import { randomUUID } from "node:crypto";
import { requireOrgAdmin } from "../access";
import { activated } from "../auth";
import { q, q1 } from "../db";
import { bad, forbidden, HttpError, int, str, uuid } from "../http";
import { findOrInviteUser, reinvite } from "../people";
import { route } from "../router";
import { withMail } from "./mail";

async function nameTaken(name: string, exceptId: string | null): Promise<boolean> {
  return !!(await q1(`SELECT 1 AS x FROM organisations WHERE lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2::uuid)`, [name, exceptId]));
}

// ---------- platformbeheerder: organisaties aanmaken en overzien ----------

route.get(
  "/api/organisations",
  async () => {
    const organisations = await q(
      `SELECT org.id, org.name, org.archived, org.require_passkey,
              (SELECT count(*)::int FROM overleggen o WHERE o.organisation_id = org.id) AS overleg_count,
              COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email) ORDER BY lower(u.name))
                          FROM organisation_admins a JOIN users u ON u.id = a.user_id
                         WHERE a.organisation_id = org.id), '[]'::json) AS admins
         FROM organisations org ORDER BY org.archived, lower(org.name)`,
    );
    return { organisations };
  },
  { admin: true },
);

route.post(
  "/api/organisations",
  async (c) => {
    const name = str((await c.body()).name, "Naam", { max: 120 });
    if (await nameTaken(name, null)) throw new HttpError(409, "Er bestaat al een organisatie met deze naam.");
    const id = randomUUID();
    await q(`INSERT INTO organisations (id, name) VALUES ($1, $2)`, [id, name]);
    // De aanmaker wordt beheerder, zodat de organisatie direct ingericht kan worden.
    // Draag het daarna over door een andere beheerder toe te voegen en jezelf te verwijderen.
    await q(`INSERT INTO organisation_admins (organisation_id, user_id) VALUES ($1, $2)`, [id, c.user.id]);
    return { id };
  },
  { admin: true },
);

// ---------- beheer van één organisatie ----------

route.patch("/api/organisations/:id", async (c) => {
  const id = uuid(c.params.id, "Organisatie");
  await requireOrgAdmin(c.user, id, true);
  const b = await c.body();
  const sets: string[] = [];
  const vals: unknown[] = [id];
  if (b.name !== undefined) {
    const name = str(b.name, "Naam", { max: 120 });
    if (await nameTaken(name, id)) throw new HttpError(409, "Er bestaat al een organisatie met deze naam.");
    vals.push(name);
    sets.push(`name = $${vals.length}`);
  }
  if (b.archived !== undefined) {
    if (!c.user.isAdmin) throw forbidden("Alleen de platformbeheerder kan een organisatie archiveren.");
    vals.push(b.archived === true);
    sets.push(`archived = $${vals.length}`);
  }
  if (b.requirePasskey !== undefined) {
    // Alleen een beheerder van de organisatie zelf, en alleen vanuit een passkey-sessie:
    // zo sluit hij zichzelf niet buiten en kan een gestolen wachtwoord de eis niet uitzetten.
    await requireOrgAdmin(c.user, id);
    if (!c.user.strong) throw forbidden("Log in met een passkey om dit te wijzigen.");
    vals.push(b.requirePasskey === true);
    sets.push(`require_passkey = $${vals.length}`);
  }
  if (b.hourlyRate !== undefined) {
    // Uurtarief voor de schatting van vergaderkosten op de pagina Inzicht; leeg laten kan.
    await requireOrgAdmin(c.user, id);
    vals.push(b.hourlyRate === null || b.hourlyRate === "" ? null : int(b.hourlyRate, "Uurtarief", 1, 1000));
    sets.push(`hourly_rate = $${vals.length}`);
  }
  if (b.aiEnabled !== undefined) {
    // Of notulen en stukken naar een taalmodel mogen, beslist de organisatie zelf, niet de platformbeheerder.
    await requireOrgAdmin(c.user, id);
    vals.push(b.aiEnabled === true);
    sets.push(`ai_enabled = $${vals.length}`);
  }
  if (!sets.length) throw bad("Geen wijzigingen.");
  await q(`UPDATE organisations SET ${sets.join(", ")} WHERE id = $1`, vals);
  return { ok: true };
});

/** Iedereen met toegang tot deze organisatie: beheerders en deelnemers van haar overleggen. */
route.get("/api/organisations/:id/people", async (c) => {
  const id = uuid(c.params.id, "Organisatie");
  await requireOrgAdmin(c.user, id);
  const people = await q(
    `SELECT u.id, u.name, u.email, u.active, ${activated("u")} AS activated,
            EXISTS (SELECT 1 FROM organisation_admins a WHERE a.organisation_id = $1 AND a.user_id = u.id) AS is_admin,
            EXISTS (SELECT 1 FROM passkeys pk WHERE pk.user_id = u.id) AS has_passkey,
            -- 'open': de beheerder kan dit overleg zelf openen (niet besloten, of hij neemt er zelf aan deel).
            COALESCE((SELECT json_agg(json_build_object('id', o.id, 'name', o.name, 'role', m.role, 'besloten', o.besloten,
                                        'open', NOT o.besloten OR EXISTS (SELECT 1 FROM memberships x WHERE x.overleg_id = o.id AND x.user_id = $2))
                                      ORDER BY lower(o.name))
                        FROM memberships m JOIN overleggen o ON o.id = m.overleg_id
                       WHERE o.organisation_id = $1 AND m.user_id = u.id), '[]'::json) AS overleggen
       FROM users u
      WHERE EXISTS (SELECT 1 FROM organisation_admins a WHERE a.organisation_id = $1 AND a.user_id = u.id)
         OR EXISTS (SELECT 1 FROM memberships m JOIN overleggen o ON o.id = m.overleg_id
                     WHERE o.organisation_id = $1 AND m.user_id = u.id)
      ORDER BY lower(u.name)`,
    [id, c.user.id],
  );
  return { people };
});

/** Beheerder toevoegen op e-mailadres (ook door de platformbeheerder, om een organisatie over te dragen). */
route.post("/api/organisations/:id/admins", async (c) => {
  const id = uuid(c.params.id, "Organisatie");
  await requireOrgAdmin(c.user, id, true);
  const b = await c.body();
  const person = await findOrInviteUser(b.email, b.name, c.user.id);
  const added = await q(
    `INSERT INTO organisation_admins (organisation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING user_id`,
    [id, person.userId],
  );
  if (!added.length) throw new HttpError(409, `${person.name} is al beheerder van deze organisatie.`);
  return withMail(c, person.userId, person);
});

async function assertNotLastAdmin(orgId: string, userId: string) {
  const row = await q1<{ others: number; isAdmin: boolean }>(
    `SELECT (SELECT count(*)::int FROM organisation_admins WHERE organisation_id = $1 AND user_id <> $2) AS others,
            EXISTS (SELECT 1 FROM organisation_admins WHERE organisation_id = $1 AND user_id = $2) AS is_admin`,
    [orgId, userId],
  );
  if (row?.isAdmin && row.others === 0) {
    throw new HttpError(409, "Dit is de enige beheerder van de organisatie. Voeg eerst een andere beheerder toe.");
  }
}

route.delete("/api/organisations/:id/admins/:userId", async (c) => {
  const id = uuid(c.params.id, "Organisatie");
  const userId = uuid(c.params.userId, "Gebruiker");
  await requireOrgAdmin(c.user, id, true);
  await assertNotLastAdmin(id, userId);
  await q(`DELETE FROM organisation_admins WHERE organisation_id = $1 AND user_id = $2`, [id, userId]);
  return { ok: true };
});

/** Toegang tot de hele organisatie intrekken: uit alle overleggen en uit het beheer. */
route.delete("/api/organisations/:id/people/:userId", async (c) => {
  const id = uuid(c.params.id, "Organisatie");
  const userId = uuid(c.params.userId, "Gebruiker");
  await requireOrgAdmin(c.user, id);
  await assertNotLastAdmin(id, userId);
  await q(
    `DELETE FROM memberships m USING overleggen o
      WHERE o.id = m.overleg_id AND o.organisation_id = $1 AND m.user_id = $2`,
    [id, userId],
  );
  await q(`DELETE FROM organisation_admins WHERE organisation_id = $1 AND user_id = $2`, [id, userId]);
  return { ok: true };
});

route.post("/api/organisations/:id/people/:userId/invite", async (c) => {
  const id = uuid(c.params.id, "Organisatie");
  const userId = uuid(c.params.userId, "Gebruiker");
  await requireOrgAdmin(c.user, id);
  const inOrg = await q1(
    `SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM organisation_admins WHERE organisation_id = $1 AND user_id = $2)
        OR EXISTS (SELECT 1 FROM memberships m JOIN overleggen o ON o.id = m.overleg_id
                    WHERE o.organisation_id = $1 AND m.user_id = $2)`,
    [id, userId],
  );
  if (!inOrg) throw new HttpError(404, "Persoon niet gevonden.");
  return withMail(c, userId, await reinvite(userId, c.user.id));
});

// ---------- besloten overleggen ----------

/**
 * Besloten overleggen van de organisatie, voor de beheerder: dat ze bestaan, wie eraan deelneemt en wie
 * de secretaris is. Niet de inhoud; daar geeft het beheer geen toegang toe (server/access.ts).
 */
route.get("/api/organisations/:id/besloten", async (c) => {
  const id = uuid(c.params.id, "Organisatie");
  await requireOrgAdmin(c.user, id);
  const overleggen = await q(
    `SELECT o.id, o.name, o.archived,
            (SELECT p.name FROM overleggen p WHERE p.id = o.parent_id) AS parent_name,
            (SELECT count(*)::int FROM memberships m WHERE m.overleg_id = o.id) AS member_count,
            COALESCE((SELECT json_agg(u.name ORDER BY lower(u.name)) FROM memberships m JOIN users u ON u.id = m.user_id
                       WHERE m.overleg_id = o.id AND m.role = 'secretaris' AND u.active), '[]'::json) AS secretarissen,
            EXISTS (SELECT 1 FROM memberships m WHERE m.overleg_id = o.id AND m.user_id = $2) AS mine
       FROM overleggen o
      WHERE o.organisation_id = $1 AND o.besloten
      ORDER BY o.archived, lower(o.name)`,
    [id, c.user.id],
  );
  return { overleggen };
});

/**
 * Herstel: heeft een besloten overleg geen actieve secretaris meer (account geblokkeerd of uit de
 * organisatie gehaald), dan kan niemand het nog beheren. Alleen dan wijst de beheerder een nieuwe
 * secretaris aan. Het staat in het logboek van het platform.
 */
route.post("/api/organisations/:id/besloten/:overlegId/secretaris", async (c) => {
  const id = uuid(c.params.id, "Organisatie");
  const overlegId = uuid(c.params.overlegId, "Overleg");
  await requireOrgAdmin(c.user, id);
  const userId = uuid((await c.body()).userId, "Persoon");
  const row = await q1<{ secretarissen: number; inOrg: boolean }>(
    `SELECT (SELECT count(*)::int FROM memberships m JOIN users u ON u.id = m.user_id
              WHERE m.overleg_id = o.id AND m.role = 'secretaris' AND u.active) AS secretarissen,
            (EXISTS (SELECT 1 FROM organisation_admins a WHERE a.organisation_id = $1 AND a.user_id = $3)
             OR EXISTS (SELECT 1 FROM memberships m JOIN overleggen x ON x.id = m.overleg_id
                         WHERE x.organisation_id = $1 AND m.user_id = $3)) AS in_org
       FROM overleggen o WHERE o.id = $2 AND o.organisation_id = $1 AND o.besloten`,
    [id, overlegId, userId],
  );
  if (!row) throw new HttpError(404, "Overleg niet gevonden.");
  if (row.secretarissen > 0) throw new HttpError(409, "Dit besloten overleg heeft een secretaris. Die beheert de deelnemers.");
  if (!row.inOrg) throw new HttpError(404, "Persoon niet gevonden.");
  await q(
    `INSERT INTO memberships (overleg_id, user_id, role) VALUES ($1, $2, 'secretaris')
     ON CONFLICT (overleg_id, user_id) DO UPDATE SET role = 'secretaris'`,
    [overlegId, userId],
  );
  return { ok: true };
});
