import { safeEqual } from "../auth";
import { dbRegion, q, q1 } from "../db";
import { store } from "../files";
import { env, forbidden } from "../http";
import { mailer, smtpSettings, verifySmtp } from "../mail";
import { plaudAvailable, plaudReachable } from "../plaud";
import { route } from "../router";
import { hasSecretKey, taskKey } from "../secret";
import { aiSelfTest } from "./ai";

/**
 * Systeemcontrole: spreekt elk onderdeel echt aan en zegt of het werkt. Zo hoeft niemand te raden of
 * de AI-assistent, de mailserver of de dagelijkse herinneringen het doen.
 *
 * - De platformbeheerder start hem met een knop.
 * - De dagelijkse taak doet hem elke ochtend (zelftest) en bewaart de uitslag. Werkt er iets niet, dan
 *   ziet de platformbeheerder dat in het menu en krijgt hij er, als de mailserver het doet, bericht van.
 * - /api/health toont de laatste uitslag in grote lijnen en start een zelftest als die verouderd is.
 */

/** Regio van de functies, de database en de stukken, en of dat binnen de EU is. */
export function dataLocation(serverRegion: string) {
  const functies = serverRegion;
  const database = dbRegion();
  const stukken = env("BLOB_REGION") ?? "eu-central-1";
  const eu = (r: string) => r.startsWith("eu-") || ["fra", "dub", "cdg", "mxp", "lokaal", "dev"].includes(r);
  return { functies, database, stukken, binnenEu: eu(functies) && eu(database) && eu(stukken) };
}

type Check = { key: string; label: string; status: "ok" | "fout" | "uit" | "let_op"; detail: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** userId: wie de controle startte (voor het logboek van AI-verzoeken); leeg bij de automatische controle. */
export async function runChecks(serverRegion: string, userId: string | null): Promise<Check[]> {
  {
    const checks: Check[] = [];

    const t0 = Date.now();
    try {
      await q(`SELECT 1 AS ok`);
      checks.push({ key: "db", label: "Database", status: "ok", detail: `Antwoord in ${Date.now() - t0} ms.` });
    } catch (e) {
      checks.push({ key: "db", label: "Database", status: "fout", detail: message(e) });
    }

    try {
      await store().get("health-check");
      checks.push({ key: "blobs", label: "Opslag van stukken", status: "ok", detail: "Bereikbaar." });
    } catch (e) {
      checks.push({ key: "blobs", label: "Opslag van stukken", status: "fout", detail: message(e) });
    }

    // De AI-test doet één klein verzoek over dezelfde route als de echte verzoeken.
    const ai = await aiSelfTest(userId);
    checks.push({
      key: "ai",
      label: "AI-assistent",
      status: ai.ok ? "ok" : ai.available ? "fout" : "uit",
      detail: ai.ok ? `Model ${ai.model} antwoordde in ${ai.ms} ms. Aanzetten doet elke organisatie zelf.` : (ai.error ?? "Onbekende fout."),
    });

    if (!(await smtpSettings())) {
      checks.push({ key: "mail", label: "E-mail", status: "uit", detail: "Geen mailserver ingesteld. Het platform verstuurt geen e-mail." });
    } else {
      const error = await verifySmtp();
      checks.push({
        key: "mail",
        label: "E-mail",
        status: error ? "fout" : "ok",
        detail: error ? `De mailserver weigert de verbinding: ${error}` : "Verbinden en aanmelden bij de mailserver lukt. Stuur een testmail om ook de aflevering te zien.",
      });
    }

    if (!plaudAvailable()) {
      checks.push({ key: "plaud", label: "Koppeling met Plaud", status: "uit", detail: "Niet ingericht (de versleutelingssleutel ontbreekt)." });
    } else {
      try {
        await plaudReachable();
        const linked = await q1<{ n: number }>(`SELECT count(*)::int AS n FROM plaud_connections`);
        checks.push({
          key: "plaud",
          label: "Koppeling met Plaud",
          status: "ok",
          detail: `Plaud is bereikbaar en biedt koppelen aan. ${linked?.n ?? 0} ${linked?.n === 1 ? "gebruiker heeft" : "gebruikers hebben"} gekoppeld.`,
        });
      } catch (e) {
        checks.push({ key: "plaud", label: "Koppeling met Plaud", status: "fout", detail: `Plaud is niet bereikbaar of biedt koppelen niet aan (${message(e)}).` });
      }
    }

    // De dagelijkse taak laat bij elke run een spoor achter; ouder dan ruim een dag betekent dat hij niet loopt.
    const last = await q1<{ value: string }>(`SELECT value FROM settings WHERE key = 'daily.last'`);
    let run: { at?: string; result?: string } = {};
    try {
      run = last ? (JSON.parse(last.value) as typeof run) : {};
    } catch {
      run = {};
    }
    const age = run.at ? (Date.now() - Date.parse(run.at)) / 3_600_000 : null;
    const when = run.at ? new Date(run.at).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam", dateStyle: "long", timeStyle: "short" }) : "";
    checks.push({
      key: "daily",
      label: "Dagelijkse herinneringen",
      status: age === null ? "uit" : age < 26 ? "ok" : "fout",
      detail:
        age === null
          ? "Nog niet gelopen sinds deze versie. De taak loopt elke ochtend rond half zeven; kijk morgen opnieuw."
          : `Laatst gelopen op ${when}: ${run.result ?? "geen uitkomst"}.${age >= 26 ? " Dat is langer dan een dag geleden: de taak loopt niet." : ""}`,
    });

    const where = dataLocation(serverRegion);
    checks.push({
      key: "locatie",
      label: "Locatie van de gegevens",
      status: where.binnenEu ? "ok" : "let_op",
      detail: `Functies: ${where.functies}. Database: ${where.database}. Stukken: ${where.stukken}.${
        where.binnenEu ? " Alles binnen de EU." : " Niet alles staat binnen de EU. De regio van de functies en de database stel je in bij Netlify (Cloud compute, Functions, Region); verhuizen kan met een back-up."
      }`,
    });

    return checks;
  }
}

// ---------- zelftest: de uitslag bewaren ----------

export type SelfTest = { at: string; by: "taak" | "beheerder" | "bewaking"; checks: Check[] };

const save = (key: string, value: string) =>
  q(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);

/** Voert de controle uit en bewaart de uitslag. */
export async function selfTest(serverRegion: string, by: SelfTest["by"], userId: string | null = null): Promise<SelfTest> {
  const result: SelfTest = { at: new Date().toISOString(), by, checks: await runChecks(serverRegion, userId) };
  await save("selftest.last", JSON.stringify(result));
  return result;
}

export async function lastSelfTest(): Promise<SelfTest | null> {
  const row = await q1<{ value: string }>(`SELECT value FROM settings WHERE key = 'selftest.last'`);
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as SelfTest;
    return Array.isArray(v.checks) && typeof v.at === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Wat er volgens de laatste zelftest niet werkt: voor de melding bij de platformbeheerder. */
export async function systemIssues(): Promise<string[]> {
  const last = await lastSelfTest();
  if (!last) return [];
  const issues = last.checks.filter((c) => c.status === "fout").map((c) => c.label);
  // De taak ververst de uitslag elke ochtend; is die dagen oud, dan loopt de taak zelf niet.
  if (Date.now() - Date.parse(last.at) > 50 * 3_600_000) issues.push("Dagelijkse controle");
  return issues;
}

const STALE_MS = 20 * 3_600_000;

/**
 * Bewaking: is de laatste zelftest ouder dan twintig uur (of nooit gedaan), dan start /api/health er één
 * in de achtergrond. De claim in de database laat hooguit één aanroeper per twintig uur door, wie de
 * pagina ook opvraagt. De sleutel gaat alleen naar het eigen adres van het platform.
 */
export async function startSelfTestIfStale(requestOrigin: string, last: SelfTest | null): Promise<boolean> {
  if (!hasSecretKey() || (last && Date.now() - Date.parse(last.at) < STALE_MS)) return false;
  const now = new Date();
  const claimed = await q(
    `INSERT INTO settings (key, value) VALUES ('selftest.claim', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE settings.value < $2
     RETURNING key`,
    [now.toISOString(), new Date(now.getTime() - STALE_MS).toISOString()],
  );
  if (!claimed.length) return false;
  const site = env("URL") || requestOrigin;
  try {
    await fetch(`${site}/api/background/selftest`, {
      method: "POST",
      headers: { origin: site, "content-type": "application/json", "x-task-key": taskKey("daily") },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    return true;
  } catch (e) {
    console.error("zelftest starten", e);
    return false;
  }
}

/**
 * Werkt er iets niet, dan krijgen de platformbeheerders daar bericht van: hooguit één keer per dag, en
 * alleen als de mailserver het zelf wel doet.
 */
export async function reportIssues(result: SelfTest, origin: string): Promise<number> {
  const wrong = result.checks.filter((c) => c.status === "fout");
  if (!wrong.length || wrong.some((c) => c.key === "mail")) return 0;
  const m = await mailer();
  if (!m) return 0;
  try {
    const admins = await q<{ id: string; email: string; name: string }>(`SELECT id, email, name FROM users WHERE is_admin AND active ORDER BY lower(name) LIMIT 20`);
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });
    let sent = 0;
    for (const a of admins) {
      const ok = await m.send({
        kind: "systeem",
        to: { email: a.email, name: a.name },
        subject: wrong.length === 1 ? `Systeemcontrole: ${wrong[0].label} werkt niet` : `Systeemcontrole: ${wrong.length} onderdelen werken niet`,
        intro: [`Beste ${a.name},`, "De dagelijkse controle van het vergaderplatform vond iets dat niet werkt. Zolang dit zo blijft, merken gebruikers het tijdens het vergaderen."],
        sections: [{ title: "Werkt niet", lines: wrong.map((c) => `${c.label}: ${c.detail}`) }],
        button: { label: "Open de systeemcontrole", url: `${origin}/beheer?tab=instellingen` },
        footer: "Je krijgt dit bericht omdat je platformbeheerder bent. Het komt hooguit één keer per dag, en alleen als er iets niet werkt.",
        dedupeKey: `zelftest:${today}:${a.id}`,
      });
      if (ok) sent++;
    }
    return sent;
  } finally {
    m.close();
  }
}

// ---------- routes ----------

route.post(
  "/api/admin/system/check",
  async (c) => {
    const r = await selfTest(c.serverRegion, "beheerder", c.user.id);
    return { checks: r.checks, at: r.at };
  },
  { admin: true, audit: false },
);

/** De laatste uitslag, van de automatische controle of van de knop. */
route.get("/api/admin/system/last", async () => ({ last: await lastSelfTest() }), { admin: true });

/**
 * De zelftest in de achtergrondfunctie: gestart door de bewaking (/api/health) met de afgeleide sleutel,
 * of door de platformbeheerder.
 */
route.post(
  "/api/background/selftest",
  async (c) => {
    const byTask = hasSecretKey() && safeEqual(c.req.headers.get("x-task-key") ?? "", taskKey("daily"));
    if (!byTask && !c.user?.isAdmin) throw forbidden("Geen toegang.");
    const r = await selfTest(c.serverRegion, byTask ? "bewaking" : "beheerder", c.user?.id ?? null);
    await reportIssues(r, c.url.origin);
    return { ok: true, at: r.at };
  },
  { public: true, audit: false },
);
