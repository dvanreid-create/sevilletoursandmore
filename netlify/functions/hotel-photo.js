// hotel-photo.js — real property photo for a hotel via Google Places API (New).
// Request:  /.netlify/functions/hotel-photo?q=<hotel name, area, Spain>&w=<px>
// Uses the SAME server-side GOOGLE_PLACES_KEY as Malaga Dine (never exposed to the browser).
// Flow: Places Text Search resolves the property -> its first photo -> the photo bytes are proxied
// back and cached HARD at the Netlify CDN, so each hotel is fetched from Google at most ~once/month
// (keeps billing negligible). If anything is missing it returns a clean branded SVG tile, never broken.
// (DLR 2026-08-29)
const PLACES = "https://places.googleapis.com/v1";

function tileSVG() {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520" viewBox="0 0 800 520">'
    + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="#0B5E8A"/><stop offset="1" stop-color="#0f2d3c"/></linearGradient></defs>'
    + '<rect width="800" height="520" fill="url(#g)"/>'
    + '<text x="400" y="272" text-anchor="middle" font-family="Anton,Arial,sans-serif" font-size="30" '
    + 'letter-spacing="1" fill="#ffffff" opacity="0.82">SEVILLE TOURS &amp; MORE</text></svg>';
}
function tile(status) {
  // Fallback tile must NOT stick in the CDN — otherwise a transient miss (or a bad key) caches a tile
  // for a long time and hides the real photo even after it's fixed. Keep it uncached. (DLR 2026-08-29)
  return { statusCode: status || 200,
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store, max-age=0" },
    body: tileSVG() };
}

exports.handler = async (event) => {
  const key = process.env.GOOGLE_PLACES_KEY;
  const p = event.queryStringParameters || {};
  const q = (p.q || "").trim();
  const debug = !!p.debug;
  const dbg = { keyPresent: !!key, keyLen: key ? key.length : 0, q: q };
  let w = parseInt(p.w || "800", 10); if (!(w > 0)) w = 800; if (w > 1200) w = 1200;
  const jd = (o) => ({ statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(o) });
  if (!key || !q) { if (debug) return jd({ ...dbg, stop: "no key or q" }); return tile(); }
  try {
    const sr = await fetch(PLACES + "/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.displayName,places.photos"
      },
      body: JSON.stringify({ textQuery: q, maxResultCount: 1, regionCode: "ES", languageCode: "en" })
    });
    const sj = await sr.json();
    dbg.searchStatus = sr.status;
    if (!sr.ok) { dbg.searchError = JSON.stringify(sj).slice(0, 400); if (debug) return jd(dbg); console.error("[hotel-photo] searchText", sr.status); return tile(); }
    const place = (sj.places || [])[0];
    dbg.placeName = place && place.displayName && place.displayName.text;
    const photoName = place && place.photos && place.photos[0] && place.photos[0].name;
    dbg.photoName = photoName || null;
    dbg.numPhotos = place && place.photos ? place.photos.length : 0;
    if (!photoName) { if (debug) return jd(dbg); return tile(); }
    const pr = await fetch(PLACES + "/" + photoName + "/media?maxWidthPx=" + w, {
      headers: { "X-Goog-Api-Key": key }
    });
    dbg.mediaStatus = pr.status;
    dbg.mediaType = pr.headers.get("content-type");
    if (!pr.ok) { dbg.mediaError = (await pr.text()).slice(0, 300); if (debug) return jd(dbg); console.error("[hotel-photo] media", pr.status); return tile(); }
    const buf = Buffer.from(await pr.arrayBuffer());
    dbg.bytes = buf.length;
    if (debug) return jd({ ...dbg, ok: true });
    const ct = pr.headers.get("content-type") || "image/jpeg";
    return {
      statusCode: 200,
      headers: {
        "content-type": ct,
        "cache-control": "public, max-age=604800",
        "netlify-cdn-cache-control": "public, max-age=2592000, durable"
      },
      isBase64Encoded: true,
      body: buf.toString("base64")
    };
  } catch (e) {
    if (debug) return jd({ ...dbg, exception: e && e.message ? e.message : String(e) });
    console.error("[hotel-photo] EXCEPTION", e && e.message ? e.message : String(e));
    return tile();
  }
};
