// mtm-create-ad-checkout — self-serve category sponsorship for sevilletoursandmore.com.
//
// Flow (mirrors Seville Live's create-ad-checkout):
//   1) Look up the category's tier + price. 14 categories, 3 tiers:
//        Premium €180 · Standard €120 · Entry €90  (per month, per slot)
//   2) Enforce max 3 sponsors per category. Counts Sold/Active rows PLUS Pending rows
//      created in the last PENDING_RESERVE_MIN minutes (so two buyers can't grab the last slot).
//   3) If the category is FULL -> no charge; saves a Waitlist row, returns { waitlisted:true }.
//   4) Otherwise -> creates a Pending row, uploads the logo (base64) to "Logo file", and opens
//      a Stripe Checkout Session in one-time PAYMENT mode for (tier price x months). Returns { url }.
//
// Env (reuses Seville Live): AIRTABLE_TOKEN, STRIPE_SECRET_KEY.
// Optional: AIRTABLE_BASE, AIRTABLE_MTM_TABLE, SITE_URL, CURRENCY,
//           AD_PREMIUM_CENTS, AD_STANDARD_CENTS, AD_ENTRY_CENTS, AD_CAP_PER_CATEGORY.

const BASE  = process.env.AIRTABLE_BASE || "appRFxS65uKsCxc03";
const TABLE = process.env.AIRTABLE_MTM_TABLE || "AIRTABLE_MTM_TABLE_NOT_SET"; // "Seville T&M Sponsors" table
const LOGO_FIELD = "Logo file";
const SITE  = process.env.SITE_URL || "https://sevilletoursandmore.com";
const CURRENCY = (process.env.CURRENCY || "eur").toLowerCase();
const CENTS = {
  Premium:  parseInt(process.env.AD_PREMIUM_CENTS  || "18000", 10), // €180
  Standard: parseInt(process.env.AD_STANDARD_CENTS || "12000", 10), // €120
  Entry:    parseInt(process.env.AD_ENTRY_CENTS    || "9000",  10), // €90
};
const CAP = parseInt(process.env.AD_CAP_PER_CATEGORY || "3", 10);
const PENDING_RESERVE_MIN = 20;
// Per-site admin alert via Resend on every submission. No-ops unless RESEND_API_KEY, RESEND_FROM and
// ADMIN_NOTIFY_EMAIL are all set, so Seville (which already emails via its Airtable automation) is
// unaffected until/unless those are set. AD_BRAND brands the Stripe line item + email per city.
const RESEND = process.env.RESEND_API_KEY || "";
const RFROM  = process.env.RESEND_FROM || "";
const ADMIN  = process.env.ADMIN_NOTIFY_EMAIL || "";
const BRAND  = process.env.AD_BRAND || "Seville Tours & More";

// canonical category value (stored) -> { display, tier }. Value must match the site's data-cat.
const CATS = {
  "Boat Tour": { d:"Boat Tour",          tier:"Premium"  },
  "City Tour": { d:"City Tour",          tier:"Standard" },
  "Day Trip":  { d:"Day Trip",           tier:"Premium"  },
  "Experience":{ d:"Experience",         tier:"Standard" },
  "Walking Tour":{ d:"Walking Tour",     tier:"Standard" },
  "cinema":    { d:"Cinema",             tier:"Entry"    },
  "family":    { d:"Family & Parks",     tier:"Standard" },
  "food":      { d:"Food & Drink",       tier:"Premium"  },
  "games":     { d:"Games & Mystery",    tier:"Entry"    },
  "immersive": { d:"Immersive & Shows",  tier:"Entry"    },
  "museums":   { d:"Museums & Culture",  tier:"Standard" },
  "sports":    { d:"Sports & Adventure", tier:"Standard" },
  "wellness":  { d:"Wellness & Spa",     tier:"Premium"  },
  "workshops": { d:"Workshops & Classes",tier:"Entry"    },
};
const OK_TYPES = { "image/png":1, "image/jpeg":1, "image/jpg":1, "image/svg+xml":1 };

const json = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
const t = (v) => (v == null ? "" : String(v).trim());
const air = (path, token, opts) => fetch("https://api.airtable.com/v0/" + BASE + "/" + path, Object.assign({ headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } }, opts || {}));

// Fire-and-forget admin email via Resend. No-ops unless RESEND_API_KEY, RESEND_FROM and ADMIN_NOTIFY_EMAIL are set.
async function notifyAdmin(subject, html) {
  if (!RESEND || !RFROM || !ADMIN) return;
  try {
    await fetch("https://api.resend.com/emails", { method: "POST",
      headers: { Authorization: "Bearer " + RESEND, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RFROM, to: ADMIN, subject, html }) });
  } catch (e) { console.error("notifyAdmin", e && e.message); }
}

async function countCategory(token, catValue) {
  const esc = catValue.replace(/'/g, "\\'");
  const formula =
    "AND({Category}='" + esc + "'," +
    "OR({Status}='Sold',{Status}='Active'," +
       "AND({Status}='Pending',DATETIME_DIFF(NOW(),CREATED_TIME(),'minutes')<" + PENDING_RESERVE_MIN + ")))";
  let count = 0, offset = "";
  do {
    const r = await air(TABLE + "?filterByFormula=" + encodeURIComponent(formula) + "&pageSize=100&fields%5B%5D=Category" + (offset ? "&offset=" + encodeURIComponent(offset) : ""), token);
    if (!r.ok) throw new Error("airtable count " + r.status + " " + (await r.text()));
    const j = await r.json();
    count += (j.records || []).length;
    offset = j.offset || "";
  } while (offset);
  return count;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method" });
  const token  = t(process.env.AIRTABLE_TOKEN);
  const stripeKey = t(process.env.STRIPE_SECRET_KEY);
  if (!token || !stripeKey) { console.error("not configured"); return json(500, { error: "not configured" }); }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "bad json" }); }
  const catValue = t(body.category);
  const cat = CATS[catValue];
  if (!cat) return json(400, { error: "unknown category" });
  const name = t(body.name), tagline = t(body.tagline), link = t(body.link), email = t(body.email);
  let months = parseInt(body.months, 10); if (!(months >= 1 && months <= 12)) months = 1;
  if (!name || !link) return json(400, { error: "name and link required" });

  const stripe = require("stripe")(stripeKey);
  const unit = CENTS[cat.tier];
  const amount = unit * months;

  try {
    // capacity check
    const used = await countCategory(token, catValue);
    if (used >= CAP) {
      await air(TABLE, token, { method: "POST", body: JSON.stringify({ fields: {
        "Category": catValue, "Tier": cat.tier, "Sponsor name": name, "Link URL": link,
        "Email": email, "Status": "Waitlist"
      }}) });
      await notifyAdmin("New " + BRAND + " ad waitlist — " + cat.d,
        "<p>A business joined the <strong>" + cat.d + "</strong> waitlist (category full).</p>" +
        "<p>Name: " + name + "<br>Email: " + (email || "—") + "<br>Link: " + link + "</p>");
      return json(200, { waitlisted: true });
    }

    // logo (optional base64 data URL). Parsed here, UPLOADED AFTER the row is created via
    // Airtable's attachment endpoint — inline data-URL attachments in the create payload fail
    // for any real-size image (Airtable rejects them above a few KB).
    let logoParsed = null;
    if (body.logo && /^data:/.test(body.logo)) {
      const m = body.logo.match(/^data:([^;]+);base64,(.+)$/);
      if (m && OK_TYPES[m[1]]) logoParsed = { contentType: m[1], b64: m[2] };
    }
    // Self-serve manage token: every sponsor gets a working /ad-portal?t=<token> link.
    const portalToken = require("crypto").randomBytes(20).toString("hex");
    const manageUrl = SITE + "/ad-portal?t=" + portalToken;
    const fields = {
      "Category": catValue, "Tier": cat.tier, "Sponsor name": name, "Tagline": tagline,
      "Link URL": link, "Email": email, "Months": months, "Status": "Pending",
      "Portal token": portalToken
    };
    if (!logoParsed && t(body.logoUrl)) fields["Logo URL"] = t(body.logoUrl);

    const create = await air(TABLE, token, { method: "POST", body: JSON.stringify({ fields }) });
    if (!create.ok) throw new Error("airtable create " + create.status + " " + (await create.text()));
    const rec = await create.json();

    // admin notification — fires the moment "Continue to secure payment" is clicked
    await notifyAdmin("New " + BRAND + " ad submitted — " + name + " (" + cat.d + ")",
      "<p>A new sponsorship was just submitted and is proceeding to payment.</p>" +
      "<p>Sponsor: " + name + "<br>Category: " + cat.d + " (" + cat.tier + ")" +
      "<br>Tagline: " + (tagline || "—") + "<br>Link: " + link +
      "<br>Email: " + (email || "—") + "<br>Months: " + months + "</p>");

    // upload the logo attachment to the new row (non-fatal: a logo failure must not block checkout)
    if (logoParsed) {
      try {
        const up = await fetch("https://content.airtable.com/v0/" + BASE + "/" + rec.id + "/" + encodeURIComponent(LOGO_FIELD) + "/uploadAttachment", {
          method: "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ contentType: logoParsed.contentType, file: logoParsed.b64, filename: (name || "logo").replace(/[^a-z0-9]+/gi, "-").slice(0, 60) + ".png" })
        });
        if (!up.ok) console.warn("logo upload", up.status, (await up.text()).slice(0, 200));
      } catch (e) { console.warn("logo upload failed (non-fatal)", e && e.message); }
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: amount,
          product_data: { name: BRAND + " sponsorship — " + cat.d + " (" + cat.tier + ")", description: months + " month" + (months > 1 ? "s" : "") }
        }
      }],
      metadata: { table: "mtm", record: rec.id, category: catValue, tier: cat.tier, months: String(months), portalToken: portalToken },
      custom_text: { after_submit: { message: "Manage or cancel your listing anytime: " + manageUrl } },
      success_url: SITE + "/advertise/?ok=1",
      cancel_url: SITE + "/advertise/?cancelled=1"
    });
    return json(200, { url: session.url });
  } catch (e) {
    console.error("mtm-create-ad-checkout error", e);
    return json(500, { error: "server" });
  }
};
