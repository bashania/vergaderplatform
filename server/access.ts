import type { User } from "./auth";
import { q1 } from "./db";
import { forbidden, HttpError, notFound } from "./http";

export type Role = "secretaris" | "deelnemer";

/**
 * CTE met de overleggen waar de gebruiker bij mag, inclusief rol.
 * Verwacht $1 = user id, $2 = is beheerder. Beheerders mogen overal bij als secretaris.
 */
export const ACC = `acc AS (
  SELECT o.id AS overleg_id, o.name AS overleg_name, o.archived,
         CASE WHEN $2::boolean THEN 'secretaris' ELSE m.role END AS role
    FROM overleggen o
    LEFT JOIN memberships m ON m.overleg_id = o.id AND m.user_id = $1::uuid
   WHERE $2::boolean OR m.user_id IS NOT NULL
)`;

/** Voorwaarde: vergadering zichtbaar voor deze rol (concepten alleen voor de secretaris). */
export const VISIBLE = `(acc.role = 'secretaris' OR mt.status <> 'concept')`;

export const accParams = (user: User): [string, boolean] => [user.id, user.isAdmin];

export async function overlegRole(user: User, overlegId: string): Promise<Role | null> {
  const row = await q1<{ role: Role | null; exists: boolean }>(
    `SELECT true AS exists,
            (SELECT role FROM memberships WHERE overleg_id = o.id AND user_id = $2) AS role
       FROM overleggen o WHERE o.id = $1`,
    [overlegId, user.id],
  );
  if (!row) return null;
  if (user.isAdmin) return "secretaris";
  return row.role;
}

export async function requireOverleg(user: User, overlegId: string, edit = false): Promise<Role> {
  const role = await overlegRole(user, overlegId);
  if (!role) throw notFound("Overleg niet gevonden.");
  if (edit && role !== "secretaris") throw forbidden("Alleen de secretaris of beheerder kan dit wijzigen.");
  return role;
}

export type MeetingRow = {
  id: string;
  overlegId: string;
  overlegName: string;
  title: string;
  startsAt: string;
  durationMin: number;
  location: string;
  onlineUrl: string;
  status: "concept" | "gepubliceerd" | "afgerond";
  notes: string;
};

type MeetingAccess = { edit?: boolean; allowClosed?: boolean };

/**
 * Laadt een vergadering als de gebruiker die mag zien.
 * edit: vereist secretarisrol. Een afgeronde vergadering is vergrendeld, tenzij allowClosed.
 */
export async function loadMeeting(
  user: User,
  meetingId: string,
  { edit = false, allowClosed = false }: MeetingAccess = {},
): Promise<{ meeting: MeetingRow; role: Role }> {
  const meeting = await q1<MeetingRow>(
    `SELECT mt.id, mt.overleg_id, o.name AS overleg_name, mt.title, mt.starts_at, mt.duration_min,
            mt.location, mt.online_url, mt.status, mt.notes
       FROM meetings mt JOIN overleggen o ON o.id = mt.overleg_id
      WHERE mt.id = $1`,
    [meetingId],
  );
  if (!meeting) throw notFound("Vergadering niet gevonden.");
  const role = await overlegRole(user, meeting.overlegId);
  if (!role || (role !== "secretaris" && meeting.status === "concept")) throw notFound("Vergadering niet gevonden.");
  if (edit) {
    if (role !== "secretaris") throw forbidden("Alleen de secretaris of beheerder kan dit wijzigen.");
    if (meeting.status === "afgerond" && !allowClosed) {
      throw new HttpError(409, "Deze vergadering is afgerond. Heropen de vergadering om te wijzigen.");
    }
  }
  return { meeting, role };
}
