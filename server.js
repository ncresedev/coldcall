const express = require("express");
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const callReports = {};

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
      model: "gpt-4o",
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

// Get report for a call
app.get("/report/:callId", (req, res) => {
  const report = callReports[req.params.callId];
  if (!report) return res.status(404).json({ error: "Report not ready" });
  res.json(report);
});

// Health check
app.get("/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Cold call bot server running on port ${PORT}`);
  console.log("PORT env:", process.env.PORT);
});
