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
  async raw(method, path, { body, binary, origin = BASE, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
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
{
  const s = await admin.get("/api/session");
  check("sessie zonder login", s.status === 200 && s.data.user === null);
  if (s.data.setupNeeded) {
    const wrong = await admin.post("/api/setup", { code: "fout", name: "Bea Beheer", ...adminCreds });
    check("setup met foute code geweigerd", wrong.status === 403, JSON.stringify(wrong));
    const short = await admin.post("/api/setup", { code: SETUP_CODE, name: "Bea Beheer", email: adminCreds.email, password: "kort" });
    check("setup met te kort wachtwoord geweigerd", short.status === 400);
    const ok = await admin.post("/api/setup", { code: SETUP_CODE, name: "Bea Beheer", orgName: "Testorganisatie", ...adminCreds });
    check("setup gelukt", ok.status === 200 && ok.data.user.isAdmin === true, JSON.stringify(ok));
    check("sessiecookie gezet", admin.cookie.includes("vp_session="));
    const again = await new Client().post("/api/setup", { code: SETUP_CODE, name: "X", email: "x@test.example", password: "nog-een-lang-wachtwoord" });
    check("tweede setup geweigerd", again.status === 409, JSON.stringify(again));
  } else {
    const ok = await admin.post("/api/login", adminCreds);
    check("login beheerder (herhaalde run)", ok.status === 200, JSON.stringify(ok));
  }
  const s2 = await admin.get("/api/session");
  check("sessie na login", s2.data.user?.email === adminCreds.email && s2.data.orgName === "Testorganisatie", JSON.stringify(s2.data));
  const anon = await new Client().get("/api/overleggen");
  check("zonder login 401", anon.status === 401);
  const csrf = await admin.call("POST", "/api/overleggen", { body: { name: "CSRF" }, origin: "https://kwaadaardig.example" });
  check("verkeerde herkomst geweigerd", csrf.status === 403, JSON.stringify(csrf));
  const noOrigin = await admin.call("POST", "/api/overleggen", { body: { name: "CSRF" }, origin: null });
  check("ontbrekende herkomst geweigerd", noOrigin.status === 403);
  const wrongPw = await new Client().post("/api/login", { email: adminCreds.email, password: "helemaal-fout-wachtwoord" });
  check("fout wachtwoord 401", wrongPw.status === 401);
}

step("2. Overleg, gebruikers en uitnodigingen");
const overlegId = (await admin.post("/api/overleggen", { name: `MT-overleg ${RUN}`, organisation: "Testbedrijf", description: "Tweewekelijks" })).data.id;
check("overleg aangemaakt", !!overlegId);
{
  const list = await admin.get("/api/overleggen");
  const o = list.data.overleggen.find((x) => x.id === overlegId);
  check("overleg in lijst met rol secretaris en organisatie", o?.role === "secretaris" && o.memberCount === 1 && o.organisation === "Testbedrijf", JSON.stringify(o));
}
async function invite(name, email, memberships) {
  const created = await admin.post("/api/users", { name, email, memberships });
  check(`gebruiker ${name} aangemaakt`, created.status === 200 && !!created.data.token, JSON.stringify(created));
  const c = new Client();
  const info = await c.get(`/api/tokens/${created.data.token}`);
  check(`uitnodiging ${name} geldig`, info.status === 200 && info.data.purpose === "invite" && info.data.email === email);
  const short = await c.post(`/api/tokens/${created.data.token}`, { password: "kort" });
  check("kort wachtwoord geweigerd, link blijft geldig", short.status === 400);
  const password = `wachtwoord-van-${name.toLowerCase().replace(/\W/g, "")}`;
  const accept = await c.post(`/api/tokens/${created.data.token}`, { password });
  check(`uitnodiging ${name} geaccepteerd`, accept.status === 200 && accept.data.user.email === email, JSON.stringify(accept));
  const reuse = await new Client().post(`/api/tokens/${created.data.token}`, { password });
  check("link werkt maar één keer", reuse.status === 404);
  return { client: c, id: created.data.id, email, password };
}
const dee = await invite("Dee Deelnemer", `dee-${RUN}@test.example`, [{ overlegId, role: "deelnemer" }]);
const bui = await invite("Bui Buitenstaander", `bui-${RUN}@test.example`, []);
{
  const dup = await admin.post("/api/users", { name: "Dubbel", email: dee.email.toUpperCase() });
  check("dubbel e-mailadres geweigerd", dup.status === 409);
  const notAdmin = await dee.client.get("/api/users");
  check("deelnemer mag gebruikerslijst niet zien", notAdmin.status === 403);
  const dir = await admin.get("/api/users/directory");
  check("er is geen namenlijst van alle accounts meer", dir.status >= 400 && !dir.data?.users, JSON.stringify(dir));
  const d = await admin.get(`/api/overleggen/${overlegId}`);
  check("overlegdetail met 2 leden", d.data.members.length === 2 && d.data.role === "secretaris", JSON.stringify(d.data.members));
  check("buitenstaander ziet overleg niet", (await bui.client.get(`/api/overleggen/${overlegId}`)).status === 404);
  check("buitenstaander heeft lege lijst", (await bui.client.get("/api/overleggen")).data.overleggen.length === 0);
  check("deelnemer mag geen leden beheren", (await dee.client.put(`/api/overleggen/${overlegId}/members/${bui.id}`, { role: "deelnemer" })).status === 403);
}

step("2b. Meerdere organisaties: de secretaris nodigt zelf uit, zonder namenlijst");
{
  const overleg2 = (await admin.post("/api/overleggen", { name: `Commissie ${RUN}`, organisation: "Testcommissie" })).data.id;
  const sec = await invite("Sec Secretaris", `sec-${RUN}@test.example`, [{ overlegId: overleg2, role: "secretaris" }]);
  check("secretaris ziet geen gebruikerslijst", (await sec.client.get("/api/users")).status === 403);
  check("secretaris ziet het andere overleg niet", (await sec.client.get(`/api/overleggen/${overlegId}`)).status === 404);
  const noName = await sec.client.post(`/api/overleggen/${overleg2}/members`, { email: `nia-${RUN}@test.example` });
  check("nieuwe persoon zonder naam: naam wordt gevraagd", noName.status === 422, JSON.stringify(noName));
  const created = await sec.client.post(`/api/overleggen/${overleg2}/members`, { email: `Nia-${RUN}@Test.example`, name: "Nia Nieuw", role: "deelnemer" });
  check("secretaris maakt account met uitnodigingslink", created.status === 200 && created.data.created === true && !!created.data.token, JSON.stringify(created));
  const again = await sec.client.post(`/api/overleggen/${overleg2}/members/${created.data.userId}/invite`);
  check("nieuwe link voor wie nog niet activeerde", again.status === 200 && again.data.purpose === "invite", JSON.stringify(again));
  check("eerdere link vervalt", (await new Client().get(`/api/tokens/${created.data.token}`)).status === 404);
  const nia = new Client();
  check("uitgenodigde activeert account", (await nia.post(`/api/tokens/${again.data.token}`, { password: "nia-kiest-een-wachtwoord" })).status === 200);
  const seen = await nia.get("/api/overleggen");
  check("uitgenodigde ziet alleen het eigen overleg", seen.data.overleggen.length === 1 && seen.data.overleggen[0].id === overleg2 && seen.data.overleggen[0].organisation === "Testcommissie");
  check("geen uitnodigingslink voor een actief account", (await sec.client.post(`/api/overleggen/${overleg2}/members/${created.data.userId}/invite`)).status === 403);
  const existing = await sec.client.post(`/api/overleggen/${overleg2}/members`, { email: dee.email.toUpperCase() });
  check("bestaand account wordt gekoppeld, zonder link", existing.status === 200 && existing.data.created === false && !existing.data.token, JSON.stringify(existing));
  check("dubbel toevoegen geweigerd", (await sec.client.post(`/api/overleggen/${overleg2}/members`, { email: dee.email })).status === 409);
  check("secretaris kan niemand toevoegen aan andermans overleg", (await sec.client.post(`/api/overleggen/${overlegId}/members`, { email: dee.email })).status === 404);
  check("deelnemer kan niemand toevoegen", (await dee.client.post(`/api/overleggen/${overleg2}/members`, { email: `x-${RUN}@test.example`, name: "X" })).status === 403);
  check("secretaris wijzigt organisatie van eigen overleg", (await sec.client.patch(`/api/overleggen/${overleg2}`, { organisation: "Testcommissie Noord" })).status === 200);
  check("secretaris haalt deelnemer uit het overleg", (await sec.client.del(`/api/overleggen/${overleg2}/members/${dee.id}`)).status === 200);
  check("verwijderde deelnemer ziet het overleg niet meer", (await dee.client.get(`/api/overleggen/${overleg2}`)).status === 404);
}

step("3. Vergadering en agenda");
const startsAt = new Date(Date.now() + 5 * 86400e3).toISOString();
const meetingId = (await admin.post(`/api/overleggen/${overlegId}/meetings`, { title: "MT week 48", startsAt, durationMin: 90, location: "Kantoor", onlineUrl: "https://teams.example/abc" })).data.id;
check("vergadering aangemaakt", !!meetingId);
check("ongeldige online link geweigerd", (await admin.post(`/api/overleggen/${overlegId}/meetings`, { title: "X", startsAt, onlineUrl: "javascript:alert(1)" })).status === 400);
check("concept onzichtbaar voor deelnemer", (await dee.client.get(`/api/meetings/${meetingId}`)).status === 404);
check("concept niet op dashboard deelnemer", (await dee.client.get("/api/dashboard")).data.upcoming.length === 0);
const itemIds = [];
for (const [title, kind, durationMin] of [["Opening en mededelingen", "informatie", 10], ["Begroting 2027", "besluit", 40], ["Rondvraag", "bespreking", null]]) {
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
  check("deelnemer ziet gepubliceerde vergadering met organisatie", md.status === 200 && md.data.role === "deelnemer" && md.data.items.length === 3 && md.data.meeting.organisation === "Testbedrijf");
  check("deelnemer mag agenda niet wijzigen", (await dee.client.post(`/api/meetings/${meetingId}/items`, { title: "Stiekem" })).status === 403);
  check("deelnemer mag notulen niet wijzigen", (await dee.client.patch(`/api/items/${itemIds[0]}`, { notes: "x" })).status === 403);
  check("buitenstaander ziet vergadering niet", (await bui.client.get(`/api/meetings/${meetingId}`)).status === 404);
  check("dashboard deelnemer toont vergadering", (await dee.client.get("/api/dashboard")).data.upcoming.some((u) => u.id === meetingId));
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
  check("jokertekens worden letterlijk genomen", (await dee.client.get("/api/search?q=%25%25")).data.results.length === 0);
  const dash = await dee.client.get("/api/dashboard");
  check("dashboard deelnemer", dash.data.myActions.length === 1 && dash.data.recentDecisions.length === 6 && dash.data.recentDocuments.length >= 3, JSON.stringify({ a: dash.data.myActions.length, d: dash.data.recentDecisions.length, s: dash.data.recentDocuments.length }));

  const users = await admin.get("/api/users");
  const me = users.data.users.find((u) => u.email === adminCreds.email);
  check("gebruikerslijst met lidmaatschappen", users.data.users.find((u) => u.id === dee.id).memberships.length === 1 && me.hasPassword);
  check("eigen beheerdersrol niet in te trekken", (await admin.patch(`/api/users/${me.id}`, { isAdmin: false })).status === 400);
  check("blokkeren", (await admin.patch(`/api/users/${bui.id}`, { active: false })).status === 200);
  check("geblokkeerde gebruiker is direct uitgelogd", (await bui.client.get("/api/overleggen")).status === 401);
  check("geblokkeerde gebruiker kan niet inloggen", (await new Client().post("/api/login", { email: bui.email, password: bui.password })).status === 401);

  const reset = await admin.post(`/api/users/${dee.id}/token`);
  check("resetlink gemaakt", reset.status === 200 && reset.data.purpose === "reset", JSON.stringify(reset));
  const fresh = new Client();
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
