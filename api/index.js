import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabase = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async (req, res) => {
  try {
    const accessKey = process.env.GONG_ACCESS_KEY;
    const accessKeySecret = process.env.GONG_ACCESS_KEY_SECRET;

    // Construct the basic auth string
    const basicAuthString = `${accessKey}:${accessKeySecret}`;

    // Encode the basic auth string in Base64
    const base64EncodedAuth = Buffer.from(basicAuthString).toString('base64');

    const gongApiEndpoint = 'https://api.gong.io/v2/calls/transcript'; // Correct endpoint with filtering

    const requestBody = {
      filter: {
        fromDateTime: "2025-02-10T00:00:00-08:00", // Your date range
        toDateTime: "2025-02-11T00:00:00-08:00"  // Your date range
      }
    };

    const response = await fetch(gongApiEndpoint, {
      method: 'POST', 
      headers: {
        'Authorization': `Basic ${base64EncodedAuth}`, 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody) // Include the filter in the body
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gong API error: ${response.status} - ${errorText}`);
    }

    const transcriptsData = await response.json();
    const transcripts = transcriptsData.callTranscripts;

    console.log("Transcripts:", transcripts);

// --- Save transcripts to Supabase (with check for existing call_id) ---
    for (const transcript of transcripts) {
      // Check if call_id already exists
      const { data: existingTranscript, error: checkError } = await supabase
      .from('call_transcripts')
      .select('call_id')
      .eq('call_id', transcript.callId)
      .maybeSingle(); // Fetch only one row (if it exists)

      if (checkError) {
        console.error("Error checking for existing call_id:", checkError);
        // Handle the error as needed (e.g., skip to the next transcript)
        continue;
      }

      if (existingTranscript) {
        console.log(`Call ${transcript.callId} already exists in the database. Skipping.`);
        continue; // Skip to the next transcript if it already exists
      }

      // If the call_id doesn't exist, insert the transcript
      const { error: insertError } = await supabase
      .from('call_transcripts')
      .insert([
          {
            call_id: transcript.callId,
            transcript: JSON.stringify(transcript),
          }
        ]);

      if (insertError) {
        console.error("Error saving transcript:", insertError);
      }
    }
    // --- End of saving transcripts ---

    console.log("Transcripts:", transcripts); // Check the structure of the transcripts data

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