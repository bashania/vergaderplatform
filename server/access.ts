import type { User } from "./auth";
import { q1 } from "./db";
import { bad, forbidden, HttpError, notFound } from "./http";
import type { Ctx } from "./router";

/**
 * Toegangsmodel
 * - Een organisatie is een eigen omgeving. Je hebt toegang als je er beheerder van bent
 *   of deelneemt aan een van haar overleggen.
 * - Organisatiebeheerder: ziet en beheert alle overleggen van die organisatie.
 * - Secretaris / deelnemer: rol per overleg.
 * - Platformbeheerder (users.is_admin): beheert accounts en organisaties, maar ziet
 *   de inhoud van een organisatie alleen als hij daar zelf beheerder of deelnemer is.
 */
export type Role = "secretaris" | "deelnemer";

/**
 * CTE met de overleggen van de gekozen organisatie waar de gebruiker bij mag, inclusief rol.
 * Verwacht $1 = user id, $2 = organisatie-id.
 */
export const ACC = `acc AS (
  SELECT o.id AS overleg_id, o.name AS overleg_name, o.archived,
         CASE WHEN oa.user_id IS NOT NULL THEN 'secretaris' ELSE m.role END AS role
    FROM overleggen o
    LEFT JOIN memberships m ON m.overleg_id = o.id AND m.user_id = $1::uuid
    LEFT JOIN organisation_admins oa ON oa.organisation_id = o.organisation_id AND oa.user_id = $1::uuid
   WHERE o.organisation_id = $2::uuid AND (oa.user_id IS NOT NULL OR m.user_id IS NOT NULL)
)`;

/** Voorwaarde: vergadering zichtbaar voor deze rol (concepten alleen voor de secretaris). */
export const VISIBLE = `(acc.role = 'secretaris' OR mt.status <> 'concept')`;

/** De organisatie waarin de gebruiker nu werkt (header x-organisation). */
export function requireOrgId(c: Ctx): string {
  if (!c.orgId) throw bad("Kies eerst een organisatie.");
  return c.orgId;
}

export const accParams = (c: Ctx): [string, string] => [c.user.id, requireOrgId(c)];

/**
 * Vereist beheerder van de organisatie. Met allowPlatformAdmin mag ook de platformbeheerder
 * (alleen voor het beheren van de organisatie zelf, niet voor de inhoud).
 */
export async function requireOrgAdmin(user: User, orgId: string, allowPlatformAdmin = false): Promise<void> {
  const row = await q1<{ isAdmin: boolean; isMember: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM organisation_admins WHERE organisation_id = org.id AND user_id = $2) AS is_admin,
            EXISTS (SELECT 1 FROM memberships m JOIN overleggen o ON o.id = m.overleg_id
                     WHERE o.organisation_id = org.id AND m.user_id = $2) AS is_member
       FROM organisations org WHERE org.id = $1`,
    [orgId, user.id],
  );
  if (!row) throw notFound("Organisatie niet gevonden.");
  if (row.isAdmin || (allowPlatformAdmin && user.isAdmin)) return;
  // Wie de organisatie niet kent, krijgt ook niet te horen dat ze bestaat.
  if (!row.isMember) throw notFound("Organisatie niet gevonden.");
  throw forbidden("Alleen een beheerder van deze organisatie kan dit doen.");
}

export async function overlegAccess(
  user: User,
  overlegId: string,
): Promise<{ role: Role | null; orgAdmin: boolean; organisationId: string } | null> {
  const row = await q1<{ role: Role | null; orgAdmin: boolean; organisationId: string }>(
    `SELECT o.organisation_id,
            (SELECT role FROM memberships WHERE overleg_id = o.id AND user_id = $2) AS role,
            EXISTS (SELECT 1 FROM organisation_admins WHERE organisation_id = o.organisation_id AND user_id = $2) AS org_admin
       FROM overleggen o WHERE o.id = $1`,
    [overlegId, user.id],
  );
  if (!row) return null;
  return { ...row, role: row.orgAdmin ? "secretaris" : row.role };
}

export async function overlegRole(user: User, overlegId: string): Promise<Role | null> {
  return (await overlegAccess(user, overlegId))?.role ?? null;
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
  organisationId: string;
  organisationName: string;
  title: string;
  startsAt: string;
  durationMin: number;
  location: string;
  onlineUrl: string;
  status: "concept" | "gepubliceerd" | "afgerond";
  description: string;
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
    `SELECT mt.id, mt.overleg_id, o.name AS overleg_name, o.organisation_id, org.name AS organisation_name,
            mt.title, mt.starts_at, mt.duration_min, mt.location, mt.online_url, mt.status, mt.description, mt.notes
       FROM meetings mt
       JOIN overleggen o ON o.id = mt.overleg_id
       JOIN organisations org ON org.id = o.organisation_id
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
