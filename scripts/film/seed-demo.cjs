// Vult een lege lokale database met fictieve demogegevens voor de instructiefilm (zie README).
//   node seed-demo.cjs   (lokale server op http://localhost:8888, lege database)
const { chromium } = require("playwright");

const BASE = process.env.BASE ?? "http://localhost:8888";
const CODE = process.env.SETUP_CODE ?? "lokale-testcode";
const ADMIN = { email: "sanne@delinde.example", password: "demo-wachtwoord-voor-de-film" };

let cookie = "";
let org = null;
async function call(method, path, body, binary) {
  const headers = { origin: BASE };
  if (cookie) headers.cookie = cookie;
  if (org) headers["x-organisation"] = org;
  let payload;
  if (binary) {
    headers["content-type"] = "application/octet-stream";
    payload = binary;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  for (const c of res.headers.getSetCookie()) cookie = c.split(";")[0];
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const post = (p, b) => call("POST", p, b ?? {});
const patch = (p, b) => call("PATCH", p, b);
const get = (p) => call("GET", p);

async function upload(target, name, bytes) {
  const { id, chunkSize, chunkCount } = await post("/api/documents", { ...target, name, mime: "application/pdf", size: bytes.length });
  for (let n = 0; n < chunkCount; n++) {
    await call("PUT", `/api/documents/${id}/chunks/${n}`, undefined, bytes.subarray(n * chunkSize, Math.min(bytes.length, (n + 1) * chunkSize)));
  }
  await post(`/api/documents/${id}/complete`);
  return id;
}

const page = (title, body) => `<!doctype html><html lang="nl"><meta charset="utf-8"><style>
  body { font: 11.5pt/1.6 Inter, "DejaVu Sans", sans-serif; color: #18181b; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 4pt; } h2 { font-size: 12.5pt; margin: 18pt 0 4pt; }
  .sub { color: #6f6c64; margin-bottom: 14pt; } table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: 5pt 8pt; border-bottom: 1px solid #e8e5db; } td:last-child, th:last-child { text-align: right; }
</style><h1>${title}</h1>${body}</html>`;

// Drie pagina's, zodat de film kan laten zien hoe je door een stuk bladert.
const GROENPLAN = page(
  "Voorstel groenplan binnentuin",
  `<div class="sub">Werkgroep Groen, Bewonerscommissie De Linde. Voor het bestuursoverleg.</div>
  <h2>Aanleiding</h2><p>De binnentuin bestaat nu vooral uit tegels en wordt weinig gebruikt. Uit de bewonersenquête blijkt dat bewoners meer groen, een plek om te zitten en betere verlichting willen.</p>
  <h2>Het plan</h2><ul><li>Drie plantvakken met inheemse beplanting en twee bomen.</li><li>Een zitplek bij de ingang, toegankelijk voor rolstoel en rollator.</li><li>Het onderhoud doet een groep van acht bewoners, met een rooster per maand.</li></ul>
  <h2>Gevraagd besluit</h2><p>De werkgroep vraagt het bestuur in te stemmen met het plan en het budget van € 4.800 vrij te geven.</p>
  <div style="page-break-before: always"></div>
  <h1>Schets van de binnentuin</h1><div class="sub">Indeling na de herinrichting. Niet op schaal.</div>
  <svg viewBox="0 0 640 420" width="100%" style="border:1px solid #c5cfd9;border-radius:8px;background:#f5f7f9">
    <rect x="20" y="20" width="600" height="380" rx="10" fill="#eef2f5" stroke="#c5cfd9"/>
    <rect x="50" y="50" width="170" height="110" rx="12" fill="#bfe3c6" stroke="#4d9a5f"/><text x="135" y="110" text-anchor="middle" font-size="15" fill="#1f5c2e">Plantvak 1</text>
    <rect x="420" y="50" width="170" height="110" rx="12" fill="#bfe3c6" stroke="#4d9a5f"/><text x="505" y="110" text-anchor="middle" font-size="15" fill="#1f5c2e">Plantvak 2</text>
    <rect x="50" y="260" width="250" height="110" rx="12" fill="#bfe3c6" stroke="#4d9a5f"/><text x="175" y="320" text-anchor="middle" font-size="15" fill="#1f5c2e">Plantvak 3</text>
    <circle cx="320" cy="105" r="34" fill="#7cc08a" stroke="#2f7a43"/><text x="320" y="110" text-anchor="middle" font-size="13" fill="#103d1c">Boom</text>
    <circle cx="390" cy="315" r="34" fill="#7cc08a" stroke="#2f7a43"/><text x="390" y="320" text-anchor="middle" font-size="13" fill="#103d1c">Boom</text>
    <rect x="470" y="270" width="120" height="90" rx="10" fill="#f6dfb3" stroke="#c9963a"/><text x="530" y="320" text-anchor="middle" font-size="15" fill="#6b4a12">Zitplek</text>
    <path d="M320 400 V210 H250" fill="none" stroke="#8a97a5" stroke-width="10" stroke-linecap="round" stroke-dasharray="2 16"/>
    <text x="320" y="392" text-anchor="middle" font-size="12" fill="#6f6c64">Ingang</text>
  </svg>
  <div style="page-break-before: always"></div>
  <h1>Kosten en planning</h1><div class="sub">Bedragen inclusief btw.</div>
  <table><tr><th>Onderdeel</th><th>Kosten</th></tr>
  <tr><td>Grondwerk en plantvakken</td><td>€ 1.900</td></tr><tr><td>Beplanting en twee bomen</td><td>€ 1.450</td></tr>
  <tr><td>Zitplek en verharding</td><td>€ 1.150</td></tr><tr><td>Verlichting</td><td>€ 300</td></tr>
  <tr><td><strong>Totaal</strong></td><td><strong>€ 4.800</strong></td></tr></table>
  <h2>Dekking</h2><p>Bij het buurtfonds is € 1.500 subsidie aangevraagd. De rest komt uit de reserve van de commissie.</p>
  <h2>Planning</h2><ul><li>Januari: offertes van drie hoveniers.</li><li>Februari: keuze en opdracht.</li><li>Maart 2027: aanleg, met een plantdag voor bewoners.</li></ul>`,
);
const BEGROTING = page(
  "Conceptbegroting 2027",
  `<div class="sub">Penningmeester, Bewonerscommissie De Linde. Ter bespreking.</div>
  <table><tr><th>Post</th><th>2026</th><th>2027</th></tr>
  <tr><td>Bijdrage verhuurder</td><td>€ 6.000</td><td>€ 6.000</td></tr><tr><td>Subsidie buurtfonds</td><td>€ 1.000</td><td>€ 1.500</td></tr>
  <tr><td>Activiteiten bewoners</td><td>€ 2.400</td><td>€ 2.200</td></tr><tr><td>Groen en binnentuin</td><td>€ 600</td><td>€ 4.800</td></tr>
  <tr><td>Zaalhuur en drukwerk</td><td>€ 900</td><td>€ 950</td></tr></table>
  <h2>Toelichting</h2><p>De grootste verandering is het groenplan voor de binnentuin. De reserve daalt daardoor naar € 2.150.</p>`,
);

(async () => {
  const browser = await chromium.launch();
  const tab = await browser.newPage();
  const pdf = async (html) => {
    await tab.setContent(html);
    return tab.pdf({ format: "A4", margin: { top: "22mm", bottom: "22mm", left: "22mm", right: "22mm" } });
  };
  const groenplan = await pdf(GROENPLAN);
  const begroting = await pdf(BEGROTING);
  await browser.close();

  await post("/api/setup", { code: CODE, name: "Sanne Visser", organisation: "Bewonerscommissie De Linde", ...ADMIN });
  org = (await get("/api/session")).organisations[0].id;
  await patch(`/api/organisations/${org}`, { aiEnabled: true });

  const overleg = (await post("/api/overleggen", { name: "Bestuursoverleg", description: "Maandelijks overleg van het bestuur van de bewonerscommissie." })).id;
  const people = {};
  const invites = {};
  for (const [name, email] of [
    ["Karim El Amrani", "karim@delinde.example"],
    ["Lotte de Boer", "lotte@delinde.example"],
    ["Peter Janssen", "peter@delinde.example"],
  ]) {
    const added = await post(`/api/overleggen/${overleg}/members`, { email, name });
    people[name] = added.userId;
    invites[name] = added.token;
  }

  // Het platform verstuurt zelf e-mail; de film vangt die op met een nagebouwde mailserver op poort 2525.
  await call("PUT", "/api/admin/mail", { host: "localhost", port: 2525, security: "geen", user: "mailer", pass: "geheim", fromName: "Bewonerscommissie De Linde", fromAddress: "vergaderen@delinde.example" });
  await post("/api/account/calendar");

  // Vorige vergadering: afgerond, met een openstaande actie voor het dashboard.
  const vorige = (
    await post(`/api/overleggen/${overleg}/meetings`, {
      title: "Bestuursoverleg oktober",
      startsAt: new Date(Date.now() - 28 * 86400e3).toISOString(),
      durationMin: 90,
      location: "Buurthuis De Linde",
      items: [{ title: "Opening en mededelingen", kind: "Ter informatie" }, { title: "Subsidie buurtfonds", kind: "Ter besluitvorming" }, { title: "Rondvraag en sluiting" }],
    })
  ).id;
  await patch(`/api/meetings/${vorige}`, { status: "gepubliceerd" });
  const vorigeItems = (await get(`/api/meetings/${vorige}`)).items;
  await post(`/api/meetings/${vorige}/decisions`, { text: "De commissie vraagt subsidie aan bij het buurtfonds voor het groenplan.", agendaItemId: vorigeItems[1].id });
  const me = (await get("/api/session")).user.id;
  await post(`/api/meetings/${vorige}/actions`, { text: "Subsidieaanvraag indienen bij het buurtfonds", ownerId: me, dueDate: "2026-12-01", agendaItemId: vorigeItems[1].id });
  await patch(`/api/meetings/${vorige}`, { status: "afgerond" });

  // De vergadering van vandaag: begint op het eerstvolgende halve uur.
  const start = new Date(Math.ceil(Date.now() / 1800e3) * 1800e3);
  const meeting = (
    await post(`/api/overleggen/${overleg}/meetings`, {
      title: "Bestuursoverleg november",
      startsAt: start.toISOString(),
      durationMin: 60,
      location: "Buurthuis De Linde",
      items: [
        { title: "Opening en mededelingen", kind: "Ter informatie" },
        { title: "Verslag vorige vergadering", kind: "Ter vaststelling" },
        { title: "Groenplan binnentuin", kind: "Ter besluitvorming", description: "De werkgroep Groen licht het voorstel toe en vraagt om akkoord en budget." },
        { title: "Begroting 2027", kind: "Ter bespreking" },
        { title: "Rondvraag en sluiting" },
      ],
    })
  ).id;
  const items = (await get(`/api/meetings/${meeting}`)).items;
  const extra = [
    { durationMin: 5, presenter: "Sanne Visser" },
    { durationMin: 5 },
    { durationMin: 25, presenter: "Lotte de Boer" },
    { durationMin: 20, presenter: "Peter Janssen" },
    { durationMin: 5 },
  ];
  for (let i = 0; i < items.length; i++) await patch(`/api/items/${items[i].id}`, extra[i]);
  await upload({ meetingId: meeting, agendaItemId: items[2].id }, "Voorstel groenplan binnentuin.pdf", groenplan);
  await upload({ meetingId: meeting, agendaItemId: items[3].id }, "Conceptbegroting 2027.pdf", begroting);
  await patch(`/api/meetings/${meeting}`, { status: "gepubliceerd" });
  // Karim heeft nog niets laten weten: hij meldt zich in de film aan vanuit de e-mail.
  for (const [name, id] of Object.entries(people)) {
    if (name !== "Karim El Amrani") await call("PUT", `/api/meetings/${meeting}/attendance`, { userId: id, status: "aanwezig" });
  }

  // Karim draagt een agendapunt aan; daarvoor accepteert hij eerst zijn uitnodiging.
  const mine = cookie;
  cookie = "";
  await post(`/api/tokens/${invites["Karim El Amrani"]}`, { password: "demo-wachtwoord-van-karim" });
  await post(`/api/overleggen/${overleg}/suggestions`, {
    title: "Fietsenstalling uitbreiden",
    description: "De stalling staat elke avond vol. Kunnen we de verhuurder vragen om extra rekken?",
  });
  cookie = mine;

  console.log(JSON.stringify({ meeting, org, ...ADMIN }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
