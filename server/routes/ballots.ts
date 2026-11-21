import { randomUUID } from "node:crypto";
import { loadMeeting, requireOverleg } from "../access";
import { q, q1 } from "../db";
import { bad, forbidden, HttpError, notFound, oneOf, optDateOnly, optStr, optUuid, str, uuid } from "../http";
import { mailer, nlDay } from "../mail";
import { route, type Ctx } from "../router";
import { insertDecision } from "./records";

/**
 * Stemronde: een besluit nemen buiten de vergadering om (schriftelijke besluitvorming).
 * De secretaris legt een voorstel voor, de deelnemers van het overleg stemmen, de secretaris sluit de
 * ronde met de uitkomst. Een aangenomen voorstel legt hij vast als besluit bij een vergadering, zodat
 * het een nummer krijgt en in de besluitenlijst staat.
 */

const OUTCOMES = ["aangenomen", "verworpen", "ingetrokken"] as const;

route.get("/api/overleggen/:id/ballots", async (c) => {
  const overlegId = uuid(c.params.id, "Overleg");
  await requireOverleg(c.user, overlegId);
  const [ballots, voters] = await Promise.all([
    q(
      `SELECT b.id, b.title, b.body, b.closes_on::text AS closes_on, b.status, b.created_at, b.closed_at, u.name AS created_by_name,
              d.number AS decision_number, d.meeting_id AS decision_meeting_id,
              COALESCE((SELECT json_agg(json_build_object('userId', v.user_id, 'name', vu.name, 'vote', v.vote, 'comment', v.comment) ORDER BY lower(vu.name))
                          FROM ballot_votes v JOIN users vu ON vu.id = v.user_id WHERE v.ballot_id = b.id), '[]'::json) AS votes
         FROM ballots b
         LEFT JOIN users u ON u.id = b.created_by
         LEFT JOIN decisions d ON d.id = b.decision_id
        WHERE b.overleg_id = $1 AND (b.status = 'open' OR b.closed_at > now() - interval '1 year')
        ORDER BY (b.status = 'open') DESC, COALESCE(b.closed_at, b.created_at) DESC
        LIMIT 100`,
      [overlegId],
    ),
    // Wie mag stemmen: de deelnemers van het overleg.
    q<{ id: string; name: string }>(
      `SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.overleg_id = $1 AND u.active ORDER BY lower(u.name)`,
      [overlegId],
    ),
  ]);
  return { ballots, voters, canVote: voters.some((v) => v.id === c.user.id) };
});

route.post("/api/overleggen/:id/ballots", async (c) => {
  const overlegId = uuid(c.params.id, "Overleg");
  await requireOverleg(c.user, overlegId, true);
  const b = await c.body();
  const title = str(b.title, "Voorstel", { max: 300 });
  const body = optStr(b.body, "Toelichting", 5000);
  const closesOn = optDateOnly(b.closesOn, "Stemmen tot en met");
  const id = randomUUID();
  await q(`INSERT INTO ballots (id, overleg_id, title, body, closes_on, created_by) VALUES ($1, $2, $3, $4, $5, $6)`, [id, overlegId, title, body, closesOn, c.user.id]);

  // De deelnemers horen dat hun stem wordt gevraagd, als het platform kan mailen.
  let mailed = 0;
  const m = await mailer();
  if (m) {
    try {
      const [overleg, members] = await Promise.all([
        q1<{ name: string; organisationName: string }>(
          `SELECT o.name, org.name AS organisation_name FROM overleggen o JOIN organisations org ON org.id = o.organisation_id WHERE o.id = $1`,
          [overlegId],
        ),
        q<{ email: string; name: string }>(
          `SELECT u.email, u.name FROM memberships mb JOIN users u ON u.id = mb.user_id WHERE mb.overleg_id = $1 AND u.active AND u.id <> $2 ORDER BY lower(u.name) LIMIT 80`,
          [overlegId, c.user.id],
        ),
      ]);
      for (const to of members) {
        const ok = await m.send({
          kind: "stemronde",
          to,
          subject: `Je stem wordt gevraagd: ${title}`,
          intro: [
            `${c.user.name} legt een voorstel voor aan ${overleg?.name ?? "het overleg"}, om buiten de vergadering over te besluiten.`,
            `Voorstel: ${title}`,
            ...(body ? [body] : []),
            ...(closesOn ? [`Stemmen kan tot en met ${nlDay(closesOn)}.`] : []),
          ],
          button: { label: "Stem uitbrengen", url: `${c.url.origin}/overleggen/${overlegId}?tab=stemrondes` },
          footer: `Je krijgt deze e-mail omdat je deelneemt aan ${overleg?.name ?? "dit overleg"}${overleg ? ` (${overleg.organisationName})` : ""}.`,
          replyTo: { email: c.user.email, name: c.user.name },
        });
        if (ok) mailed++;
      }
    } finally {
      m.close();
    }
  }
  return { id, mailed };
});

async function loadBallot(id: string) {
  const b = await q1<{ id: string; overlegId: string; title: string; status: string; decisionId: string | null }>(
    `SELECT id, overleg_id, title, status, decision_id FROM ballots WHERE id = $1`,
    [id],
  );
  if (!b) throw notFound("Stemronde niet gevonden.");
  return b;
}

route.put("/api/ballots/:id/vote", async (c) => {
  const ballot = await loadBallot(uuid(c.params.id, "Stemronde"));
  await requireOverleg(c.user, ballot.overlegId);
  // Stemrecht hoort bij de deelnemers; een beheerder die niet deelneemt, kijkt mee.
  if (!(await q1(`SELECT 1 AS x FROM memberships WHERE overleg_id = $1 AND user_id = $2`, [ballot.overlegId, c.user.id]))) {
    throw forbidden("Alleen deelnemers van dit overleg kunnen stemmen.");
  }
  if (ballot.status !== "open") throw new HttpError(409, "Deze stemronde is gesloten.");
  const b = await c.body();
  const vote = oneOf(b.vote, "Stem", ["akkoord", "niet_akkoord", "onthouding"] as const);
  const comment = optStr(b.comment, "Toelichting", 1000);
  await q(
    `INSERT INTO ballot_votes (ballot_id, user_id, vote, comment) VALUES ($1, $2, $3, $4)
     ON CONFLICT (ballot_id, user_id) DO UPDATE SET vote = EXCLUDED.vote, comment = EXCLUDED.comment, voted_at = now()`,
    [ballot.id, c.user.id, vote, comment],
  );
  return { ok: true };
});

/** Legt een aangenomen voorstel vast als besluit bij een vergadering van hetzelfde overleg. */
async function register(c: Ctx, ballot: { id: string; overlegId: string }, meetingId: string, text: string) {
  const { meeting } = await loadMeeting(c.user, meetingId, { edit: true });
  if (meeting.overlegId !== ballot.overlegId) throw bad("Deze vergadering hoort bij een ander overleg.");
  const tally = await q1<{ voor: number; tegen: number; onthouding: number; closedOn: string }>(
    `SELECT (count(*) FILTER (WHERE v.vote = 'akkoord'))::int AS voor,
            (count(*) FILTER (WHERE v.vote = 'niet_akkoord'))::int AS tegen,
            (count(*) FILTER (WHERE v.vote = 'onthouding'))::int AS onthouding,
            (SELECT (COALESCE(closed_at, now()) AT TIME ZONE 'Europe/Amsterdam')::date::text FROM ballots WHERE id = $1) AS closed_on
       FROM ballot_votes v WHERE v.ballot_id = $1`,
    [ballot.id],
  );
  const suffix = tally
    ? ` (Besloten buiten de vergadering op ${nlDay(tally.closedOn)}: ${tally.voor} akkoord, ${tally.tegen} niet akkoord, ${tally.onthouding} ${tally.onthouding === 1 ? "onthouding" : "onthoudingen"}.)`
    : "";
  const decision = await insertDecision(ballot.overlegId, meetingId, null, `${text}${suffix}`.slice(0, 5000), c.user.id);
  if (decision) await q(`UPDATE ballots SET decision_id = $2 WHERE id = $1`, [ballot.id, decision.id]);
  return decision;
}

route.post("/api/ballots/:id/close", async (c) => {
  const ballot = await loadBallot(uuid(c.params.id, "Stemronde"));
  await requireOverleg(c.user, ballot.overlegId, true);
  if (ballot.status !== "open") throw new HttpError(409, "Deze stemronde is al gesloten.");
  const b = await c.body();
  const outcome = oneOf(b.outcome, "Uitkomst", OUTCOMES);
  const meetingId = outcome === "aangenomen" ? optUuid(b.meetingId, "Vergadering") : null;
  const text = meetingId ? str(b.decisionText ?? ballot.title, "Besluit", { max: 4000 }) : "";
  // Eerst controleren of het besluit kan worden vastgelegd; dan pas sluiten.
  if (meetingId) await loadMeeting(c.user, meetingId, { edit: true });
  await q(`UPDATE ballots SET status = $2, closed_by = $3, closed_at = now() WHERE id = $1 AND status = 'open'`, [ballot.id, outcome, c.user.id]);
  const decision = meetingId ? await register(c, ballot, meetingId, text) : null;
  return { status: outcome, decision };
});

/** Een eerder aangenomen voorstel alsnog in de besluitenlijst zetten. */
route.post("/api/ballots/:id/decision", async (c) => {
  const ballot = await loadBallot(uuid(c.params.id, "Stemronde"));
  await requireOverleg(c.user, ballot.overlegId, true);
  if (ballot.status !== "aangenomen") throw new HttpError(409, "Alleen een aangenomen voorstel kan als besluit worden vastgelegd.");
  if (ballot.decisionId) throw new HttpError(409, "Dit voorstel staat al in de besluitenlijst.");
  const b = await c.body();
  const decision = await register(c, ballot, uuid(b.meetingId, "Vergadering"), str(b.decisionText ?? ballot.title, "Besluit", { max: 4000 }));
  return { decision };
});

route.delete("/api/ballots/:id", async (c) => {
  const ballot = await loadBallot(uuid(c.params.id, "Stemronde"));
  await requireOverleg(c.user, ballot.overlegId, true);
  await q(`DELETE FROM ballots WHERE id = $1`, [ballot.id]);
  return { ok: true };
});
