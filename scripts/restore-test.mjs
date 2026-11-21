// Test van het terugzetten van een back-up. Draait tegen een LEGE database, met een back-up die
// scripts/e2e.mjs heeft geschreven (BACKUP_OUT=<bestand> node scripts/e2e.mjs).
//   BACKUP=<bestand> node scripts/restore-test.mjs
import { readFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:8888";
const CODE = process.env.SETUP_CODE ?? "lokale-testcode";
const ADMIN = { email: "beheer@test.example", password: "een-lang-testwachtwoord" };
const backup = JSON.parse(readFileSync(process.env.BACKUP, "utf8"));
let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) passed++;
  else {
    failures.push(`${name} ${detail}`);
    console.log(`  FOUT: ${name} ${detail}`);
  }
};

let cookie = "";
let org = null;
async function call(method, path, body) {
  const headers = { origin: BASE };
  if (cookie) headers.cookie = cookie;
  if (org) headers["x-organisation"] = org;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  for (const c of res.headers.getSetCookie()) cookie = c.split(";")[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}
const restore = (body) => call("POST", "/api/setup/restore", { code: CODE, ...body });

check("leeg platform wacht op inrichting", (await call("GET", "/api/session")).data.setupNeeded === true);
check("rijen sturen zonder te beginnen geweigerd", (await restore({ step: "rows", table: "users", rows: backup.tables.users })).status === 409);
check("verkeerde code geweigerd", (await call("POST", "/api/setup/restore", { code: "fout", step: "start", format: backup.format, version: 1 })).status === 403);
check("onbekend bestand geweigerd", (await restore({ step: "start", format: "iets-anders", version: 1 })).status === 400);
const start = await restore({ step: "start", format: backup.format, version: backup.version });
check("terugzetten gestart, met de volgorde van de tabellen", start.status === 200 && start.data.order[0] === "users", JSON.stringify(start.data));

let sent = 0;
for (const name of start.data.order) {
  const rows = backup.tables[name] ?? [];
  // Kleine delen, zoals de browser doet; een deel twee keer sturen mag niets dubbel opleveren.
  for (let i = 0; i < rows.length; i += 40) {
    const part = rows.slice(i, i + 40);
    const res = await restore({ step: "rows", table: name, rows: part });
    if (res.status !== 200) {
      check(`deel van ${name} teruggezet`, false, JSON.stringify(res));
      break;
    }
    sent += res.data.inserted;
    if (i === 0) check(`${name}: hetzelfde deel nog eens sturen voegt niets toe`, (await restore({ step: "rows", table: name, rows: part })).data.inserted === 0);
  }
  if (name === "users") {
    check("tijdens het terugzetten blijft het inrichtscherm staan", (await call("GET", "/api/session")).data.setupNeeded === true);
    check("een afgebroken actie kan opnieuw beginnen", (await restore({ step: "start", format: backup.format, version: 1 })).status === 200);
  }
}
const total = Object.values(backup.tables).reduce((n, r) => n + r.length, 0);
check("alle regels teruggezet", sent === total, `${sent} van ${total}`);
check("onbekende tabel geweigerd", (await restore({ step: "rows", table: "sessions", rows: [{}] })).status === 400);
const finish = await restore({ step: "finish" });
check("afgerond met de juiste aantallen", finish.status === 200 && finish.data.users === backup.tables.users.length && finish.data.meetings === backup.tables.meetings.length, JSON.stringify(finish.data));
check("daarna is het platform in gebruik", (await call("GET", "/api/session")).data.setupNeeded === false && (await restore({ step: "start", format: backup.format, version: 1 })).status === 409);

// Werkt het teruggezette platform?
const login = await call("POST", "/api/login", ADMIN);
check("inloggen met het bestaande wachtwoord", login.status === 200, JSON.stringify(login));
const session = await call("GET", "/api/session");
check("organisaties zijn terug", session.data.organisations.length >= 1 && session.data.user.passkeys === backup.tables.passkeys.filter((p) => p.user_id === session.data.user.id).length, JSON.stringify(session.data.organisations));
org = session.data.organisations.find((o) => o.name === "Testbedrijf")?.id ?? session.data.organisations[0].id;
const overleggen = await call("GET", "/api/overleggen");
check("overleggen zijn terug", overleggen.status === 200 && overleggen.data.overleggen.length >= 1, JSON.stringify(overleggen).slice(0, 200));
const meeting = backup.tables.meetings.find((m) => m.title === "MT week 48");
const detail = await call("GET", `/api/meetings/${meeting.id}`);
const expected = (table, key = "meeting_id") => backup.tables[table].filter((r) => r[key] === meeting.id).length;
check(
  "vergadering met agenda, notulen, besluiten, acties en stukken is terug",
  detail.status === 200 &&
    detail.data.items.length === expected("agenda_items") &&
    detail.data.decisions.length === expected("decisions") &&
    detail.data.actions.length === expected("actions") &&
    detail.data.documents.length === expected("documents") &&
    detail.data.items.some((i) => i.notes.includes("xyzzy")),
  JSON.stringify({ items: detail.data?.items?.length, decisions: detail.data?.decisions?.length }),
);
check("vergadermodus loopt niet na terugzetten", detail.data.meeting.liveStartedAt === null);
const decisions = await call("GET", "/api/decisions");
check("besluitenlijst met nummers is terug", decisions.data.decisions.length > 0 && decisions.data.decisions.every((d) => /^\d{4}-\d{3}$/.test(d.number)));
// Nieuwe besluiten nummeren door, en het logboek loopt door (reeksnummers hersteld).
// Een besloten overleg blijft na terugzetten besloten: de beheerder van de organisatie kan er niet bij.
const closedIds = new Set(backup.tables.overleggen.filter((o) => o.besloten).map((o) => o.id));
const closed = backup.tables.meetings.find((m) => closedIds.has(m.overleg_id));
if (closed) {
  check(
    "een besloten overleg blijft besloten voor de beheerder",
    (await call("GET", `/api/meetings/${closed.id}`)).status === 404 && (await call("GET", `/api/overleggen/${closed.overleg_id}`)).status === 404,
  );
  const kring = backup.tables.overleggen.find((o) => o.parent_id);
  const listed = (await call("GET", `/api/organisations/${org}/besloten`)).data.overleggen;
  check("het beheer ziet de besloten kring met het overleg waar hij bij hoort", !kring || listed.some((o) => o.id === kring.id && !!o.parentName), JSON.stringify(listed));
}
const open = backup.tables.meetings.find((m) => m.status === "gepubliceerd" && !closedIds.has(m.overleg_id));
if (open) {
  const next = await call("POST", `/api/meetings/${open.id}/decisions`, { text: "Besluit na terugzetten." });
  const numbers = new Set(backup.tables.decisions.map((d) => d.number));
  check("een nieuw besluit krijgt een nieuw nummer", next.status === 200 && !numbers.has(next.data.number), JSON.stringify(next));
  await new Promise((r) => setTimeout(r, 1500));
  check("het logboek loopt door", (await call("GET", "/api/audit")).data.entries[0].action === "POST /api/meetings/:id/decisions", JSON.stringify((await call("GET", "/api/audit")).data.entries[0]));
}

console.log(`\n${passed} controles geslaagd, ${failures.length} mislukt`);
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join("\n"));
  process.exit(1);
}
