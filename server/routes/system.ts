import { q, q1 } from "../db";
import { store } from "../files";
import { smtpSettings, verifySmtp } from "../mail";
import { plaudAvailable, plaudReachable } from "../plaud";
import { route } from "../router";
import { dataLocation } from "./admin";
import { aiSelfTest } from "./ai";

/**
 * Systeemcontrole voor de platformbeheerder: één knop die elk onderdeel echt aanspreekt en zegt
 * of het werkt. Zo hoeft niemand te raden of de AI-assistent, de mailserver of de dagelijkse
 * herinneringen het doen.
 */

type Check = { key: string; label: string; status: "ok" | "fout" | "uit" | "let_op"; detail: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

route.post(
  "/api/admin/system/check",
  async (c) => {
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
    const ai = await aiSelfTest(c.user.id);
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

    const where = dataLocation(c.serverRegion);
    checks.push({
      key: "locatie",
      label: "Locatie van de gegevens",
      status: where.binnenEu ? "ok" : "let_op",
      detail: `Functies: ${where.functies}. Database: ${where.database}. Stukken: ${where.stukken}.${
        where.binnenEu ? " Alles binnen de EU." : " Niet alles staat binnen de EU. De regio van de functies en de database stel je in bij Netlify (Cloud compute, Functions, Region); verhuizen kan met een back-up."
      }`,
    });

    return { checks, at: new Date().toISOString() };
  },
  { admin: true, audit: false },
);
