const { createClient } = require('@supabase/supabase-js');
const { Gong } = require('gong-api'); // Or use node-fetch if preferred
const fetch = require('node-fetch');

// Supabase setup (same as before)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = async (req, res) => {
  try {
    // 1. Fetch transcripts from Gong API
    const gong = new Gong({ apiKey: process.env.GONG_API_KEY }); // Or use node-fetch
    const calls = await gong.getCalls(); // Or your custom fetch logic

    // Example: Log the first call to check if it's working
    if (calls && calls.length > 0) {
      console.log('First Gong call:', calls[0]); // Check the structure of the data
    } else {
      console.log('No calls found.');
    }

    // 2. Process transcripts and summarize (We'll implement this later)
    const summaries = {}; // Placeholder for summaries

    // 3. Retrieve user interests from Supabase (same as before)
    const { data: userInterests, error } = await supabase
        .from('user_interests')
        .select('*');

    if (error) {
        console.error("Error fetching user interests:", error);
        return res.status(500).json({ error: 'Failed to fetch user interests' });
    }

    // 4. Send messages to Slack (same as before)
    for (const user of userInterests) {
        const userSummary = summaries[user.interests]; // Assuming interest-based summaries
        if (userSummary) {
            const slackMessage = {
                text: `New Gong Call Summary for ${user.email}:\n${userSummary}`, // Customize the message
            };

            try {
                const response = await fetch(process.env.SLACK_WEBHOOK_URL, {
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
    res.status(500).json({ error: 'An error occurred' });
  }
};
