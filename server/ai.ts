import Anthropic from "@anthropic-ai/sdk";
import { q, q1 } from "./db";
import { currentDeployContext } from "./files";
import { env, forbidden, HttpError } from "./http";

/**
 * AI-assistent. Loopt via Netlify AI Gateway: die zet op de server de toegang tot Claude klaar
 * (ANTHROPIC_API_KEY en ANTHROPIC_BASE_URL), dus er hoeft geen eigen sleutel beheerd te worden.
 *
 * Uitgangspunten:
 * - Uit, tot een beheerder van de organisatie hem aanzet: notulen en stukken verlaten dan het platform.
 * - De assistent stelt voor; een mens beslist. Er wordt niets vastgelegd zonder dat iemand het overneemt.
 * - Eén verzoek moet binnen de limiet van een Netlify Function (60 s) klaar zijn.
 * - De gateway geeft geen bèta-headers door. Een automatische terugval naar een ander model bij een
 *   weigering (server-side fallbacks) kan daardoor niet; een weigering melden we netjes aan de gebruiker.
 */

/** Ander model nodig? Zet AI_MODEL op een actueel Claude-model dat de gateway aanbiedt. */
export const aiModel = () => env("AI_MODEL") ?? "claude-opus-5-5";

/** Alleen lokaal: vaste antwoorden in plaats van een echt model, zodat de tests zonder gateway draaien. */
const fakeMode = () => currentDeployContext() === "dev" && env("AI_FAKE") === "1";

export const aiAvailable = () => fakeMode() || !!(env("ANTHROPIC_API_KEY") ?? env("ANTHROPIC_AUTH_TOKEN"));

/** Ruim binnen de 60 seconden van de functie, zodat de gebruiker een nette melding krijgt in plaats van een afgebroken verzoek. */
const TIME_LIMIT_MS = 48_000;
const PER_USER_PER_HOUR = 30;
const PER_ORG_PER_DAY = 300;

export async function requireAi(organisationId: string): Promise<void> {
  const row = await q1<{ aiEnabled: boolean }>(`SELECT ai_enabled FROM organisations WHERE id = $1`, [organisationId]);
  if (!row?.aiEnabled) {
    throw forbidden("De AI-assistent staat uit voor deze organisatie. Een beheerder zet hem aan onder Toegang en beheer.");
  }
  if (!aiAvailable()) throw new HttpError(503, "De AI-assistent is op dit platform niet beschikbaar.");
}

type Request = {
  kind: "voorstellen" | "samenvatting" | "test";
  organisationId: string | null;
  userId: string;
  system: string;
  content: Anthropic.MessageParam["content"];
  /** JSON-schema voor een gestructureerd antwoord. */
  schema?: Record<string, unknown>;
  maxTokens: number;
  /** Antwoord in de lokale testmodus. */
  fake: () => string;
};

async function checkBudget(r: Request): Promise<void> {
  const used = await q1<{ byUser: number; byOrg: number }>(
    `SELECT count(*) FILTER (WHERE user_id = $1 AND at > now() - interval '1 hour')::int AS by_user,
            count(*) FILTER (WHERE organisation_id = $2)::int AS by_org
       FROM ai_calls WHERE at > now() - interval '24 hours'`,
    [r.userId, r.organisationId],
  );
  if (used && used.byUser >= PER_USER_PER_HOUR) {
    throw new HttpError(429, "Je hebt de AI-assistent het afgelopen uur al vaak gebruikt. Probeer het later opnieuw.");
  }
  if (used && used.byOrg >= PER_ORG_PER_DAY) {
    throw new HttpError(429, "De daglimiet van de AI-assistent voor deze organisatie is bereikt. Morgen kan het weer.");
  }
}

function record(r: Request, model: string, ok: boolean, usage?: { input_tokens: number; output_tokens: number }) {
  return q(
    `INSERT INTO ai_calls (organisation_id, user_id, kind, model, input_tokens, output_tokens, ok) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [r.organisationId, r.userId, r.kind, model, usage?.input_tokens ?? 0, usage?.output_tokens ?? 0, ok],
  ).catch((e) => console.error("ai_calls", e));
}

/** Technische foutmelding, voor de verbindingstest van de platformbeheerder. */
export function aiErrorDetail(e: unknown): string {
  if (e instanceof Anthropic.APIError) return `${e.status ?? "geen status"}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

function userError(e: unknown): unknown {
  if (e instanceof HttpError) return e;
  // Van specifiek naar algemeen: een time-out is ook een verbindingsfout, en alles is een APIError.
  if (e instanceof Anthropic.APIUserAbortError || e instanceof Anthropic.APIConnectionTimeoutError) {
    return new HttpError(504, "Het taalmodel deed er te lang over. Probeer het opnieuw, of met een korter stuk.");
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new HttpError(429, "De AI-assistent heeft het druk of het tegoed is op. Probeer het over een minuut opnieuw.");
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new HttpError(503, "De AI-assistent is niet bereikbaar. Vraag de platformbeheerder de koppeling te testen.");
  }
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.ContentTooLargeError) {
    return new HttpError(422, "Het taalmodel kon deze invoer niet verwerken. Het stuk is mogelijk te groot of beschadigd.");
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new HttpError(502, "Geen verbinding met het taalmodel. Probeer het opnieuw.");
  }
  if (e instanceof Anthropic.APIError) {
    return new HttpError(502, "Het taalmodel gaf een fout. Probeer het later opnieuw.");
  }
  return e;
}

/**
 * Eén vraag aan het model. Gooit een HttpError met een melding die de gebruiker begrijpt;
 * met `raw` blijft de oorspronkelijke fout staan (voor de verbindingstest).
 */
export async function ask(r: Request, raw = false): Promise<{ text: string; model: string }> {
  await checkBudget(r);
  const model = aiModel();
  if (fakeMode()) {
    await record(r, "test", true);
    return { text: r.fake(), model: "test" };
  }
  try {
    // De gateway vult sleutel en adres in; zelf opnieuw proberen doen we niet (de tijd is daarvoor te krap).
    const client = new Anthropic({ maxRetries: 0, timeout: TIME_LIMIT_MS });
    // Streamen houdt de verbinding levend bij een lang antwoord. De klok hieronder begrenst het geheel.
    const stream = client.messages.stream({
      model,
      max_tokens: r.maxTokens,
      system: r.system,
      messages: [{ role: "user", content: r.content }],
      output_config: {
        // Samenvatten en overnemen uit notulen vraagt geen diep redeneerwerk, wel een vlot antwoord.
        effort: "low",
        ...(r.schema ? { format: { type: "json_schema" as const, schema: r.schema } } : {}),
      },
    });
    const timer = setTimeout(() => stream.abort(), TIME_LIMIT_MS);
    let message: Anthropic.Message;
    try {
      message = await stream.finalMessage();
    } finally {
      clearTimeout(timer);
    }
    await record(r, message.model, true, message.usage);
    if (message.stop_reason === "refusal") {
      throw new HttpError(422, "Het taalmodel verwerkt deze inhoud niet. Leg dit onderdeel zelf vast.");
    }
    if (message.stop_reason === "max_tokens") {
      throw new HttpError(502, "Het antwoord van het taalmodel werd te lang en is afgekapt. Probeer het met minder tekst.");
    }
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new HttpError(502, "Het taalmodel gaf geen bruikbaar antwoord. Probeer het opnieuw.");
    return { text, model: message.model };
  } catch (e) {
    if (!(e instanceof HttpError)) {
      console.error("ai", r.kind, aiErrorDetail(e));
      await record(r, model, false);
    }
    throw raw ? e : userError(e);
  }
}

/** Verbruik van een organisatie in de lopende maand. */
export function aiUsage(organisationId: string) {
  return q1<{ calls: number; inputTokens: number; outputTokens: number }>(
    `SELECT count(*)::int AS calls, COALESCE(sum(input_tokens), 0)::int AS input_tokens, COALESCE(sum(output_tokens), 0)::int AS output_tokens
       FROM ai_calls WHERE organisation_id = $1 AND ok AND at >= date_trunc('month', now())`,
    [organisationId],
  );
}
