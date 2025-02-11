import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabase = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const BATCH_SIZE = 25;

export default async (req, res) => {
  try {
    /* 

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

      console.log("Current batch of transcripts count:", transcripts.length);
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
          transcript: JSON.stringify(transcripts[i].transcript),
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
    //const summaries = {}; // Placeholder for summaries

    */


    // --- Fetch User Interests ---
    const { data: userInterests, error: interestsError } = await supabase.rpc('unnest_interests');

    if (interestsError) {
      console.error("Error fetching user interests:", interestsError);
      return res.status(500).json({ error: 'Failed to fetch user interests' });
    }

    const interestArray = userInterests.map(row => row.interest);
    console.log("User interests full list:", interestArray);

    // --- Perform Zero-Shot Classification ---
    async function classifyTranscript(text, keywords) {
      const prompt = `Analyze this call transcript and identify which of the following topics it relates to: ${keywords.join(", ")}.
      Transcript: ${text}
      Return only the relevant topics as a JSON array.`;

      console.log("Prompt:", prompt);

      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4-turbo",
          messages: [{ role: "user", content: prompt }],
          response_format: "json",
        });
        console.log("Response:", response);

        return JSON.parse(response.choices[0].message.content);

      } catch (error) {
        console.error("Error in Zero-Shot Classification:", error);
        return [];
      }
    }

    //for (const transcriptData of allTranscripts) {
      // const text = transcriptData.transcript.join(" "); // Convert transcript array into a single text block
      const text = "I really dislike Paddle's Dashboard as it doesn't give me the data I need to run my business, however the boost to payment acceptance makes it worth it."
      const matchedKeywords = await classifyTranscript(text, interestArray);

      console.log("Matched keywords:", matchedKeywords);

      /* if (matchedKeywords.length > 0) {
        const { error } = await supabase
          .from('call_transcripts')
          .update({ matched_keywords: matchedKeywords })
          .eq('call_id', transcriptData.callId);
      
        if (error) {
          console.error(`Error updating transcript ${transcriptData.callId}:`, error);
        }
        
      }
    }
    */



    res.status(200).json({ message: 'Processing complete' });

  } catch (error) {
    console.error('Error in Vercel function:', error);
    res.status(500).json({ error: error.message });
  }
};

