import { randomUUID } from "node:crypto";
import { ACC, accParams, requireOverleg } from "../access";
import { q, q1 } from "../db";
import { bad, forbidden, notFound, oneOf, optStr, str, uuid } from "../http";
import { route } from "../router";

const ROLES = ["secretaris", "deelnemer"] as const;

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
    accParams(c.user),
  );
  return { overleggen };
});

route.post(
  "/api/overleggen",
  async (c) => {
    const b = await c.body();
    const name = str(b.name, "Naam", { max: 120 });
    const description = optStr(b.description, "Omschrijving", 1000);
    const id = randomUUID();
    await q(`INSERT INTO overleggen (id, name, description) VALUES ($1, $2, $3)`, [id, name, description]);
    // De aanmaker neemt meestal zelf deel; kan daarna weer als lid verwijderd worden.
    await q(`INSERT INTO memberships (overleg_id, user_id, role) VALUES ($1, $2, 'secretaris')`, [id, c.user.id]);
    return { id };
  },
  { admin: true },
);

route.get("/api/overleggen/:id", async (c) => {
  const id = uuid(c.params.id, "Overleg");
  const role = await requireOverleg(c.user, id);
  const isSec = role === "secretaris";
  const [overleg, members, meetings, documents] = await Promise.all([
    q1(`SELECT id, name, description, archived FROM overleggen WHERE id = $1`, [id]),
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
  return { overleg, role, members, meetings, documents };
});

route.patch("/api/overleggen/:id", async (c) => {
  const id = uuid(c.params.id, "Overleg");
  await requireOverleg(c.user, id, true);
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
    if (!c.user.isAdmin) throw forbidden("Alleen een beheerder kan een overleg archiveren.");
    set("archived", b.archived === true);
  }
  if (!sets.length) throw bad("Geen wijzigingen.");
  await q(`UPDATE overleggen SET ${sets.join(", ")} WHERE id = $1`, vals);
  return { ok: true };
});

route.put("/api/overleggen/:id/members/:userId", async (c) => {
  const id = uuid(c.params.id, "Overleg");
  const userId = uuid(c.params.userId, "Gebruiker");
  await requireOverleg(c.user, id, true);
  const role = oneOf((await c.body()).role, "Rol", ROLES);
  if (!(await q1(`SELECT 1 AS x FROM users WHERE id = $1 AND active`, [userId]))) throw notFound("Gebruiker niet gevonden.");
  await q(
    `INSERT INTO memberships (overleg_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (overleg_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [id, userId, role],
  );
  return { ok: true };
});

route.delete("/api/overleggen/:id/members/:userId", async (c) => {
  const id = uuid(c.params.id, "Overleg");
  const userId = uuid(c.params.userId, "Gebruiker");
  await requireOverleg(c.user, id, true);
  await q(`DELETE FROM memberships WHERE overleg_id = $1 AND user_id = $2`, [id, userId]);
  return { ok: true };
});
