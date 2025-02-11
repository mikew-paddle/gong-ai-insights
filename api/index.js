import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabase = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BATCH_SIZE = 25;

export default async (req, res) => {
  try {
    const accessKey = process.env.GONG_ACCESS_KEY;
    const accessKeySecret = process.env.GONG_ACCESS_KEY_SECRET;

    // Construct the basic auth string
    const basicAuthString = `${accessKey}:${accessKeySecret}`;

    // Encode the basic auth string in Base64
    const base64EncodedAuth = Buffer.from(basicAuthString).toString('base64');

    const gongApiEndpoint = 'https://api.gong.io/v2/calls/transcript'; // Correct endpoint with filtering

    // --- Get fromDateTime and toDateTime from query parameters ---
    const fromDateTime = req.query.fromDateTime || "2025-02-10T00:00:00-08:00"; // Default value if not provided
    const toDateTime = req.query.toDateTime || "2025-02-11T00:00:00-08:00"; // Default value if not provided

    console.log("From date:", fromDateTime);
    console.log("To date:", toDateTime);

    let nextCursor = null;
    let allTranscripts =[];

    do {
      const requestBody = {
        filter: {
          fromDateTime: fromDateTime,
          toDateTime: toDateTime
        },
        cursor: nextCursor,
        pageSize: BATCH_SIZE,
      };

      const response = await fetch(gongApiEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${base64EncodedAuth}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gong API error: ${response.status} - ${errorText}`);
      }

      const transcriptsData = await response.json();
      const transcripts = transcriptsData.callTranscripts;

      allTranscripts = allTranscripts.concat(transcripts);

      nextCursor = transcriptsData.records.cursor;

      console.log("Current batch of transcripts:", transcripts);
      console.log("Records data:", transcriptsData.records);
      console.log("Next Cursor:", nextCursor);

      // --- Save transcripts to Supabase (with batch insertion and check for existing call_id) ---
      const batches =[];
      let currentBatch =[];

      for (let i = 0; i < transcripts.length; i++) {
        // Check if call_id already exists
        const { data: existingTranscript, error: checkError } = await supabase
        .from('call_transcripts')
        .select('call_id')
        .eq('call_id', transcripts[i].callId)
        .maybeSingle();

        if (checkError) {
          console.error("Error checking for existing call_id:", checkError);
          continue;
        }

        if (existingTranscript) {
          console.log(`Call ${transcripts[i].callId} already exists in the database. Skipping.`);
          continue;
        }

        currentBatch.push({
          call_id: transcripts[i].callId,
          transcript: JSON.stringify(transcripts[i].transacript),
        });

        if (currentBatch.length === BATCH_SIZE || i === transcripts.length - 1) {
          batches.push(currentBatch);
          currentBatch =[];
        }
      }

      for (const batch of batches) {
        const { error } = await supabase
        .from('call_transcripts')
        .insert(batch);

        if (error) {
          console.error("Error saving batch:", error);
        }
      }

    }  while (nextCursor);
      // --- End of saving transcripts ---

    // 3. Process transcripts and summarize (IMPLEMENT THIS LOGIC)
    const summaries = {}; // Placeholder for summaries

    // 4. Retrieve user interests from Supabase
    const { data: userInterests, error } = await supabase
    .from('user_interests')
    .select('*');

    if (error) {
      console.error("Error fetching user interests:", error);
      return res.status(500).json({ error: 'Failed to fetch user interests' });
    }

    // 5. Send messages to Slack
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    for (const user of userInterests) {
      const userSummary = summaries[user.interests]; // Assuming interest-based summaries
      if (userSummary) {
        const slackMessage = {
          text: `New Gong Call Summary for ${user.email}:\n${userSummary}`,
        };

        try {
          const response = await fetch(slackWebhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(slackMessage),
          });

          if (!response.ok) {
            console.error('Error sending to Slack:', response.status, await response.text());
          } else {
            console.log('Message sent to Slack');
          }
        } catch (error) {
          console.error('Error sending to Slack:', error);
        }
      }
    }


    res.status(200).json({ message: 'Processing complete' });

  } catch (error) {
    console.error('Error in Vercel function:', error);
    res.status(500).json({ error: error.message });
  }
};

