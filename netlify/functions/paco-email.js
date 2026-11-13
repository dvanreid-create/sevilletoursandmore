// netlify/functions/paco-email.js — "Email me this itinerary" (server-side send).
// Sends the Paqui & Paco itinerary straight to the visitor's inbox, so the button works for
// EVERYONE with NO mail-client dependency (unlike a mailto: link, which only opens the device's
// default handler). Emitted into the site by build_tours.py, alongside paco-chat.js. (DLR 2026-08-24)
//
// SETUP (one-time, done by the owner in Netlify — the code can't create accounts or hold secrets):
//   1. Create a Resend account (resend.com) and VERIFY the malagatoursandmore.com sending domain.
//   2. In Netlify → Site settings → Environment variables, add:
//        RESEND_API_KEY = <the Resend API key>
//        PACO_FROM      = Paqui & Paco <hello@malagatoursandmore.com>  (optional; this is the default)
// Until RESEND_API_KEY is set, this returns {ok:false,error:"not_configured"} and the page falls
// back to mailto — so nothing breaks in the meantime.
//
// Abuse control: fixed FROM (can't be spoofed), single validated recipient, size caps, and a soft
// same-site origin check. The body is the visitor's own itinerary text — not arbitrary relay content.

exports.handler = async (event) => {
  const H = { "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return json(H, 200, {});
  if (event.httpMethod !== "POST") return json(H, 405, { ok: false, error: "method" });

  // Soft same-site guard: this endpoint only serves our own Paco page.
  const ref = ((event.headers && (event.headers.origin || event.headers.referer)) || "") + "";
  if (ref && !/malagatoursandmore\.com/i.test(ref)) return json(H, 403, { ok: false, error: "origin" });

  let b = {};
  try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  // Accept one OR MANY recipients: an array, or a string separated by ; , or spaces. (DLR 2026-09-12)
  const toList = (Array.isArray(b.to) ? b.to : String(b.to || "").split(/[;,\s]+/))
    .map((s) => String(s || "").trim()).filter(Boolean).slice(0, 10);
  const subject = (b.subject || "Your Málaga itinerary from Paqui & Paco").toString().slice(0, 200);
  const text = (b.text || "").toString().slice(0, 20000);
  // The Paco page may send a fully-designed HTML body (Aman-style). It is built by our own same-site
  // page (origin-guarded above) from the visitor's own itinerary, so we use it as-is; size-capped.
  const richHtml = (b.html || "").toString().slice(0, 80000);

  const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  if (!toList.length || !toList.every((t) => emailRe.test(t))) return json(H, 400, { ok: false, error: "bad_email" });
  if (!text.trim()) return json(H, 400, { ok: false, error: "empty" });

  const key = process.env.RESEND_API_KEY;
  const from = process.env.PACO_FROM || "Paqui & Paco <hello@malagatoursandmore.com>";
  if (!key) return json(H, 200, { ok: false, error: "not_configured" }); // UI falls back to mailto

  // Prefer the page's designed HTML body; otherwise fall back to a minimal escaped/linkified version.
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = richHtml ||
    ('<div style="font:15px/1.6 -apple-system,Segoe UI,Arial,sans-serif;color:#1d2b33;max-width:640px">' +
    esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#c4502e">$1</a>').replace(/\n/g, "<br>") +
    "</div>");

  // Static map for the email (DLR 2026-09-12): the page can't build this — a Static Maps URL would leak
  // the API key into the delivered email. So we fetch the map SERVER-SIDE with the key and inline it as a
  // data-URI at the <!--PACO_MAP--> placeholder; the key never leaves the server. Needs the Maps Static API
  // enabled on GOOGLE_STATICMAP_KEY (falls back to GOOGLE_PLACES_KEY). Best-effort: any failure -> no map,
  // never a broken email. (Note: Gmail strips data-URI images; it renders in Apple Mail/Outlook and most others.)
  if (html.indexOf("<!--PACO_MAP-->") >= 0) {
    let mapImg = "";
    try {
      const markers = Array.isArray(b.mapMarkers) ? b.mapMarkers.slice(0, 25) : [];
      const mkey = process.env.GOOGLE_STATICMAP_KEY || process.env.GOOGLE_PLACES_KEY;
      if (markers.length && mkey) {
        const cols = ["0xE8662A", "0x143A4E", "0x0B5E8A", "0x7a5c2e"];
        const byDay = {};
        markers.forEach((m) => { const d = (m.d | 0); (byDay[d] = byDay[d] || []).push(m); });
        let params = "size=600x260&scale=2&maptype=roadmap&language=en";
        Object.keys(byDay).forEach((d) => {
          const pts = byDay[d].filter((m) => typeof m.lat === "number" && typeof m.lng === "number")
                              .map((m) => (Math.round(m.lat * 1e5) / 1e5) + "," + (Math.round(m.lng * 1e5) / 1e5));
          if (pts.length) params += "&markers=" + encodeURIComponent("color:" + cols[d % cols.length] + "|size:small|" + pts.join("|"));
        });
        const mr = await fetch("https://maps.googleapis.com/maps/api/staticmap?" + params + "&key=" + mkey);
        if (mr.ok) {
          const buf = Buffer.from(await mr.arrayBuffer());
          if (buf.length && buf.length < 900000) {
            mapImg = '<img src="data:image/png;base64,' + buf.toString("base64") +
                     '" width="600" alt="Your itinerary map" style="width:100%;max-width:600px;border-radius:6px;display:block;margin:18px auto 4px">';
          }
        }
      }
    } catch (e) { /* best-effort: leave mapImg empty */ }
    html = html.replace("<!--PACO_MAP-->", mapImg);
  }

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: toList, subject, text, html })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return json(H, 200, { ok: false, error: "send_failed", detail: t.slice(0, 300) });
    }
    return json(H, 200, { ok: true });
  } catch (e) {
    return json(H, 200, { ok: false, error: "exception" });
  }
};

function json(H, statusCode, obj) { return { statusCode, headers: H, body: JSON.stringify(obj) }; }
