// mtm-sponsors-feed — serves PAID category sponsors for sevilletoursandmore.com.
//
// Returns { "<Category>": [ { name, tagline, link, logo } ] } for Sold/Active rows that
// are inside their date window. The site's per-category sponsor boxes fetch this and swap
// paid sponsors in over the house cards (each category's top-3 earners), capped at 3.
//
// Env (reuses Seville Live's setup): AIRTABLE_TOKEN, AIRTABLE_BASE, AIRTABLE_MTM_TABLE.

const BASE  = process.env.AIRTABLE_BASE || "appRFxS65uKsCxc03";
const TABLE = process.env.AIRTABLE_MTM_TABLE || "AIRTABLE_MTM_TABLE_NOT_SET"; // "Seville T&M Sponsors" table

function j(obj, maxAge) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=" + maxAge + ", s-maxage=" + maxAge },
    body: JSON.stringify(obj)
  };
}
function today() { return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" }); } // YYYY-MM-DD

exports.handler = async () => {
  const EMPTY = j({}, 60);
  try {
    const token = process.env.AIRTABLE_TOKEN;
    if (!token) { console.error("AIRTABLE_TOKEN not set"); return EMPTY; }
    const formula = encodeURIComponent("OR({Status}='Sold',{Status}='Active')");
    const url = "https://api.airtable.com/v0/" + BASE + "/" + TABLE + "?filterByFormula=" + formula + "&pageSize=100";
    let records = [], offset = "";
    do {
      const r = await fetch(url + (offset ? "&offset=" + encodeURIComponent(offset) : ""), { headers: { Authorization: "Bearer " + token } });
      if (!r.ok) { console.error("airtable read", r.status, await r.text()); return EMPTY; }
      const p = await r.json();
      records = records.concat(p.records || []);
      offset = p.offset || "";
    } while (offset);

    const td = today(), out = {};
    for (const rec of records) {
      const f = rec.fields || {};
      const start = (f["Start date"] || "").slice(0, 10);
      const exp   = (f["Expires"] || "").slice(0, 10);
      if (start && td < start) continue;
      if (exp && exp < td) continue;
      const cat = String(f["Category"] || "").trim();
      if (!cat) continue;
      const att = Array.isArray(f["Logo file"]) && f["Logo file"][0] ? f["Logo file"][0].url : "";
      const item = {
        name: f["Sponsor name"] || "",
        tagline: f["Tagline"] || "",
        link: f["Link URL"] || "",
        logo: att || f["Logo URL"] || ""
      };
      (out[cat] = out[cat] || []).push(item);
    }
    Object.keys(out).forEach(k => { out[k] = out[k].slice(0, 3); }); // hard cap 3 per category
    return j(out, 60);
  } catch (e) {
    console.error("mtm-sponsors-feed error", e);
    return EMPTY;
  }
};
