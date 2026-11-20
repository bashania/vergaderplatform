import { randomUUID } from "node:crypto";
import { activated, createUserToken } from "./auth";
import { q, q1 } from "./db";
import { bad, email, HttpError, str } from "./http";

export type AddedPerson = {
  userId: string;
  name: string;
  email: string;
  /** Er is zojuist een nieuw account aangemaakt. */
  created: boolean;
  /** Het account is nog niet geactiveerd (uitnodiging nog niet geaccepteerd). */
  pending: boolean;
  token?: string;
  purpose?: "invite" | "reset";
  validDays?: number;
};

/**
 * Zoekt een account op e-mailadres, of maakt er een met uitnodigingslink.
 * Bewust op e-mailadres en niet uit een namenlijst: wie iemand toevoegt, ziet zo
 * geen accounts van andere organisaties.
 */
export async function findOrInviteUser(rawEmail: unknown, rawName: unknown, createdBy: string): Promise<AddedPerson> {
  const mail = email(rawEmail);
  const existing = await q1<{ id: string; name: string; active: boolean; activated: boolean }>(
    `SELECT id, name, active, ${activated("users")} AS activated FROM users WHERE lower(email) = $1`,
    [mail],
  );
  if (existing) {
    if (!existing.active) throw bad("Dit account is geblokkeerd. Vraag de platformbeheerder om het te activeren.");
    return { userId: existing.id, name: existing.name, email: mail, created: false, pending: !existing.activated };
  }
  if (typeof rawName !== "string" || !rawName.trim()) {
    throw new HttpError(422, "Deze persoon heeft nog geen account. Vul ook de naam in, dan maak je direct een uitnodiging.");
  }
  const name = str(rawName, "Naam", { max: 120 });
  const userId = randomUUID();
  await q(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [userId, mail, name]);
  const link = await createUserToken(userId, "invite", createdBy);
  return { userId, name, email: mail, created: true, pending: true, ...link };
}

/**
 * Nieuwe uitnodigingslink voor iemand die zijn account nog niet heeft geactiveerd.
 * Voor een actief account (wachtwoord vergeten) blijft dit bij de platformbeheerder:
 * een resetlink geeft toegang tot het account van iemand anders.
 */
export async function reinvite(userId: string, createdBy: string): Promise<AddedPerson> {
  const u = await q1<{ name: string; email: string; active: boolean; activated: boolean }>(
    `SELECT name, email, active, ${activated("users")} AS activated FROM users WHERE id = $1`,
    [userId],
  );
  if (!u) throw new HttpError(404, "Persoon niet gevonden.");
  if (!u.active) throw bad("Dit account is geblokkeerd. Vraag de platformbeheerder om het te activeren.");
  if (u.activated) {
    throw new HttpError(403, "Deze persoon heeft al een actief account. Een nieuw wachtwoord regelt de platformbeheerder.");
  }
  const link = await createUserToken(userId, "invite", createdBy);
  return { userId, name: u.name, email: u.email, created: false, pending: true, ...link };
}
