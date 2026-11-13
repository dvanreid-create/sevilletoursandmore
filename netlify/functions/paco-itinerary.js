// netlify/functions/paco-itinerary.js — Gemini-built Málaga itinerary for "Plan my perfect day".
// Emitted verbatim as paco-itinerary.js by build_tours.py. Needs GEMINI_API_KEY (reuses GOOGLE_PLACES_KEY
// for a place's Maps link).
//
// Takes the quiz answers + the bookable MT&M catalogue and uses Gemini 3.6 Flash with Google Maps +
// Google Search grounding to build a REAL, geo-sequenced, hours-aware day-by-day plan that PRIORITISES
// the catalogue tours (so the booking/commission logic is preserved) and fills the gaps with real local
// places (a lunch, a viewpoint, a plaza). Maps grounding is English-only, so it grounds/plans in English
// then translates the human-readable text. Returns JSON the client renders; the client falls back to its
// own deterministic builder on ANY error, so the page can never break. (DLR 2026-09-12 — Gemini rebuild)

const MODEL = "gemini-3.6-flash";
const GC = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent";
const MALAGA = { lat: 36.7213, lng: -4.4213 };
const LANGN = { en:"English", es:"Spanish", de:"German", fr:"French", sv:"Swedish", no:"Norwegian", da:"Danish", fi:"Finnish" };

exports.handler = async (event) => {
  const H = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "{}" };

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  const P = body.quiz || {};
  const lang = (body.lang || "en").toString().slice(0, 5);
  const cat = Array.isArray(body.catalogue) ? body.catalogue.slice(0, 60) : [];
  const debug = !!body.debug;
  const key = process.env.GEMINI_API_KEY;
  if (!key) return ok(H, { ok: false, reason: "no-key" });

  // Single-day mode: the client fires one call PER DAY in parallel so no serverless call exceeds its
  // ~26s limit (a grounded 5-day plan in one call times out at 504). (DLR 2026-09-12)
  const dayTotal = Math.max(1, Math.min(10, parseInt(body.dayTotal, 10) || parseInt(P.days, 10) || 1));
  const dayIndex = (body.dayIndex != null && body.dayIndex !== "") ? Math.max(0, Math.min(dayTotal - 1, parseInt(body.dayIndex, 10))) : null;
  const singleDay = dayIndex !== null;
  const days = singleDay ? 1 : Math.max(1, Math.min(4, parseInt(P.days, 10) || 1));
  const list = cat.map((c, i) => i + ". " + c.n + " — " + (c.area || "") + (c.price ? " (from €" + Math.round(c.price) + ")" : "") + (c.cat ? " [" + c.cat + "]" : "")).join("\n");

  // Accessibility: honour a mobility note as a HARD constraint (not just an acknowledgement).
  const notes = String(P.notes || "");
  const mobility = /wheelchair|wheel chair|silla de ruedas|movilidad reducida|mobilit|step[- ]?free|accessible|walker|scooter|cannot walk|can'?t walk|limited mobility/i.test(notes);
  // Distinct day-trip area PER day index, so the parallel single-day calls can't all pick the same
  // place (the 5-day test returned Ronda for days 1,2 AND 3). Accessible list when mobility is flagged.
  const DAYTRIPS = mobility
    ? ["Marbella old town & the flat seafront promenade", "Nerja & the Balcón de Europa seafront", "Fuengirola's seafront promenade & Sohail castle grounds", "Benalmádena's Puerto Marina", "Málaga city museums, the port & Muelle Uno"]
    : ["Ronda & Setenil de las Bodegas", "Nerja & Frigiliana", "Caminito del Rey & Antequera", "Marbella & Puerto Banús", "Mijas Pueblo & the coast", "Córdoba's old town"];
  const midArea = DAYTRIPS[Math.max(0, dayIndex - 1) % DAYTRIPS.length];

  // The "anything we should plan around" field is free text — it could be ANYTHING valid. Rather than
  // hard-coding categories, hand the note to Gemini as a HARD, top-priority constraint and let it reason
  // about what the note implies for every stop and alternative. The mobility list above is just a helpful
  // prior; this clause is what makes any valid entry (diet, allergies, kids, heights, no alcohol, faith,
  // budget, pace, a companion's needs…) actually shape the plan. (DLR 2026-09-12)
  const noteClause = notes
    ? ("TOP PRIORITY — the visitor wrote this under 'anything we should plan around': \"" + notes.slice(0, 300) + "\". "
       + "Treat it as a HARD requirement that shapes EVERY stop AND every alternative. Work out what it implies "
       + "(e.g. accessibility or mobility, dietary needs or allergies, travelling with young children / elderly / a pet, "
       + "fear of heights, seasickness, avoiding alcohol, religious observance, budget or a gentler pace) and choose "
       + "places, day-trips and food stops that genuinely satisfy it. NEVER suggest anything that conflicts with it; "
       + "if it means certain places or activities should be avoided, avoid them — and override the suggested day-trip "
       + "area if that area does not suit the note.\n"
       + (mobility ? "Here that means step-free, wheelchair-accessible stops only — flat promenades, museums and venues "
                   + "with lifts or ramps, level plazas; never gorges, caves, steep old towns, unpaved trails or Caminito del Rey.\n" : ""))
    : "";

  const prompt =
    "You are Paqui & Paco, warm local hosts on the Málaga / Costa del Sol coast. " +
    (singleDay
      ? ("Plan ONLY day " + (dayIndex + 1) + " of this visitor's " + dayTotal + "-day trip — return EXACTLY ONE day. "
         + (dayIndex === 0 ? ("Day 1 eases them in with the best of " + (P.base || "Málaga city") + ", close to where they're based. ")
            : (dayIndex === dayTotal - 1 ? "This is the FINAL day — keep it relaxed and lighter (a beach, a long lunch, an easy wander). "
               : ("This is a MIDDLE day — plan it as a day-trip focused on " + midArea + " (unless that area conflicts with the visitor's note below — then pick a DIFFERENT, still-distinct area that suits them). Do NOT re-plan " + (P.base || "Málaga city") + ", and do NOT use any of the OTHER day-trip areas, so every day of the trip is DISTINCT. "))))
      : ("Build a realistic " + days + "-day plan for this visitor. ")) +
    "Think in ENGLISH (we translate afterwards).\n" +
    noteClause +
    "Visitor: name " + (P.name || "—") + "; party " + (P.party || "—") + "; pace " + (P.pace || "balanced") + "; based in " + (P.base || "Málaga city") + "; getting around by " + (P.transport || "—") + ".\n" +
    "Interests: " + ((P.interests || []).join(", ") || "—") + ". Occasions: " + ((P.occasions || []).join(", ") || "—") + ". Moods: " + ((P.moods || []).join(", ") || "—") + ".\n" +
    "\nUSE GOOGLE MAPS + SEARCH GROUNDING for every real place: correct town, opening hours/days, and sensible travel order so a day never zig-zags across the coast. Respect opening times and a realistic pace (" + (P.pace === "relaxed" ? "2" : "3") + " stops/day).\n" +
    "\nPRIORITISE these bookable tours where they genuinely fit the interests — reference them by their index number:\n" + (list || "(none)") + "\n" +
    "\nFor each day give 2–3 ordered stops. A stop is EITHER one of the bookable tours (set \"tour\" to its index) OR a real local place you found via grounding (set \"tour\" to null and give its real name + area). Sequence stops by real geography and opening hours.\n" +
    "For EACH stop also give 1–2 ALTERNATIVES the visitor could swap in — a different bookable tour (by index) or a different real nearby place of the same kind — in an \"alts\" array.\n" +
    "\nReturn ONLY a valid JSON object, no prose, in exactly this shape:\n" +
    "Include approximate map coordinates (\"lat\",\"lng\" as numbers) for each stop.\n" +
    "{\"intro\":\"one warm sentence to the visitor\",\"days\":[{\"title\":\"short day title\",\"area\":\"main area that day\",\"stops\":[{\"tour\":<index or null>,\"name\":\"place name\",\"area\":\"town/area\",\"when\":\"Morning|Afternoon|Evening\",\"why\":\"one warm sentence\",\"lat\":<number>,\"lng\":<number>,\"alts\":[{\"tour\":<index or null>,\"name\":\"place name\",\"area\":\"town/area\",\"why\":\"short reason\"}]}]}]}";

  let planText = "";
  try {
    const r = await gc(key, { contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_maps: {} }] });
    planText = extractText(r);
    if (debug) return ok(H, { debug: true, planText: planText.slice(0, 1500), raw: JSON.stringify(r).slice(0, 1800) });
  } catch (e) {
    return ok(H, { ok: false, reason: "gemini-error", error: String(e && e.message || e) });
  }

  let plan = parseJson(planText);
  if (!plan || !Array.isArray(plan.days) || !plan.days.length) return ok(H, { ok: false, reason: "no-plan" });

  // Translate the human-readable strings into the visitor's language (English stays as-is).
  if (lang !== "en") {
    try {
      const tr = await gc(key, { contents: [{ parts: [{ text:
        "Translate the string VALUES of the \"intro\", \"title\", \"area\" and \"why\" fields (wherever they appear, including inside \"stops\" and \"alts\") in this JSON into natural, warm " + (LANGN[lang] || "English") +
        ". Keep proper place names, numbers and the JSON structure/keys EXACTLY. Keep any \"name\" values unchanged. Output ONLY the JSON:\n\n" + JSON.stringify(plan) }] }] });
      const t = parseJson(extractText(tr));
      if (t && Array.isArray(t.days) && t.days.length) plan = t;
    } catch (e) { /* keep the English plan */ }
  }

  // Attach the bookable tour, a real Maps link, and precise map coordinates for each stop + alternative.
  const pkey = process.env.GOOGLE_PLACES_KEY;
  async function enrich(s, isMain) {
    const ti = (s.tour === 0 || s.tour) ? parseInt(s.tour, 10) : null;
    if (ti !== null && ti >= 0 && ti < cat.length) { s.tourObj = cat[ti]; s.name = s.name || cat[ti].n; }
    else { s.tour = null; }
    if (pkey && s.name) {
      try {
        const inf = await placeInfo(pkey, s.name + ", " + (s.area || "Málaga") + ", Spain");
        if (inf.maps && !s.tourObj) s.maps = inf.maps;      // "View on map" link only for real places
        if (typeof inf.lat === "number" && typeof inf.lng === "number") { s.lat = inf.lat; s.lng = inf.lng; }
        if (typeof inf.rating === "number") s.rating = inf.rating;
        if (typeof inf.reviews === "number") s.reviews = inf.reviews;
        if (inf.priceLevel) s.priceLevel = inf.priceLevel;
        if (inf.editorial) s.editorial = inf.editorial;
        if (inf.hours) s.hours = inf.hours;                 // weekday opening-hours lines (real Google data)
        if (inf.access) s.access = inf.access;              // {wheelchairAccessibleEntrance:true,...}
        // Real photo only for MAIN real-place stops (a tour keeps its own image; alts show no photo) —
        // this is the one enrichment that costs an extra billed call, so keep it to the stops that show one.
        if (isMain && !s.tourObj && inf.photoName) { const pu = await placePhoto(pkey, inf.photoName); if (pu) s.photo = pu; }
      } catch (e) {}
    }
  }
  const items = [];
  for (const d of plan.days) {
    if (!Array.isArray(d.stops)) { d.stops = []; continue; }
    for (const s of d.stops) {
      items.push({ s: s, main: true });
      s.alts = Array.isArray(s.alts) ? s.alts.slice(0, 2) : [];
      for (const a of s.alts) items.push({ s: a, main: false });
    }
  }
  await Promise.all(items.map(function (it) { return enrich(it.s, it.main); }));   // parallel so ~15 lookups don't slow the plan

  return ok(H, { ok: true, intro: plan.intro || "", days: plan.days });
};

// ---- helpers -------------------------------------------------------------------------------------
async function gc(key, payload) {
  const r = await fetch(GC, { method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(payload) });
  return await r.json();
}
async function placeInfo(pkey, q) {
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": pkey,
               "X-Goog-FieldMask": "places.googleMapsUri,places.location,places.rating,places.userRatingCount,places.priceLevel,places.regularOpeningHours,places.editorialSummary,places.accessibilityOptions,places.photos" },
    body: JSON.stringify({ textQuery: q, maxResultCount: 1, regionCode: "ES", languageCode: "en" }) });
  const j = await r.json();
  const p0 = (j.places || [])[0];
  if (!p0) return {};
  return { maps: p0.googleMapsUri || "",
           lat: p0.location && p0.location.latitude,
           lng: p0.location && p0.location.longitude,
           rating: p0.rating,
           reviews: p0.userRatingCount,
           priceLevel: p0.priceLevel || "",
           hours: (p0.regularOpeningHours && p0.regularOpeningHours.weekdayDescriptions) || null,
           editorial: (p0.editorialSummary && p0.editorialSummary.text) || "",
           access: p0.accessibilityOptions || null,
           photoName: (p0.photos && p0.photos[0] && p0.photos[0].name) || "" };
}
// Place Photos (New): resolve a photo resource name to a KEYLESS image URL (skipHttpRedirect returns the
// googleusercontent photoUri as JSON), so the key never reaches the browser. One extra billed call per stop.
async function placePhoto(pkey, name) {
  try {
    const r = await fetch("https://places.googleapis.com/v1/" + name + "/media?maxWidthPx=800&skipHttpRedirect=true",
      { headers: { "X-Goog-Api-Key": pkey } });
    const j = await r.json();
    return j.photoUri || "";
  } catch (e) { return ""; }
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
