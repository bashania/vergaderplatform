import { safeEqual } from "../auth";
import { q, q1, qRaw } from "../db";
import { bad, env, forbidden, HttpError, int, oneOf } from "../http";
import { route } from "../router";

/**
 * Back-up en terugzetten van alle gegevens in de database.
 *
 * - Back-up: de platformbeheerder downloadt alle tabellen als één bestand. De browser haalt ze
 *   tabel voor tabel op (een antwoord van de server mag niet groter zijn dan een paar MB).
 * - Terugzetten: alleen op een leeg platform (nog geen accounts) en met de installatiecode.
 *   Bedoeld voor een verhuizing (andere regio, ander project) of herstel na verlies.
 *
 * Niet in de back-up: de bestanden zelf (die staan in de opslag voor stukken; de back-up bevat
 * wel hun gegevens) en vluchtige zaken als sessies, eenmalige links en logboeken van mail en AI.
 */

type Table = { name: string; order: string; page: number; where?: string; strip?: string[] };

/** In de volgorde waarin terugzetten kan: een tabel staat na de tabellen waar ze naar verwijst. */
const TABLES: Table[] = [
  { name: "users", order: "id", page: 300 },
  { name: "organisations", order: "id", page: 300 },
  { name: "organisation_admins", order: "organisation_id, user_id", page: 500 },
  { name: "overleggen", order: "id", page: 300 },
  { name: "memberships", order: "overleg_id, user_id", page: 500 },
  // De stand van de vergadermodus verwijst naar een agendapunt en gaat niet mee: na terugzetten loopt er geen vergadering.
  { name: "meetings", order: "id", page: 100, strip: ["live_started_at", "live_item_id", "live_item_started_at"] },
  // Hoofdpunten vóór hun subpunten.
  { name: "agenda_items", order: "(parent_id IS NOT NULL), id", page: 50 },
  { name: "documents", order: "id", page: 300, where: "status = 'ready'" },
  { name: "decision_counters", order: "overleg_id, year", page: 500 },
  { name: "decisions", order: "id", page: 200 },
  { name: "actions", order: "id", page: 300 },
  { name: "attendance", order: "meeting_id, user_id", page: 500 },
  { name: "suggestions", order: "id", page: 200 },
  // Verwijst naar een besluit; besluiten staan hierboven.
  { name: "ballots", order: "id", page: 200 },
  { name: "ballot_votes", order: "ballot_id, user_id", page: 500 },
  { name: "transcripts", order: "meeting_id", page: 3 },
  { name: "passkeys", order: "id", page: 300 },
  { name: "plaud_connections", order: "user_id", page: 300 },
  { name: "settings", order: "key", page: 300, where: "key NOT LIKE 'restore.%' AND key <> 'daily.last'" },
  { name: "audit_log", order: "id", page: 500 },
];
const NAMES = TABLES.map((t) => t.name);
const table = (name: unknown) => TABLES.find((t) => t.name === oneOf(name, "Tabel", NAMES as [string, ...string[]]))!;

// ---------- back-up (platformbeheerder) ----------

route.get(
  "/api/admin/backup",
  async () => {
    const counts: Record<string, number> = {};
    for (const t of TABLES) {
      counts[t.name] = (await q1<{ n: number }>(`SELECT count(*)::int AS n FROM ${t.name}${t.where ? ` WHERE ${t.where}` : ""}`))?.n ?? 0;
    }
    return { format: "vergaderplatform-backup", version: 1, tables: TABLES.map((t) => ({ name: t.name, rows: counts[t.name] })) };
  },
  { admin: true },
);

/** Eén deel van één tabel. Een POST, zodat elke back-up in het logboek staat. */
route.post(
  "/api/admin/backup",
  async (c) => {
    const b = await c.body();
    const t = table(b.table);
    const offset = int(b.offset ?? 0, "Positie", 0, 100_000_000);
    // De rij zoals Postgres haar kent (kolomnamen ongewijzigd), zodat terugzetten haar precies zo terugleest.
    const rows = (await qRaw<{ r: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS r FROM ${t.name} t${t.where ? ` WHERE ${t.where}` : ""} ORDER BY ${t.order} LIMIT ${t.page} OFFSET $1`,
      [offset],
    )).map(({ r }) => {
      for (const column of t.strip ?? []) delete r[column];
      return r;
    });
    return { table: t.name, rows, next: rows.length === t.page ? offset + rows.length : null };
  },
  // Alleen het begin van een tabel komt in het logboek, niet elk vervolgdeel.
  { admin: true, audit: false },
);

/** Aangeroepen als de browser de back-up compleet heeft: zo staat in het logboek wie wanneer een back-up maakte. */
route.post("/api/admin/backup/done", async () => ({ ok: true }), { admin: true });

// ---------- terugzetten (leeg platform, met de installatiecode) ----------

function checkCode(given: unknown) {
  const code = env("SETUP_CODE");
  if (!code || typeof given !== "string" || !safeEqual(given, code)) throw forbidden("De installatiecode klopt niet.");
}

const busy = async () => !!(await q1(`SELECT 1 AS x FROM settings WHERE key = 'restore.busy'`));

route.post(
  "/api/setup/restore",
  async (c) => {
    const b = await c.body();
    checkCode(b.code);
    const step = oneOf(b.step, "Stap", ["start", "rows", "finish"] as const);

    if (step === "start") {
      // Een afgebroken terugzetactie mag opnieuw beginnen: wat er al staat, wordt overgeslagen.
      if (!(await busy()) && (await q1(`SELECT 1 AS x FROM users LIMIT 1`))) {
        throw new HttpError(409, "Dit platform is al in gebruik. Een back-up terugzetten kan alleen op een leeg platform.");
      }
      if (b.format !== "vergaderplatform-backup" || b.version !== 1) throw bad("Dit bestand is geen back-up van het vergaderplatform, of van een versie die hier niet past.");
      await q(`INSERT INTO settings (key, value) VALUES ('restore.busy', '1') ON CONFLICT (key) DO NOTHING`);
      return { order: NAMES };
    }

    // Zolang het terugzetten loopt, is het platform van niemand: alleen wie de code heeft, kan verder.
    if (!(await busy())) throw new HttpError(409, "Er loopt geen terugzetactie. Begin opnieuw.");

    if (step === "rows") {
      const t = table(b.table);
      if (!Array.isArray(b.rows) || b.rows.length > 1000) throw bad("Ongeldig deel van de back-up.");
      const rows = b.rows.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r));
      if (!rows.length) return { inserted: 0 };
      // Alleen kolommen die deze versie kent en die in het bestand staan; de rest krijgt zijn standaardwaarde.
      const known = (await q<{ columnName: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [t.name])).map((r) => r.columnName);
      const present = new Set(rows.flatMap((r) => Object.keys(r)));
      const columns = known.filter((name) => present.has(name) && !(t.strip ?? []).includes(name)).map((name) => `"${name.replace(/"/g, "")}"`);
      if (!columns.length) throw bad(`De back-up bevat geen bruikbare gegevens voor ${t.name}.`);
      const inserted = await q(
        `INSERT INTO ${t.name} (${columns.join(", ")}) SELECT ${columns.join(", ")} FROM jsonb_populate_recordset(NULL::${t.name}, $1::jsonb) ON CONFLICT DO NOTHING RETURNING 1 AS x`,
        [JSON.stringify(rows)],
      );
      return { inserted: inserted.length };
    }

    // Afronden: er moet een beheerder zijn om mee in te loggen, en nieuwe logboekregels moeten doornummeren.
    if (!(await q1(`SELECT 1 AS x FROM users WHERE is_admin AND active LIMIT 1`))) {
      throw new HttpError(422, "De back-up bevat geen actieve platformbeheerder. Terugzetten is niet afgerond; controleer het bestand.");
    }
    await q(`SELECT setval(pg_get_serial_sequence('audit_log', 'id'), GREATEST((SELECT COALESCE(max(id), 0) FROM audit_log), 1))`);
    await q(`DELETE FROM settings WHERE key = 'restore.busy'`);
    const totals = await q1(`SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM organisations) AS organisations, (SELECT count(*)::int FROM meetings) AS meetings`);
    return { ok: true, ...totals };
  },
  { public: true, audit: false },
);

