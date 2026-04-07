require("dotenv").config();
const express = require("express");
const OpenAI = require("openai");
const Stripe = require("stripe");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const isLive = process.env.STRIPE_MODE === "live";
const stripe = new Stripe(
  isLive ? process.env.STRIPE_SECRET_KEY_LIVE : process.env.STRIPE_SECRET_KEY_TEST
);
const stripePublishableKey = isLive
  ? process.env.STRIPE_PUBLISHABLE_KEY_LIVE
  : process.env.STRIPE_PUBLISHABLE_KEY_TEST;

const callReports = {};
const paidCalls = new Set(); // track which callIds have been paid for

const app = express();
app.use(express.json());
app.use(express.static("public"));

async function enrichProspect(input) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: `Given this prospect description: '${input}', return a JSON object with exactly two fields:\n- displayName: a realistic short professional male name (e.g. 'James R., CEO' or 'Michael T., Executive Assistant')\n- enrichedPersona: a 2-3 sentence description of this person's professional background, personality, and how they typically behave when receiving cold calls\n\nReturn only valid JSON, no other text.`,
      },
    ],
    response_format: { type: "json_object" },
  });

  return JSON.parse(completion.choices[0].message.content);
}

// Create a Retell web call and return access_token
app.post("/start-call", async (req, res) => {
  console.log("start-call body:", req.body);
  const { prospectType, difficulty, product } = req.body;

  try {
    const { displayName, enrichedPersona } = await enrichProspect(prospectType);
    console.log("Enriched prospect:", { displayName, enrichedPersona });

    const requestBody = {
      agent_id: "agent_e0700657d1382fb2ee1ac6679f",
      metadata: { product, prospectType, difficulty },
      retell_llm_dynamic_variables: { product, prospectType: enrichedPersona, difficulty },
      agent_override: { voice_id: "11labs-Brian" },
    };
    console.log("Retell request body:", JSON.stringify(requestBody, null, 2));

    const response = await fetch("https://api.retellai.com/v2/create-web-call", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.RETELL_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Retell API error:", err);
      return res.status(500).json({ error: "Failed to create call" });
    }

    const data = await response.json();
    console.log("Retell API response:", JSON.stringify(data, null, 2));

    res.json({ access_token: data.access_token, call_id: data.call_id, displayName });
  } catch (err) {
    console.error("start-call error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Retell webhook — score call on call_ended
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const { event_type, data } = req.body;
  if (event_type !== "call_ended") return;

  const callId = data?.call_id;
  const transcript = data?.transcript_object || data?.transcript;
  if (!callId || !transcript) {
    console.log("webhook: missing callId or transcript", { callId, transcript: !!transcript });
    return;
  }

  console.log(`webhook: scoring call ${callId}`);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [
        {
          role: "user",
          content: `You are a brutally honest cold call coach. Analyze this sales call transcript and score it fairly. Be strict — a score of 8+ should only go to genuinely excellent calls. Most average calls should score 4-6. Poor calls should score 1-3.

Scoring criteria:
- Opening (0-10): Did the caller introduce themselves clearly, establish credibility, and give a compelling reason for calling within the first 30 seconds? No intro = 0-2. Weak intro = 3-4. Decent = 5-6. Strong = 7-8. Exceptional = 9-10.
- Objection Handling (0-10): Did the caller address the prospect's concerns directly and confidently? Ignored objections = 0-2. Poor handling = 3-4. Decent = 5-6. Good = 7-8. Excellent = 9-10.
- Tone & Pace (0-10): Was the caller confident, natural, and easy to listen to? Nervous/rushed/monotone = 0-3. Okay = 4-6. Good = 7-8. Excellent = 9-10.
- Closing (0-10): Did the caller attempt to secure a next step (meeting, follow-up, demo)? No attempt = 0-2. Weak attempt = 3-4. Decent = 5-6. Strong = 7-8. Perfect = 9-10.
- Active Listening (0-10): Did the caller respond to what the prospect actually said or just follow a script? Ignored prospect = 0-2. Minimal = 3-4. Some = 5-6. Good = 7-8. Excellent = 9-10.

If the transcript is blank, silent, or contains no meaningful sales conversation, return all scores as 0 and verdict as "No pitch detected."

Return only valid JSON with these exact fields:
{
  "overall": (average of the 5 skill scores, one decimal),
  "verdict": (one sentence summary of the call),
  "talkRatio": (estimated percentage the caller was talking e.g. "62%"),
  "objectionCount": (number of objections raised by prospect),
  "highlights": [
    { "type": "positive", "text": "one line about what went well" },
    { "type": "negative", "text": "one line about what went wrong" },
    { "type": "negative", "text": "one line about another weakness" },
    { "type": "positive", "text": "one line about another strength" }
  ],
  "skills": {
    "opening": (0-10),
    "objectionHandling": (0-10),
    "toneAndPace": (0-10),
    "closing": (0-10),
    "activeListening": (0-10)
  }
}

Transcript:
${JSON.stringify(transcript)}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const report = JSON.parse(completion.choices[0].message.content);
    callReports[callId] = report;
    console.log(`webhook: report stored for ${callId}`, report);
  } catch (err) {
    console.error(`webhook: scoring failed for ${callId}`, err.message);
  }
});

// Get report for a call — fetches transcript from Retell, scores with OpenAI
app.get("/report/:callId", async (req, res) => {
  const callId = req.params.callId;

  // Return cached report if already scored
  if (callReports[callId]) return res.json(callReports[callId]);

  try {
    // Wait for Retell to finish saving the call data
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const retellRes = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
      headers: { Authorization: `Bearer ${process.env.RETELL_API_KEY}` },
    });

    if (!retellRes.ok) {
      const err = await retellRes.text();
      console.error(`report: Retell fetch failed for ${callId}`, err);
      return res.status(502).json({ error: "Failed to fetch call from Retell" });
    }

    const callData = await retellRes.json();
    const transcript = callData.transcript_object || callData.transcript;

    if (!transcript) {
      return res.status(404).json({ error: "No transcript available for this call" });
    }

    // Extract call metadata for the frontend
    const durationSec = callData.end_timestamp && callData.start_timestamp
      ? Math.round((callData.end_timestamp - callData.start_timestamp) / 1000)
      : null;
    const prospectName = callData.metadata?.prospectType || "Prospect";

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [
        {
          role: "user",
          content: `You are a brutally honest cold call coach. Analyze this sales call transcript and score it fairly. Be strict — a score of 8+ should only go to genuinely excellent calls. Most average calls should score 4-6. Poor calls should score 1-3.

Scoring criteria:
- Opening (0-10): Did the caller introduce themselves clearly, establish credibility, and give a compelling reason for calling within the first 30 seconds? No intro = 0-2. Weak intro = 3-4. Decent = 5-6. Strong = 7-8. Exceptional = 9-10.
- Objection Handling (0-10): Did the caller address the prospect's concerns directly and confidently? Ignored objections = 0-2. Poor handling = 3-4. Decent = 5-6. Good = 7-8. Excellent = 9-10.
- Tone & Pace (0-10): Was the caller confident, natural, and easy to listen to? Nervous/rushed/monotone = 0-3. Okay = 4-6. Good = 7-8. Excellent = 9-10.
- Closing (0-10): Did the caller attempt to secure a next step (meeting, follow-up, demo)? No attempt = 0-2. Weak attempt = 3-4. Decent = 5-6. Strong = 7-8. Perfect = 9-10.
- Active Listening (0-10): Did the caller respond to what the prospect actually said or just follow a script? Ignored prospect = 0-2. Minimal = 3-4. Some = 5-6. Good = 7-8. Excellent = 9-10.

If the transcript is blank, silent, or contains no meaningful sales conversation, return all scores as 0 and verdict as "No pitch detected."

Return only valid JSON with these exact fields:
{
  "overall": (average of the 5 skill scores, one decimal),
  "verdict": (one sentence summary of the call),
  "talkRatio": (estimated percentage the caller was talking e.g. "62%"),
  "objectionCount": (number of objections raised by prospect),
  "highlights": [
    { "type": "positive", "text": "one line about what went well" },
    { "type": "negative", "text": "one line about what went wrong" },
    { "type": "negative", "text": "one line about another weakness" },
    { "type": "positive", "text": "one line about another strength" }
  ],
  "skills": {
    "opening": (0-10),
    "objectionHandling": (0-10),
    "toneAndPace": (0-10),
    "closing": (0-10),
    "activeListening": (0-10)
  }
}

Transcript:
${JSON.stringify(transcript)}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const report = JSON.parse(completion.choices[0].message.content);
    report.meta = { durationSec, prospectName };
    callReports[callId] = report;
    console.log(`report: scored call ${callId}`, report);
    res.json(report);
  } catch (err) {
    console.error(`report: failed for ${callId}`, err.message);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

// Stripe config — frontend needs the publishable key
app.get("/stripe-config", (_req, res) => {
  res.json({ publishableKey: stripePublishableKey });
});

// Create Stripe Checkout Session
app.post("/create-checkout", async (req, res) => {
  const { callId, email } = req.body;
  if (!callId) return res.status(400).json({ error: "Missing callId" });

  try {
    const origin = `${req.protocol}://${req.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "ColdTalk Full Debrief" },
            unit_amount: 149, // $1.49
          },
          quantity: 1,
        },
      ],
      customer_email: email || undefined,
      metadata: { callId },
      success_url: `${origin}/?paid=true&call_id=${callId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?paid=false&call_id=${callId}`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("create-checkout error:", err.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// Verify payment completed
app.get("/verify-payment/:callId", async (req, res) => {
  const { callId } = req.params;
  const { session_id } = req.query;

  if (paidCalls.has(callId)) return res.json({ paid: true });

  if (!session_id) return res.json({ paid: false });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status === "paid" && session.metadata.callId === callId) {
      paidCalls.add(callId);
      return res.json({ paid: true });
    }
    res.json({ paid: false });
  } catch (err) {
    console.error("verify-payment error:", err.message);
    res.status(500).json({ error: "Failed to verify payment" });
  }
});

// Health check
app.get("/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Cold call bot server running on port ${PORT}`);
  console.log("PORT env:", process.env.PORT);
});
