import { randomUUID } from "node:crypto";
import { loadMeeting } from "../access";
import { requireAi } from "../ai";
import type { User } from "../auth";
import { q, q1 } from "../db";
import { bad, dateTime, forbidden, HttpError, notFound, optStr, str, uuid } from "../http";
import { runNotesJob } from "../notes-job";
import { getTranscript } from "../plaud";
import { route } from "../router";
import { plaudRedirectUri } from "./plaud";

/**
 * Het transcript van een vergadering: de woordelijke tekst van de opname. Alleen de secretaris
 * (en de beheerder van de organisatie) ziet het; deelnemers krijgen de notulen die eruit volgen.
 */

const MIN_CHARS = 200;
/** Ruim genoeg voor een vergadering van een dag, en binnen wat het taalmodel in één keer kan lezen. */
const MAX_CHARS = 400_000;

/** Alleen de secretaris. Bewerken kan niet meer als de vergadering is afgerond; inzien en verwijderen wel. */
async function secretary(user: User, meetingId: string, edit: boolean) {
  const { meeting, role } = await loadMeeting(user, meetingId, edit ? { edit: true } : {});
  if (role !== "secretaris") throw forbidden("Alleen de secretaris of beheerder kan het transcript zien.");
  return meeting;
}

route.get("/api/meetings/:id/transcript", async (c) => {
  const meetingId = uuid(c.params.id, "Vergadering");
  await secretary(c.user, meetingId, false);
  const withBody = c.url.searchParams.has("body");
  const [transcript, job] = await Promise.all([
    q1(
      `SELECT t.source, t.title, t.recorded_at, length(t.body) AS chars, t.created_at, u.name AS created_by_name${withBody ? ", t.body" : ""}
         FROM transcripts t LEFT JOIN users u ON u.id = t.created_by WHERE t.meeting_id = $1`,
      [meetingId],
    ),
    // De laatste klus van deze gebruiker: zo vindt het scherm lopend of afgerond werk terug na verversen.
    q1(
      `SELECT id, status FROM ai_jobs WHERE meeting_id = $1 AND user_id = $2 AND created_at > now() - interval '1 day' ORDER BY created_at DESC LIMIT 1`,
      [meetingId, c.user.id],
    ),
  ]);
  return { transcript, job };
});

route.put("/api/meetings/:id/transcript", async (c) => {
  const meetingId = uuid(c.params.id, "Vergadering");
  await secretary(c.user, meetingId, true);
  const b = await c.body();
  const title = optStr(b.title, "Naam", 200);
  let body: string;
  let source: "plaud" | "tekst";
  let recordedAt: string | null = null;
  if (b.plaudFileId !== undefined) {
    source = "plaud";
    body = await getTranscript(c.user.id, plaudRedirectUri(c), str(b.plaudFileId, "Opname", { max: 200 }));
    if (b.recordedAt) recordedAt = dateTime(b.recordedAt, "Tijdstip van de opname");
  } else {
    source = "tekst";
    body = typeof b.text === "string" ? b.text.replace(/\r\n?/g, "\n").trim() : "";
    if (body.length < MIN_CHARS) throw bad("Dit is te kort voor een transcript. Plak de volledige tekst van de opname.");
  }
  if (body.length > MAX_CHARS) {
    throw new HttpError(413, "Dit transcript is te lang om te verwerken (maximaal 400.000 tekens, ruim een vergaderdag). Splits de vergadering of kort het transcript in.");
  }
  await q(
    `INSERT INTO transcripts (meeting_id, source, title, recorded_at, body, created_by) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (meeting_id) DO UPDATE SET source = EXCLUDED.source, title = EXCLUDED.title, recorded_at = EXCLUDED.recorded_at,
       body = EXCLUDED.body, created_by = EXCLUDED.created_by, created_at = now()`,
    [meetingId, source, title, recordedAt, body, c.user.id],
  );
  return { chars: body.length, preview: body.slice(0, 600) };
});

route.delete("/api/meetings/:id/transcript", async (c) => {
  const meetingId = uuid(c.params.id, "Vergadering");
  // Verwijderen kan ook na afronden: het transcript hoort juist niet langer te blijven dan nodig.
  await secretary(c.user, meetingId, false);
  await q(`DELETE FROM transcripts WHERE meeting_id = $1`, [meetingId]);
  await q(`DELETE FROM ai_jobs WHERE meeting_id = $1`, [meetingId]);
  return { ok: true };
});

/** Zet de klus klaar; het scherm start daarna het achtergrondwerk en vraagt de stand op. */
route.post("/api/meetings/:id/transcript/notes", async (c) => {
  const meetingId = uuid(c.params.id, "Vergadering");
  const meeting = await secretary(c.user, meetingId, true);
  await requireAi(meeting.organisationId);
  if (!(await q1(`SELECT 1 AS x FROM transcripts WHERE meeting_id = $1`, [meetingId]))) throw notFound("Er staat nog geen transcript bij deze vergadering.");
  if (!(await q1(`SELECT 1 AS x FROM agenda_items WHERE meeting_id = $1 LIMIT 1`, [meetingId]))) {
    throw new HttpError(422, "Deze vergadering heeft geen agendapunten om de notulen over te verdelen.");
  }
  const busy = await q1<{ id: string }>(
    `SELECT id FROM ai_jobs WHERE meeting_id = $1 AND status IN ('wacht', 'bezig') AND created_at > now() - interval '15 minutes' LIMIT 1`,
    [meetingId],
  );
  if (busy) return { jobId: busy.id, running: true };
  const jobId = randomUUID();
  await q(`INSERT INTO ai_jobs (id, kind, meeting_id, user_id) VALUES ($1, 'notulen', $2, $3)`, [jobId, meetingId, c.user.id]);
  return { jobId, running: false };
});

route.get("/api/jobs/:id", async (c) => {
  const id = uuid(c.params.id, "Klus");
  // Werk dat is blijven hangen (functie gestopt) na een kwartier afsluiten, zodat het scherm niet eeuwig wacht.
  await q(
    `UPDATE ai_jobs SET status = 'mislukt', error = 'Het maken van de concept-notulen is afgebroken. Probeer het opnieuw.', finished_at = now()
      WHERE id = $1 AND status IN ('wacht', 'bezig') AND created_at < now() - interval '15 minutes'`,
    [id],
  );
  const job = await q1<{ id: string; status: string; result: unknown; error: string; userId: string }>(
    `SELECT id, status, result, error, user_id FROM ai_jobs WHERE id = $1`,
    [id],
  );
  if (!job || job.userId !== c.user.id) throw notFound("Klus niet gevonden.");
  return { id: job.id, status: job.status, result: job.status === "klaar" ? job.result : null, error: job.error };
});

/**
 * Het eigenlijke werk. Deze route draait in de achtergrondfunctie (netlify/functions/api-background.mts):
 * het scherm krijgt direct antwoord, het werk mag tot een kwartier duren.
 */
route.post(
  "/api/background/jobs/:id/run",
  async (c) => {
    await runNotesJob(uuid(c.params.id, "Klus"), c.user.id);
    return { ok: true };
  },
  { audit: false },
);
