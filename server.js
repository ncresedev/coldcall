require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DIFFICULTY_INSTRUCTIONS = {
  easy: "You are open-minded and willing to listen. You are polite and give the caller a fair chance to explain themselves.",
  medium: "You are skeptical and busy. You push back on claims, ask pointed questions, and hint that you don't have much time.",
  hard: "You are dismissive and want to hang up. You interrupt, express annoyance, and frequently try to end the call.",
};

function buildSystemPrompt({ product, prospectType, difficulty }) {
  const difficultyGuide =
    DIFFICULTY_INSTRUCTIONS[difficulty] || DIFFICULTY_INSTRUCTIONS.medium;

  return `You are roleplaying as a prospect receiving a cold call. Stay in character at all times.

PROSPECT TYPE: ${prospectType}
PRODUCT BEING SOLD: ${product}
PERSONALITY: ${difficultyGuide}

RULES:
- You answer the phone first with a short greeting (e.g. "Hello?", "Yeah?", "This is [name].")
- Keep every response to 1-3 sentences maximum — this is a phone call, not an essay.
- React naturally to what the caller says. If they pitch well, warm up slightly. If they stumble, get more impatient.
- Raise realistic objections relevant to your prospect type and the product.
- Never break character or acknowledge you are an AI.
- Do not end the call unless the difficulty is hard and the caller is doing poorly.`;
}

async function getProspectResponse(messages, systemPrompt) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    max_tokens: 120,
    temperature: 0.8,
  });
  return completion.choices[0].message.content.trim();
}

async function scoreTranscript(transcript, { product, prospectType, difficulty }) {
  const prompt = `You are a cold call coach. Score this sales call transcript across 4 dimensions.

Context:
- Product: ${product}
- Prospect type: ${prospectType}
- Difficulty: ${difficulty}

Transcript:
${transcript}

Score each dimension out of 10. For each, provide:
- score (number)
- grade (A, B, C, or D)
- comment (one sentence)

Dimensions to score:
1. Opening — did the caller establish rapport and a clear reason for calling?
2. Objection Handling — did the caller address pushback effectively?
3. Closing Attempt — did the caller attempt to move toward a next step?
4. Overall Tone — was the caller confident, natural, and professional?

Respond in this exact JSON format:
{
  "opening":            { "score": 0, "grade": "X", "comment": "..." },
  "objectionHandling":  { "score": 0, "grade": "X", "comment": "..." },
  "closingAttempt":     { "score": 0, "grade": "X", "comment": "..." },
  "overallTone":        { "score": 0, "grade": "X", "comment": "..." }
}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 400,
    temperature: 0.3,
  });

  const raw = completion.choices[0].message.content.trim();
  return JSON.parse(raw);
}

// Active call sessions keyed by call_id
const sessions = {};

wss.on("connection", (ws) => {
  let callId = null;

  ws.on("message", async (data) => {
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }

    const type = event.event || event.interaction_type;

    // call_started / call_details
    if (type === "call_started" || type === "call_details") {
      const metadata = event.metadata || {};
      callId = event.call_id;

      sessions[callId] = {
        systemPrompt: buildSystemPrompt({
          product: metadata.product || "our product",
          prospectType: metadata.prospectType || "business owner",
          difficulty: metadata.difficulty || "medium",
        }),
        messages: [],
        transcriptLines: [],
        metadata,
      };

      // Prospect picks up the phone first
      const opening = await getProspectResponse([], sessions[callId].systemPrompt);
      sessions[callId].messages.push({ role: "assistant", content: opening });
      sessions[callId].transcriptLines.push(`Prospect: ${opening}`);

      ws.send(JSON.stringify({ event: "agent_response", agent_response: opening }));
      return;
    }

    // Caller (salesperson) spoke
    if (type === "transcript" || type === "speech_ended") {
      const session = sessions[callId];
      if (!session) return;

      const callerText =
        event.transcript || event.transcript_with_tool_calls || event.text || "";
      if (!callerText) return;

      session.messages.push({ role: "user", content: callerText });
      session.transcriptLines.push(`Caller: ${callerText}`);

      const response = await getProspectResponse(
        session.messages,
        session.systemPrompt
      );

      session.messages.push({ role: "assistant", content: response });
      session.transcriptLines.push(`Prospect: ${response}`);

      ws.send(JSON.stringify({ event: "agent_response", agent_response: response }));
      return;
    }

    // Call ended — score the transcript
    if (type === "call_ended") {
      const session = sessions[callId];
      if (!session) return;

      const fullTranscript = session.transcriptLines.join("\n");

      try {
        const scores = await scoreTranscript(fullTranscript, session.metadata);
        console.log(`\n=== CALL SCORED [${callId}] ===`);
        console.log(JSON.stringify(scores, null, 2));
        ws.send(JSON.stringify({ event: "call_scores", call_id: callId, scores }));
      } catch (err) {
        console.error("Scoring error:", err.message);
      }

      delete sessions[callId];
    }
  });

  ws.on("close", () => {
    if (callId && sessions[callId]) {
      delete sessions[callId];
    }
  });
});

// Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

server.listen(3000, () => {
  console.log("Cold call bot server running on port 3000");
});
