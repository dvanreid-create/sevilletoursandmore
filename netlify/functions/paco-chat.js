// netlify/functions/paco-chat.js — "Ask Paqui & Paco" live chat, powered by Gemini 3.6 Flash with
// Grounding with Google Maps + Google Search. Emitted verbatim as paco-chat.js by build_tours.py.
//
// Needs GEMINI_API_KEY in the Netlify environment (and reuses GOOGLE_PLACES_KEY for a venue's
// website / Maps / reviews links). Without GEMINI_API_KEY it returns a friendly "being switched on"
// message so the UI never breaks.
//
// Maps grounding is English-only, so we ground / reason in ENGLISH (accurate places, hours, travel)
// and then translate the final reply into the traveller's language; place names + links stay
// universal. Returns the SAME shape the existing UI renders: {reply, place, website, maps, reviews,
// picks}. (DLR 2026-09-12 — Gemini rebuild of the former Claude-Haiku function.)

const MODEL = "gemini-3.6-flash";
const GEN = "https://generativelanguage.googleapis.com/v1beta/interactions";
const PLACES = "https://places.googleapis.com/v1";
const MALAGA = { lat: 36.7213, lng: -4.4213 };
const LANGN = { en:"English", es:"Spanish", de:"German", fr:"French", sv:"Swedish", no:"Norwegian", da:"Danish", fi:"Finnish" };

exports.handler = async (event) => {
  const H = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "{}" };

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  const q = (body.q || "").toString().slice(0, 500).trim();
  const lang = (body.lang || "en").toString().slice(0, 5);
  const cands = Array.isArray(body.candidates) ? body.candidates.slice(0, 24) : [];
  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
  const debug = !!body.debug;
  const key = process.env.GEMINI_API_KEY;

  if (!q && !debug) return ok(H, { reply: "¡Hola! Ask us anything about Málaga — what are you in the mood for?", picks: [] });
  if (!key) return ok(H, { reply: "¡Hola! Our live chat is just being switched on — meanwhile tap ‘Plan my trip’ above and we’ll build you a full Málaga itinerary in seconds!", picks: [] });

  // DIAGNOSTIC (temporary): probe every endpoint/tool with the real key so we know FACTUALLY what the
  // project can and cannot do, instead of guessing. Trigger with {diag:true}. (DLR 2026-09-12)
  if (body.diag) {
    const M = String(body.model || "gemini-3.6-flash");
    const probe = async (url, payload, method) => {
      try {
        const r = await fetch(url, { method: method || "POST",
          headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
          body: payload ? JSON.stringify(payload) : undefined });
        return { status: r.status, ok: r.ok, body: (await r.text()).slice(0, 400) };
      } catch (e) { return { error: String(e && e.message || e) }; }
    };
    const GC = "https://generativelanguage.googleapis.com/v1beta/models/" + M + ":generateContent";
    const out = { keyLen: key.length, model: M };
    out.listModels   = await probe("https://generativelanguage.googleapis.com/v1beta/models", null, "GET");
    out.genBasic     = await probe(GC, { contents: [{ parts: [{ text: "Say hi in three words." }] }] });
    out.genSearch    = await probe(GC, { contents: [{ parts: [{ text: "What is on in Malaga this week?" }] }], tools: [{ google_search: {} }] });
    out.genMaps      = await probe(GC, { contents: [{ parts: [{ text: "Best paella near Malagueta beach, Malaga?" }] }], tools: [{ google_maps: {} }] });
    out.interactions = await probe("https://generativelanguage.googleapis.com/v1beta/interactions", { model: M, input: "Say hi", tools: [{ type: "google_search" }] });
    return ok(H, { diag: true, probes: out });
  }

  const list = cands.map((c, i) => i + ". " + c.n + " — " + (c.area || "") + (c.price ? " — from €" + Math.round(c.price) : "") + (c.cat ? " (" + c.cat + ")" : "")).join("\n");
  const hist = history.map(h => (h.who === "paco" ? "Paqui & Paco" : "Traveller") + ": " + String(h.text || "").slice(0, 280)).join("\n");

  const prompt =
    "You are Paqui & Paco, a warm married couple who have lived on the Málaga / Costa del Sol coast your whole lives and are the local hosts on malagatoursandmore.com. You answer together as \"we\".\n" +
    "Write a warm, natural answer in ENGLISH (it is translated afterwards for the traveller): 2 to 4 short, genuinely useful sentences. No padding, no upselling, and do NOT end by asking whether they'd like other places.\n" +
    "Use Google Maps and Google Search grounding for anything factual — a specific place, exactly where it is, opening hours, whether it's open, prices, current events. Never guess; base facts on what you actually find, and check which town a place is in.\n" +
    "If the answer centres on ONE specific venue (restaurant, bar, beach, museum, spa, shop, hotel…), decide the single best one.\n" +
    (hist ? ("\nRecent conversation so far:\n" + hist + "\n") : "") +
    "\nBookable CANDIDATE tours (from our own catalogue):\n" + (list || "(none)") + "\n" +
    "\nTraveller question: \"" + (q || "What should we do in Málaga today?") + "\"\n" +
    "\nAfter your answer, output these two lines EXACTLY and nothing after them:\n" +
    "PLACE: <the single best specific venue's exact name, or NONE>\n" +
    "PICKS: <comma-separated indices of CANDIDATE tours above that directly answer the question, e.g. 0,3 — or leave blank>";

  // 1) Grounded English answer (Maps + Search)
  let respObj = null, raw = "";
  try {
    respObj = await genFetch(key, { model: MODEL, input: prompt,
      tools: [{ type: "google_maps", latitude: MALAGA.lat, longitude: MALAGA.lng }, { type: "google_search" }] });
    raw = extractText(respObj);
  } catch (e) {
    if (debug) return ok(H, { debug: true, stage: "gemini-fetch", error: String(e && e.message || e) });
    return ok(H, { reply: "Sorry, our line dropped for a second — please try again.", place: "", picks: [] });
  }
  if (debug) return ok(H, { debug: true, extracted: raw, gemini: respObj });
  if (!raw) return ok(H, { reply: "Sorry, could you ask that again?", place: "", picks: [] });

  // 2) Parse PLACE + PICKS, strip them from the reply text
  let placeName = "";
  const pl = raw.match(/PLACE:\s*(.+)/i);
  if (pl) { placeName = pl[1].trim(); if (/^none$/i.test(placeName)) placeName = ""; }
  let picks = [];
  const pk = raw.match(/PICKS:\s*([0-9,\s]*)/i);
  if (pk) picks = pk[1].split(",").map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n >= 0 && n < cands.length).slice(0, 3);
  let english = raw.replace(/^\s*PLACE:.*$/im, "").replace(/^\s*PICKS:.*$/im, "").trim();
  english = stripJunk(english);
  if (!english) english = "Sorry, could you ask that again?";

  // 3) Enrich the venue with an authoritative website / Maps / reviews link via Google Places (New)
  let place = placeName.slice(0, 80), website = "", maps = "", reviews = "";
  const pkey = process.env.GOOGLE_PLACES_KEY;
  if (placeName && pkey) {
    try {
      const sr = await fetch(PLACES + "/places:searchText", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": pkey,
                   "X-Goog-FieldMask": "places.displayName,places.websiteUri,places.googleMapsUri" },
        body: JSON.stringify({ textQuery: placeName + ", Málaga, Spain", maxResultCount: 1, regionCode: "ES", languageCode: "en" })
      });
      const sj = await sr.json();
      const p0 = (sj.places || [])[0];
      if (p0) {
        if (p0.displayName && p0.displayName.text) place = p0.displayName.text.slice(0, 80);
        website = p0.websiteUri || "";
        maps = p0.googleMapsUri || "";
        reviews = p0.googleMapsUri || "";   // the Google Maps listing is where reviews live
      }
    } catch (e) { /* links are optional — never fail the reply over them */ }
  }

  // 4) Translate the reply into the traveller's language (English is returned as-is)
  let reply = english;
  if (lang !== "en") {
    try {
      const tr = await genFetch(key, { model: MODEL,
        input: "Translate the following into natural, warm " + (LANGN[lang] || "English") + ". Keep proper names (Málaga, venue names), numbers and prices EXACTLY. Output ONLY the translation, no preamble:\n\n" + english });
      const t = stripJunk(extractText(tr)).trim();
      if (t) reply = t;
    } catch (e) { /* fall back to the English reply */ }
  }
  reply = stripJunk(reply);

  return ok(H, { reply, place, website: cleanUrl(website), maps: cleanUrl(maps), reviews: cleanUrl(reviews), picks });
};

// ---- helpers -------------------------------------------------------------------------------------
async function genFetch(key, payload) {
  const r = await fetch(GEN, { method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(payload) });
  return await r.json();
}

// Pull the model's answer text out of the Interactions response, whatever the exact nesting.
function extractText(resp) {
  if (!resp || typeof resp !== "object") return "";
  if (typeof resp.output_text === "string" && resp.output_text.trim()) return resp.output_text;
  if (typeof resp.outputText === "string" && resp.outputText.trim()) return resp.outputText;
  if (typeof resp.text === "string" && resp.text.trim()) return resp.text;
  const out = [];
  (function rec(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(rec); return; }
    if ((o.type === "text" || o.type === "output_text") && typeof o.text === "string") out.push(o.text);
    for (const k in o) { const v = o[k]; if (v && typeof v === "object") rec(v); }
  })(resp);
  return out.join("\n").trim();
}

function stripJunk(s) {
  s = String(s || "");
  s = s.replace(/<\/?cite[^>]*>/gi, "").replace(/<[^>]+>/g, "");   // citation + stray HTML tags
  s = s.replace(/\s*\[\d+(?:[-,]\d+)*\]/g, "");                     // footnote markers [1] [1-2]
  s = s.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function cleanUrl(u) {
  u = String(u || "").trim();
  if (!/^https?:\/\//i.test(u)) return "";
  if (/google\.[^/]+\/search|\/search\?q=|bing\.com|duckduckgo/i.test(u)) return "";
  return u.slice(0, 300);
}

function ok(H, obj) { return { statusCode: 200, headers: H, body: JSON.stringify(obj) }; }
