import { q, q1 } from "../db";
import { HttpError, notFound, oneOf } from "../http";
import { route } from "../router";
import { hasSecretKey, sign, verify } from "../secret";

/**
 * Aan- of afmelden voor een vergadering vanuit de e-mail, zonder in te loggen.
 * De link bevat een handtekening over vergadering en persoon: wie hem heeft, kan alleen
 * de aanwezigheid van die ene persoon bij die ene vergadering zetten.
 *
 * De link opent een pagina waarop je de keuze bevestigt. Zo legt een virusscanner die
 * links in e-mail alvast opent, niet ongemerkt iemands aanwezigheid vast.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function rsvpToken(meetingId: string, userId: string): string {
  return `${meetingId}.${userId}.${sign("rsvp", `${meetingId}:${userId}`)}`;
}

/** De keuzeknoppen voor in een e-mail, of niets als links niet ondertekend kunnen worden. */
export function rsvpChoice(origin: string, meetingId: string, userId: string) {
  if (!hasSecretKey()) return undefined;
  const base = `${origin}/aanwezigheid#${rsvpToken(meetingId, userId)}`;
  return { question: "Ben je erbij?", options: [{ label: "Ik ben erbij", url: `${base}~ja` }, { label: "Ik ben verhinderd", url: `${base}~nee` }] };
}

async function load(token: string) {
  const [meetingId, userId, signature] = token.split(".");
  if (!meetingId || !userId || !signature || !UUID.test(meetingId) || !UUID.test(userId) || !verify("rsvp", `${meetingId}:${userId}`, signature)) {
    throw notFound("Deze link is niet geldig. Open de vergadering in het platform om je aan of af te melden.");
  }
  const row = await q1<{ title: string; startsAt: string; location: string; status: string; name: string; attendance: string | null }>(
    `SELECT mt.title, mt.starts_at, mt.location, mt.status, u.name, a.status AS attendance
       FROM meetings mt
       JOIN memberships mb ON mb.overleg_id = mt.overleg_id AND mb.user_id = $2
       JOIN users u ON u.id = mb.user_id AND u.active
       LEFT JOIN attendance a ON a.meeting_id = mt.id AND a.user_id = u.id
      WHERE mt.id = $1`,
    [meetingId, userId],
  );
  // Vergadering verwijderd, teruggezet naar concept, of de persoon neemt niet meer deel.
  if (!row || row.status === "concept") throw notFound("Deze vergadering is niet (meer) beschikbaar.");
  return { meetingId, userId, ...row };
}

route.get(
  "/api/rsvp/:token",
  async (c) => {
    const r = await load(c.params.token);
    return { meetingId: r.meetingId, title: r.title, startsAt: r.startsAt, location: r.location, name: r.name, attendance: r.attendance, closed: r.status === "afgerond" };
  },
  { public: true },
);

route.post(
  "/api/rsvp/:token",
  async (c) => {
    const r = await load(c.params.token);
    if (r.status === "afgerond") throw new HttpError(409, "Deze vergadering is al afgerond.");
    const status = oneOf((await c.body()).status, "Keuze", ["aanwezig", "afwezig"] as const);
    await q(
      `INSERT INTO attendance (meeting_id, user_id, status) VALUES ($1, $2, $3)
       ON CONFLICT (meeting_id, user_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
      [r.meetingId, r.userId, status],
    );
    return { attendance: status };
  },
  { public: true, audit: false },
);
