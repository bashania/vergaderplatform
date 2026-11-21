// End-to-end test van de API. Draait tegen een lege (of eerder door dit script gevulde) database.
//   BASE=http://localhost:8888 SETUP_CODE=lokale-testcode node scripts/e2e.mjs
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { startFakePlaud } from "./fake-plaud.mjs";
import { SoftAuthenticator } from "./soft-authenticator.mjs";

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

step("0. Bewaking: de health-controle start een zelftest als er nog geen is");
{
  const first = await new Client().get("/api/health");
  check("health werkt op een leeg platform", first.status === 200 && first.data.db === "ok", JSON.stringify(first.data));
  if (first.data.zelftest === null) {
    let z = null;
    for (let i = 0; i < 40 && !z; i++) {
      await new Promise((r) => setTimeout(r, 500));
      z = (await new Client().get("/api/health")).data.zelftest;
    }
    check("de zelftest is in de achtergrond gedaan en de uitslag staat in health", z?.door === "bewaking" && z.db === "ok" && z.blobs === "ok" && z.ai === "ok" && z.mail === "uit" && !Number.isNaN(Date.parse(z.op)), JSON.stringify(z));
    const again = (await new Client().get("/api/health")).data.zelftest;
    check("een verse uitslag start geen nieuwe zelftest", again.op === z?.op);
  } else {
    console.log("  (database was al gevuld: de start vanuit health is niet opnieuw getest)");
  }
}

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

step("2c. Passkeys: inloggen zonder wachtwoord en tweestapsverificatie per organisatie");
{
  /** Maakt een passkey aan voor de ingelogde gebruiker van deze client. */
  const enrol = async (client, authenticator, name) => {
    const opt = await client.post("/api/account/passkeys/options");
    if (opt.status !== 200) return opt;
    return client.post("/api/account/passkeys", { challengeId: opt.data.challengeId, response: authenticator.create(opt.data.options), name });
  };
  /** Logt een schone client in met een passkey. */
  const passkeyLogin = async (authenticator, mutate) => {
    const client = new Client();
    const opt = await client.post("/api/passkeys/login/options");
    const response = authenticator.get(opt.data.options);
    if (mutate) mutate(response);
    const res = await client.post("/api/passkeys/login", { challengeId: opt.data.challengeId, response });
    return { client, res };
  };

  // Eerste passkey vanuit een wachtwoordsessie.
  const secKey = new SoftAuthenticator(BASE);
  let s = await sec.client.get("/api/session");
  check("sessie begint zonder passkey", s.data.user.strong === false && s.data.user.passkeys === 0 && s.data.user.hasPassword === true, JSON.stringify(s.data.user));
  const opt = await sec.client.post("/api/account/passkeys/options");
  check("registratie eist vingerafdruk/pincode en een vindbare passkey", opt.status === 200 && opt.data.options.rp.id === new URL(BASE).hostname && opt.data.options.authenticatorSelection.userVerification === "required" && opt.data.options.authenticatorSelection.residentKey === "required", JSON.stringify(opt.data?.options?.authenticatorSelection));
  const created = secKey.create(opt.data.options);
  const reg = await sec.client.post("/api/account/passkeys", { challengeId: opt.data.challengeId, response: created, name: "Testlaptop" });
  check("eerste passkey geregistreerd", reg.status === 200, JSON.stringify(reg));
  check("uitdaging werkt maar één keer", (await sec.client.post("/api/account/passkeys", { challengeId: opt.data.challengeId, response: created, name: "x" })).status === 400);
  s = await sec.client.get("/api/session");
  check("sessie telt nu als passkey-sessie", s.data.user.strong === true && s.data.user.passkeys === 1, JSON.stringify(s.data.user));
  const mine = await sec.client.get("/api/account/passkeys");
  check("passkey staat in het account", mine.data.passkeys.length === 1 && mine.data.passkeys[0].name === "Testlaptop");

  // Inloggen zonder wachtwoord.
  const viaKey = await passkeyLogin(secKey);
  check("inloggen met passkey, zonder wachtwoord", viaKey.res.status === 200 && viaKey.res.data.user.email === sec.email, JSON.stringify(viaKey.res));
  check("passkey-sessie is sterk", (await viaKey.client.get("/api/session")).data.user.strong === true);
  const tampered = await passkeyLogin(secKey, (r) => {
    const sig = Buffer.from(r.response.signature, "base64url");
    sig[sig.length - 1] ^= 1;
    r.response.signature = sig.toString("base64url");
  });
  check("vervalste handtekening geweigerd", tampered.res.status === 401, JSON.stringify(tampered.res));
  const phishing = new SoftAuthenticator("https://nep-vergaderplatform.example");
  phishing.credentials = secKey.credentials;
  check("passkey werkt niet vanaf een ander adres (phishing)", (await passkeyLogin(phishing)).res.status === 401);
  const stranger = new SoftAuthenticator(BASE);
  stranger.create({ challenge: "x", user: { id: "x" } });
  check("onbekende passkey geweigerd", (await passkeyLogin(stranger)).res.status === 401);
  const replay = new Client();
  const o1 = await replay.post("/api/passkeys/login/options");
  const o2 = await replay.post("/api/passkeys/login/options");
  check("antwoord op een andere uitdaging geweigerd", (await replay.post("/api/passkeys/login", { challengeId: o2.data.challengeId, response: secKey.get(o1.data.options) })).status === 401);

  // Een wachtwoordsessie blijft mogelijk, maar is niet sterk en mag niets aan de passkeys veranderen.
  const byPassword = new Client();
  await byPassword.post("/api/login", { email: sec.email, password: sec.password });
  check("wachtwoordsessie is niet sterk", (await byPassword.get("/api/session")).data.user.strong === false);
  check("extra passkey vanuit wachtwoordsessie geweigerd", (await byPassword.post("/api/account/passkeys/options")).status === 403);
  check("passkey verwijderen vanuit wachtwoordsessie geweigerd", (await byPassword.del(`/api/account/passkeys/${created.id}`)).status === 403);
  check("wachtwoord verwijderen vanuit wachtwoordsessie geweigerd", (await byPassword.del("/api/account/password")).status === 403);

  // Passkey verplichten voor organisatie 2.
  const adminIn2 = new Client();
  adminIn2.cookie = admin.cookie;
  adminIn2.org = org2;
  check("passkey-eis instellen zonder passkey-sessie geweigerd", (await adminIn2.patch(`/api/organisations/${org2}`, { requirePasskey: true })).status === 403);
  const adminKey = new SoftAuthenticator(BASE);
  check("beheerder maakt passkey aan", (await enrol(admin, adminKey, "Beheer-pc")).status === 200);
  adminIn2.cookie = admin.cookie;
  check("passkey-eis instellen", (await adminIn2.patch(`/api/organisations/${org2}`, { requirePasskey: true })).status === 200);
  check("sessie toont de eis", (await adminIn2.get("/api/session")).data.organisations.find((o) => o.id === org2).requirePasskey === true);
  const besloten = (await adminIn2.post(`/api/overleggen/${overleg2}/meetings`, { title: "Besloten vergadering", startsAt: new Date(Date.now() + 9 * 86400e3).toISOString() })).data.id;
  await adminIn2.patch(`/api/meetings/${besloten}`, { status: "gepubliceerd" });
  const geheim = await adminIn2.upload({ meetingId: besloten }, "Cijfers.txt", "text/plain", Buffer.from("vertrouwelijk"));

  // Zonder passkey-sessie is de hele organisatie dicht, op elk pad.
  const locked = await bui.client.get("/api/overleggen");
  check("overzicht geblokkeerd zonder passkey", locked.status === 403 && locked.data.code === "passkey_required" && locked.data.organisationId === org2, JSON.stringify(locked));
  check("overleg geblokkeerd zonder passkey", (await bui.client.get(`/api/overleggen/${overleg2}`)).status === 403);
  check("vergadering geblokkeerd zonder passkey", (await bui.client.get(`/api/meetings/${besloten}`)).status === 403);
  check("stuk geblokkeerd zonder passkey", (await bui.client.raw("GET", `/api/documents/${geheim.data.id}/file`)).status === 403);
  check("dashboard en zoeken geblokkeerd zonder passkey", (await bui.client.get("/api/dashboard")).status === 403 && (await bui.client.get("/api/search?q=besloten")).status === 403);
  byPassword.org = org2;
  check("ook wie een passkey heeft maar met wachtwoord inlogde is geblokkeerd", (await byPassword.get("/api/overleggen")).status === 403);
  viaKey.client.org = org2;
  check("passkey-sessie heeft toegang", (await viaKey.client.get("/api/overleggen")).status === 200 && (await viaKey.client.get(`/api/meetings/${besloten}`)).status === 200);
  check("buitenstaander krijgt geen hint over de passkey-eis", (await dee.client.get(`/api/overleggen/${overleg2}`)).status === 404);
  check("organisatie zonder eis blijft bereikbaar met wachtwoord", (await dee.client.get("/api/overleggen")).status === 200);
  const adminByPassword = new Client();
  await adminByPassword.post("/api/login", adminCreds);
  adminByPassword.org = org2;
  check("passkey-eis niet uit te zetten vanuit een wachtwoordsessie van de beheerder", (await adminByPassword.patch(`/api/organisations/${org2}`, { requirePasskey: false })).status === 403);

  // Wie nog geen passkey heeft, maakt er een aan en kan direct verder.
  const buiKey = new SoftAuthenticator(BASE);
  check("deelnemer maakt eerste passkey aan", (await enrol(bui.client, buiKey, "Telefoon")).status === 200);
  check("daarna direct toegang", (await bui.client.get("/api/overleggen")).status === 200 && (await bui.client.raw("GET", `/api/documents/${geheim.data.id}/file`)).status === 200);
  const people = await adminIn2.get(`/api/organisations/${org2}/people`);
  check("beheerder ziet wie een passkey heeft", people.data.people.find((p) => p.id === bui.id).hasPasskey === true && people.data.people.some((p) => p.hasPasskey === false));

  // Uitnodiging accepteren met een passkey: een account zonder wachtwoord.
  const pia = await adminIn2.post(`/api/overleggen/${overleg2}/members`, { email: `pia-${RUN}@test.example`, name: "Pia Passkey" });
  const piaClient = new Client();
  piaClient.org = org2;
  check("uitnodiging biedt een passkey aan", (await piaClient.get(`/api/tokens/${pia.data.token}`)).data.canUsePasskey === true);
  const piaKey = new SoftAuthenticator(BASE);
  const po = await piaClient.post(`/api/tokens/${pia.data.token}/passkey/options`);
  const pv = await piaClient.post(`/api/tokens/${pia.data.token}/passkey`, { challengeId: po.data.challengeId, response: piaKey.create(po.data.options), name: "iPhone" });
  check("uitnodiging geaccepteerd met passkey", pv.status === 200 && pv.data.user.email === `pia-${RUN}@test.example`, JSON.stringify(pv));
  const piaSession = await piaClient.get("/api/session");
  check("account zonder wachtwoord, sterke sessie, direct toegang", piaSession.data.user.strong === true && piaSession.data.user.hasPassword === false && (await piaClient.get("/api/overleggen")).status === 200);
  check("link daarna verbruikt", (await new Client().get(`/api/tokens/${pia.data.token}`)).status === 404);
  const members = await adminIn2.get(`/api/overleggen/${overleg2}`);
  check("account met alleen een passkey telt als geactiveerd", members.data.members.find((m) => m.id === pia.data.userId).activated === true);
  check("geen nieuwe uitnodigingslink voor een account met passkey", (await adminIn2.post(`/api/overleggen/${overleg2}/members/${pia.data.userId}/invite`)).status === 403);
  check("inloggen met wachtwoord kan niet bij een passkey-account", (await new Client().post("/api/login", { email: `pia-${RUN}@test.example`, password: "een-geraden-wachtwoord" })).status === 401);
  const piaKeys = await piaClient.get("/api/account/passkeys");
  check("enige passkey zonder wachtwoord is niet te verwijderen", (await piaClient.del(`/api/account/passkeys/${piaKeys.data.passkeys[0].id}`)).status === 409);
  check("wachtwoord instellen vanuit passkey-sessie", (await piaClient.post("/api/account/password", { password: "pia-kiest-toch-een-wachtwoord" })).status === 200);
  check("sessie blijft sterk na instellen wachtwoord", (await piaClient.get("/api/session")).data.user.strong === true);
  check("wachtwoord weer verwijderen", (await piaClient.del("/api/account/password")).status === 200);

  // Apparaat kwijt: de platformbeheerder wist de passkeys.
  check("deelnemer mag passkeys van een ander niet wissen", (await piaClient.del(`/api/users/${bui.id}/passkeys`)).status === 403);
  check("platformbeheerder wist passkeys", (await admin.del(`/api/users/${pia.data.userId}/passkeys`)).status === 200);
  check("daarna is de sessie weg", (await piaClient.get("/api/session")).data.user === null);
  check("en werkt de oude passkey niet meer", (await passkeyLogin(piaKey)).res.status === 401);
  const again = await admin.post(`/api/users/${pia.data.userId}/token`);
  check("nieuwe link biedt weer een passkey aan", again.status === 200 && (await new Client().get(`/api/tokens/${again.data.token}`)).data.canUsePasskey === true);

  // Eis weer uit, zodat de rest van de test met wachtwoordsessies verder kan.
  check("passkey-eis uitzetten", (await adminIn2.patch(`/api/organisations/${org2}`, { requirePasskey: false })).status === 200);
  check("daarna weer bereikbaar met wachtwoord", (await byPassword.get("/api/overleggen")).status === 200);
  check("opruimen besloten vergadering", (await adminIn2.del(`/api/documents/${geheim.data.id}`)).status === 200 && (await adminIn2.del(`/api/meetings/${besloten}`)).status === 200);
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

step("5b. Vergadermodus en AI-assistent");
{
  const livePath = `/api/meetings/${meetingId}/live`;
  const meetingPath = `/api/meetings/${meetingId}`;
  const before = await admin.get(meetingPath);
  const tops = before.data.items.filter((i) => !i.parentId);

  const live0 = await dee.client.get(livePath);
  check("stand van de vergadermodus voor deelnemer", live0.status === 200 && live0.data.liveStartedAt === null && typeof live0.data.version === "string", JSON.stringify(live0.data));
  check("buitenstaander ziet de vergadermodus niet", (await bui.client.get(livePath)).status === 404);
  check("deelnemer mag de vergadering niet starten", (await dee.client.post(livePath, { action: "start" })).status === 403);
  check("onbekende actie geweigerd", (await admin.post(livePath, { action: "pauze" })).status === 400);

  const started = await admin.post(livePath, { action: "start" });
  check("starten begint bij het eerste agendapunt", started.status === 200 && started.data.liveItemId === tops[0].id && !!started.data.liveStartedAt, JSON.stringify(started.data));
  check("versie verandert bij starten", started.data.version !== live0.data.version);
  check("deelnemer ziet het actuele punt", (await dee.client.get(livePath)).data.liveItemId === tops[0].id);
  check("dashboard toont de lopende vergadering", (await dee.client.get("/api/dashboard")).data.upcoming.some((m) => m.id === meetingId && m.live === true));
  const again = await admin.post(livePath, { action: "start" });
  check("opnieuw starten laat de klok doorlopen", again.data.liveItemStartedAt === started.data.liveItemStartedAt && again.data.liveStartedAt === started.data.liveStartedAt);

  await new Promise((r) => setTimeout(r, 1200));
  const moved = await admin.post(livePath, { action: "goto", itemId: tops[1].id });
  check("naar het volgende punt", moved.status === 200 && moved.data.liveItemId === tops[1].id && moved.data.version !== started.data.version);
  const during = await admin.get(meetingPath);
  check("bestede tijd geteld bij het verlaten punt", during.data.items.find((i) => i.id === tops[0].id).spentSec >= 1, JSON.stringify(during.data.items.map((i) => i.spentSec)));
  check("vergadering meldt dat ze bezig is", during.data.meeting.liveItemId === tops[1].id && !!during.data.meeting.liveStartedAt);
  check("punt van een andere vergadering geweigerd", (await admin.post(livePath, { action: "goto", itemId: "00000000-0000-4000-8000-000000000000" })).status === 400);
  const v1 = (await dee.client.get(livePath)).data.version;
  await admin.patch(`/api/items/${tops[1].id}`, { notes: `${tops[1].notes} De vergadering stemt in met het jaarplan. Dee stuurt de offerte voor 15 januari naar de leden.`.trim() });
  check("versie verandert bij nieuwe notulen", (await dee.client.get(livePath)).data.version !== v1);

  const stopped = await admin.post(livePath, { action: "stop" });
  check("vergadermodus beëindigen", stopped.status === 200 && stopped.data.liveStartedAt === null && stopped.data.liveItemId === null);
  const draft = await admin.post(`/api/overleggen/${overlegId}/meetings`, { title: "Concept voor vergadermodus", startsAt, items: [{ title: "Punt" }] });
  check("een concept kan niet starten", (await admin.post(`/api/meetings/${draft.data.id}/live`, { action: "start" })).status === 409);
  check("testconcept opgeruimd", (await admin.del(`/api/meetings/${draft.data.id}`)).status === 200);
  // Loopt door tot stap 6: afronden moet de vergadermodus beëindigen.
  await admin.post(livePath, { action: "start" });

  // --- AI-assistent (lokaal met vaste antwoorden, AI_FAKE=1) ---
  const orgPath = `/api/organisations/${org1}`;
  const proposalsPath = `/api/meetings/${meetingId}/ai/proposals`;
  const summaryPath = `/api/documents/${smallDoc}/ai/summary`;
  const session = await admin.get("/api/session");
  check("assistent beschikbaar maar per organisatie uit", session.data.aiAvailable === true && session.data.organisations.find((o) => o.id === org1).aiEnabled === false);
  check("uit: geen voorstellen", (await admin.post(proposalsPath)).status === 403);
  check("uit: geen samenvatting", (await dee.client.post(summaryPath)).status === 403);
  check("deelnemer mag de assistent niet aanzetten", (await dee.client.patch(orgPath, { aiEnabled: true })).status === 403);
  check("beheerder zet de assistent aan", (await admin.patch(orgPath, { aiEnabled: true })).status === 200);
  check("sessie meldt assistent aan", (await dee.client.get("/api/session")).data.organisations.find((o) => o.id === org1).aiEnabled === true);

  const prop = await admin.post(proposalsPath);
  check("voorstellen uit de notulen", prop.status === 200 && prop.data.decisions.length === 1 && prop.data.actions.length === 1, JSON.stringify(prop.data));
  check(
    "voorstel gekoppeld aan agendapunt, actiehouder en deadline",
    prop.data.decisions[0]?.agendaItemId === tops[1].id && prop.data.actions[0]?.ownerId === dee.id && /^\d{4}-01-15$/.test(prop.data.actions[0]?.dueDate ?? ""),
    JSON.stringify(prop.data),
  );
  const after = await admin.get(meetingPath);
  check("voorstellen leggen zelf niets vast", after.data.decisions.length === before.data.decisions.length && after.data.actions.length === before.data.actions.length);
  check("deelnemer kan geen voorstellen vragen", (await dee.client.post(proposalsPath)).status === 403);
  check("buitenstaander kan geen voorstellen vragen", (await bui.client.post(proposalsPath)).status === 404);

  const sum = await dee.client.post(summaryPath);
  check("samenvatting van een tekststuk", sum.status === 200 && sum.data.cached === false && sum.data.summary.includes("Kernpunten") && !!sum.data.at, JSON.stringify(sum.data));
  const cached = await dee.client.post(summaryPath);
  check("tweede keer komt de samenvatting uit de opslag", cached.status === 200 && cached.data.cached === true && cached.data.summary === sum.data.summary);
  check("deelnemer mag andermans samenvatting niet vernieuwen", (await dee.client.post(summaryPath, { refresh: true })).status === 403);
  check("secretaris mag de samenvatting vernieuwen", (await admin.post(summaryPath, { refresh: true })).data.cached === false);
  check("buitenstaander krijgt geen samenvatting", (await bui.client.post(summaryPath)).status === 404);
  const docs = (await admin.get(meetingPath)).data.documents;
  check("vergadering toont welk stuk een samenvatting heeft", docs.find((d) => d.id === smallDoc).hasSummary === true && docs.filter((d) => d.hasSummary).length === 1);
  const pdf = docs.find((d) => d.name.endsWith(".pdf"));
  const zip = docs.find((d) => d.name.endsWith(".zip"));
  check("pdf samenvatten", !!pdf && (await admin.post(`/api/documents/${pdf.id}/ai/summary`)).status === 200);
  check("zip is niet samen te vatten (415)", !!zip && (await admin.post(`/api/documents/${zip.id}/ai/summary`)).status === 415);

  const usage = await admin.get(`${orgPath}/ai`);
  check("verbruik zichtbaar voor de beheerder", usage.status === 200 && usage.data.enabled === true && usage.data.month.calls >= 4, JSON.stringify(usage.data));
  check("deelnemer ziet het verbruik niet", (await dee.client.get(`${orgPath}/ai`)).status === 403);
  const test = await admin.post("/api/admin/ai/test");
  check("verbindingstest", test.status === 200 && test.data.ok === true && test.data.reply === "werkt", JSON.stringify(test.data));
  check("verbindingstest alleen voor de platformbeheerder", (await dee.client.post("/api/admin/ai/test")).status === 403);

  check("assistent weer uit", (await admin.patch(orgPath, { aiEnabled: false })).status === 200);
  check("bestaande samenvatting blijft leesbaar", (await dee.client.post(summaryPath)).data.cached === true);
  check("nieuwe samenvatting dan niet meer", !!zip && (await admin.post(`/api/documents/${zip.id}/ai/summary`)).status === 403);
}

step("5c. Transcript, koppeling met Plaud en concept-notulen");
{
  // Nagebouwde Plaud-server; de lokale server wijst ernaar met PLAUD_MCP_URL (zie README).
  const plaud = await startFakePlaud(8899);
  const tPath = `/api/meetings/${meetingId}/transcript`;
  const today = new Date().toISOString().slice(0, 10);

  const status0 = await admin.get("/api/plaud");
  check("Plaud beschikbaar, nog niet gekoppeld", status0.status === 200 && status0.data.available === true && status0.data.connected === false, JSON.stringify(status0.data));
  check("zonder koppeling geen opnames", (await admin.get(`/api/plaud/recordings?from=${today}&to=${today}`)).status === 409);

  /** Doorloopt het inloggen bij (de nagebouwde) Plaud en geeft het pad van de terugkeer naar het platform. */
  async function consent(client) {
    const start = await client.post("/api/plaud/connect");
    if (start.status !== 200) return { start };
    const authorize = new URL(start.data.url);
    const atPlaud = await fetch(authorize, { redirect: "manual" });
    const back = new URL(atPlaud.headers.get("location"));
    return { start, authorize, callback: back.pathname + back.search };
  }
  const first = await consent(admin);
  check(
    "koppelen start met PKCE en een eigen terugkeeradres",
    first.start.status === 200 &&
      first.authorize.searchParams.get("code_challenge_method") === "S256" &&
      first.authorize.searchParams.get("redirect_uri") === `${BASE}/api/plaud/callback` &&
      first.authorize.searchParams.get("resource") === plaud.url,
    JSON.stringify(first.start.data),
  );
  const stolen = await dee.client.raw("GET", first.callback);
  check("terugkeer door een andere gebruiker wordt geweigerd", stolen.status === 302 && stolen.headers.get("location") === "/account?plaud=mislukt");
  const done = await admin.raw("GET", first.callback);
  check("terugkeer rondt de koppeling af", done.status === 302 && done.headers.get("location") === "/account?plaud=gekoppeld", done.headers.get("location") ?? "");
  const replay = await admin.raw("GET", first.callback);
  check("dezelfde terugkeer werkt maar één keer", replay.headers.get("location") === "/account?plaud=mislukt");
  check("terugkeer zonder sessie geeft een nette melding", (await new Client().raw("GET", "/api/plaud/callback?code=x&state=y")).headers.get("location") === "/account?plaud=mislukt");
  check("gekoppeld", (await admin.get("/api/plaud")).data.connected === true);
  check("de koppeling is persoonlijk", (await dee.client.get("/api/plaud")).data.connected === false);

  const recs = await admin.get(`/api/plaud/recordings?from=${today}&to=${today}`);
  check("opnames van vandaag", recs.status === 200 && recs.data.recordings.length === 2 && recs.data.recordings[0].durationMin === 60 && !!recs.data.recordings[0].startAt, JSON.stringify(recs.data));
  check("ongeldige datum geweigerd", (await admin.get("/api/plaud/recordings?from=gisteren&to=morgen")).status === 400);

  const imported = await admin.put(tPath, { plaudFileId: "rec-vandaag", title: "Bestuursoverleg (opname)", recordedAt: new Date().toISOString() });
  check("transcript uit Plaud opgehaald", imported.status === 200 && imported.data.chars > 5000, JSON.stringify(imported.data).slice(0, 200));
  const full = await admin.get(`${tPath}?body`);
  const lines = full.data.transcript?.body?.split("\n") ?? [];
  check("alle delen opgehaald, met tijd en spreker", lines.length === 130 && lines[0].startsWith("[00:00:00] Sanne Visser: Welkom") && lines[129].startsWith("[00:19:21] "), `${lines.length} regels, ${lines[0]}`);
  const meta = await admin.get(tPath);
  check("gegevens van het transcript zonder de tekst", meta.data.transcript.source === "plaud" && meta.data.transcript.chars === imported.data.chars && meta.data.transcript.body === undefined);
  check("deelnemer ziet het transcript niet", (await dee.client.get(tPath)).status === 403);
  check("buitenstaander ziet het transcript niet", (await bui.client.get(tPath)).status === 404);
  check("deelnemer kan geen transcript plaatsen", (await dee.client.put(tPath, { text: "x".repeat(500) })).status === 403);
  check("opname zonder transcript geeft uitleg", (await admin.put(tPath, { plaudFileId: "rec-leeg" })).status === 409);
  check("onbekende opname", (await admin.put(tPath, { plaudFileId: "bestaat-niet" })).status === 502);

  plaud.expireAccess();
  check("verlopen sleutel wordt vanzelf ververst", (await admin.put(tPath, { plaudFileId: "rec-vandaag" })).status === 200);
  plaud.revokeAll();
  const revoked = await admin.put(tPath, { plaudFileId: "rec-vandaag" });
  check("ingetrokken toestemming vraagt opnieuw koppelen", revoked.status === 409 && revoked.data.code === "plaud_reconnect", JSON.stringify(revoked));
  check("koppeling is dan weg", (await admin.get("/api/plaud")).data.connected === false);
  const second = await consent(admin);
  check("opnieuw koppelen", (await admin.raw("GET", second.callback)).headers.get("location") === "/account?plaud=gekoppeld");
  check("ontkoppelen", (await admin.del("/api/plaud")).status === 200 && (await admin.get("/api/plaud")).data.connected === false);

  check("te korte tekst geweigerd", (await admin.put(tPath, { text: "Te kort." })).status === 400);
  const pasted = await admin.put(tPath, { text: full.data.transcript.body, title: "Geplakt transcript" });
  check("transcript als tekst geplaatst", pasted.status === 200 && (await admin.get(tPath)).data.transcript.source === "tekst");

  // Concept-notulen: klaarzetten, op de achtergrond uitvoeren, stand opvragen.
  const notesPath = `${tPath}/notes`;
  check("assistent uit: geen concept-notulen", (await admin.post(notesPath)).status === 403);
  await admin.patch(`/api/organisations/${org1}`, { aiEnabled: true });
  check("deelnemer kan geen concept-notulen vragen", (await dee.client.post(notesPath)).status === 403);
  const job = await admin.post(notesPath);
  check("klus klaargezet", job.status === 200 && !!job.data.jobId && job.data.running === false, JSON.stringify(job));
  check("tweede aanvraag sluit aan bij de lopende klus", (await admin.post(notesPath)).data.jobId === job.data.jobId);
  check("klus van een ander is onzichtbaar", (await dee.client.get(`/api/jobs/${job.data.jobId}`)).status === 404);
  check("een ander kan de klus niet starten", (await dee.client.post(`/api/background/jobs/${job.data.jobId}/run`)).status < 300 && (await admin.get(`/api/jobs/${job.data.jobId}`)).data.status === "wacht");
  const run = await admin.post(`/api/background/jobs/${job.data.jobId}/run`);
  check("achtergrondwerk gestart", run.status === 202 || run.status === 200, `${run.status}`);
  let state;
  for (let i = 0; i < 40; i++) {
    state = (await admin.get(`/api/jobs/${job.data.jobId}`)).data;
    if (state.status === "klaar" || state.status === "mislukt") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const noted = state.result?.items ?? [];
  check("concept-notulen per agendapunt", state.status === "klaar" && noted.some((n) => n.agendaItemId === itemIds[1] && n.notes.includes("begroting")), JSON.stringify(state).slice(0, 300));
  check("concept legt zelf niets vast", (await admin.get(`/api/meetings/${meetingId}`)).data.items.find((i) => i.id === itemIds[1]).notes.includes("xyzzy"));
  check("scherm vindt de laatste klus terug", (await admin.get(tPath)).data.job?.id === job.data.jobId);
  await admin.patch(`/api/organisations/${org1}`, { aiEnabled: false });
  await plaud.close();
}

step("5d. Agenda-abonnement, punten aandragen en e-mail");
{
  // --- agenda-abonnement ---
  check("agenda-abonnement staat uit", (await dee.client.get("/api/account/calendar")).data.active === false);
  const feed = await dee.client.post("/api/account/calendar");
  check("agendalink gemaakt", feed.status === 200 && feed.data.url.startsWith(`${BASE}/api/agenda/`) && feed.data.url.endsWith(".ics"), JSON.stringify(feed.data));
  const ics = await fetch(feed.data.url);
  const body = await ics.text();
  check("agenda zonder inloggen op te halen", ics.status === 200 && ics.headers.get("content-type").startsWith("text/calendar") && body.startsWith("BEGIN:VCALENDAR"));
  check("gepubliceerde vergadering met agendapunten staat erin", body.includes("SUMMARY:MT week 48") && body.includes("Begroting 2027") && body.includes(`/vergaderingen/${meetingId}`), body.slice(0, 600));
  check("lange regels zijn afgebroken", body.split("\r\n").every((l) => Buffer.byteLength(l) <= 75));
  const other = await bui.client.post("/api/account/calendar");
  check("agenda van iemand uit een andere organisatie bevat deze vergadering niet", !(await (await fetch(other.data.url)).text()).includes("MT week 48"));
  check("onbekende agendalink", (await fetch(`${BASE}/api/agenda/${"x".repeat(43)}.ics`)).status === 404);
  const renewed = await dee.client.post("/api/account/calendar");
  check("nieuwe link maakt de oude ongeldig", (await fetch(feed.data.url)).status === 404 && (await fetch(renewed.data.url)).status === 200);
  check("abonnement stoppen", (await dee.client.del("/api/account/calendar")).status === 200 && (await fetch(renewed.data.url)).status === 404);
  await bui.client.del("/api/account/calendar");

  // --- agendapunten aandragen ---
  const sPath = `/api/overleggen/${overlegId}/suggestions`;
  const s1 = await dee.client.post(sPath, { title: "Nieuwe bedrijfsbus", description: "De oude is aan vervanging toe." });
  check("deelnemer draagt een punt aan", s1.status === 200 && !!s1.data.id, JSON.stringify(s1));
  check("buitenstaander kan niets aandragen of zien", (await bui.client.post(sPath, { title: "X" })).status === 404 && (await bui.client.get(sPath)).status === 404);
  check("aangedragen punt zichtbaar voor het overleg", (await admin.get(sPath)).data.suggestions.some((s) => s.id === s1.data.id && s.status === "open" && s.createdByName === "Dee Deelnemer"));
  check("deelnemer kan niet zelf op de agenda zetten", (await dee.client.post(`/api/suggestions/${s1.data.id}/place`, { meetingId })).status === 403);
  const placed = await admin.post(`/api/suggestions/${s1.data.id}/place`, { meetingId });
  const withItem = await admin.get(`/api/meetings/${meetingId}`);
  const newItem = withItem.data.items.find((i) => i.id === placed.data.itemId);
  check("secretaris zet het punt op de agenda", placed.status === 200 && newItem?.title === "Nieuwe bedrijfsbus" && newItem.presenter === "Dee Deelnemer" && newItem.description.includes("vervanging"), JSON.stringify(newItem));
  const afterPlace = (await dee.client.get(sPath)).data.suggestions.find((s) => s.id === s1.data.id);
  check("aandrager ziet op welke vergadering het staat", afterPlace.status === "geplaatst" && afterPlace.meetingId === meetingId);
  check("al geplaatst punt niet nog eens te plaatsen", (await admin.post(`/api/suggestions/${s1.data.id}/place`, { meetingId })).status === 409);
  const s2 = await dee.client.post(sPath, { title: "Kerstborrel" });
  check("deelnemer kan niet afwijzen", (await dee.client.post(`/api/suggestions/${s2.data.id}/dismiss`, { reply: "x" })).status === 403);
  check("secretaris wijst af met reden", (await admin.post(`/api/suggestions/${s2.data.id}/dismiss`, { reply: "Hoort bij de personeelsvereniging." })).status === 200);
  check("aandrager ziet de reden", (await dee.client.get(sPath)).data.suggestions.find((s) => s.id === s2.data.id).reply.includes("personeelsvereniging"));
  const s3 = await dee.client.post(sPath, { title: "Toch niet" });
  check("eigen openstaand punt intrekken", (await dee.client.del(`/api/suggestions/${s3.data.id}`)).status === 200);
  check("afgehandeld punt niet zelf te verwijderen", (await dee.client.del(`/api/suggestions/${s2.data.id}`)).status === 403);
  check("agendapunt weer van de agenda (latere stappen tellen de punten)", (await admin.del(`/api/items/${placed.data.itemId}`)).status === 200);

  // --- e-mail: nagebouwde mailserver vangt alles op ---
  const inbox = [];
  const systemMails = [];
  const logins = [];
  const smtp = new SMTPServer({
    authOptional: true,
    allowInsecureAuth: true,
    disabledCommands: ["STARTTLS"],
    onAuth: (auth, _session, done) => {
      logins.push(`${auth.username}:${auth.password}`);
      done(null, { user: auth.username });
    },
    // Berichten van de zelftest (aan de platformbeheerder) apart: de tests hieronder tellen de herinneringen.
    onData: (stream, _session, done) => simpleParser(stream).then((mail) => (((mail.subject ?? "").startsWith("Systeemcontrole") ? systemMails : inbox).push(mail), done()), done),
  });
  await new Promise((r) => smtp.listen(2525, r));
  const to = (mail) => mail.to.value[0].address;
  const arrived = async (n) => {
    for (let i = 0; i < 50 && inbox.length < n; i++) await new Promise((r) => setTimeout(r, 200));
    return inbox.length;
  };

  const before = await admin.get("/api/admin/mail");
  check("mail nog niet ingesteld", before.status === 200 && before.data.available === true && before.data.settings === null);
  check("deelnemer komt niet bij de mailinstellingen", (await dee.client.get("/api/admin/mail")).status === 403);
  check("zonder mailserver geen mail naar deelnemers", (await admin.post(`/api/meetings/${meetingId}/mail`, { kind: "agenda" })).status === 409);
  const settings = { host: "localhost", port: 2525, security: "geen", user: "mailer", pass: "geheim-wachtwoord", fromName: "Vergaderen", fromAddress: "vergaderen@test.example" };
  check("mailserver instellen", (await admin.put("/api/admin/mail", settings)).status === 200);
  const saved = await admin.get("/api/admin/mail");
  check("wachtwoord komt niet terug naar het scherm", saved.data.settings.hasPassword === true && saved.data.settings.pass === undefined && saved.data.settings.host === "localhost");
  check("sessie meldt dat mailen kan", (await dee.client.get("/api/session")).data.mailEnabled === true);
  check("testmail", (await admin.post("/api/admin/mail/test")).status === 200 && (await arrived(1)) === 1 && to(inbox[0]) === adminCreds.email && inbox[0].subject.includes("Testmail"));
  check("aangemeld bij de mailserver met het opgeslagen wachtwoord", logins.includes("mailer:geheim-wachtwoord"));
  check("afzender zoals ingesteld", inbox[0].from.value[0].address === "vergaderen@test.example" && inbox[0].from.value[0].name === "Vergaderen");
  await admin.put("/api/admin/mail", { ...settings, port: 2526, pass: "" });
  const failed = await admin.post("/api/admin/mail/test");
  check("onbereikbare mailserver geeft de melding door", failed.status === 502 && failed.data.error.includes("mailserver"), JSON.stringify(failed));
  await admin.put("/api/admin/mail", { ...settings, pass: "" });
  check("leeg wachtwoord laat het bestaande staan", (await admin.post("/api/admin/mail/test")).status === 200 && logins.at(-1) === "mailer:geheim-wachtwoord");
  inbox.length = 0;

  const mia = await admin.post(`/api/overleggen/${overlegId}/members`, { email: `mia-${RUN}@test.example`, name: "Mia Mail" });
  check("uitnodiging wordt gemaild", mia.status === 200 && mia.data.mailed === true && (await arrived(1)) === 1 && to(inbox[0]) === `mia-${RUN}@test.example`, JSON.stringify(mia.data));
  check("mail bevat de eenmalige link", inbox[0].text.includes(`${BASE}/welkom#${mia.data.token}`) && inbox[0].html.includes("Account activeren"));
  inbox.length = 0;

  check("deelnemer kan de deelnemers niet mailen", (await dee.client.post(`/api/meetings/${meetingId}/mail`, { kind: "agenda" })).status === 403);
  const agendaMail = await admin.post(`/api/meetings/${meetingId}/mail`, { kind: "agenda", note: "Lees vooral de begroting." });
  await arrived(agendaMail.data.sent ?? 99);
  const toDee = inbox.find((m) => to(m) === dee.email);
  check("agenda gemaild naar alle deelnemers", agendaMail.status === 200 && agendaMail.data.sent === inbox.length && agendaMail.data.failed.length === 0 && !!toDee, JSON.stringify(agendaMail.data));
  check(
    "agendamail: onderwerp, agenda, bericht, link en antwoordadres",
    toDee.subject.startsWith("Agenda: MT week 48") && toDee.text.includes("2. Begroting 2027") && toDee.text.includes("Lees vooral de begroting.") && toDee.text.includes(`/vergaderingen/${meetingId}`) && toDee.replyTo.value[0].address === adminCreds.email,
    toDee.text.slice(0, 400),
  );
  check("agendamail heeft een agendabestand als bijlage", toDee.attachments.length === 1 && toDee.attachments[0].content.toString().includes("SUMMARY:MT week 48"));
  const admin_id = (await admin.get("/api/session")).data.user.id;
  const rsvp = /\/aanwezigheid#([^~\s]+)~ja/.exec(toDee.text)?.[1] ?? "";
  check("agendamail heeft knoppen om aan of af te melden", !!rsvp && toDee.text.includes(`${rsvp}~nee`) && toDee.html.includes("Ik ben verhinderd"), toDee.text.slice(0, 600));
  const anon = new Client();
  const rsvpInfo = await anon.get(`/api/rsvp/${rsvp}`);
  check("aanmeldlink toont de vergadering zonder inloggen", rsvpInfo.status === 200 && rsvpInfo.data.title === "MT week 48" && rsvpInfo.data.name === "Dee Deelnemer" && rsvpInfo.data.attendance === "aanwezig", JSON.stringify(rsvpInfo.data));
  check("afmelden via de link", (await anon.post(`/api/rsvp/${rsvp}`, { status: "afwezig" })).status === 200 && (await admin.get(`/api/meetings/${meetingId}`)).data.members.find((x) => x.id === dee.id).attendance === "afwezig");
  check("ongeldige keuze geweigerd", (await anon.post(`/api/rsvp/${rsvp}`, { status: "misschien" })).status === 400);
  check("vervalste link geweigerd", (await anon.post(`/api/rsvp/${rsvp.slice(0, -3)}abc`, { status: "aanwezig" })).status === 404);
  const [rsvpMeeting, , rsvpSignature] = rsvp.split(".");
  check("link van de een werkt niet voor een ander", (await anon.get(`/api/rsvp/${rsvpMeeting}.${admin_id}.${rsvpSignature}`)).status === 404);
  check("weer aanmelden via de link", (await anon.post(`/api/rsvp/${rsvp}`, { status: "aanwezig" })).status === 200);
  inbox.length = 0;
  const verslagMail = await admin.post(`/api/meetings/${meetingId}/mail`, { kind: "verslag" });
  await arrived(verslagMail.data.sent ?? 99);
  const verslag = inbox.find((m) => to(m) === dee.email);
  check("verslag gemaild met besluiten en acties", verslag?.subject.startsWith("Verslag: MT week 48") && /\d{4}-\d{3}: /.test(verslag.text) && verslag.text.includes("Offertes opvragen"), verslag?.text.slice(0, 500));
  inbox.length = 0;

  // Dagelijkse herinneringen: de dag vóór de vergadering, met een actie die dan afloopt.
  const meetingDay = new Date(startsAt).toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });
  const dayBefore = new Date(new Date(`${meetingDay}T12:00:00Z`).getTime() - 86400e3).toISOString().slice(0, 10);
  const soon = await admin.post(`/api/meetings/${meetingId}/actions`, { text: "Cijfers aanleveren", ownerId: dee.id, dueDate: meetingDay, agendaItemId: itemIds[1] });
  const taskKey = createHash("sha256").update("daily:lokale-sleutel-voor-tests").digest("hex");
  const daily = (key) => new Client().call("POST", "/api/background/daily", { body: { today: dayBefore }, headers: { "x-task-key": key } });
  await daily("verkeerde-sleutel");
  await new Promise((r) => setTimeout(r, 1500));
  check("dagelijkse taak zonder de juiste sleutel doet niets", inbox.length === 0);
  check("herinneringen uitzetten", (await dee.client.patch("/api/account/mail", { reminders: false })).status === 200 && (await dee.client.get("/api/account/mail")).data.reminders === false);
  await daily(taskKey);
  await new Promise((r) => setTimeout(r, 2500));
  check("wie herinneringen uit heeft staan, krijgt er geen", inbox.length >= 1 && !inbox.some((m) => to(m) === dee.email), inbox.map(to).join());
  check("anderen krijgen de herinnering voor morgen", inbox.every((m) => m.subject.startsWith("Morgen: MT week 48")));
  check("wie nog niets liet weten, kan vanuit de herinnering reageren", inbox.some((m) => m.text.includes("Ben je erbij?") && m.text.includes("/aanwezigheid#")));
  await dee.client.patch("/api/account/mail", { reminders: true });
  inbox.length = 0;
  await daily(taskKey);
  await arrived(2);
  await new Promise((r) => setTimeout(r, 800));
  const deeMails = inbox.filter((m) => to(m) === dee.email);
  check("wie al heeft gereageerd, krijgt die vraag niet opnieuw", !deeMails.some((m) => m.text.includes("Ben je erbij?")));
  check("herinnering voor de vergadering van morgen", deeMails.some((m) => m.subject.startsWith("Morgen: MT week 48") && m.text.includes("Uitzetten kan onder Mijn account")), inbox.map((m) => `${to(m)}: ${m.subject}`).join(" | "));
  // De taak deed ook de zelftest. Plaud is hier onbereikbaar: de platformbeheerder krijgt daar één keer per dag bericht van.
  for (let i = 0; i < 40 && systemMails.length < 1; i++) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 1200));
  check(
    "zelftest: de platformbeheerder krijgt één bericht over wat niet werkt",
    systemMails.length === 1 && to(systemMails[0]) === adminCreds.email && systemMails[0].subject === "Systeemcontrole: Koppeling met Plaud werkt niet" && systemMails[0].text.includes("/beheer?tab=instellingen"),
    systemMails.map((m) => `${to(m)}: ${m.subject}`).join(" | "),
  );
  const afterTask = await admin.get("/api/admin/system/last");
  check("zelftest: de dagelijkse taak bewaart de uitslag", afterTask.data.last?.by === "taak" && afterTask.data.last.checks.find((x) => x.key === "daily").status === "ok", JSON.stringify(afterTask.data.last?.by));
  const digest = deeMails.find((m) => m.subject.startsWith("Je acties"));
  check("overzicht van aflopende en verlopen acties", !!digest && digest.text.includes("Cijfers aanleveren") && digest.text.includes("morgen") && digest.text.includes("Offertes opvragen") && digest.text.includes(`${BASE}/acties`), digest?.text.slice(0, 500));
  check("niemand anders dan de actiehouder krijgt het overzicht", inbox.filter((m) => m.subject.startsWith("Je acties")).length === 1);
  inbox.length = 0;
  await daily(taskKey);
  await new Promise((r) => setTimeout(r, 2500));
  check("dezelfde herinnering gaat niet twee keer de deur uit", inbox.length === 0, inbox.map((m) => m.subject).join());
  check("logboek voor de beheerder", (await admin.get("/api/admin/mail")).data.log.some((l) => l.kind === "herinnering" && l.status === "verzonden") && (await admin.get("/api/admin/mail")).data.log.some((l) => l.status === "mislukt"));

  check("testactie opgeruimd", (await admin.del(`/api/actions/${soon.data.id}`)).status === 200);
  check("Mia weer uit het overleg", (await admin.del(`/api/overleggen/${overlegId}/members/${mia.data.userId}`)).status === 200);
  check("mailinstellingen wissen zet mailen uit", (await admin.del("/api/admin/mail")).status === 200 && (await admin.get("/api/session")).data.mailEnabled === false);
  await new Promise((r) => smtp.close(r));
}

step("5e. Inzicht en vraag het archief");
{
  const iPath = `/api/organisations/${org1}/insights`;
  check("inzicht alleen voor beheerders", (await dee.client.get(iPath)).status === 403 && (await bui.client.get(iPath)).status === 404);
  const ins = await admin.get(`${iPath}?months=12`);
  const mt = ins.data.overleggen?.find((o) => o.id === overlegId);
  check("inzicht per overleg", ins.status === 200 && !!mt && mt.decisions >= 1 && mt.actionsOpen >= 1 && mt.actionsLate >= 1 && mt.actionsCreated >= 1, JSON.stringify(mt));
  check("vergadering in de toekomst telt nog niet mee", mt.meetings === 0 && mt.plannedMin === 0);
  check("openstaande acties per persoon", ins.data.people.some((p) => p.id === dee.id && p.open >= 1 && p.late >= 1), JSON.stringify(ins.data.people));
  check("ongeldige periode geweigerd", (await admin.get(`${iPath}?months=99`)).status === 400);
  check("deelnemer mag het uurtarief niet zetten", (await dee.client.patch(`/api/organisations/${org1}`, { hourlyRate: 65 })).status === 403);
  check("uurtarief opslaan", (await admin.patch(`/api/organisations/${org1}`, { hourlyRate: 65 })).status === 200 && (await admin.get(iPath)).data.hourlyRate === 65);
  check("ongeldig uurtarief geweigerd", (await admin.patch(`/api/organisations/${org1}`, { hourlyRate: 0 })).status === 400);
  check("uurtarief weer leeg", (await admin.patch(`/api/organisations/${org1}`, { hourlyRate: null })).status === 200 && (await admin.get(iPath)).data.hourlyRate === null);

  const start = await admin.get(`/api/organisations/${org1}/start`);
  check(
    "aan de slag: wat er al is ingericht",
    start.status === 200 && start.data.overleggen >= 1 && start.data.firstOverlegId === overlegId && start.data.members >= 1 && start.data.published >= 1 && start.data.calendar === false && start.data.mailEnabled === false && start.data.mailPossible === true,
    JSON.stringify(start.data),
  );
  check("aan de slag alleen voor beheerders", (await dee.client.get(`/api/organisations/${org1}/start`)).status === 403);

  const question = { question: "Wat is er besloten over de begroting van 2027?" };
  check("assistent uit: geen vragen aan het archief", (await dee.client.post("/api/ai/ask", question)).status === 403);
  await admin.patch(`/api/organisations/${org1}`, { aiEnabled: true });
  const answer = await dee.client.post("/api/ai/ask", question);
  check("antwoord uit het archief met bron", answer.status === 200 && answer.data.answer.toLowerCase().includes("begroting") && answer.data.sources.length === 1, JSON.stringify(answer.data).slice(0, 400));
  check("bron verwijst naar de vergadering", answer.data.sources[0]?.meetingId === meetingId && ["besluit", "notulen", "actie"].includes(answer.data.sources[0]?.type));
  check("te korte vraag geweigerd", (await dee.client.post("/api/ai/ask", { question: "Hoe?" })).status === 422);
  // Iemand van buiten die de organisatie in de header zet, krijgt niets uit het archief te zien.
  const outsider = new Client();
  outsider.cookie = bui.client.cookie;
  outsider.org = org1;
  const leaked = await outsider.post("/api/ai/ask", question);
  check("buitenstaander krijgt niets uit het archief", leaked.status === 200 && leaked.data.sources.length === 0 && !leaked.data.answer.toLowerCase().includes("begroting"), JSON.stringify(leaked.data));
  await admin.patch(`/api/organisations/${org1}`, { aiEnabled: false });
}

step("5f. Stemrondes en systeemcontrole");
{
  const bPath = `/api/overleggen/${overlegId}/ballots`;
  check("deelnemer kan geen stemronde starten", (await dee.client.post(bPath, { title: "X" })).status === 403);
  check("buitenstaander ziet geen stemrondes", (await bui.client.get(bPath)).status === 404);
  const made = await admin.post(bPath, { title: "De offerte van hovenier Groen voor € 4.800 wordt geaccepteerd.", body: "Zie de bijlage.", closesOn: "2030-01-15" });
  check("stemronde gestart (zonder mailserver niets gemaild)", made.status === 200 && !!made.data.id && made.data.mailed === 0, JSON.stringify(made));
  const votePath = `/api/ballots/${made.data.id}/vote`;
  const list1 = await dee.client.get(bPath);
  check(
    "deelnemer ziet de stemronde en mag stemmen",
    list1.status === 200 && list1.data.ballots[0].id === made.data.id && list1.data.ballots[0].status === "open" && list1.data.canVote === true && list1.data.voters.some((v) => v.id === dee.id),
    JSON.stringify(list1.data).slice(0, 300),
  );
  check("overzicht vraagt om je stem", (await dee.client.get("/api/dashboard")).data.openBallots.some((b) => b.id === made.data.id));
  check("ongeldige stem geweigerd", (await dee.client.put(votePath, { vote: "misschien" })).status === 400);
  check("buitenstaander kan niet stemmen", (await bui.client.put(votePath, { vote: "akkoord" })).status === 404);
  check("stemmen met toelichting", (await dee.client.put(votePath, { vote: "niet_akkoord", comment: "Te duur." })).status === 200);
  check("stem wijzigen", (await dee.client.put(votePath, { vote: "akkoord" })).status === 200);
  const votes = (await admin.get(bPath)).data.ballots[0].votes;
  check("stemmen zijn zichtbaar met naam, één per persoon", votes.length === 1 && votes[0].userId === dee.id && votes[0].name === "Dee Deelnemer" && votes[0].vote === "akkoord" && votes[0].comment === "", JSON.stringify(votes));
  check("na stemmen verdwijnt de vraag van het overzicht", !(await dee.client.get("/api/dashboard")).data.openBallots.some((b) => b.id === made.data.id));

  check("deelnemer kan de ronde niet sluiten", (await dee.client.post(`/api/ballots/${made.data.id}/close`, { outcome: "aangenomen" })).status === 403);
  check("onbekende uitkomst geweigerd", (await admin.post(`/api/ballots/${made.data.id}/close`, { outcome: "misschien" })).status === 400);
  const closed = await admin.post(`/api/ballots/${made.data.id}/close`, { outcome: "aangenomen", meetingId, decisionText: "De offerte van hovenier Groen wordt geaccepteerd." });
  check("sluiten legt het besluit vast met een nummer", closed.status === 200 && closed.data.status === "aangenomen" && /^\d{4}-\d{3}$/.test(closed.data.decision?.number ?? ""), JSON.stringify(closed));
  const decision = (await admin.get(`/api/meetings/${meetingId}`)).data.decisions.find((d) => d.number === closed.data.decision.number);
  check("besluit vermeldt de stemverhouding", decision?.text.startsWith("De offerte van hovenier Groen wordt geaccepteerd. (Besloten buiten de vergadering op ") && decision.text.includes("1 akkoord, 0 niet akkoord, 0 onthoudingen"), decision?.text);
  check("na sluiten kan niemand meer stemmen", (await dee.client.put(votePath, { vote: "niet_akkoord" })).status === 409);
  const after = (await dee.client.get(bPath)).data.ballots[0];
  check("gesloten ronde verwijst naar het besluit", after.status === "aangenomen" && after.decisionNumber === closed.data.decision.number && after.decisionMeetingId === meetingId);
  check("twee keer sluiten kan niet", (await admin.post(`/api/ballots/${made.data.id}/close`, { outcome: "verworpen" })).status === 409);

  // Aangenomen zonder direct vast te leggen, en later alsnog.
  const second = await admin.post(bPath, { title: "De kerstborrel is op 18 december." });
  check("sluiten zonder vastleggen", (await admin.post(`/api/ballots/${second.data.id}/close`, { outcome: "aangenomen" })).data.decision === null);
  const later = await admin.post(`/api/ballots/${second.data.id}/decision`, { meetingId });
  check("later alsnog in de besluitenlijst", later.status === 200 && !!later.data.decision.number && (await admin.post(`/api/ballots/${second.data.id}/decision`, { meetingId })).status === 409);
  const third = await admin.post(bPath, { title: "Voorstel dat het niet haalt." });
  check("verworpen voorstel wordt geen besluit", (await admin.post(`/api/ballots/${third.data.id}/close`, { outcome: "verworpen", meetingId })).data.decision === null);
  check("verworpen voorstel niet alsnog vast te leggen", (await admin.post(`/api/ballots/${third.data.id}/decision`, { meetingId })).status === 409);

  // Opruimen: latere stappen tellen de besluiten van deze vergadering.
  const mine = (await admin.get(`/api/meetings/${meetingId}`)).data.decisions.filter((d) => d.text.includes("Besloten buiten de vergadering"));
  for (const d of mine) await admin.del(`/api/decisions/${d.id}`);
  check("testbesluiten opgeruimd", mine.length === 2);
  for (const id of [made.data.id, second.data.id, third.data.id]) await admin.del(`/api/ballots/${id}`);
  check("stemrondes verwijderd", (await admin.get(bPath)).data.ballots.length === 0);

  // --- systeemcontrole: elk onderdeel wordt echt aangesproken ---
  check("systeemcontrole alleen voor de platformbeheerder", (await dee.client.post("/api/admin/system/check")).status === 403);
  const plaud = await startFakePlaud(8899);
  const smtp = new SMTPServer({ authOptional: true, disabledCommands: ["STARTTLS"], onAuth: (a, _s, done) => done(null, { user: a.username }), onData: (s, _x, done) => (s.resume(), s.on("end", done)) });
  await new Promise((r) => smtp.listen(2525, r));
  const byKey = (res) => Object.fromEntries(res.data.checks.map((x) => [x.key, x]));
  const off = byKey(await admin.post("/api/admin/system/check"));
  check("zonder mailserver: e-mail niet actief, de rest werkt", off.db.status === "ok" && off.blobs.status === "ok" && off.ai.status === "ok" && off.plaud.status === "ok" && off.mail.status === "uit", JSON.stringify(off));
  check("dagelijkse taak heeft een spoor achtergelaten", off.daily.status === "ok" && off.daily.detail.includes("herinneringen"), off.daily.detail);
  await admin.put("/api/admin/mail", { host: "localhost", port: 2525, security: "geen", user: "mailer", pass: "geheim", fromAddress: "vergaderen@test.example" });
  check("mailserver bereikbaar: e-mail werkt", byKey(await admin.post("/api/admin/system/check")).mail.status === "ok");
  await admin.put("/api/admin/mail", { host: "localhost", port: 2526, security: "geen", user: "mailer", pass: "", fromAddress: "vergaderen@test.example" });
  const broken = byKey(await admin.post("/api/admin/system/check"));
  check("onbereikbare mailserver wordt gemeld", broken.mail.status === "fout" && broken.mail.detail.includes("mailserver"), broken.mail.detail);
  await plaud.close();
  check("onbereikbare Plaud wordt gemeld", byKey(await admin.post("/api/admin/system/check")).plaud.status === "fout");

  // --- zelftest: de uitslag blijft bewaard en is zichtbaar voor wie hem nodig heeft ---
  const lastCheck = await admin.get("/api/admin/system/last");
  check("laatste uitslag bewaard", lastCheck.status === 200 && lastCheck.data.last.by === "beheerder" && byKey({ data: lastCheck.data.last }).plaud.status === "fout", JSON.stringify(lastCheck.data.last?.by));
  check("laatste uitslag alleen voor de platformbeheerder", (await dee.client.get("/api/admin/system/last")).status === 403);
  const issues = (await admin.get("/api/session")).data.systemIssues;
  check("de platformbeheerder ziet in de sessie wat niet werkt", issues.includes("Koppeling met Plaud") && issues.includes("E-mail") && !issues.includes("Database"), JSON.stringify(issues));
  check("een deelnemer krijgt die melding niet", (await dee.client.get("/api/session")).data.systemIssues.length === 0);
  const healthText = await (await new Client().raw("GET", "/api/health")).text();
  const hz = JSON.parse(healthText).zelftest;
  check("health toont de uitslag in grote lijnen, zonder toelichting", hz?.plaud === "fout" && hz.mail === "fout" && hz.db === "ok" && hz.door === "beheerder" && !/bereikbaar|weigert|localhost/.test(healthText), healthText.slice(0, 400));
  const selftest = (key) => new Client().call("POST", "/api/background/selftest", { body: {}, headers: { "x-task-key": key } });
  await selftest("verkeerde-sleutel");
  await new Promise((r) => setTimeout(r, 1500));
  check("zelftest in de achtergrond niet zonder de juiste sleutel", (await admin.get("/api/admin/system/last")).data.last.by === "beheerder");
  await selftest(createHash("sha256").update("daily:lokale-sleutel-voor-tests").digest("hex"));
  let byWatch = null;
  for (let i = 0; i < 40 && byWatch !== "bewaking"; i++) {
    await new Promise((r) => setTimeout(r, 400));
    byWatch = (await admin.get("/api/admin/system/last")).data.last.by;
  }
  check("zelftest in de achtergrond met de sleutel van de taak", byWatch === "bewaking");
  await admin.del("/api/admin/mail");
  await new Promise((r) => smtp.close(r));
}

step("5g. Besloten overleg en besloten kring");
{
  // Het geval waar dit voor is: een raad van toezicht waarvan de bestuurder (hier: de beheerder van de
  // organisatie) het besloten deel niet mag zien. Kenmerkwoord in alle inhoud; dat mag nergens bij hem opduiken.
  const woord = `kwartsiet${RUN}`;
  const rvt = (await admin.post("/api/overleggen", { name: `Raad van toezicht ${RUN}` })).data.id;
  const ria = await addMember(admin, rvt, org1, "Ria Raad", `ria-${RUN}@test.example`, "secretaris");
  const tes = await addMember(admin, rvt, org1, "Tes Toezicht", `tes-${RUN}@test.example`);
  const nok = await addMember(admin, rvt, org1, "Nok Niet", `nok-${RUN}@test.example`);

  check("deelnemer mag geen besloten kring maken", (await tes.client.post(`/api/overleggen/${rvt}/kring`, { name: "Stiekem", memberIds: [] })).status === 403);
  check("kring alleen met deelnemers van het overleg", (await ria.client.post(`/api/overleggen/${rvt}/kring`, { name: "Met buitenstaander", memberIds: [dee.id] })).status === 400);
  const made = await ria.client.post(`/api/overleggen/${rvt}/kring`, { name: `RvT besloten ${RUN}`, memberIds: [tes.id] });
  check("secretaris maakt een besloten kring", made.status === 200 && !!made.data.id, JSON.stringify(made));
  const kring = made.data.id;
  check("een kring heeft zelf geen kring", (await ria.client.post(`/api/overleggen/${kring}/kring`, { name: "Dieper", memberIds: [] })).status === 400);

  // Inhoud in de kring.
  const kStart = new Date(Date.now() + 9 * 86400e3).toISOString();
  const km = (await ria.client.post(`/api/overleggen/${kring}/meetings`, { title: `Vooroverleg ${woord}`, startsAt: kStart, durationMin: 30 })).data.id;
  const ki = (await ria.client.post(`/api/meetings/${km}/items`, { title: `Beoordeling ${woord}`, kind: "Ter bespreking", durationMin: 20, presenter: "Ria", description: `Toelichting ${woord}` })).data.id;
  await ria.client.patch(`/api/items/${ki}`, { notes: `Besproken: ${woord} in de notulen.` });
  await ria.client.patch(`/api/meetings/${km}`, { status: "gepubliceerd" });
  const kd = await ria.client.post(`/api/meetings/${km}/decisions`, { text: `Besluit over ${woord}.` });
  const ka = await ria.client.post(`/api/meetings/${km}/actions`, { text: `Uitzoeken ${woord}`, ownerId: tes.id, dueDate: "2020-01-15" });
  const kdoc = await ria.client.upload({ meetingId: km }, `Notitie ${woord}.txt`, "text/plain", Buffer.from(`inhoud ${woord}`));
  await ria.client.post(`/api/overleggen/${kring}/suggestions`, { title: `Voorstel ${woord}` });
  check("inhoud in de kring vastgelegd", !!km && !!ki && kd.status === 200 && ka.status === 200 && kdoc.status === 200, JSON.stringify([kd.status, ka.status, kdoc.status]));

  // Wie in de kring zit, werkt er gewoon mee.
  const tList = (await tes.client.get("/api/overleggen")).data.overleggen.find((o) => o.id === kring);
  check("kringlid ziet de kring, met kenmerk besloten en het overleg waar hij bij hoort", tList?.besloten === true && tList.parentName === `Raad van toezicht ${RUN}` && tList.role === "deelnemer", JSON.stringify(tList));
  const tDetail = await tes.client.get(`/api/overleggen/${kring}`);
  check("kring: deelnemers en link naar het overleg", tDetail.status === 200 && tDetail.data.overleg.besloten === true && tDetail.data.overleg.isKring === true && tDetail.data.members.length === 2 && tDetail.data.parent?.id === rvt, JSON.stringify(tDetail.data.overleg));
  check("het overleg toont de kring aan wie erin zit", (await tes.client.get(`/api/overleggen/${rvt}`)).data.kringen.map((k) => k.id).join() === kring);
  const tMeeting = await tes.client.get(`/api/meetings/${km}`);
  check("kringlid ziet de vergadering van de kring", tMeeting.status === 200 && tMeeting.data.meeting.besloten === true && tMeeting.data.items.length === 1 && tMeeting.data.decisions.length === 1);
  check("kringlid vindt de inhoud terug", (await tes.client.get(`/api/search?q=${woord}`)).data.results.length >= 3 && (await tes.client.get("/api/dashboard")).data.myActions.some((a) => a.text.includes(woord)));

  // Wie wel aan het overleg deelneemt maar niet in de kring zit, merkt er niets van.
  const text = async (client, path) => (await client.raw("GET", path)).text();
  const nokSees = (await Promise.all(["/api/overleggen", `/api/overleggen/${rvt}`, "/api/dashboard", "/api/decisions", "/api/actions?status=alle", `/api/search?q=${woord}`].map((p) => text(nok.client, p)))).join("\n");
  check("deelnemer buiten de kring ziet de kring nergens", !nokSees.includes(woord) && !nokSees.includes(kring) && (await nok.client.get(`/api/overleggen/${kring}`)).status === 404 && (await nok.client.get(`/api/meetings/${km}`)).status === 404);

  // De beheerder van de organisatie neemt deel aan het overleg, maar zit niet in de kring.
  check("beheerder kan de kring niet openen", (await admin.get(`/api/overleggen/${kring}`)).status === 404);
  const denied = await Promise.all([
    admin.get(`/api/meetings/${km}`),
    admin.get(`/api/meetings/${km}/live`),
    admin.get(`/api/meetings/${km}/transcript`),
    admin.raw("GET", `/api/documents/${kdoc.data.id}/file`),
    admin.get(`/api/overleggen/${kring}/ballots`),
    admin.get(`/api/overleggen/${kring}/suggestions`),
    admin.post(`/api/overleggen/${kring}/members`, { email: adminCreds.email }),
    admin.patch(`/api/overleggen/${kring}`, { besloten: false }),
    admin.patch(`/api/overleggen/${kring}`, { archived: true }),
    admin.post(`/api/overleggen/${kring}/meetings`, { title: "Inbreken", startsAt: kStart }),
    admin.post(`/api/meetings/${km}/decisions`, { text: "x" }),
    admin.post(`/api/meetings/${km}/mail`, { kind: "agenda" }),
    admin.del(`/api/overleggen/${kring}/members/${tes.id}`),
  ]);
  check("beheerder komt er langs geen enkele weg in", denied.every((r) => r.status === 404), denied.map((r) => r.status).join());

  await admin.patch(`/api/organisations/${org1}`, { aiEnabled: true });
  const feedAdmin = await admin.post("/api/account/calendar");
  const feedTes = await tes.client.post("/api/account/calendar");
  const ask = { question: `Wat is er besloten over ${woord} in het vooroverleg?` };
  const sweep = [
    "/api/overleggen",
    `/api/overleggen/${rvt}`,
    "/api/dashboard",
    "/api/decisions",
    `/api/decisions?overleg=${kring}`,
    "/api/actions?status=alle",
    `/api/actions?overleg=${kring}&status=alle`,
    `/api/search?q=${woord}`,
    "/api/search?q=vooroverleg",
    `/api/organisations/${org1}/insights?months=12`,
    `/api/organisations/${org1}/start`,
    "/api/session",
    "/api/users",
  ];
  const adminSees = (await Promise.all(sweep.map((p) => text(admin, p)))).join("\n") + (await (await fetch(feedAdmin.data.url)).text()) + JSON.stringify((await admin.post("/api/ai/ask", ask)).data);
  check("inhoud van de kring duikt nergens op bij de beheerder", !adminSees.includes(woord), sweep.filter(() => adminSees.includes(woord)).join(" "));
  check("ook het bestaan van de kring staat niet in zijn overzichten", !adminSees.includes(kring) && !adminSees.includes(km));
  const tesFeed = await (await fetch(feedTes.data.url)).text();
  const tesAsk = await tes.client.post("/api/ai/ask", ask);
  check("het kringlid krijgt de vergadering wel in agenda en archiefvraag", tesFeed.includes(woord) && tesAsk.status === 200 && tesAsk.data.sources.length >= 1, JSON.stringify(tesAsk.data).slice(0, 300));
  await admin.patch(`/api/organisations/${org1}`, { aiEnabled: false });
  await admin.del("/api/account/calendar");
  await tes.client.del("/api/account/calendar");

  // Wat de beheerder wel ziet: dat de kring bestaat, en wie eraan deelneemt.
  const gov = await admin.get(`/api/organisations/${org1}/besloten`);
  const g = gov.data.overleggen?.find((o) => o.id === kring);
  check("beheer ziet dat de kring bestaat, met secretaris en aantal deelnemers", gov.status === 200 && g?.memberCount === 2 && g.secretarissen.join() === "Ria Raad" && g.mine === false && g.parentName === `Raad van toezicht ${RUN}`, JSON.stringify(g));
  check("overzicht van besloten overleggen alleen voor beheerders", (await ria.client.get(`/api/organisations/${org1}/besloten`)).status === 403);
  const person = (await admin.get(`/api/organisations/${org1}/people`)).data.people.find((p) => p.id === tes.id);
  check("bij een persoon staat de kring als besloten, zonder toegang voor de beheerder", person.overleggen.some((o) => o.id === kring && o.besloten === true && o.open === false) && person.overleggen.some((o) => o.id === rvt && o.open === true), JSON.stringify(person.overleggen));
  check("een secretaris aanwijzen kan niet zolang er een is", (await admin.post(`/api/organisations/${org1}/besloten/${kring}/secretaris`, { userId: nok.id })).status === 409);

  // Er moet een secretaris overblijven: het beheer kan het niet overnemen.
  check("laatste secretaris van een besloten overleg kan niet weg", (await ria.client.del(`/api/overleggen/${kring}/members/${ria.id}`)).status === 409 && (await ria.client.put(`/api/overleggen/${kring}/members/${ria.id}`, { role: "deelnemer" })).status === 409);
  check("deelnemer verwijderen uit de kring kan wel", (await ria.client.del(`/api/overleggen/${kring}/members/${tes.id}`)).status === 200 && (await tes.client.get(`/api/overleggen/${kring}`)).status === 404);
  await ria.client.post(`/api/overleggen/${kring}/members`, { email: tes.email });

  // Een bestaand overleg besloten maken en weer openstellen.
  const open = (await admin.post("/api/overleggen", { name: `Personeelszaken ${RUN}` })).data.id;
  await admin.post(`/api/overleggen/${open}/members`, { email: ria.email, role: "secretaris" });
  check("deelnemer mag een overleg niet besloten maken", (await admin.post(`/api/overleggen/${open}/members`, { email: tes.email })).status === 200 && (await tes.client.patch(`/api/overleggen/${open}`, { besloten: true })).status === 403);
  check("secretaris maakt het overleg besloten", (await ria.client.patch(`/api/overleggen/${open}`, { besloten: true })).status === 200 && (await ria.client.get(`/api/overleggen/${open}`)).data.overleg.besloten === true);
  check("een beheerder die zelf deelneemt, houdt toegang", (await admin.get(`/api/overleggen/${open}`)).status === 200);
  check("haalt de secretaris hem eruit, dan is de toegang weg", (await ria.client.del(`/api/overleggen/${open}/members/${(await admin.get("/api/session")).data.user.id}`)).status === 200 && (await admin.get(`/api/overleggen/${open}`)).status === 404);
  check("weer openstellen geeft het beheer de toegang terug", (await ria.client.patch(`/api/overleggen/${open}`, { besloten: false })).status === 200 && (await admin.get(`/api/overleggen/${open}`)).data?.role === "secretaris");
  check("een beheerder die niet deelneemt, kan een overleg niet besloten maken", (await admin.patch(`/api/overleggen/${open}`, { besloten: true })).status === 403);

  // Direct als besloten aanmaken, en herstel als de secretaris wegvalt.
  const direct = await admin.post("/api/overleggen", { name: `Vertrouwenscommissie ${RUN}`, besloten: true });
  const los = direct.data.id;
  check("besloten overleg direct aanmaken", direct.status === 200 && (await admin.get(`/api/overleggen/${los}`)).data.overleg.besloten === true);
  await admin.post(`/api/overleggen/${los}/members`, { email: nok.email, role: "secretaris" });
  const adminId = (await admin.get("/api/session")).data.user.id;
  check("de aanmaker stapt eruit en kan er daarna niet meer bij", (await admin.del(`/api/overleggen/${los}/members/${adminId}`)).status === 200 && (await admin.get(`/api/overleggen/${los}`)).status === 404 && (await nok.client.get(`/api/overleggen/${los}`)).status === 200);
  check("de secretaris verlaat de organisatie", (await admin.del(`/api/organisations/${org1}/people/${nok.id}`)).status === 200);
  const orphan = (await admin.get(`/api/organisations/${org1}/besloten`)).data.overleggen.find((o) => o.id === los);
  check("het beheer ziet dat er geen secretaris meer is", orphan?.secretarissen.length === 0 && orphan.memberCount === 0, JSON.stringify(orphan));
  check("nieuwe secretaris moet bij de organisatie horen", (await admin.post(`/api/organisations/${org1}/besloten/${los}/secretaris`, { userId: bui.id })).status === 404);
  check("het beheer wijst een nieuwe secretaris aan", (await admin.post(`/api/organisations/${org1}/besloten/${los}/secretaris`, { userId: tes.id })).status === 200 && (await tes.client.get(`/api/overleggen/${los}`)).data?.role === "secretaris");
  check("daarna is het weer aan de secretaris", (await admin.post(`/api/organisations/${org1}/besloten/${los}/secretaris`, { userId: ria.id })).status === 409 && (await admin.get(`/api/overleggen/${los}`)).status === 404);
  check("herstel staat in het logboek", (await admin.get("/api/audit")).data.entries.some((e) => e.action === "POST /api/organisations/:id/besloten/:overlegId/secretaris"));
}

step("6. Afronden, vergrendeling en overnemen");
let nextMeetingId;
{
  check("afronden", (await admin.patch(`/api/meetings/${meetingId}`, { status: "afgerond" })).status === 200);
  check("afronden beëindigt de vergadermodus", (await admin.get(`/api/meetings/${meetingId}/live`)).data.liveStartedAt === null);
  check("afgerond: transcript niet meer te vervangen", (await admin.put(`/api/meetings/${meetingId}/transcript`, { text: "x".repeat(500) })).status === 409);
  check("afgerond: transcript nog wel in te zien", (await admin.get(`/api/meetings/${meetingId}/transcript`)).data.transcript?.source === "tekst");
  check("afgerond: transcript verwijderen kan", (await admin.del(`/api/meetings/${meetingId}/transcript`)).status === 200 && (await admin.get(`/api/meetings/${meetingId}/transcript`)).data.transcript === null);
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
  check("accountlijst met organisaties", users.data.users.find((u) => u.id === dee.id).organisations.join() === "Testbedrijf" && me.activated === true && me.passkeys === 1);
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

step("7b. Back-up en locatie van de gegevens");
{
  const health = await new Client().get("/api/health");
  check("health meldt waar de gegevens staan", health.status === 200 && typeof health.data.regio?.functies === "string" && health.data.regio.stukken === "eu-central-1" && typeof health.data.regio.binnenEu === "boolean", JSON.stringify(health.data));
  const location = (await admin.post("/api/admin/system/check")).data.checks.find((x) => x.key === "locatie");
  check("systeemcontrole toont de locatie", !!location && location.detail.includes("Database:") && ["ok", "let_op"].includes(location.status), JSON.stringify(location));

  const notAdmin = await sec.client.post("/api/admin/backup", { table: "users" });
  check("back-up alleen voor de platformbeheerder", (await new Client().get("/api/admin/backup")).status === 401 && [401, 403].includes(notAdmin.status) && !notAdmin.data?.rows, `${notAdmin.status}`);
  const plan = await admin.get("/api/admin/backup");
  check("overzicht van de back-up", plan.status === 200 && plan.data.format === "vergaderplatform-backup" && plan.data.tables[0].name === "users" && plan.data.tables.some((t) => t.name === "transcripts"), JSON.stringify(plan.data).slice(0, 200));
  check("onbekende tabel geweigerd", (await admin.post("/api/admin/backup", { table: "sessions" })).status === 400);
  const backup = { format: plan.data.format, version: plan.data.version, exportedAt: new Date().toISOString(), tables: {} };
  for (const t of plan.data.tables) {
    const rows = [];
    let offset = 0;
    while (offset !== null) {
      const part = await admin.post("/api/admin/backup", { table: t.name, offset });
      if (part.status !== 200) throw new Error(`back-up van ${t.name}: ${part.status} ${JSON.stringify(part.data)}`);
      rows.push(...part.data.rows);
      offset = part.data.next;
    }
    backup.tables[t.name] = rows;
  }
  check("elke tabel compleet opgehaald", plan.data.tables.every((t) => backup.tables[t.name].length === t.rows), plan.data.tables.map((t) => `${t.name}:${t.rows}/${backup.tables[t.name].length}`).join(" "));
  const me = backup.tables.users.find((u) => u.email === adminCreds.email);
  check("rijen staan er zoals de database ze kent", !!me && typeof me.password_hash === "string" && me.is_admin === true && !("passwordHash" in me));
  check("stand van de vergadermodus gaat niet mee", backup.tables.meetings.length > 0 && backup.tables.meetings.every((m) => !("live_item_id" in m)));
  check("hoofdpunten staan vóór hun subpunten", (() => {
    const seen = new Set();
    return backup.tables.agenda_items.every((i) => (seen.add(i.id), !i.parent_id || seen.has(i.parent_id)));
  })());
  check("een besloten kring staat na het overleg waar hij bij hoort", backup.tables.overleggen.some((o) => o.parent_id && o.besloten === true) && (() => {
    const seen = new Set();
    return backup.tables.overleggen.every((o) => (seen.add(o.id), !o.parent_id || seen.has(o.parent_id)));
  })());
  const proef = await admin.post("/api/admin/backup/verify", { table: "agenda_items", rows: backup.tables.agenda_items });
  check("back-upbestand controleren: alles leesbaar en aanwezig, niets gewijzigd", proef.status === 200 && proef.data.readable === backup.tables.agenda_items.length && proef.data.present === proef.data.readable, JSON.stringify(proef.data));
  const vreemd = await admin.post("/api/admin/backup/verify", { table: "users", rows: [{ ...backup.tables.users[0], id: "00000000-0000-4000-8000-00000000abcd" }] });
  check("controle telt een onbekende regel niet als aanwezig", vreemd.data.readable === 1 && vreemd.data.present === 0);
  check("controle weigert onleesbare gegevens", (await admin.post("/api/admin/backup/verify", { table: "users", rows: [{ id: "geen-uuid" }] })).status >= 400);
  check("controle alleen voor de platformbeheerder", [401, 403].includes((await sec.client.post("/api/admin/backup/verify", { table: "users", rows: [] })).status));
  check("terugzetten op een platform in gebruik geweigerd", (await new Client().post("/api/setup/restore", { code: SETUP_CODE, step: "start", format: backup.format, version: 1 })).status === 409);
  check("terugzetten zonder de juiste code geweigerd", (await new Client().post("/api/setup/restore", { code: "fout", step: "start", format: backup.format, version: 1 })).status === 403);
  check("back-up staat in het logboek", (await admin.post("/api/admin/backup/done")).status === 200 && (await admin.get("/api/audit")).data.entries.some((e) => e.action === "POST /api/admin/backup/done"));
  if (process.env.BACKUP_OUT) {
    writeFileSync(process.env.BACKUP_OUT, JSON.stringify(backup));
    console.log(`  back-up geschreven naar ${process.env.BACKUP_OUT} (${Object.values(backup.tables).reduce((n, r) => n + r.length, 0)} regels)`);
  }
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
