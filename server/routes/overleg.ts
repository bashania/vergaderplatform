import { randomUUID } from "node:crypto";
import { ACC, accParams, overlegAccess, requireOrgAdmin, requireOrgId, requireOverleg } from "../access";
import { q, q1 } from "../db";
import { bad, forbidden, HttpError, notFound, oneOf, optStr, str, uuid } from "../http";
import { findOrInviteUser, reinvite } from "../people";
import { route } from "../router";

const ROLES = ["secretaris", "deelnemer"] as const;

/** Overleggen van de gekozen organisatie waar de gebruiker bij mag. */
route.get("/api/overleggen", async (c) => {
  const overleggen = await q(
    `WITH ${ACC}
     SELECT o.id, o.name, o.description, o.archived, acc.role,
            (SELECT count(*)::int FROM memberships m WHERE m.overleg_id = o.id) AS member_count,
            (SELECT count(*)::int FROM actions a WHERE a.overleg_id = o.id AND a.status = 'open') AS open_actions,
            (SELECT json_build_object('id', mt.id, 'title', mt.title, 'startsAt', mt.starts_at, 'status', mt.status)
               FROM meetings mt
              WHERE mt.overleg_id = o.id AND mt.starts_at >= now() - interval '3 hours'
                AND (acc.role = 'secretaris' OR mt.status <> 'concept')
              ORDER BY mt.starts_at LIMIT 1) AS next_meeting
       FROM acc JOIN overleggen o ON o.id = acc.overleg_id
      ORDER BY o.archived, lower(o.name)`,
    accParams(c),
  );
  return { overleggen };
});

/** Nieuw overleg in de gekozen organisatie: alleen de beheerder van die organisatie. */
route.post("/api/overleggen", async (c) => {
  const orgId = requireOrgId(c);
  await requireOrgAdmin(c.user, orgId);
  const b = await c.body();
  const name = str(b.name, "Naam", { max: 120 });
  const description = optStr(b.description, "Omschrijving", 1000);
  const id = randomUUID();
  await q(`INSERT INTO overleggen (id, organisation_id, name, description) VALUES ($1, $2, $3, $4)`, [id, orgId, name, description]);
  // De aanmaker neemt meestal zelf deel; kan daarna weer als deelnemer verwijderd worden.
  await q(`INSERT INTO memberships (overleg_id, user_id, role) VALUES ($1, $2, 'secretaris')`, [id, c.user.id]);
  return { id };
});

route.get("/api/overleggen/:id", async (c) => {
  const id = uuid(c.params.id, "Overleg");
  const access = await overlegAccess(c.user, id);
  if (!access?.role) throw notFound("Overleg niet gevonden.");
  const isSec = access.role === "secretaris";
  const [overleg, members, meetings, documents] = await Promise.all([
    q1(
      `SELECT o.id, o.name, o.description, o.archived, o.organisation_id, org.name AS organisation_name
         FROM overleggen o JOIN organisations org ON org.id = o.organisation_id WHERE o.id = $1`,
      [id],
    ),
    q(
      `SELECT u.id, u.name, u.email, m.role, u.active, (u.password_hash IS NOT NULL) AS has_password
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.overleg_id = $1 ORDER BY lower(u.name)`,
      [id],
    ),
    q(
      `SELECT mt.id, mt.title, mt.starts_at, mt.duration_min, mt.location, mt.status,
              (SELECT count(*)::int FROM agenda_items ai WHERE ai.meeting_id = mt.id) AS item_count,
              (SELECT count(*)::int FROM documents d WHERE d.meeting_id = mt.id AND d.status = 'ready') AS document_count,
              (SELECT count(*)::int FROM decisions d WHERE d.meeting_id = mt.id) AS decision_count
         FROM meetings mt
        WHERE mt.overleg_id = $1 AND ($2::boolean OR mt.status <> 'concept')
        ORDER BY mt.starts_at DESC`,
      [id, isSec],
    ),
    q(
      `SELECT d.id, d.name, d.mime, d.size::float8 AS size, d.uploaded_at, d.uploaded_by, u.name AS uploaded_by_name
         FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
        WHERE d.overleg_id = $1 AND d.meeting_id IS NULL AND d.status = 'ready'
        ORDER BY lower(d.name)`,
      [id],
    ),
  ]);
  return { overleg, role: access.role, orgAdmin: access.orgAdmin, members, meetings, documents };
});

route.patch("/api/overleggen/:id", async (c) => {
  const id = uuid(c.params.id, "Overleg");
  const access = await overlegAccess(c.user, id);
  if (!access?.role) throw notFound("Overleg niet gevonden.");
  if (access.role !== "secretaris") throw forbidden("Alleen de secretaris of beheerder kan dit wijzigen.");
  const b = await c.body();
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (b.name !== undefined) set("name", str(b.name, "Naam", { max: 120 }));
  if (b.description !== undefined) set("description", optStr(b.description, "Omschrijving", 1000));
  if (b.archived !== undefined) {
    if (!access.orgAdmin) throw forbidden("Alleen een beheerder van de organisatie kan een overleg archiveren.");
    set("archived", b.archived === true);
  }
  if (!sets.length) throw bad("Geen wijzigingen.");
  await q(`UPDATE overleggen SET ${sets.join(", ")} WHERE id = $1`, vals);
  return { ok: true };
});

// ---------- deelnemers ----------

/**
 * Deelnemer toevoegen op e-mailadres. Bestaat het account al, dan wordt het gekoppeld;
 * anders maakt de secretaris hier een account met uitnodigingslink aan.
 */
route.post("/api/overleggen/:id/members", async (c) => {
  const id = uuid(c.params.id, "Overleg");
  await requireOverleg(c.user, id, true);
  const b = await c.body();
  const role = oneOf(b.role ?? "deelnemer", "Rol", ROLES);
  const person = await findOrInviteUser(b.email, b.name, c.user.id);
  const added = await q(
    `INSERT INTO memberships (overleg_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING user_id`,
    [id, person.userId, role],
  );
  if (!added.length) throw new HttpError(409, `${person.name} neemt al deel aan dit overleg.`);
  return person;
});

async function requireMember(overlegId: string, userId: string) {
  if (!(await q1(`SELECT 1 AS x FROM memberships WHERE overleg_id = $1 AND user_id = $2`, [overlegId, userId]))) {
    throw notFound("Deelnemer niet gevonden.");
  }
}

route.post("/api/overleggen/:id/members/:userId/invite", async (c) => {
  const id = uuid(c.params.id, "Overleg");
  const userId = uuid(c.params.userId, "Gebruiker");
  await requireOverleg(c.user, id, true);
  await requireMember(id, userId);
  return reinvite(userId, c.user.id);
});

route.put("/api/overleggen/:id/members/:userId", async (c) => {
  const id = uuid(c.params.id, "Overleg");
  const userId = uuid(c.params.userId, "Gebruiker");
  await requireOverleg(c.user, id, true);
  const role = oneOf((await c.body()).role, "Rol", ROLES);
  // Alleen de rol van een bestaande deelnemer wijzigen; toevoegen gaat op e-mailadres.
  await requireMember(id, userId);
  await q(`UPDATE memberships SET role = $3 WHERE overleg_id = $1 AND user_id = $2`, [id, userId, role]);
  return { ok: true };
});

route.delete("/api/overleggen/:id/members/:userId", async (c) => {
  const id = uuid(c.params.id, "Overleg");
  const userId = uuid(c.params.userId, "Gebruiker");
  await requireOverleg(c.user, id, true);
  await q(`DELETE FROM memberships WHERE overleg_id = $1 AND user_id = $2`, [id, userId]);
  return { ok: true };
});
