require("dotenv").config();
const path = require("path");
const express = require("express");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

// Surface module-load crashes in serverless logs instead of dying silently.
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err && err.stack ? err.stack : err);
});

if (!process.env.OPENAI_API_KEY) {
  console.error("⚠ OPENAI_API_KEY is not set — OpenAI calls will fail at runtime");
}
// Pass a placeholder when the key is missing so the constructor doesn't throw at module load.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "missing-key" });

// Supabase — use the service_role key (long JWT starting with eyJ...), NOT the anon/publishable key
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error("⚠ Supabase env vars missing: set SUPABASE_URL and SUPABASE_SERVICE_KEY");
}
const supabase = createClient(
  process.env.SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_KEY || "placeholder"
);

// Verify Supabase connection on startup (non-fatal — never throw at module load on serverless)
(async () => {
  try {
    const { error } = await supabase.from("sessions").select("id").limit(1);
    if (error) {
      console.error("⚠ Supabase connection FAILED:", error.message);
      console.error("  Check SUPABASE_URL and SUPABASE_SERVICE_KEY env vars");
      console.error("  The service key should be a long JWT starting with 'eyJ...'");
    } else {
      console.log("✓ Supabase connected");
    }
  } catch (err) {
    console.error("⚠ Supabase startup check threw:", err.message);
  }
})();

// In-memory caches (for fast lookups during a session)
const callReports = {};
const paidCalls = new Set();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Helpers ──

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    null
  );
}

// OpenAI pricing per 1M tokens (as of 2025)
const OPENAI_PRICING = {
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4.1":     { input: 2.00, output: 8.00 },
};

function calcOpenAICost(model, usage) {
  const pricing = OPENAI_PRICING[model];
  if (!pricing || !usage) return 0;
  const inputCost = ((usage.prompt_tokens || 0) / 1_000_000) * pricing.input;
  const outputCost = ((usage.completion_tokens || 0) / 1_000_000) * pricing.output;
  return parseFloat((inputCost + outputCost).toFixed(6));
}

// Fetch Retell cost after a delay (cost is calculated async on their side)
async function fetchAndStoreRetellCost(callId) {
  try {
    const res = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
      headers: { Authorization: `Bearer ${process.env.RETELL_API_KEY}` },
    });
    if (!res.ok) return;
    const callData = await res.json();
    // Retell provides cost in different possible fields
    const cost = callData.opt_out_sensitive_data_storage
      ? 0
      : parseFloat(callData.call_cost || callData.cost || 0);
    if (cost > 0) {
      await dbUpdate(callId, { cost_retell: cost });
      console.log(`db: stored Retell cost $${cost} for ${callId}`);
    }
  } catch (err) {
    console.error(`Failed to fetch Retell cost for ${callId}:`, err.message);
  }
}

// Fire-and-forget DB writes — logs errors but doesn't block the response
async function dbUpdate(callId, data) {
  const { error } = await supabase
    .from("sessions")
    .update(data)
    .eq("call_id", callId);
  if (error) {
    console.error(`db update failed for ${callId}:`, error.message, error.details);
  }
}

// ── Scoring prompt (shared by webhook + report endpoint) ──
const SCORING_PROMPT = (transcript) => `You are a brutally honest cold call coach. Analyze this sales call transcript and score it fairly. Be strict — a score of 8+ should only go to genuinely excellent calls. Most average calls should score 4-6. Poor calls should score 1-3.

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
  "meetingBooked": (true if the prospect agreed to a meeting, follow-up, demo, or next step — false if they refused, hung up, or the call ended without commitment),
  "skills": {
    "opening": (0-10),
    "objectionHandling": (0-10),
    "toneAndPace": (0-10),
    "closing": (0-10),
    "activeListening": (0-10)
  }
}

Transcript:
${JSON.stringify(transcript)}`;

// ── Enrich prospect ──

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

  const cost = calcOpenAICost("gpt-4o-mini", completion.usage);
  const result = JSON.parse(completion.choices[0].message.content);
  return { ...result, enrichCost: cost };
}

// ── Routes ──

// Create a Retell web call and return access_token
app.post("/start-call", async (req, res) => {
  const { prospectType, difficulty, product } = req.body;
  const ip = getClientIp(req);

  try {
    const { displayName, enrichedPersona, enrichCost } = await enrichProspect(prospectType);

    const requestBody = {
      agent_id: "agent_e0700657d1382fb2ee1ac6679f",
      metadata: { product, prospectType, difficulty },
      retell_llm_dynamic_variables: { product, prospectType: enrichedPersona, difficulty },
      agent_override: { voice_id: "11labs-Brian", max_call_duration_ms: 180000 },
    };

    const response = await fetch("https://api.retellai.com/v2/create-web-call", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Retell API error:", err);
      return res.status(500).json({ error: "Failed to create call" });
    }

    const data = await response.json();

    // Insert session row into Supabase (don't await — don't block the response)
    supabase
      .from("sessions")
      .insert({
        ip_address: ip,
        product,
        prospect_type: prospectType,
        difficulty,
        display_name: displayName,
        call_id: data.call_id,
        cost_openai_enrich: enrichCost,
      })
      .then(({ error: dbErr }) => {
        if (dbErr) console.error("db insert failed:", dbErr.message, dbErr.details);
        else console.log("db: session created for", data.call_id);
      });

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
  if (!callId || !transcript) return;

  // Extract Retell metadata
  const recordingUrl = data?.recording_url || null;
  const durationSec =
    data?.end_timestamp && data?.start_timestamp
      ? Math.round((data.end_timestamp - data.start_timestamp) / 1000)
      : null;

  // Persist transcript, recording, duration immediately
  dbUpdate(callId, {
    transcript,
    recording_url: recordingUrl,
    duration_sec: durationSec,
  });

  // Retell cost isn't available immediately — fetch it after a delay
  setTimeout(() => fetchAndStoreRetellCost(callId), 15000);

  // Score with OpenAI
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [{ role: "user", content: SCORING_PROMPT(transcript) }],
      response_format: { type: "json_object" },
    });

    const reportCost = calcOpenAICost("gpt-4.1", completion.usage);
    const report = JSON.parse(completion.choices[0].message.content);
    callReports[callId] = report;

    dbUpdate(callId, {
      report,
      cost_openai_report: reportCost,
    });

    console.log(`webhook: scored ${callId}, cost=$${reportCost}`);
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

    const durationSec =
      callData.end_timestamp && callData.start_timestamp
        ? Math.round((callData.end_timestamp - callData.start_timestamp) / 1000)
        : null;
    const prospectName = callData.metadata?.prospectType || "Prospect";
    const recordingUrl = callData.recording_url || null;

    // Persist call data we fetched from Retell
    dbUpdate(callId, {
      transcript,
      recording_url: recordingUrl,
      duration_sec: durationSec,
    });

    // Retell cost may not be ready yet — fetch after delay
    setTimeout(() => fetchAndStoreRetellCost(callId), 15000);

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [{ role: "user", content: SCORING_PROMPT(transcript) }],
      response_format: { type: "json_object" },
    });

    const reportCost = calcOpenAICost("gpt-4.1", completion.usage);
    const report = JSON.parse(completion.choices[0].message.content);
    report.meta = { durationSec, prospectName };
    callReports[callId] = report;

    dbUpdate(callId, {
      report,
      cost_openai_report: reportCost,
    });

    console.log(`report: scored ${callId}, cost=$${reportCost}`);
    res.json(report);
  } catch (err) {
    console.error(`report: failed for ${callId}`, err.message);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

// Newsletter subscription — unlocks report + stores subscriber info
app.post("/subscribe", async (req, res) => {
  const { name, email, callId } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  if (callId) paidCalls.add(callId);
  console.log("New subscriber:", { name, email, callId });

  // Update the session row with subscriber info
  if (callId) {
    dbUpdate(callId, {
      subscriber_name: name || null,
      subscriber_email: email,
      subscribed_at: new Date().toISOString(),
    });
  }

  res.json({ success: true });
});

// ── Admin ──

function requireBasicAuth(req, res, next) {
  const expectedEmail = process.env.USER_EMAIL;
  const expectedPassword = process.env.USER_PASSWORD;
  if (!expectedEmail || !expectedPassword) {
    return res.status(500).send("Admin credentials not configured. Set USER_EMAIL and USER_PASSWORD in .env");
  }
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="ColdTalk Admin", charset="UTF-8"');
    return res.status(401).send("Authentication required");
  }
  let decoded;
  try {
    decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  } catch {
    res.set("WWW-Authenticate", 'Basic realm="ColdTalk Admin", charset="UTF-8"');
    return res.status(401).send("Invalid credentials");
  }
  const sep = decoded.indexOf(":");
  const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
  const pass = sep >= 0 ? decoded.slice(sep + 1) : "";
  if (user !== expectedEmail || pass !== expectedPassword) {
    res.set("WWW-Authenticate", 'Basic realm="ColdTalk Admin", charset="UTF-8"');
    return res.status(401).send("Invalid credentials");
  }
  next();
}

app.get("/admin", requireBasicAuth, (_req, res) => {
  res.sendFile("admin.html", { root: path.join(__dirname, "views") });
});

// List sessions (excludes transcript for payload size). Supports ?from=ISO&to=ISO
app.get("/admin/api/sessions", requireBasicAuth, async (req, res) => {
  const { from, to } = req.query;
  let query = supabase
    .from("sessions")
    .select(
      "id, created_at, ip_address, product, prospect_type, difficulty, call_id, display_name, recording_url, duration_sec, report, cost_openai_enrich, cost_openai_report, cost_retell, subscriber_name, subscriber_email, subscribed_at"
    )
    .order("created_at", { ascending: false })
    .limit(5000);
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);
  const { data, error } = await query;
  if (error) {
    console.error("admin sessions list failed:", error.message);
    return res.status(500).json({ error: error.message });
  }
  res.json({ sessions: data || [] });
});

// Full session detail (includes transcript) for modal view
app.get("/admin/api/sessions/:id", requireBasicAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", req.params.id)
    .single();
  if (error) {
    console.error("admin session detail failed:", error.message);
    return res.status(404).json({ error: error.message });
  }
  res.json(data);
});

// Health check
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// On Vercel, the platform imports this module and invokes the exported handler —
// don't bind a port. Locally, run a real server.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Cold call bot server running on port ${PORT}`);
  });
}

module.exports = app;
