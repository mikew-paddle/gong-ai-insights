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
          link: z.string(), // Gong call link with timestamp
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
      };



    //for (const transcriptData of allTranscripts) {
      // const text = transcriptData.transcript.join(" "); // Convert transcript array into a single text block
      const text = '[{"speakerId":"3867619688448981073","topic":"Call Setup","sentences":[{"start":0,"end":120,"text":"hello?"},{"start":300,"end":1220,"text":"Can you hear me?"},{"start":1830,"end":2410,"text":"Yeah, I can hear you."},{"start":2530,"end":3190,"text":"How's your day going?"},{"start":4030,"end":4510,"text":"Hey, good."},{"start":4590,"end":4770,"text":"Good."},{"start":5210,"end":6370,"text":"Yeah, I'm Eric, how you doing?"},{"start":6550,"end":7210,"text":"Let's see here?"}]},{"speakerId":"8655377485631110871","topic":"Call Setup","sentences":[{"start":9150,"end":9940,"text":"Nice to meet you."},{"start":10580,"end":12180,"text":"I had to quickly introduce myself."},{"start":12460,"end":13440,"text":"My name is Caleb."},{"start":13560,"end":22320,"text":"I'm on the commercial product team here at paddle help companies during the onboarding phase kind of go through the commercial, answer legal questions."}]},{"speakerId":"8655377485631110871","topic":"Discovery","sentences":[{"start":22380,"end":27000,"text":"If there are, you know, more advanced legal questions, loop in our legal team, make sure you guys are properly taken care of."},{"start":27980,"end":28380,"text":"Yeah."}]},{"speakerId":"3867619688448981073","topic":"Discovery","sentences":[{"start":30780,"end":31260,"text":"Okay."},{"start":32700,"end":33400,"text":"Yeah."},{"start":33520,"end":35400,"text":"My name is Eric Olson."},{"start":35520,"end":39720,"text":"I'm the sbu director for rainbird pumps and services."},{"start":40080,"end":48820,"text":"And then I have a responsibility for software as a service, subscription services."}]},{"speakerId":"3867619688448981073","topic":"Call Setup","sentences":[{"start":49500,"end":56720,"text":"And so that's for the whole company trying to figure that out in the and there's ever, we're just making an introduction."},{"start":56820,"end":58740,"text":"Do you want to introduce yourself to Caleb?"}]},{"speakerId":"9051386317822361738","topic":"Call Setup","sentences":[{"start":62080,"end":62280,"text":"Sure."},{"start":63120,"end":63920,"text":"Thank you."},{"start":64060,"end":64960,"text":"Hey, Caleb."},{"start":65260,"end":66500,"text":"Nice to meet you."},{"start":66580,"end":80160,"text":"I'm ever portillo… I'm working with the online store team and pretty much enable the e commerce sales and different offers for the company."},{"start":81700,"end":88360,"text":"I'm the technical guy here, so you can think of myself as the technical person for this conversation."},{"start":88820,"end":89940,"text":"Nice to meet you."}]},{"speakerId":"8655377485631110871","topic":"Call Setup","sentences":[{"start":90850,"end":91250,"text":"Good to meet you."},{"start":92150,"end":94090,"text":"I saw on the email thread."},{"start":94090,"end":96310,"text":"You guys were wanting to move past the discovery phase."},{"start":96450,"end":99730,"text":"Certainly, happy to do that just so I position the call correctly."}]},{"speakerId":"8655377485631110871","topic":null,"sentences":[{"start":99930,"end":103330,"text":"Is there anything that you both are very, specifically wanting to cover?"},{"start":103730,"end":106550,"text":"I'm going to make sure I take the proper time to address anything of that sort."}]},{"speakerId":"3867619688448981073","topic":null,"sentences":[{"start":107840,"end":107880,"text":"Yeah."},{"start":107880,"end":111280,"text":"Well, you got my email details."},{"start":111480,"end":114440,"text":"So we had a digital river."},{"start":114540,"end":117720,"text":"We had them for two different kind of applications."},{"start":117980,"end":124840,"text":"And we got notice last August that they were going to discontinue one line of their business."},{"start":124920,"end":132020,"text":"They gave us a little time and then recently they had this abrupt shutdown on the 30 first."},{"start":132020,"end":138600,"text":"And so we were already looking and thinking about how to go find a new merchant of record."}]},{"speakerId":"3867619688448981073","topic":"What We Do","sentences":[{"start":138720,"end":147960,"text":"But this like shifted it into high gear because, you know, we have over a 1,000,000 dollars of business that's you know, where we're collecting cellular subscriptions."},{"start":147960,"end":156700,"text":"So we're looking for and trying to educate ourselves as fast as we can on, you know, we're looking for a new merchant of record."}]},{"speakerId":"3867619688448981073","topic":"Discovery","sentences":[{"start":156700,"end":160700,"text":"And we're trying to kind of go through that process."},{"start":160700,"end":167400,"text":"Now meet with as many people as we can learning about, you know, what's available, who the leaders are."},{"start":167480,"end":170580,"text":"We want to make sure it's a good fit for rainbird."},{"start":170820,"end":172620,"text":"You know, we're a private company."},{"start":173580,"end":178200,"text":"We're over 500,000,000 in revenue, but it's private."},{"start":178280,"end":180860,"text":"So we don't really share a lot of details."},{"start":180940,"end":184220,"text":"So it's you know, bigger than that."},{"start":184460,"end":191140,"text":"We are trying to historically, we'd sell a, say, an irrigation controller that would control irrigation."},{"start":191140,"end":196880,"text":"And so we'd sell a piece of hardware that would control valves, turning on and off water."},{"start":196880,"end":204540,"text":"And we have quite a bit of software that's now in the controllers where people can access them online."},{"start":204540,"end":208020,"text":"And these would be for golf courses or large commercial entities."},{"start":208020,"end":213760,"text":"And now even homeowners were, you know, having online apps where they can control their irrigation."},{"start":213760,"end":232910,"text":"So… we're working to take the company to a place where instead of selling hardware and giving free software, that we go to sell subscription services on all of our irrigation controllers."},{"start":232910,"end":240750,"text":"So that path we're starting to move forward on, and that'll probably be how we likely sell in the future."},{"start":240750,"end":248730,"text":"And so this is a big core strategic initiative for the company to sell software as a service this way."},{"start":248730,"end":251770,"text":"And so we're trying to pick the right partner."},{"start":251770,"end":253930,"text":"So we don't have to change or have problems?"}]},{"speakerId":"3867619688448981073","topic":null,"sentences":[{"start":253930,"end":262410,"text":"So we want to have a good match for you and rainbird to make sure, you know, like if, are we too big or too small, and what are we thinking?"},{"start":262410,"end":266450,"text":"And to make sure we get the right service, and offering."},{"start":266730,"end":269880,"text":"So that's kind of, where we are."}]},{"speakerId":"8655377485631110871","topic":null,"sentences":[{"start":272210,"end":273030,"text":"Yeah, yeah, absolutely."},{"start":273030,"end":276050,"text":"You know, I'm happy to offer input when it comes to merchant record."},{"start":276050,"end":281730,"text":"There really are a ton I would say that are financially equipped to handle a company of rainberg sides."},{"start":281730,"end":292230,"text":"Besides, I mean it you probably count the companies on one hand that are actually be a good fit to protect you as revenue and have avoid any kind of bankruptcy situation there in that, the essence of that."},{"start":292910,"end":297970,"text":"And ultimately, if we're not a good fit, still having to point you in a direction of where maybe they would be a better fit too."},{"start":297970,"end":306210,"text":"So I think this could be a pretty no harm conversation when it comes to your current software kind of what you're wanting this next provider."}]},{"speakerId":"8655377485631110871","topic":"License Activation","sentences":[{"start":306210,"end":310490,"text":"So someone buys are they have their phone or they buy a physical good from you."},{"start":310490,"end":315230,"text":"You're wanting them to have to log in and create an account or have a software?"},{"start":315230,"end":323770,"text":"Is that an on Prem like through a license key or is it cloud based that gives them access or, you know, make sure they're a continuing paying customer or how does that work?"}]},{"speakerId":"3867619688448981073","topic":"License Activation","sentences":[{"start":327350,"end":346550,"text":"Well, today, we, we're in a transition phase but, and we got golf products and landscape products and, you know, and even someday we'll have agriculture products and this could be different for each products that we have and sell."}]},{"speakerId":"9051386317822361738","topic":"License Activation","sentences":[{"start":347940,"end":348720,"text":"So,"}]},{"speakerId":"3867619688448981073","topic":"License Activation","sentences":[{"start":349780,"end":355500,"text":"some in the landscape would buy the controller hardware and they'd go install it on their wall."},{"start":355500,"end":361780,"text":"But then they'd want to connect to an irrigation app or software."},{"start":361780,"end":365120,"text":"And then so they would sign up for an account that way, right?"},{"start":365120,"end":367520,"text":"That's a lot of it golf."},{"start":367520,"end":380940,"text":"Where we're going to, in golf is where you would kind of, you know, buy the subscription of the software and we still need to put, a box for a local connection."}]},{"speakerId":"3867619688448981073","topic":"Discovery","sentences":[{"start":380940,"end":382760,"text":"So that that's where we're going to go."},{"start":382760,"end":390000,"text":"We're going to sell a golf software that way, you know, pay over time but they would still get a box."},{"start":390000,"end":391860,"text":"So it's kind of depending on the market."},{"start":391860,"end":393900,"text":"It's a little bit all over the map today."}]},{"speakerId":"8655377485631110871","topic":"Discovery","sentences":[{"start":394530,"end":395130,"text":"Yep."},{"start":395690,"end":409070,"text":"Because, that price, you know, that go to market strategy kind of puts you closer to the realm of like a peloton, a remarkable e notebook where they buy a physical good, but then there's a separate subscription to maintain kind of the use of that product, got it."},{"start":409070,"end":414330,"text":"And how do they currently buy the physical product or, you know, the device that's going to be on the wall?"},{"start":414430,"end":420990,"text":"And then are you comfortable to pair with that for them to have a second checkout to pay for the software?"},{"start":420990,"end":430010,"text":"Are you guys envisioning two different checkout experiences one for that physical good through the sales rep or however you'd like to take that to the market, and then a self serve model for the software."}]},{"speakerId":"3867619688448981073","topic":"Discovery","sentences":[{"start":432880,"end":435420,"text":"We would like to probably have the capability for both."},{"start":435420,"end":440040,"text":"Most of what we sell today goes through dealers and distributors."},{"start":440540,"end":444980,"text":"So a dealer would, you know, or retail would sell the box."},{"start":444980,"end":451120,"text":"And again, you know, someone might want to hook up to the software and pay for software."}]},{"speakerId":"3867619688448981073","topic":"What We Do","sentences":[{"start":451120,"end":461800,"text":"But there could be likely where end users like say golf courses, you know, just buy a straight up subscription."},{"start":461800,"end":465000,"text":"And in the subscription, they get some hardware."}]},{"speakerId":"8655377485631110871","topic":"What We Do","sentences":[{"start":465770,"end":466070,"text":"Okay."},{"start":466070,"end":467390,"text":"Got it."},{"start":467390,"end":473150,"text":"And this is the one limitation that you'll speak to a lot of merchant records that handle software."},{"start":473990,"end":480470,"text":"The biggest in the space only handle software because physical goods are just handled differently or taxed differently."}]},{"speakerId":"8655377485631110871","topic":"Discovery","sentences":[{"start":480470,"end":481590,"text":"And it gets there's."},{"start":481590,"end":483750,"text":"Really just a digital river."},{"start":483750,"end":486970,"text":"You know, they had their shortcomings in certain areas but were good in other areas."},{"start":486970,"end":494030,"text":"They were like maybe the only provider that allowed you to do physical good and software on a singular transaction depending on how you had it set up."}]},{"speakerId":"8655377485631110871","topic":"What We Do","sentences":[{"start":494030,"end":503430,"text":"So most merchant records that you speak to will only allow you to sell software through them or there'll be a merchant record that will allow you to sell physical goods but not software through them."},{"start":503430,"end":514730,"text":"And so, I guess that's kind of what I was asking if you guys would be comfortable to keep the physical product goods separate and then have transactions only for software, you know, now and moving forward?"}]},{"speakerId":"3867619688448981073","topic":null,"sentences":[{"start":516970,"end":520470,"text":"I think so, don't I mean ever, is that makes sense?"},{"start":520470,"end":532810,"text":"Now, at some point when we do the software reoccurring, you know, that we could still do that reoccurring transaction but, we could deliver a piece of hardware, right?"},{"start":532810,"end":533830,"text":"Yeah."}]},{"speakerId":"8655377485631110871","topic":null,"sentences":[{"start":533980,"end":539460,"text":"Yeah, as long as that software transaction isn't for the physical good that's completely fine."},{"start":539460,"end":551620,"text":"We, we work with like let's say newspapers, for example, where they sell e newspaper online or access to a subscription, but then they deliver their newspaper to certain people, whether they're subscribers or not."},{"start":551620,"end":553320,"text":"I don't really know how that works."},{"start":553320,"end":559480,"text":"They just do that on their own accord outside of the software platform or where the payments panel is processing for them."}]},{"speakerId":"9051386317822361738","topic":"What We Do","sentences":[{"start":560750,"end":590690,"text":"So the first appetite… if you will, is for selling the subscription for the merchant of record, which is so that's pretty much my umbrella now with regards to the second line of business which is selling the physical goods that's under shampooing umbrella, Eric, but I'll say, yeah, we will need to get him involved just to understand his vision."},{"start":591830,"end":597830,"text":"But eventually we are trying to also go global with the physical goods selling as well."}]},{"speakerId":"8655377485631110871","topic":"Discovery","sentences":[{"start":598590,"end":598710,"text":"Okay."},{"start":599350,"end":599750,"text":"Yeah."},{"start":600490,"end":604510,"text":"Another example, a company called fender, they do music distribution."},{"start":604730,"end":606750,"text":"I don't know, they probably do a couple 1,000,000,000 a year."},{"start":606870,"end":608670,"text":"They keep their fiscal goods separate."},{"start":608990,"end":621890,"text":"And as you kind of dive into these conversations with payment providers, you'll realize that companies do something, very good but it's in a very specific vertical and it can be physical good, payment processing like Shopify, they excel at that."}]},{"speakerId":"8655377485631110871","topic":"What We Do","sentences":[{"start":622010,"end":623290,"text":"And that's why a lot of companies will do that."},{"start":623410,"end":627510,"text":"And then there's paddle that does software or SaaS, or one time purchases very good."},{"start":627610,"end":633050,"text":"And we have a bunch of competitors that typically payment companies specialize in one specific thing."},{"start":633290,"end":640650,"text":"And what that actually allows is for your team to almost excel in that fashion because you have the best performing solution for that need."},{"start":640850,"end":643030,"text":"And you know, they're on independent verticals."},{"start":643030,"end":652110,"text":"So you have the best performing solution for a physical good or a reseller which is very common too for physical goods just because compliance can get tricky around the world for that too."},{"start":652110,"end":656530,"text":"So if you guys are open to it, paddle certainly can handle the software side."}]},{"speakerId":"8655377485631110871","topic":null,"sentences":[{"start":657170,"end":658510,"text":"It's what we specialize in."},{"start":658590,"end":665410,"text":"And ultimately, we help convert more customers and retain your customers through return mitigation tools that are native to."},{"start":665570,"end":672450,"text":"So if that's what you guys are open to that's something that we can certainly evaluate and help you guys through to understand that paddle's a good fit."}]},{"speakerId":"3867619688448981073","topic":"Payment Methods","sentences":[{"start":674040,"end":677760,"text":"Yeah, we'd like to hear this and explore more about your company."}]},{"speakerId":"8655377485631110871","topic":"Payment Methods","sentences":[{"start":678360,"end":678580,"text":"Okay."},{"start":678660,"end":682040,"text":"Now, let's dive into the actual software, subscription side of things."},{"start":683280,"end":684480,"text":"How do your customers pay?"},{"start":684560,"end":685600,"text":"Are they all credit, card?"},{"start":685800,"end":688480,"text":"Are they ach, wire transfers, or how do they like to pay?"}]},{"speakerId":"3867619688448981073","topic":"Payment Methods","sentences":[{"start":690020,"end":701400,"text":"We have a lot of credit card transactions, but we also have a lot of transactions that still go through this distributor intermediary."}]},{"speakerId":"3867619688448981073","topic":"Wire Transfer","sentences":[{"start":701800,"end":709360,"text":"So maybe I just don't hold me to this but it might be 65 percent will manage the credit card."},{"start":709360,"end":714640,"text":"But there's a lot of these businesses that they can't process that credit card transaction."},{"start":714840,"end":721520,"text":"So, we're going through a distributor and billing them that way for this type of work."}]},{"speakerId":"8655377485631110871","topic":"Sales Tax","sentences":[{"start":723690,"end":729610,"text":"And how would you like to keep that model where the ones that use the distributor keep using them?"},{"start":729610,"end":738950,"text":"And then you have a provider for the individuals or organizations, so to speak, that want to just self serve and pay direct or would you like to remove essentially all distributors?"}]},{"speakerId":"3867619688448981073","topic":"Sales Tax","sentences":[{"start":742180,"end":747510,"text":"Well, we need a way to have a distributor in there, I think, right?"},{"start":748070,"end":749650,"text":"Ever, do you have a thought here?"}]},{"speakerId":"9051386317822361738","topic":"Sales Tax","sentences":[{"start":751010,"end":753940,"text":"Pretty much the majority of the transaction through credit card?"},{"start":754740,"end":759760,"text":"And I can think of a reason right now to remove the distributor."},{"start":760320,"end":773080,"text":"So there should be a way also for continuing that process forward because some of our customers like public agency or some type of company doesn't want to charge like using a distributor."},{"start":773800,"end":774720,"text":"Got it."},{"start":774800,"end":775440,"text":"Okay."}]},{"speakerId":"8655377485631110871","topic":"Payment Methods","sentences":[{"start":791460,"end":791470,"text":"Yeah."},{"start":791520,"end":800040,"text":"And the reason I ask is I think this is with what you guys are looking to accomplish and credit card and how your customers pay."},{"start":800240,"end":801860,"text":"I'm going to be very forthcoming."},{"start":802000,"end":803980,"text":"I don't know if paddle is the perfect fit for you."},{"start":803980,"end":809420,"text":"All, we specialize in companies where almost their entire volume is through paypal or card payments or apple pay."},{"start":809420,"end":815600,"text":"Now, when invoice starts getting involved or just frankly like that starts to get out of where our system performs the best."},{"start":816320,"end":823120,"text":"And then to pair that with your guys, you know, eventually kind of wanting to allow software to upsell the physical goods or vice versa."},{"start":823220,"end":827940,"text":"Then our system would really kind of get tricky and might not future proof your guys' go to market strategies."}]},{"speakerId":"8655377485631110871","topic":null,"sentences":[{"start":828280,"end":839140,"text":"And so, you know, my feedback here about 15 minutes in, is that we might just not be the best fit for what you guys were looking to accomplish and your kind of current go to market strategy to be very transparent with you all."},{"start":839140,"end":839940,"text":"So I know it gets."}]},{"speakerId":"3867619688448981073","topic":"Wire Transfer","sentences":[{"start":841400,"end":847700,"text":"Because paypal or credit card is really your sweet spot."}]},{"speakerId":"8655377485631110871","topic":"Wire Transfer","sentences":[{"start":848300,"end":848900,"text":"Yeah, correct."},{"start":849360,"end":851160,"text":"We work with a lot of vc companies."}]},{"speakerId":"3867619688448981073","topic":"Wire Transfer","sentences":[{"start":851880,"end":852160,"text":"Yeah."},{"start":852300,"end":855940,"text":"Do you do merchant of record though work internationally?"},{"start":856280,"end":857040,"text":"Do you do this?"}]},{"speakerId":"8655377485631110871","topic":"Wire Transfer","sentences":[{"start":857650,"end":858330,"text":"Yeah, yeah, absolutely."},{"start":858690,"end":867770,"text":"And we do have an invoicing tool like, but there's more so for like the occasional one off invoice, it isn't something that necessarily scales all that well."}]},{"speakerId":"8655377485631110871","topic":"Payment Methods","sentences":[{"start":867770,"end":868570,"text":"Like the apis."},{"start":868570,"end":873550,"text":"If we dug into it from a technical workshops perspective are not the same as a self serve."},{"start":873550,"end":882310,"text":"Or for, if you take let's say someone from India or Japan, or Germany, if they wanted to pay via paypal or credit card, then yeah, we can take those payments and we're a good fit."},{"start":882510,"end":891450,"text":"But for the most part, our bread and butter is b to c companies or b to s and b where most of their transactions, if not all are credit card or paypal transactions."},{"start":894070,"end":894430,"text":"Okay?"},{"start":897100,"end":902620,"text":"But as far… yeah, so there are providers that,"}]}]'
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



