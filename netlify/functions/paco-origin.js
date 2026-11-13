// netlify/functions/paco-origin.js — accurate, warm "where are you coming from?" acknowledgement.
// Emitted verbatim as paco-origin.js by build_tours.py. Needs GEMINI_API_KEY.
//
// The client shows an instant, offline greeting (nickname map + a small near-list) the moment the
// visitor types. Once they finish, the client calls THIS function so the line is accurate for ANY
// place on earth — Gemini judges the real distance/relationship to the Costa del Sol coast and writes
// one warm sentence in the visitor's language. A short hop (Spain/Iberia/nearby Europe) is never
// greeted with "all the way from"; a far origin is. HARD RULE: in English, NEVER write "the" before
// "Costa del Sol". (DLR 2026-09-12)

const MODEL = "gemini-3.6-flash";
const GC = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent";
const LANGN = { en:"English", es:"Spanish", de:"German", fr:"French", sv:"Swedish", no:"Norwegian", da:"Danish", fi:"Finnish" };

exports.handler = async (event) => {
  const H = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "{}" };

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  const origin = String(body.origin || "").trim().slice(0, 120);
  const lang = String(body.lang || "en").slice(0, 5);
  const key = process.env.GEMINI_API_KEY;
  if (!key) return ok(H, { ok: false, reason: "no-key" });
  if (!origin) return ok(H, { ok: true, line: "" });

  const langName = LANGN[lang] || "English";
  const prompt =
    "A visitor to the Costa del Sol (Málaga, southern Spain) just told us where they're travelling FROM: \"" + origin + "\".\n" +
    "Write ONE short, warm, welcoming sentence (max ~18 words) acknowledging where they're coming from, as a friendly local host (Paqui & Paco) would.\n" +
    "Be GEOGRAPHICALLY ACCURATE about the distance to the Costa del Sol:\n" +
    "- If it's within Spain, Portugal, Gibraltar or nearby (a short flight / drive), treat it as a short hop — do NOT say 'all the way from' or imply a long journey.\n" +
    "- If it's far (other continents, or the far side of Europe), a warm 'all the way from …' is fine.\n" +
    "- If somewhere is genuinely close to Málaga (e.g. within Andalusia), you may say so warmly.\n" +
    "Mention the place by the name they used (tidy the spelling/capitalisation). You may add ONE well-known, verifiable nickname or tag ONLY if you are certain of it; never invent one.\n" +
    "Write the sentence in " + langName + ".\n" +
    (lang === "en" ? "CRITICAL: in English never write the word 'the' before 'Costa del Sol' — write 'Costa del Sol', not 'the Costa del Sol'.\n" : "") +
    "If \"" + origin + "\" is not a recognisable real place (gibberish/empty), return an empty line.\n" +
    "Return ONLY a JSON object: {\"line\":\"…\"} (empty string if not a real place). No other text.";

  let text = "";
  try {
    const r = await gc(key, { contents: [{ parts: [{ text: prompt }] }] });
    text = extractText(r);
  } catch (e) {
    return ok(H, { ok: false, reason: "gemini-error", error: String(e && e.message || e) });
  }

  const j = parseJson(text);
  let line = j && typeof j.line === "string" ? j.line.trim() : "";
  // Belt-and-braces: strip a stray leading "the " before Costa del Sol in English.
  if (lang === "en") line = line.replace(/\bthe\s+(Costa del Sol)/gi, "$1");
  return ok(H, { ok: true, line: line });
};

// ---- helpers -------------------------------------------------------------------------------------
async function gc(key, payload) {
  const r = await fetch(GC, { method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(payload) });
  return await r.json();
}
function extractText(resp) {
  if (!resp || typeof resp !== "object") return "";
  const out = [];
  (function rec(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(rec); return; }
    if (typeof o.text === "string" && !o.functionCall) out.push(o.text);
    for (const k in o) { const v = o[k]; if (v && typeof v === "object") rec(v); }
  })(resp);
  return out.join("").trim();
}
function parseJson(s) {
  s = String(s || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}
function ok(H, obj) { return { statusCode: 200, headers: H, body: JSON.stringify(obj) }; }
