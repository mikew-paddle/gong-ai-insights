const { createClient } = require('@supabase/supabase-js');
import fetch from 'node-fetch';

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = async (req, res) => {
  try {
    const gongApiKey = process.env.GONG_API_KEY;
    const gongApiEndpoint = 'https://api.gong.io/v2/calls/transcript'; // Correct endpoint with filtering

    const requestBody = {
      filter: {
        fromDateTime: "2025-02-10T00:00:00-08:00", // Your date range
        toDateTime: "2025-02-11T00:00:00-08:00"  // Your date range
      }
    };

    const response = await fetch(gongApiEndpoint, {
      method: 'POST', // or GET, depending on Gong API requirements
      headers: {
        'Authorization': `Bearer ${gongApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody) // Include the filter in the body
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gong API error: ${response.status} - ${errorText}`);
    }

    const transcriptsData = await response.json();

    // The structure of transcriptsData might vary; adjust accordingly
    const transcripts = transcriptsData.callTranscripts;

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