import type { User } from "./auth";
import { q1 } from "./db";
import { bad, forbidden, HttpError, notFound, passkeyRequired } from "./http";
import type { Ctx } from "./router";

/**
 * Toegangsmodel
 * - Een organisatie is een eigen omgeving. Je hebt toegang als je er beheerder van bent
 *   of deelneemt aan een van haar overleggen.
 * - Organisatiebeheerder: ziet en beheert alle overleggen van die organisatie, behalve besloten
 *   overleggen: die zijn er alleen voor de deelnemers. De beheerder ziet daarvan dat ze bestaan en
 *   wie eraan deelneemt (routes/organisations.ts), niet de inhoud.
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
  SELECT o.id AS overleg_id, o.name AS overleg_name, o.archived, o.besloten,
         CASE WHEN oa.user_id IS NOT NULL AND NOT o.besloten THEN 'secretaris' ELSE m.role END AS role
    FROM overleggen o
    LEFT JOIN memberships m ON m.overleg_id = o.id AND m.user_id = $1::uuid
    LEFT JOIN organisation_admins oa ON oa.organisation_id = o.organisation_id AND oa.user_id = $1::uuid
   WHERE o.organisation_id = $2::uuid AND ((oa.user_id IS NOT NULL AND NOT o.besloten) OR m.user_id IS NOT NULL)
)`;

/**
 * Voorwaarde voor overzichten die niet via `acc` lopen (cijfers voor de beheerder, het agenda-abonnement):
 * een besloten overleg telt alleen mee voor wie er zelf aan deelneemt. Verwacht de alias `o` voor overleggen.
 */
export const openOrMember = (userParam: string) =>
  `(NOT o.besloten OR EXISTS (SELECT 1 FROM memberships bm WHERE bm.overleg_id = o.id AND bm.user_id = ${userParam}::uuid))`;

/** Voorwaarde: vergadering zichtbaar voor deze rol (concepten alleen voor de secretaris). */
export const VISIBLE = `(acc.role = 'secretaris' OR mt.status <> 'concept')`;

/** De organisatie waarin de gebruiker nu werkt (header x-organisation). */
export function requireOrgId(c: Ctx): string {
  if (!c.orgId) throw bad("Kies eerst een organisatie.");
  if (c.orgLocked) throw passkeyRequired(c.orgId);
  return c.orgId;
}

export const accParams = (c: Ctx): [string, string] => [c.user.id, requireOrgId(c)];

/**
 * Vereist beheerder van de organisatie. Met allowPlatformAdmin mag ook de platformbeheerder
 * (alleen voor het beheren van de organisatie zelf, niet voor de inhoud).
 */
export async function requireOrgAdmin(user: User, orgId: string, allowPlatformAdmin = false): Promise<void> {
  const row = await q1<{ isAdmin: boolean; isMember: boolean; requirePasskey: boolean }>(
    `SELECT org.require_passkey,
            EXISTS (SELECT 1 FROM organisation_admins WHERE organisation_id = org.id AND user_id = $2) AS is_admin,
            EXISTS (SELECT 1 FROM memberships m JOIN overleggen o ON o.id = m.overleg_id
                     WHERE o.organisation_id = org.id AND m.user_id = $2) AS is_member
       FROM organisations org WHERE org.id = $1`,
    [orgId, user.id],
  );
  if (!row) throw notFound("Organisatie niet gevonden.");
  if (row.isAdmin) {
    if (row.requirePasskey && !user.strong) throw passkeyRequired(orgId);
    return;
  }
  if (allowPlatformAdmin && user.isAdmin) return;
  // Wie de organisatie niet kent, krijgt ook niet te horen dat ze bestaat.
  if (!row.isMember) throw notFound("Organisatie niet gevonden.");
  throw forbidden("Alleen een beheerder van deze organisatie kan dit doen.");
}

export async function overlegAccess(
  user: User,
  overlegId: string,
): Promise<{ role: Role | null; memberRole: Role | null; orgAdmin: boolean; besloten: boolean; organisationId: string } | null> {
  const row = await q1<{ role: Role | null; orgAdmin: boolean; besloten: boolean; organisationId: string; requirePasskey: boolean }>(
    `SELECT o.organisation_id, o.besloten,
            (SELECT require_passkey FROM organisations WHERE id = o.organisation_id) AS require_passkey,
            (SELECT role FROM memberships WHERE overleg_id = o.id AND user_id = $2) AS role,
            EXISTS (SELECT 1 FROM organisation_admins WHERE organisation_id = o.organisation_id AND user_id = $2) AS org_admin
       FROM overleggen o WHERE o.id = $1`,
    [overlegId, user.id],
  );
  if (!row) return null;
  // Een besloten overleg is er alleen voor de deelnemers: beheerder van de organisatie zijn geeft daar geen toegang toe.
  const role: Role | null = row.orgAdmin && !row.besloten ? "secretaris" : row.role;
  // Alleen wie er echt bij hoort krijgt te horen dat een passkey nodig is; voor anderen bestaat het overleg niet.
  if (role && row.requirePasskey && !user.strong) throw passkeyRequired(row.organisationId);
  return { role, memberRole: row.role, orgAdmin: row.orgAdmin, besloten: row.besloten, organisationId: row.organisationId };
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
  /** Besloten overleg: alleen de deelnemers zien deze vergadering. */
  besloten: boolean;
  title: string;
  startsAt: string;
  durationMin: number;
  location: string;
  onlineUrl: string;
  status: "concept" | "gepubliceerd" | "afgerond";
  description: string;
  notes: string;
  /** Gevuld zolang de vergadering bezig is (vergadermodus). */
  liveStartedAt: string | null;
  liveItemId: string | null;
  liveItemStartedAt: string | null;
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
    `SELECT mt.id, mt.overleg_id, o.name AS overleg_name, o.organisation_id, org.name AS organisation_name, o.besloten,
            mt.title, mt.starts_at, mt.duration_min, mt.location, mt.online_url, mt.status, mt.description, mt.notes,
            mt.live_started_at, mt.live_item_id, mt.live_item_started_at
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
