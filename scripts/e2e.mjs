// End-to-end test van de API. Draait tegen een lege (of eerder door dit script gevulde) database.
//   BASE=http://localhost:8888 SETUP_CODE=lokale-testcode node scripts/e2e.mjs
import { createHash, randomBytes } from "node:crypto";

const BASE = process.env.BASE ?? "http://localhost:8888";
const SETUP_CODE = process.env.SETUP_CODE ?? "lokale-testcode";
const RUN = Date.now().toString(36);
let passed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) passed++;
  else {
    failures.push(`${name} ${detail}`);
    console.log(`  FOUT: ${name} ${detail}`);
  }
}

class Client {
  cookie = "";
  /** De organisatie waarin deze gebruiker werkt (header x-organisation). */
  org = null;
  async raw(method, path, { body, binary, origin = BASE, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.org) h["x-organisation"] = this.org;
    if (origin && method !== "GET") h.origin = origin;
    let payload;
    if (binary) {
      h["content-type"] = "application/octet-stream";
      payload = binary;
    } else if (body !== undefined) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      this.cookie = pair.endsWith("=") ? "" : pair;
    }
    return res;
  }
  async call(method, path, opts) {
    const res = await this.raw(method, path, opts);
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }
  get = (p) => this.call("GET", p);
  post = (p, body) => this.call("POST", p, { body: body ?? {} });
  put = (p, body) => this.call("PUT", p, { body });
  patch = (p, body) => this.call("PATCH", p, { body });
  del = (p) => this.call("DELETE", p);

  async upload(target, name, mime, bytes) {
    const start = await this.post("/api/documents", { ...target, name, mime, size: bytes.length });
    if (start.status !== 200) return start;
    const { id, chunkSize, chunkCount } = start.data;
    for (let n = 0; n < chunkCount; n++) {
      const part = bytes.subarray(n * chunkSize, Math.min(bytes.length, (n + 1) * chunkSize));
      const r = await this.call("PUT", `/api/documents/${id}/chunks/${n}`, { binary: part });
      if (r.status !== 200) return r;
    }
    const done = await this.post(`/api/documents/${id}/complete`);
    return { status: done.status, data: { id, chunkCount } };
  }
}

const sha = (b) => createHash("sha256").update(b).digest("hex");
const step = (s) => console.log(`\n${s}`);

const admin = new Client();
const adminCreds = { email: "beheer@test.example", password: "een-lang-testwachtwoord" };

step("1. Inrichting en inloggen");
let org1;
{
  const s = await admin.get("/api/session");
  check("sessie zonder login", s.status === 200 && s.data.user === null);
  if (s.data.setupNeeded) {
    const wrong = await admin.post("/api/setup", { code: "fout", name: "Bea Beheer", organisation: "Testbedrijf", ...adminCreds });
    check("setup met foute code geweigerd", wrong.status === 403, JSON.stringify(wrong));
    const short = await admin.post("/api/setup", { code: SETUP_CODE, name: "Bea Beheer", email: adminCreds.email, password: "kort" });
    check("setup met te kort wachtwoord geweigerd", short.status === 400);
    const ok = await admin.post("/api/setup", { code: SETUP_CODE, name: "Bea Beheer", organisation: "Testbedrijf", ...adminCreds });
    check("setup gelukt", ok.status === 200 && ok.data.user.isAdmin === true, JSON.stringify(ok));
    check("sessiecookie gezet", admin.cookie.includes("vp_session="));
    const again = await new Client().post("/api/setup", { code: SETUP_CODE, name: "X", email: "x@test.example", password: "nog-een-lang-wachtwoord" });
    check("tweede setup geweigerd", again.status === 409, JSON.stringify(again));
  } else {
    const ok = await admin.post("/api/login", adminCreds);
    check("login beheerder (herhaalde run)", ok.status === 200, JSON.stringify(ok));
  }
  const s2 = await admin.get("/api/session");
  const mine = s2.data.organisations?.find((o) => o.name === "Testbedrijf");
  check("sessie met eerste organisatie als beheerder", s2.data.user?.email === adminCreds.email && mine?.role === "beheerder", JSON.stringify(s2.data));
  org1 = mine.id;
  check("overzicht zonder gekozen organisatie geweigerd", (await admin.get("/api/overleggen")).status === 400);
  admin.org = org1;
  const anon = await new Client().get("/api/overleggen");
  check("zonder login 401", anon.status === 401);
  const csrf = await admin.call("POST", "/api/overleggen", { body: { name: "CSRF" }, origin: "https://kwaadaardig.example" });
  check("verkeerde herkomst geweigerd", csrf.status === 403, JSON.stringify(csrf));
  const noOrigin = await admin.call("POST", "/api/overleggen", { body: { name: "CSRF" }, origin: null });
  check("ontbrekende herkomst geweigerd", noOrigin.status === 403);
  const wrongPw = await new Client().post("/api/login", { email: adminCreds.email, password: "helemaal-fout-wachtwoord" });
  check("fout wachtwoord 401", wrongPw.status === 401);
}

/** Voegt iemand op e-mailadres toe aan een overleg en laat diegene de uitnodiging accepteren. */
async function addMember(by, overleg, org, name, email, role = "deelnemer") {
  const added = await by.post(`/api/overleggen/${overleg}/members`, { email, name, role });
  check(`${name} toegevoegd met uitnodigingslink`, added.status === 200 && added.data.created === true && !!added.data.token, JSON.stringify(added));
  const c = new Client();
  const info = await c.get(`/api/tokens/${added.data.token}`);
  check(`uitnodiging ${name} geldig`, info.status === 200 && info.data.purpose === "invite" && info.data.email === email);
  const short = await c.post(`/api/tokens/${added.data.token}`, { password: "kort" });
  check("kort wachtwoord geweigerd, link blijft geldig", short.status === 400);
  const password = `wachtwoord-van-${name.toLowerCase().replace(/\W/g, "")}`;
  const accept = await c.post(`/api/tokens/${added.data.token}`, { password });
  check(`uitnodiging ${name} geaccepteerd`, accept.status === 200 && accept.data.user.email === email, JSON.stringify(accept));
  const reuse = await new Client().post(`/api/tokens/${added.data.token}`, { password });
  check("link werkt maar één keer", reuse.status === 404);
  c.org = org;
  return { client: c, id: added.data.userId, email, password };
}

step("2. Overleg en deelnemers binnen één organisatie");
const overlegId = (await admin.post("/api/overleggen", { name: `MT-overleg ${RUN}`, description: "Tweewekelijks" })).data.id;
check("overleg aangemaakt", !!overlegId);
{
  const list = await admin.get("/api/overleggen");
  const o = list.data.overleggen.find((x) => x.id === overlegId);
  check("overleg in lijst met rol secretaris", o?.role === "secretaris" && o.memberCount === 1, JSON.stringify(o));
}
const dee = await addMember(admin, overlegId, org1, "Dee Deelnemer", `dee-${RUN}@test.example`);
{
  const dup = await admin.post(`/api/overleggen/${overlegId}/members`, { email: dee.email.toUpperCase(), name: "Dubbel" });
  check("dubbel toevoegen geweigerd", dup.status === 409);
  check("deelnemer mag accountlijst niet zien", (await dee.client.get("/api/users")).status === 403);
  check("er is geen namenlijst van alle accounts", (await admin.get("/api/users/directory")).status >= 400);
  const s = await dee.client.get("/api/session");
  check("deelnemer ziet alleen de eigen organisatie", s.data.organisations.length === 1 && s.data.organisations[0].id === org1 && s.data.organisations[0].role === "lid", JSON.stringify(s.data.organisations));
  const d = await admin.get(`/api/overleggen/${overlegId}`);
  check("overlegdetail met 2 deelnemers", d.data.members.length === 2 && d.data.role === "secretaris" && d.data.orgAdmin === true && d.data.overleg.organisationId === org1, JSON.stringify(d.data.overleg));
  check("deelnemer mag geen overleg aanmaken", (await dee.client.post("/api/overleggen", { name: "Stiekem" })).status === 403);
  check("deelnemer mag niemand toevoegen", (await dee.client.post(`/api/overleggen/${overlegId}/members`, { email: `x-${RUN}@test.example`, name: "X" })).status === 403);
  check("deelnemer mag organisatie niet beheren", (await dee.client.get(`/api/organisations/${org1}/people`)).status === 403);
}

step("2b. Tweede organisatie: gescheiden omgevingen");
let org2, overleg2, bui, sec;
{
  check("deelnemer mag geen organisatie aanmaken", (await dee.client.post("/api/organisations", { name: "Stiekem" })).status === 403);
  const created = await admin.post("/api/organisations", { name: `Testcommissie ${RUN}` });
  check("tweede organisatie aangemaakt", created.status === 200 && !!created.data.id, JSON.stringify(created));
  org2 = created.data.id;
  check("dubbele organisatienaam geweigerd", (await admin.post("/api/organisations", { name: `testcommissie ${RUN}` })).status === 409);
  const s = await admin.get("/api/session");
  check("aanmaker is beheerder van beide organisaties", s.data.organisations.filter((o) => o.role === "beheerder").length >= 2);

  const inOrg2 = new Client();
  inOrg2.cookie = admin.cookie;
  inOrg2.org = org2;
  overleg2 = (await inOrg2.post("/api/overleggen", { name: `Commissie ${RUN}` })).data.id;
  check("overleg in tweede organisatie", !!overleg2);
  check("overzicht toont alleen de gekozen organisatie", (await inOrg2.get("/api/overleggen")).data.overleggen.map((o) => o.id).join() === overleg2 && (await admin.get("/api/overleggen")).data.overleggen.every((o) => o.id !== overleg2));

  bui = await addMember(inOrg2, overleg2, org2, "Bui Buitenstaander", `bui-${RUN}@test.example`);
  sec = await addMember(inOrg2, overleg2, org2, "Sec Secretaris", `sec-${RUN}@test.example`, "secretaris");

  // Scheiding: wie alleen in organisatie 2 zit, ziet niets van organisatie 1, ook niet door de header te wijzigen.
  check("buitenstaander ziet overleg van andere organisatie niet", (await bui.client.get(`/api/overleggen/${overlegId}`)).status === 404);
  const spoof = new Client();
  spoof.cookie = bui.client.cookie;
  spoof.org = org1;
  check("andere organisatie kiezen in de header levert niets op", (await spoof.get("/api/overleggen")).data.overleggen.length === 0);
  check("dashboard van andere organisatie blijft leeg", (await spoof.get("/api/dashboard")).data.upcoming.length === 0);
  check("geen overleg aanmaken in andere organisatie", (await spoof.post("/api/overleggen", { name: "Inbraak" })).status === 404);
  check("andere organisatie niet te beheren", (await spoof.get(`/api/organisations/${org1}/people`)).status === 404);
  check("deelnemer van organisatie 1 ziet overleg van organisatie 2 niet", (await dee.client.get(`/api/overleggen/${overleg2}`)).status === 404);

  // Secretaris (geen beheerder) nodigt zelf uit, zonder namenlijst.
  check("secretaris ziet geen accountlijst", (await sec.client.get("/api/users")).status === 403);
  check("secretaris mag geen overleg aanmaken", (await sec.client.post("/api/overleggen", { name: "Extra" })).status === 403);
  const noName = await sec.client.post(`/api/overleggen/${overleg2}/members`, { email: `nia-${RUN}@test.example` });
  check("nieuwe persoon zonder naam: naam wordt gevraagd", noName.status === 422, JSON.stringify(noName));
  const nia = await sec.client.post(`/api/overleggen/${overleg2}/members`, { email: `Nia-${RUN}@Test.example`, name: "Nia Nieuw" });
  check("secretaris maakt account met uitnodigingslink", nia.status === 200 && nia.data.created === true && !!nia.data.token, JSON.stringify(nia));
  const again = await sec.client.post(`/api/overleggen/${overleg2}/members/${nia.data.userId}/invite`);
  check("nieuwe link voor wie nog niet activeerde", again.status === 200 && again.data.purpose === "invite", JSON.stringify(again));
  check("eerdere link vervalt", (await new Client().get(`/api/tokens/${nia.data.token}`)).status === 404);
  const niaClient = new Client();
  check("uitgenodigde activeert account", (await niaClient.post(`/api/tokens/${again.data.token}`, { password: "nia-kiest-een-wachtwoord" })).status === 200);
  check("geen uitnodigingslink voor een actief account", (await sec.client.post(`/api/overleggen/${overleg2}/members/${nia.data.userId}/invite`)).status === 403);
  check("secretaris kan overleg niet archiveren", (await sec.client.patch(`/api/overleggen/${overleg2}`, { archived: true })).status === 403);
  check("secretaris kan niemand toevoegen aan overleg van andere organisatie", (await sec.client.post(`/api/overleggen/${overlegId}/members`, { email: dee.email })).status === 404);

  // Iemand in twee organisaties: één account, twee omgevingen.
  const linked = await sec.client.post(`/api/overleggen/${overleg2}/members`, { email: dee.email });
  check("bestaand account wordt gekoppeld, zonder link", linked.status === 200 && linked.data.created === false && !linked.data.token, JSON.stringify(linked));
  const two = await dee.client.get("/api/session");
  check("deelnemer heeft nu twee organisaties", two.data.organisations.length === 2);
  const deeIn2 = new Client();
  deeIn2.cookie = dee.client.cookie;
  deeIn2.org = org2;
  check("per organisatie een eigen overzicht", (await deeIn2.get("/api/overleggen")).data.overleggen.map((o) => o.id).join() === overleg2 && (await dee.client.get("/api/overleggen")).data.overleggen.map((o) => o.id).join() === overlegId);

  // Beheer van de organisatie.
  const people = await inOrg2.get(`/api/organisations/${org2}/people`);
  check("beheerder ziet iedereen met toegang", people.status === 200 && people.data.people.length === 5 && people.data.people.filter((p) => p.isAdmin).length === 1, JSON.stringify(people.data?.people?.map((p) => p.name)));
  check("laatste beheerder kan niet weg", (await inOrg2.del(`/api/organisations/${org2}/admins/${(await admin.get("/api/session")).data.user.id}`)).status === 409);
  check("secretaris wordt beheerder", (await inOrg2.post(`/api/organisations/${org2}/admins`, { email: sec.email })).status === 200);
  check("beheerder mag nu overleg archiveren en weer terugzetten", (await sec.client.patch(`/api/overleggen/${overleg2}`, { archived: true })).status === 200 && (await sec.client.patch(`/api/overleggen/${overleg2}`, { archived: false })).status === 200);
  check("organisatie hernoemen", (await sec.client.patch(`/api/organisations/${org2}`, { name: `Testcommissie Noord ${RUN}` })).status === 200);
  check("beheerder kan organisatie niet archiveren", (await sec.client.patch(`/api/organisations/${org2}`, { archived: true })).status === 403);
  check("beheer weer intrekken", (await inOrg2.del(`/api/organisations/${org2}/admins/${sec.id}`)).status === 200);
  check("toegang tot organisatie intrekken", (await inOrg2.del(`/api/organisations/${org2}/people/${dee.id}`)).status === 200);
  check("daarna ziet de deelnemer die organisatie niet meer", (await dee.client.get("/api/session")).data.organisations.length === 1 && (await dee.client.get(`/api/overleggen/${overleg2}`)).status === 404);

  // De platformbeheerder ziet de inhoud niet vanzelf.
  const pam = await admin.post("/api/users", { name: "Pam Platform", email: `pam-${RUN}@test.example`, isAdmin: true });
  const pamClient = new Client();
  await pamClient.post(`/api/tokens/${pam.data.token}`, { password: "pam-kiest-een-wachtwoord" });
  check("platformbeheerder zonder organisatie", (await pamClient.get("/api/session")).data.organisations.length === 0);
  check("platformbeheerder ziet overleg niet zonder lidmaatschap", (await pamClient.get(`/api/overleggen/${overlegId}`)).status === 404);
  pamClient.org = org1;
  check("platformbeheerder ziet geen overleggen van een organisatie waar hij niet in zit", (await pamClient.get("/api/overleggen")).data.overleggen.length === 0);
  check("platformbeheerder ziet wel de lijst met organisaties", (await pamClient.get("/api/organisations")).data.organisations.length >= 2);
  check("platformbeheerder kan de mensen van een organisatie niet inzien", (await pamClient.get(`/api/organisations/${org1}/people`)).status === 404);
  check("platformbeheer intrekken", (await admin.patch(`/api/users/${pam.data.id}`, { isAdmin: false, active: false })).status === 200);
}

step("3. Vergadering en agenda");
const startsAt = new Date(Date.now() + 5 * 86400e3).toISOString();
const meetingId = (await admin.post(`/api/overleggen/${overlegId}/meetings`, { title: "MT week 48", startsAt, durationMin: 90, location: "Kantoor", onlineUrl: "https://teams.example/abc" })).data.id;
check("vergadering aangemaakt", !!meetingId);
check("ongeldige online link geweigerd", (await admin.post(`/api/overleggen/${overlegId}/meetings`, { title: "X", startsAt, onlineUrl: "javascript:alert(1)" })).status === 400);
check("concept onzichtbaar voor deelnemer", (await dee.client.get(`/api/meetings/${meetingId}`)).status === 404);
check("concept niet op dashboard deelnemer", (await dee.client.get("/api/dashboard")).data.upcoming.length === 0);
const itemIds = [];
for (const [title, kind, durationMin] of [["Opening en mededelingen", "Ter informatie", 10], ["Begroting 2027", "Ter besluitvorming", 40], ["Rondvraag", "", null]]) {
  const r = await admin.post(`/api/meetings/${meetingId}/items`, { title, kind, durationMin, presenter: "Bea", description: `Toelichting ${title}` });
  check(`agendapunt ${title}`, r.status === 200, JSON.stringify(r));
  itemIds.push(r.data.id);
}
{
  const order = [itemIds[1], itemIds[0], itemIds[2]];
  check("volgorde wijzigen", (await admin.put(`/api/meetings/${meetingId}/order`, { ids: order })).status === 200);
  const m = await admin.get(`/api/meetings/${meetingId}`);
  check("nieuwe volgorde opgeslagen", m.data.items.map((i) => i.id).join() === order.join(), m.data.items.map((i) => i.title).join());
  check("onvolledige volgorde geweigerd", (await admin.put(`/api/meetings/${meetingId}/order`, { ids: [itemIds[0]] })).status === 409);
  await admin.put(`/api/meetings/${meetingId}/order`, { ids: itemIds });
  check("notulen opslaan", (await admin.patch(`/api/items/${itemIds[1]}`, { notes: "Besproken: zoekwoord-xyzzy in de notulen." })).status === 200);
  check("publiceren", (await admin.patch(`/api/meetings/${meetingId}`, { status: "gepubliceerd" })).status === 200);
  const md = await dee.client.get(`/api/meetings/${meetingId}`);
  check("deelnemer ziet gepubliceerde vergadering met organisatie", md.status === 200 && md.data.role === "deelnemer" && md.data.items.length === 3 && md.data.meeting.organisationId === org1 && md.data.meeting.organisationName === "Testbedrijf");
  check("deelnemer mag agenda niet wijzigen", (await dee.client.post(`/api/meetings/${meetingId}/items`, { title: "Stiekem" })).status === 403);
  check("deelnemer mag notulen niet wijzigen", (await dee.client.patch(`/api/items/${itemIds[0]}`, { notes: "x" })).status === 403);
  check("buitenstaander ziet vergadering niet", (await bui.client.get(`/api/meetings/${meetingId}`)).status === 404);
  check("dashboard deelnemer toont vergadering", (await dee.client.get("/api/dashboard")).data.upcoming.some((u) => u.id === meetingId));
}

step("3b. Subpunten, vrije labels en een bestaande agenda overnemen");
{
  // De agenda van een echte vergadering: hoofdpunten, subpunten 2.1 t/m 2.6 en eigen labels.
  const rvt = [
    { title: "Opening en vaststelling agenda", kind: "Ter vaststelling" },
    {
      title: "Mededelingen directie",
      children: [
        { title: "Voortgang verbouwing en verhuizing", kind: "Ter informatie" },
        { title: "Remplooi / arbodienst", kind: "Ter informatie" },
        { title: "Bedrijfsmakelaar: verhuur kantoorruimte", kind: "Ter informatie" },
        { title: "Afspraken leverancier", kind: "Ter bespreking en voor afspraken" },
        { title: "Q3-cijfers 2026", kind: "Ter bespreking en voor afspraken" },
        { title: "Liquiditeitsprognose", kind: "Ter bespreking en voor afspraken" },
      ],
    },
    { title: "Rendabiliteit", kind: "Ter bespreking" },
    { title: "Personeelsontwikkeling", kind: "Ter informatie" },
    { title: "Bespreking statuten", kind: "Ter bespreking", description: "Bespreking van de stukken en voorgestelde wijzigingen." },
  ];
  const created = await admin.post(`/api/overleggen/${overlegId}/meetings`, {
    title: "RvT 3 december",
    startsAt: new Date(Date.now() + 13 * 86400e3).toISOString(),
    durationMin: 120,
    location: "Rijswijk",
    description: "De directie voegt de actuele financiële stukken toe.",
    items: rvt,
  });
  check("vergadering met geplakte agenda aangemaakt", created.status === 200, JSON.stringify(created));
  const mid = created.data.id;
  let m = await admin.get(`/api/meetings/${mid}`);
  const tops = () => m.data.items.filter((i) => !i.parentId);
  const subsOf = (id) => m.data.items.filter((i) => i.parentId === id);
  check("5 hoofdpunten en 6 subpunten", tops().length === 5 && subsOf(tops()[1].id).length === 6 && m.data.items.length === 11, `${m.data.items.length}`);
  check("vrije labels bewaard", tops()[0].kind === "Ter vaststelling" && tops()[1].kind === "" && subsOf(tops()[1].id)[3].kind === "Ter bespreking en voor afspraken");
  check("toelichting bij punt en bij agenda", tops()[4].description.startsWith("Bespreking van de stukken") && m.data.meeting.description.startsWith("De directie"));
  check("volgorde subpunten klopt", subsOf(tops()[1].id).map((s) => s.position).join() === "1,2,3,4,5,6");

  const parent = tops()[1];
  const sub = await admin.post(`/api/meetings/${mid}/items`, { title: "Extra mededeling", kind: "Ter informatie", parentId: parent.id });
  check("subpunt toevoegen", sub.status === 200, JSON.stringify(sub));
  check("subpunt onder een subpunt geweigerd", (await admin.post(`/api/meetings/${mid}/items`, { title: "Te diep", parentId: sub.data.id })).status === 400);
  check("subpunt onder punt van andere vergadering geweigerd", (await admin.post(`/api/meetings/${meetingId}/items`, { title: "Verkeerd", parentId: parent.id })).status === 400);
  m = await admin.get(`/api/meetings/${mid}`);
  const subIds = subsOf(parent.id).map((s) => s.id);
  check("nieuw subpunt komt achteraan", subIds.length === 7 && subIds[6] === sub.data.id);
  const reordered = [subIds[6], ...subIds.slice(0, 6)];
  check("subpunten onderling verplaatsen", (await admin.put(`/api/meetings/${mid}/order`, { ids: reordered, parentId: parent.id })).status === 200);
  check("hoofdpunten en subpunten niet door elkaar te verplaatsen", (await admin.put(`/api/meetings/${mid}/order`, { ids: reordered })).status === 409);
  m = await admin.get(`/api/meetings/${mid}`);
  check("nieuwe volgorde subpunten", subsOf(parent.id).map((s) => s.id).join() === reordered.join());
  check("hoofdpunten onderling verplaatsen blijft werken", (await admin.put(`/api/meetings/${mid}/order`, { ids: tops().map((x) => x.id).reverse() })).status === 200);
  await admin.put(`/api/meetings/${mid}/order`, { ids: tops().map((x) => x.id) });

  const more = await admin.post(`/api/meetings/${mid}/items/bulk`, { items: [{ title: "Rondvraag" }, { title: "Sluiting", kind: "Ter informatie" }] });
  check("agenda plakken voegt achteraan toe", more.status === 200 && more.data.count === 2, JSON.stringify(more));
  check("lege plakactie geweigerd", (await admin.post(`/api/meetings/${mid}/items/bulk`, { items: [] })).status === 400);
  check("deelnemer mag geen agenda plakken", (await dee.client.post(`/api/meetings/${mid}/items/bulk`, { items: [{ title: "x" }] })).status === 404);
  m = await admin.get(`/api/meetings/${mid}`);
  check("7 hoofdpunten na plakken", tops().length === 7 && tops()[6].title === "Sluiting" && tops()[6].position === 7);

  const copy = await admin.post(`/api/overleggen/${overlegId}/meetings`, { title: "RvT kopie", startsAt: new Date(Date.now() + 40 * 86400e3).toISOString(), copyFromId: mid });
  const cm = await admin.get(`/api/meetings/${copy.data.id}`);
  const cTops = cm.data.items.filter((i) => !i.parentId);
  check("overnemen behoudt subpunten", cm.data.items.length === 14 && cTops.length === 7 && cm.data.items.filter((i) => i.parentId === cTops[1].id).length === 7 && cm.data.items.every((i) => i.id !== parent.id));

  check("hoofdpunt verwijderen verwijdert de subpunten", (await admin.del(`/api/items/${parent.id}`)).status === 200);
  m = await admin.get(`/api/meetings/${mid}`);
  check("na verwijderen 6 punten over", m.data.items.length === 6 && m.data.items.every((i) => !i.parentId));
  check("opruimen testvergaderingen", (await admin.del(`/api/meetings/${mid}`)).status === 200 && (await admin.del(`/api/meetings/${copy.data.id}`)).status === 200);
}

step("4. Stukken");
let smallDoc, bigDoc, hugeDoc;
{
  const text = Buffer.from("Agenda-bijlage: dit is een tekstbestand met een é.\n", "utf8");
  const up = await admin.upload({ meetingId, agendaItemId: itemIds[1] }, "Bijlage begroting.txt", "text/plain", text);
  check("klein stuk geüpload", up.status === 200, JSON.stringify(up));
  smallDoc = up.data.id;
  const res = await dee.client.raw("GET", `/api/documents/${smallDoc}/file`);
  const body = Buffer.from(await res.arrayBuffer());
  check("deelnemer downloadt klein stuk identiek", res.status === 200 && body.equals(text));
  check("tekst wordt inline getoond", res.headers.get("content-type").startsWith("text/plain") && res.headers.get("content-disposition").startsWith("inline"));
  check("nosniff-header", res.headers.get("x-content-type-options") === "nosniff");
  check("buitenstaander kan stuk niet openen", (await bui.client.raw("GET", `/api/documents/${smallDoc}/file`)).status === 404);
  check("anoniem kan stuk niet openen", (await new Client().raw("GET", `/api/documents/${smallDoc}/file`)).status === 401);

  const big = randomBytes(8_000_000);
  const upBig = await dee.client.upload({ meetingId }, "Tekeningen (groot).pdf", "application/pdf", big);
  check("deelnemer uploadt stuk van 8 MB in 3 delen", upBig.status === 200 && upBig.data.chunkCount === 3, JSON.stringify(upBig));
  bigDoc = upBig.data.id;
  const resBig = await admin.raw("GET", `/api/documents/${bigDoc}/file`);
  const bodyBig = Buffer.from(await resBig.arrayBuffer());
  check("stuk van 8 MB komt identiek terug", resBig.status === 200 && sha(bodyBig) === sha(big), `${bodyBig.length} bytes`);
  check("pdf inline", resBig.headers.get("content-type") === "application/pdf");
  const dl = await admin.raw("GET", `/api/documents/${bigDoc}/file?download=1`);
  await dl.arrayBuffer();
  check("download-variant is attachment", dl.headers.get("content-disposition").startsWith("attachment"));

  const html = Buffer.from("<script>alert(1)</script>");
  const upHtml = await admin.upload({ meetingId }, "gevaarlijk.html", "text/html", html);
  const resHtml = await admin.raw("GET", `/api/documents/${upHtml.data.id}/file`);
  await resHtml.arrayBuffer();
  check("html wordt nooit inline geserveerd", resHtml.headers.get("content-type") === "application/octet-stream" && resHtml.headers.get("content-disposition").startsWith("attachment"));
  check("beheerder verwijdert stuk", (await admin.del(`/api/documents/${upHtml.data.id}`)).status === 200);
  check("verwijderd stuk is weg", (await admin.raw("GET", `/api/documents/${upHtml.data.id}/file`)).status === 404);

  const huge = randomBytes(20_000_000);
  const upHuge = await admin.upload({ meetingId }, "Dossier 20MB.zip", "application/zip", huge);
  check("stuk van 20 MB geüpload", upHuge.status === 200 && upHuge.data.chunkCount === 6, JSON.stringify(upHuge));
  hugeDoc = upHuge.data.id;
  check("20 MB niet in één keer te streamen (413)", (await admin.raw("GET", `/api/documents/${hugeDoc}/file`)).status === 413);
  const parts = [];
  for (let n = 0; n < 6; n++) {
    const r = await dee.client.raw("GET", `/api/documents/${hugeDoc}/chunks/${n}`);
    parts.push(Buffer.from(await r.arrayBuffer()));
  }
  check("20 MB in delen komt identiek terug", sha(Buffer.concat(parts)) === sha(huge));

  check("deelnemer mag andermans stuk niet verwijderen", (await dee.client.del(`/api/documents/${smallDoc}`)).status === 403);
  check("leeg bestand geweigerd", (await admin.post("/api/documents", { meetingId, name: "leeg.txt", mime: "text/plain", size: 0 })).status === 400);
  check("te groot bestand geweigerd", (await admin.post("/api/documents", { meetingId, name: "groot.bin", mime: "x/y", size: 200 * 1024 * 1024 })).status === 400);
  const wrongSize = await admin.post("/api/documents", { meetingId, name: "klopt-niet.txt", mime: "text/plain", size: 10 });
  check("deel met verkeerde grootte geweigerd", (await admin.call("PUT", `/api/documents/${wrongSize.data.id}/chunks/0`, { binary: Buffer.alloc(11) })).status === 400);
  check("onvolledige upload niet af te ronden", (await admin.post(`/api/documents/${wrongSize.data.id}/complete`)).status === 409);

  check("deelnemer mag geen vaste stukken uploaden", (await dee.client.post("/api/documents", { overlegId, name: "reglement.pdf", mime: "application/pdf", size: 5 })).status === 403);
  const fixed = await admin.upload({ overlegId }, "Reglement.txt", "text/plain", Buffer.from("regels"));
  check("vast stuk geüpload", fixed.status === 200);
  check("deelnemer ziet vast stuk", (await dee.client.get(`/api/overleggen/${overlegId}`)).data.documents.some((d) => d.id === fixed.data.id));
  const m = await dee.client.get(`/api/meetings/${meetingId}`);
  check("stukken zichtbaar in vergadering (zonder onvolledige upload)", m.data.documents.length === 3, `${m.data.documents.length}`);
}

step("5. Besluiten en acties");
let decisionId, actionId;
{
  const year = new Date(startsAt).getFullYear();
  const d1 = await admin.post(`/api/meetings/${meetingId}/decisions`, { text: "De begroting 2027 is vastgesteld.", agendaItemId: itemIds[1] });
  check("besluit krijgt nummer 001", d1.status === 200 && d1.data.number === `${year}-001`, JSON.stringify(d1));
  decisionId = d1.data.id;
  const many = await Promise.all([1, 2, 3, 4, 5].map((n) => admin.post(`/api/meetings/${meetingId}/decisions`, { text: `Gelijktijdig besluit ${n}` })));
  const numbers = many.map((r) => r.data?.number).sort();
  check("gelijktijdige besluiten krijgen unieke opvolgende nummers", numbers.join() === [2, 3, 4, 5, 6].map((n) => `${year}-00${n}`).join(), numbers.join());
  check("deelnemer mag geen besluit vastleggen", (await dee.client.post(`/api/meetings/${meetingId}/decisions`, { text: "x" })).status === 403);
  check("besluit bij vreemd agendapunt geweigerd", (await admin.post(`/api/meetings/${meetingId}/decisions`, { text: "x", agendaItemId: "00000000-0000-4000-8000-000000000000" })).status === 400);

  const a = await admin.post(`/api/meetings/${meetingId}/actions`, { text: "Offertes opvragen bij drie partijen", ownerId: dee.id, dueDate: "2020-01-15", agendaItemId: itemIds[1] });
  check("actie vastgelegd", a.status === 200, JSON.stringify(a));
  actionId = a.data.id;
  check("actiehouder buiten overleg geweigerd", (await admin.post(`/api/meetings/${meetingId}/actions`, { text: "x", ownerId: bui.id })).status === 400);
  check("deelnemer mag eigen actie niet herschrijven", (await dee.client.patch(`/api/actions/${actionId}`, { text: "anders" })).status === 403);
  check("deelnemer meldt eigen actie af", (await dee.client.patch(`/api/actions/${actionId}`, { status: "gereed" })).status === 200);
  check("buitenstaander kan actie niet wijzigen", (await bui.client.patch(`/api/actions/${actionId}`, { status: "open" })).status === 404);
  await dee.client.patch(`/api/actions/${actionId}`, { status: "open" });
  const mine = await dee.client.get("/api/actions?mine=1");
  check("mijn acties", mine.data.actions.length === 1 && mine.data.actions[0].dueDate === "2020-01-15" && mine.data.actions[0].ownerName === "Dee Deelnemer", JSON.stringify(mine.data));
  check("buitenstaander ziet geen acties", (await bui.client.get("/api/actions")).data.actions.length === 0);
  const reg = await dee.client.get(`/api/decisions?overleg=${overlegId}`);
  check("besluitenlijst deelnemer", reg.data.decisions.length === 6 && reg.data.decisions[0].decidedOn.length === 10, JSON.stringify(reg.data.decisions[0]));
  check("buitenstaander ziet geen besluiten", (await bui.client.get("/api/decisions")).data.decisions.length === 0);

  check("deelnemer meldt zich af", (await dee.client.put(`/api/meetings/${meetingId}/attendance`, { status: "afwezig" })).status === 200);
  check("deelnemer mag aanwezigheid van ander niet zetten", (await dee.client.put(`/api/meetings/${meetingId}/attendance`, { userId: (await admin.get("/api/session")).data.user.id, status: "afwezig" })).status === 403);
  check("secretaris zet aanwezigheid", (await admin.put(`/api/meetings/${meetingId}/attendance`, { userId: dee.id, status: "aanwezig" })).status === 200);
  const m = await admin.get(`/api/meetings/${meetingId}`);
  check("aanwezigheid opgeslagen", m.data.members.find((x) => x.id === dee.id).attendance === "aanwezig");
}

step("6. Afronden, vergrendeling en overnemen");
let nextMeetingId;
{
  check("afronden", (await admin.patch(`/api/meetings/${meetingId}`, { status: "afgerond" })).status === 200);
  check("afgerond: agenda vergrendeld", (await admin.post(`/api/meetings/${meetingId}/items`, { title: "Te laat" })).status === 409);
  check("afgerond: titel vergrendeld", (await admin.patch(`/api/meetings/${meetingId}`, { title: "Anders" })).status === 409);
  check("afgerond: besluittekst vergrendeld", (await admin.patch(`/api/decisions/${decisionId}`, { text: "Herschreven" })).status === 409);
  check("afgerond: geen nieuwe stukken", (await dee.client.post("/api/documents", { meetingId, name: "nagekomen.txt", mime: "text/plain", size: 3 })).status === 409);
  check("afgerond: stuk niet te verwijderen", (await admin.del(`/api/documents/${smallDoc}`)).status === 409);
  check("afgerond: actie nog wel af te melden", (await dee.client.patch(`/api/actions/${actionId}`, { status: "gereed" })).status === 200);
  check("afgerond: besluit nog wel in te trekken", (await admin.patch(`/api/decisions/${decisionId}`, { status: "ingetrokken" })).status === 200);
  await dee.client.patch(`/api/actions/${actionId}`, { status: "open" });
  await admin.patch(`/api/decisions/${decisionId}`, { status: "genomen" });
  check("afgerond: verwijderen geblokkeerd", (await admin.del(`/api/meetings/${meetingId}`)).status === 409);
  check("heropenen", (await admin.patch(`/api/meetings/${meetingId}`, { status: "gepubliceerd" })).status === 200);
  check("vergadering met besluiten niet te verwijderen", (await admin.del(`/api/meetings/${meetingId}`)).status === 409);

  const next = await admin.post(`/api/overleggen/${overlegId}/meetings`, { title: "MT week 50", startsAt: new Date(Date.now() + 19 * 86400e3).toISOString(), durationMin: 60, copyFromId: meetingId });
  nextMeetingId = next.data.id;
  const nm = await admin.get(`/api/meetings/${nextMeetingId}`);
  check("agenda overgenomen zonder notulen", nm.data.items.length === 3 && nm.data.items.every((i) => i.notes === "") && nm.data.items[1].title === "Begroting 2027", JSON.stringify(nm.data.items.map((i) => i.title)));
  check("open actie staat op actielijst volgende vergadering", nm.data.carriedActions.length === 1 && nm.data.carriedActions[0].id === actionId);
  check("nieuwe vergadering heeft geen besluiten of stukken", nm.data.decisions.length === 0 && nm.data.documents.length === 0);
  const tmpDoc = await admin.upload({ meetingId: nextMeetingId }, "weg.txt", "text/plain", Buffer.from("weg"));
  check("conceptvergadering zonder besluiten verwijderen", (await admin.del(`/api/meetings/${nextMeetingId}`)).status === 200);
  check("stukken van verwijderde vergadering zijn weg", (await admin.raw("GET", `/api/documents/${tmpDoc.data.id}/file`)).status === 404);
}

step("7. Zoeken, dashboard, beheer");
{
  const s1 = await dee.client.get("/api/search?q=begroting");
  const types = new Set(s1.data.results.map((r) => r.type));
  check("zoeken vindt agendapunt, besluit en stuk", types.has("agendapunt") && types.has("besluit") && types.has("stuk"), [...types].join());
  check("zoeken in notulen", (await dee.client.get("/api/search?q=xyzzy")).data.results.length === 1);
  check("buitenstaander vindt niets", (await bui.client.get("/api/search?q=begroting")).data.results.length === 0);
  const spoof = new Client();
  spoof.cookie = bui.client.cookie;
  spoof.org = org1;
  check("zoeken in andere organisatie levert niets op", (await spoof.get("/api/search?q=begroting")).data.results.length === 0);
  check("jokertekens worden letterlijk genomen", (await dee.client.get("/api/search?q=%25%25")).data.results.length === 0);
  const dash = await dee.client.get("/api/dashboard");
  check("dashboard deelnemer", dash.data.myActions.length === 1 && dash.data.recentDecisions.length === 6 && dash.data.recentDocuments.length >= 3, JSON.stringify({ a: dash.data.myActions.length, d: dash.data.recentDecisions.length, s: dash.data.recentDocuments.length }));

  const users = await admin.get("/api/users");
  const me = users.data.users.find((u) => u.email === adminCreds.email);
  check("accountlijst met organisaties", users.data.users.find((u) => u.id === dee.id).organisations.join() === "Testbedrijf" && me.hasPassword);
  check("eigen beheerdersrol niet in te trekken", (await admin.patch(`/api/users/${me.id}`, { isAdmin: false })).status === 400);
  check("blokkeren", (await admin.patch(`/api/users/${bui.id}`, { active: false })).status === 200);
  check("geblokkeerde gebruiker is direct uitgelogd", (await bui.client.get("/api/overleggen")).status === 401);
  check("geblokkeerde gebruiker kan niet inloggen", (await new Client().post("/api/login", { email: bui.email, password: bui.password })).status === 401);

  const reset = await admin.post(`/api/users/${dee.id}/token`);
  check("resetlink gemaakt", reset.status === 200 && reset.data.purpose === "reset", JSON.stringify(reset));
  const fresh = new Client();
  fresh.org = org1;
  check("nieuw wachtwoord via resetlink", (await fresh.post(`/api/tokens/${reset.data.token}`, { password: "een-heel-nieuw-wachtwoord" })).status === 200);
  check("oude sessie vervalt na reset", (await dee.client.get("/api/overleggen")).status === 401);
  check("inloggen met oud wachtwoord mislukt", (await new Client().post("/api/login", { email: dee.email, password: dee.password })).status === 401);
  check("inloggen met nieuw wachtwoord", (await new Client().post("/api/login", { email: dee.email.toUpperCase(), password: "een-heel-nieuw-wachtwoord" })).status === 200);
  check("wachtwoord wijzigen met fout huidig wachtwoord", (await fresh.post("/api/account/password", { current: "fout", password: "nog-een-nieuw-wachtwoord" })).status === 400);
  check("wachtwoord wijzigen", (await fresh.post("/api/account/password", { current: "een-heel-nieuw-wachtwoord", password: "nog-een-nieuw-wachtwoord" })).status === 200);
  check("sessie blijft geldig na eigen wijziging", (await fresh.get("/api/overleggen")).status === 200);
  check("naam wijzigen", (await fresh.patch("/api/account", { name: "Dee de Deelnemer" })).status === 200);

  let last;
  for (let i = 0; i < 9; i++) last = await new Client().post("/api/login", { email: `brute-${RUN}@test.example`, password: `poging-${i}` });
  check("na 8 mislukte pogingen geblokkeerd (429)", last.status === 429, `${last.status}`);

  const audit = await admin.get("/api/audit");
  check("logboek gevuld", audit.data.entries.length > 10 && audit.data.entries.some((e) => e.action === "POST /api/meetings/:id/decisions"));
  const diag = await admin.get("/api/admin/diagnostics");
  check("diagnose", diag.status === 200 && typeof diag.data.dbRoundTripMs === "number", JSON.stringify(diag.data));
  console.log("  diagnose:", JSON.stringify(diag.data));
  check("instellingen opslaan", (await admin.put("/api/settings", { orgName: "Testorganisatie" })).status === 200);
  check("deelnemer mag instellingen niet wijzigen", (await fresh.put("/api/settings", { orgName: "Gekaapt" })).status === 403);

  check("uitloggen", (await fresh.post("/api/logout")).status === 200);
  check("na uitloggen 401", (await fresh.get("/api/overleggen")).status === 401);
  check("onbekende route 404", (await admin.get("/api/bestaat-niet")).status === 404);
}

if (process.env.CLEANUP === "1") {
  step("8. Opruimen: stukken van deze testrun verwijderen");
  const m = await admin.get(`/api/meetings/${meetingId}`);
  const o = await admin.get(`/api/overleggen/${overlegId}`);
  const docs = [...(m.data?.documents ?? []), ...(o.data?.documents ?? [])];
  for (const d of docs) check(`stuk ${d.name} verwijderd`, (await admin.del(`/api/documents/${d.id}`)).status === 200);
  console.log(`  ${docs.length} stukken verwijderd`);
}

console.log(`\n${passed} controles geslaagd, ${failures.length} mislukt`);
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join("\n"));
  process.exit(1);
}
