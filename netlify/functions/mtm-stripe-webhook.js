// mtm-stripe-webhook — on successful payment, marks the pending category sponsorship as Sold
// and sets its Start/Expires dates. Register the endpoint in Stripe -> Developers -> Webhooks:
//   {SITE}/.netlify/functions/mtm-stripe-webhook   (event: checkout.session.completed)
// Env: STRIPE_SECRET_KEY, STRIPE_MTM_WEBHOOK_SECRET, AIRTABLE_TOKEN.
// (Reuses Seville Live's Stripe account; use a SEPARATE webhook signing secret for this endpoint.)

const BASE  = process.env.AIRTABLE_BASE || "appRFxS65uKsCxc03";
const TABLE = process.env.AIRTABLE_MTM_TABLE || "AIRTABLE_MTM_TABLE_NOT_SET"; // "Seville T&M Sponsors" table

function addMonths(d, n) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
function ymd(d) { return d.toISOString().slice(0, 10); }

exports.handler = async (event) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const whSecret  = process.env.STRIPE_MTM_WEBHOOK_SECRET;
  const token     = process.env.AIRTABLE_TOKEN;
  if (!stripeKey || !token) { console.error("not configured"); return { statusCode: 500, body: "config" }; }
  const stripe = require("stripe")(stripeKey);

  let evt;
  try {
    const sig = event.headers["stripe-signature"];
    evt = whSecret ? stripe.webhooks.constructEvent(event.body, sig, whSecret) : JSON.parse(event.body);
  } catch (e) { console.error("sig verify failed", e.message); return { statusCode: 400, body: "bad sig" }; }

  if (evt.type !== "checkout.session.completed") return { statusCode: 200, body: "ignored" };
  const s = evt.data.object, md = s.metadata || {};
  if (md.table !== "mtm" || !md.record) return { statusCode: 200, body: "not mtm" };

  const months = parseInt(md.months, 10) || 1;
  const start = new Date(), exp = addMonths(start, months);
  try {
    const r = await fetch("https://api.airtable.com/v0/" + BASE + "/" + TABLE + "/" + md.record, {
      method: "PATCH",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { "Status": "Sold", "Start date": ymd(start), "Expires": ymd(exp), "Stripe session": s.id } })
    });
    if (!r.ok) console.error("airtable patch", r.status, await r.text());
  } catch (e) { console.error("webhook patch error", e); }
  return { statusCode: 200, body: "ok" };
};
