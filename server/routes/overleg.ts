import { randomUUID } from "node:crypto";
import { ACC, accParams, overlegAccess, requireOrgAdmin, requireOrgId, requireOverleg } from "../access";
import { activated } from "../auth";
import { q, q1 } from "../db";
import { bad, forbidden, HttpError, notFound, oneOf, optStr, str, uuid } from "../http";
import { findOrInviteUser, reinvite } from "../people";
import { route } from "../router";
import { withMail } from "./mail";

const ROLES = ["secretaris", "deelnemer"] as const;

/** Overleggen van de gekozen organisatie waar de gebruiker bij mag. */
route.get("/api/overleggen", async (c) => {
  const overleggen = await q(
    `WITH ${ACC}
     SELECT o.id, o.name, o.description, o.archived, o.besloten, acc.role,
            -- De naam van het overleg waar een kring bij hoort, alleen als de gebruiker dat overleg ook ziet.
            (SELECT p.overleg_name FROM acc p WHERE p.overleg_id = o.parent_id) AS parent_name,
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
  // De aanmaker neemt meestal zelf deel; kan daarna weer als deelnemer verwijderd worden. In één opdracht,
  // zodat een besloten overleg nooit zonder secretaris bestaat.
  await q(
    `WITH nieuw AS (INSERT INTO overleggen (id, organisation_id, name, description, besloten) VALUES ($1, $2, $3, $4, $5) RETURNING id)
     INSERT INTO memberships (overleg_id, user_id, role) SELECT id, $6::uuid, 'secretaris' FROM nieuw`,
    [id, orgId, name, description, b.besloten === true, c.user.id],
  );
  return { id };
});

/**
 * Besloten kring bij een overleg: een eigen, besloten overleg voor een deel van de deelnemers, bijvoorbeeld
 * de toezichthouders zonder de bestuurder. De secretaris van het overleg maakt hem aan en wordt er zelf
 * secretaris van. De afscherming is die van elk besloten overleg (server/access.ts): er komt geen nieuwe
 * uitzondering bij op de plekken waar inhoud naar buiten gaat.
 */
route.post("/api/overleggen/:id/kring", async (c) => {
  const id = uuid(c.params.id, "Overleg");
  const access = await overlegAccess(c.user, id);
  if (!access?.role) throw notFound("Overleg niet gevonden.");
  if (access.role !== "secretaris") throw forbidden("Alleen de secretaris of beheerder kan een besloten kring maken.");
  const parent = await q1<{ parentId: string | null; archived: boolean }>(`SELECT parent_id, archived FROM overleggen WHERE id = $1`, [id]);
  if (parent?.parentId) throw bad("Een besloten kring kan zelf geen kring hebben.");
  if (parent?.archived) throw bad("Dit overleg is gearchiveerd.");
  const b = await c.body();
  const name = str(b.name, "Naam", { max: 120 });
  const description = optStr(b.description, "Omschrijving", 1000);
  if (!Array.isArray(b.memberIds) || b.memberIds.length > 200) throw bad("Kies de deelnemers van de kring.");
  const others = [...new Set(b.memberIds.map((m) => uuid(m, "Deelnemer")))].filter((m) => m !== c.user.id);
  // Alleen wie aan het overleg deelneemt, kan in de kring.
  const valid = await q(`SELECT user_id FROM memberships WHERE overleg_id = $1 AND user_id = ANY($2::uuid[])`, [id, others]);
  if (valid.length !== others.length) throw bad("Een kring bestaat uit deelnemers van dit overleg.");
  const kringId = randomUUID();
  await q(
    `WITH nieuw AS (INSERT INTO overleggen (id, organisation_id, name, description, besloten, parent_id)
                    VALUES ($1, $2, $3, $4, true, $5) RETURNING id)
     INSERT INTO memberships (overleg_id, user_id, role)
     SELECT nieuw.id, u, CASE WHEN u = $6::uuid THEN 'secretaris' ELSE 'deelnemer' END FROM nieuw, unnest($7::uuid[]) AS u`,
    [kringId, access.organisationId, name, description, id, c.user.id, [c.user.id, ...others]],
  );
  return { id: kringId };
});

route.get("/api/overleggen/:id", async (c) => {
  const id = uuid(c.params.id, "Overleg");
  const access = await overlegAccess(c.user, id);
  if (!access?.role) throw notFound("Overleg niet gevonden.");
  const isSec = access.role === "secretaris";
  // Een ander overleg (waar deze kring bij hoort, of een kring van dit overleg) is alleen te zien voor wie er zelf bij mag.
  const reachable = `(EXISTS (SELECT 1 FROM memberships m WHERE m.overleg_id = k.id AND m.user_id = $2) OR (NOT k.besloten AND $3::boolean))`;
  const [overleg, parent, kringen, members, meetings, documents] = await Promise.all([
    q1(
      `SELECT o.id, o.name, o.description, o.archived, o.besloten, (o.parent_id IS NOT NULL) AS is_kring, o.organisation_id, org.name AS organisation_name
         FROM overleggen o JOIN organisations org ON org.id = o.organisation_id WHERE o.id = $1`,
      [id],
    ),
    q1(
      `SELECT k.id, k.name FROM overleggen o JOIN overleggen k ON k.id = o.parent_id WHERE o.id = $1 AND ${reachable}`,
      [id, c.user.id, access.orgAdmin],
    ),
    q(
      `SELECT k.id, k.name, (SELECT count(*)::int FROM memberships m WHERE m.overleg_id = k.id) AS member_count
         FROM overleggen k WHERE k.parent_id = $1 AND NOT k.archived AND ${reachable} ORDER BY lower(k.name)`,
      [id, c.user.id, access.orgAdmin],
    ),
    q(
      `SELECT u.id, u.name, u.email, m.role, u.active, ${activated("u")} AS activated
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
  return { overleg, role: access.role, memberRole: access.memberRole, orgAdmin: access.orgAdmin, parent, kringen, members, meetings, documents };
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
  if (b.besloten !== undefined && (b.besloten === true) !== access.besloten) {
    // Alleen wie zelf als secretaris deelneemt: een beheerder van de organisatie zou zichzelf anders buitensluiten,
    // of een besloten overleg voor het beheer openzetten zonder dat de deelnemers dat weten.
    if (access.memberRole !== "secretaris") {
      throw forbidden("Alleen een secretaris die zelf aan dit overleg deelneemt, kan het besloten maken of weer openstellen.");
    }
    set("besloten", b.besloten === true);
  }
  if (!sets.length) throw bad("Geen wijzigingen.");
  await q(`UPDATE overleggen SET ${sets.join(", ")} WHERE id = $1`, vals);
  return { ok: true };
});

// ---------- deelnemers ----------

/**
 * In een besloten overleg kan het beheer van de organisatie niet bijspringen: er moet een actieve
 * secretaris overblijven. (Valt de laatste toch weg, bijvoorbeeld door een geblokkeerd account, dan
 * wijst een beheerder een nieuwe aan; zie routes/organisations.ts.)
 */
async function assertSecretarisRemains(overlegId: string, userId: string) {
  const row = await q1<{ besloten: boolean; isSec: boolean; others: number }>(
    `SELECT o.besloten,
            EXISTS (SELECT 1 FROM memberships m WHERE m.overleg_id = o.id AND m.user_id = $2 AND m.role = 'secretaris') AS is_sec,
            (SELECT count(*)::int FROM memberships m JOIN users u ON u.id = m.user_id
              WHERE m.overleg_id = o.id AND m.role = 'secretaris' AND m.user_id <> $2 AND u.active) AS others
       FROM overleggen o WHERE o.id = $1`,
    [overlegId, userId],
  );
  if (row?.besloten && row.isSec && row.others === 0) {
    throw new HttpError(409, "Wijs eerst een andere secretaris aan. In een besloten overleg kan het beheer van de organisatie dat niet overnemen.");
  }
}

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
  return withMail(c, person.userId, person);
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
  return withMail(c, userId, await reinvite(userId, c.user.id));
});

route.put("/api/overleggen/:id/members/:userId", async (c) => {
  const id = uuid(c.params.id, "Overleg");
  const userId = uuid(c.params.userId, "Gebruiker");
  await requireOverleg(c.user, id, true);
  const role = oneOf((await c.body()).role, "Rol", ROLES);
  // Alleen de rol van een bestaande deelnemer wijzigen; toevoegen gaat op e-mailadres.
  await requireMember(id, userId);
  if (role !== "secretaris") await assertSecretarisRemains(id, userId);
  await q(`UPDATE memberships SET role = $3 WHERE overleg_id = $1 AND user_id = $2`, [id, userId, role]);
  return { ok: true };
});

route.delete("/api/overleggen/:id/members/:userId", async (c) => {
  const id = uuid(c.params.id, "Overleg");
  const userId = uuid(c.params.userId, "Gebruiker");
  await requireOverleg(c.user, id, true);
  await assertSecretarisRemains(id, userId);
  await q(`DELETE FROM memberships WHERE overleg_id = $1 AND user_id = $2`, [id, userId]);
  return { ok: true };
});
