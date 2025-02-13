import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import OpenAI from 'openai'; 
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabase = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
          toDateTime: toDateTime,
          callIds: ['7651631180145571239']
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

      //console.log("Current batch of transcripts count:", transcripts.length);
      //console.log("Records data:", transcriptsData.records);
      //console.log("Next Cursor:", nextCursor);

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

        const transcriptText = transcripts[i].transcript

        currentBatch.push({
          call_id: transcripts[i].callId,
          transcript: transcriptText, 
        });


        if (currentBatch.length === BATCH_SIZE || i === transcripts.length - 1) {
          batches.push(currentBatch);
          currentBatch =[];
        }
      }

      // insert to database
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
          model: "gpt-3.5-turbo",
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

    const TranscriptAnalysisSchema = z.object({
      call_id: z.string(),
      matches: z.array(
        z.object({
          keyword: z.string(),
          summary: z.string(),
          timestamp: z.number(), // Most relevant timestamp in milliseconds
          link: z.string().url(), // Gong call link with timestamp
        })
      ),
    });

    async function classifyTranscriptWithStructuredOutput(text, keywords, callId) {
        try {
            const completion = await openai.beta.chat.completions.parse({
              model: "gpt-4o-2024-08-06",
              messages: [
                { role: "system", content: "You are an expert research analyst analysing a call transript for matches to relevant topic. The topics are provided to you as keywords. You are given a json object which contains the transcript split into sentences each with a start and end timestamp, as well as the text of what was said. Analyze the call transcript sentence text for topics matching the keywords and provide a very short summary of what was discussed regarding the topic (max 200 characters) per keyword matched. Also provide the more relevant timestamp at which someone would want to start watching to call back to see what was discussed related to the keyword, as well as a link to the call in the format 'https://us.app.gong.io/call?id=${call_id}&highlights=%5B%7B%22from%22%3A[timestamp]%7D%5D'. If you don't find any matches to the keywords return null." },
                { role: "user", content: `Transcript: ${text}\n\nIdentify any topics from this list: ${keywords.join(", ")}.` }
              ],
              store: true,
              response_format: zodResponseFormat(TranscriptAnalysisSchema, "call_analysis"), // ✅ Structured Output
            });

            return completion.choices[0].message.parsed;
          } catch (error) {
            console.error("Error in Zero-Shot Classification:", error);
            return { call_id: callId, matches: [] };
          }
      }



    //for (const transcriptData of allTranscripts) {
      // const text = transcriptData.transcript.join(" "); // Convert transcript array into a single text block
      const text = "hello? Can you hear me? Yeah, I can hear you. How's your day going? Hey, good. Good. Yeah, I'm Eric, how you doing? Let's see here? Nice to meet you. I had to quickly introduce myself. My name is Caleb. I'm on the commercial product team here at paddle help companies during the onboarding phase kind of go through the commercial, answer legal questions. If there are, you know, more advanced legal questions, loop in our legal team, make sure you guys are properly taken care of. Yeah. Okay. Yeah. My name is Eric Olson. I'm the sbu director for rainbird pumps and services. And then I have a responsibility for software as a service, subscription services. And so that's for the whole company trying to figure that out in the and there's ever, we're just making an introduction. Do you want to introduce yourself to Caleb? Sure. Thank you. Hey, Caleb. Nice to meet you. I'm ever portillo… I'm working with the online store team and pretty much enable the e commerce sales and different offers for the company. I'm the technical guy here, so you can think of myself as the technical person for this conversation. Nice to meet you. Good to meet you. I saw on the email thread. You guys were wanting to move past the discovery phase. Certainly, happy to do that just so I position the call correctly. Is there anything that you both are very, specifically wanting to cover? I'm going to make sure I take the proper time to address anything of that sort. Yeah. Well, you got my email details. So we had a digital river. We had them for two different kind of applications. And we got notice last August that they were going to discontinue one line of their business. They gave us a little time and then recently they had this abrupt shutdown on the 30 first. And so we were already looking and thinking about how to go find a new merchant of record. But this like shifted it into high gear because, you know, we have over a 1,000,000 dollars of business that's you know, where we're collecting cellular subscriptions. So we're looking for and trying to educate ourselves as fast as we can on, you know, we're looking for a new merchant of record. And we're trying to kind of go through that process. Now meet with as many people as we can learning about, you know, what's available, who the leaders are. We want to make sure it's a good fit for rainbird. You know, we're a private company. We're over 500,000,000 in revenue, but it's private. So we don't really share a lot of details. So it's you know, bigger than that. We are trying to historically, we'd sell a, say, an irrigation controller that would control irrigation. And so we'd sell a piece of hardware that would control valves, turning on and off water. And we have quite a bit of software that's now in the controllers where people can access them online. And these would be for golf courses or large commercial entities. And now even homeowners were, you know, having online apps where they can control their irrigation. So… we're working to take the company to a place where instead of selling hardware and giving free software, that we go to sell subscription services on all of our irrigation controllers. So that path we're starting to move forward on, and that'll probably be how we likely sell in the future. And so this is a big core strategic initiative for the company to sell software as a service this way. And so we're trying to pick the right partner. So we don't have to change or have problems? So we want to have a good match for you and rainbird to make sure, you know, like if, are we too big or too small, and what are we thinking? And to make sure we get the right service, and offering. So that's kind of, where we are. Yeah, yeah, absolutely. You know, I'm happy to offer input when it comes to merchant record. There really are a ton I would say that are financially equipped to handle a company of rainberg sides. Besides, I mean it you probably count the companies on one hand that are actually be a good fit to protect you as revenue and have avoid any kind of bankruptcy situation there in that, the essence of that. And ultimately, if we're not a good fit, still having to point you in a direction of where maybe they would be a better fit too. So I think this could be a pretty no harm conversation when it comes to your current software kind of what you're wanting this next provider. So someone buys are they have their phone or they buy a physical good from you. You're wanting them to have to log in and create an account or have a software? Is that an on Prem like through a license key or is it cloud based that gives them access or, you know, make sure they're a continuing paying customer or how does that work? Well, today, we, we're in a transition phase but, and we got golf products and landscape products and, you know, and even someday we'll have agriculture products and this could be different for each products that we have and sell. So, some in the landscape would buy the controller hardware and they'd go install it on their wall. But then they'd want to connect to an irrigation app or software. And then so they would sign up for an account that way, right? That's a lot of it golf. Where we're going to, in golf is where you would kind of, you know, buy the subscription of the software and we still need to put, a box for a local connection. So that that's where we're going to go. We're going to sell a golf software that way, you know, pay over time but they would still get a box. So it's kind of depending on the market. It's a little bit all over the map today. Yep. Because, that price, you know, that go to market strategy kind of puts you closer to the realm of like a peloton, a remarkable e notebook where they buy a physical good, but then there's a separate subscription to maintain kind of the use of that product, got it. And how do they currently buy the physical product or, you know, the device that's going to be on the wall? And then are you comfortable to pair with that for them to have a second checkout to pay for the software? Are you guys envisioning two different checkout experiences one for that physical good through the sales rep or however you'd like to take that to the market, and then a self serve model for the software. We would like to probably have the capability for both. Most of what we sell today goes through dealers and distributors. So a dealer would, you know, or retail would sell the box. And again, you know, someone might want to hook up to the software and pay for software. But there could be likely where end users like say golf courses, you know, just buy a straight up subscription. And in the subscription, they get some hardware. Okay. Got it. And this is the one limitation that you'll speak to a lot of merchant records that handle software. The biggest in the space only handle software because physical goods are just handled differently or taxed differently. And it gets there's. Really just a digital river. You know, they had their shortcomings in certain areas but were good in other areas. They were like maybe the only provider that allowed you to do physical good and software on a singular transaction depending on how you had it set up. So most merchant records that you speak to will only allow you to sell software through them or there'll be a merchant record that will allow you to sell physical goods but not software through them. And so, I guess that's kind of what I was asking if you guys would be comfortable to keep the physical product goods separate and then have transactions only for software, you know, now and moving forward? I think so, don't I mean ever, is that makes sense? Now, at some point when we do the software reoccurring, you know, that we could still do that reoccurring transaction but, we could deliver a piece of hardware, right? Yeah. Yeah, as long as that software transaction isn't for the physical good that's completely fine. We, we work with like let's say newspapers, for example, where they sell e newspaper online or access to a subscription, but then they deliver their newspaper to certain people, whether they're subscribers or not. I don't really know how that works. They just do that on their own accord outside of the software platform or where the payments panel is processing for them. So the first appetite… if you will, is for selling the subscription for the merchant of record, which is so that's pretty much my umbrella now with regards to the second line of business which is selling the physical goods that's under shampooing umbrella, Eric, but I'll say, yeah, we will need to get him involved just to understand his vision. But eventually we are trying to also go global with the physical goods selling as well. Okay. Yeah. Another example, a company called fender, they do music distribution. I don't know, they probably do a couple 1,000,000,000 a year. They keep their fiscal goods separate. And as you kind of dive into these conversations with payment providers, you'll realize that companies do something, very good but it's in a very specific vertical and it can be physical good, payment processing like Shopify, they excel at that. And that's why a lot of companies will do that. And then there's paddle that does software or SaaS, or one time purchases very good. And we have a bunch of competitors that typically payment companies specialize in one specific thing. And what that actually allows is for your team to almost excel in that fashion because you have the best performing solution for that need. And you know, they're on independent verticals. So you have the best performing solution for a physical good or a reseller which is very common too for physical goods just because compliance can get tricky around the world for that too. So if you guys are open to it, paddle certainly can handle the software side. It's what we specialize in. And ultimately, we help convert more customers and retain your customers through return mitigation tools that are native to. So if that's what you guys are open to that's something that we can certainly evaluate and help you guys through to understand that paddle's a good fit. Yeah, we'd like to hear this and explore more about your company. Okay. Now, let's dive into the actual software, subscription side of things. How do your customers pay? Are they all credit, card? Are they ach, wire transfers, or how do they like to pay? We have a lot of credit card transactions, but we also have a lot of transactions that still go through this distributor intermediary. So maybe I just don't hold me to this but it might be 65 percent will manage the credit card. But there's a lot of these businesses that they can't process that credit card transaction. So, we're going through a distributor and billing them that way for this type of work. And how would you like to keep that model where the ones that use the distributor keep using them? And then you have a provider for the individuals or organizations, so to speak, that want to just self serve and pay direct or would you like to remove essentially all distributors? Well, we need a way to have a distributor in there, I think, right? Ever, do you have a thought here? Pretty much the majority of the transaction through credit card? And I can think of a reason right now to remove the distributor. So there should be a way also for continuing that process forward because some of our customers like public agency or some type of company doesn't want to charge like using a distributor. Got it. Okay. Yeah. And the reason I ask is I think this is with what you guys are looking to accomplish and credit card and how your customers pay. I'm going to be very forthcoming. I don't know if paddle is the perfect fit for you. All, we specialize in companies where almost their entire volume is through paypal or card payments or apple pay. Now, when invoice starts getting involved or just frankly like that starts to get out of where our system performs the best. And then to pair that with your guys, you know, eventually kind of wanting to allow software to upsell the physical goods or vice versa. Then our system would really kind of get tricky and might not future proof your guys' go to market strategies. And so, you know, my feedback here about 15 minutes in, is that we might just not be the best fit for what you guys were looking to accomplish and your kind of current go to market strategy to be very transparent with you all. So I know it gets. Because paypal or credit card is really your sweet spot. Yeah, correct. We work with a lot of vc companies. Yeah. Do you do merchant of record though work internationally? Do you do this? Yeah, yeah, absolutely. And we do have an invoicing tool like, but there's more so for like the occasional one off invoice, it isn't something that necessarily scales all that well. Like the apis. If we dug into it from a technical workshops perspective are not the same as a self serve. Or for, if you take let's say someone from India or Japan, or Germany, if they wanted to pay via paypal or credit card, then yeah, we can take those payments and we're a good fit. But for the most part, our bread and butter is b to c companies or b to s and b where most of their transactions, if not all are credit card or paypal transactions. Okay? But as far… yeah, so there are providers that,"
      const matchedKeywords = await classifyTranscriptWithStructuredOutput(text, interestArray, "12345");

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



