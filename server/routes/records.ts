import { randomUUID } from "node:crypto";
import { ACC, accParams, loadMeeting, overlegRole, VISIBLE } from "../access";
import { q, q1 } from "../db";
import { bad, forbidden, notFound, oneOf, optDateOnly, optUuid, str, uuid } from "../http";
import { route } from "../router";

async function checkItem(meetingId: string, agendaItemId: string | null) {
  if (agendaItemId && !(await q1(`SELECT 1 AS x FROM agenda_items WHERE id = $1 AND meeting_id = $2`, [agendaItemId, meetingId]))) {
    throw bad("Het agendapunt hoort niet bij deze vergadering.");
  }
}

// ---------- besluiten ----------

route.post("/api/meetings/:id/decisions", async (c) => {
  const meetingId = uuid(c.params.id, "Vergadering");
  const { meeting } = await loadMeeting(c.user, meetingId, { edit: true });
  const b = await c.body();
  const text = str(b.text, "Besluit", { max: 5000 });
  const agendaItemId = optUuid(b.agendaItemId, "Agendapunt");
  await checkItem(meetingId, agendaItemId);
  // Nummer uitgeven en besluit opslaan in één statement: geen dubbele nummers bij gelijktijdig invoeren.
  const row = await q1<{ id: string; number: string }>(
    `WITH m AS (
       SELECT (starts_at AT TIME ZONE 'Europe/Amsterdam')::date AS d FROM meetings WHERE id = $2
     ), c AS (
       INSERT INTO decision_counters (overleg_id, year, last)
       SELECT $1, extract(year FROM m.d)::int, 1 FROM m
       ON CONFLICT (overleg_id, year) DO UPDATE SET last = decision_counters.last + 1
       RETURNING year, last
     )
     INSERT INTO decisions (id, overleg_id, meeting_id, agenda_item_id, number, text, decided_on, created_by)
     SELECT $3, $1, $2, $4, c.year::text || '-' || lpad(c.last::text, 3, '0'), $5, m.d, $6 FROM c, m
     RETURNING id, number`,
    [meeting.overlegId, meetingId, randomUUID(), agendaItemId, text, c.user.id],
  );
  return row;
});

async function loadDecision(id: string) {
  const d = await q1<{ id: string; meetingId: string }>(`SELECT id, meeting_id FROM decisions WHERE id = $1`, [id]);
  if (!d) throw notFound("Besluit niet gevonden.");
  return d;
}

route.patch("/api/decisions/:id", async (c) => {
  const id = uuid(c.params.id, "Besluit");
  const d = await loadDecision(id);
  const b = await c.body();
  // Intrekken (status) kan ook na afronding; de tekst wijzigen niet.
  const onlyStatus = Object.keys(b).every((k) => k === "status");
  await loadMeeting(c.user, d.meetingId, { edit: true, allowClosed: onlyStatus });
  const sets: string[] = ["updated_at = now()"];
  const vals: unknown[] = [id];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (b.text !== undefined) set("text", str(b.text, "Besluit", { max: 5000 }));
  if (b.status !== undefined) set("status", oneOf(b.status, "Status", ["genomen", "ingetrokken"] as const));
  if (b.agendaItemId !== undefined) {
    const itemId = optUuid(b.agendaItemId, "Agendapunt");
    await checkItem(d.meetingId, itemId);
    set("agenda_item_id", itemId);
  }
  if (sets.length === 1) throw bad("Geen wijzigingen.");
  await q(`UPDATE decisions SET ${sets.join(", ")} WHERE id = $1`, vals);
  return { ok: true };
});

route.delete("/api/decisions/:id", async (c) => {
  const id = uuid(c.params.id, "Besluit");
  const d = await loadDecision(id);
  await loadMeeting(c.user, d.meetingId, { edit: true });
  await q(`DELETE FROM decisions WHERE id = $1`, [id]);
  return { ok: true };
});

route.get("/api/decisions", async (c) => {
  const overlegId = optUuid(c.url.searchParams.get("overleg"), "Overleg");
  const decisions = await q(
    `WITH ${ACC}
     SELECT d.id, d.number, d.text, d.status, d.decided_on::text AS decided_on,
            d.overleg_id, acc.overleg_name, d.meeting_id, mt.title AS meeting_title
       FROM decisions d
       JOIN acc ON acc.overleg_id = d.overleg_id
       JOIN meetings mt ON mt.id = d.meeting_id
      WHERE ${VISIBLE}
        AND CASE WHEN $3::uuid IS NULL THEN NOT acc.archived ELSE d.overleg_id = $3::uuid END
      ORDER BY d.decided_on DESC, d.number DESC
      LIMIT 1000`,
    [...accParams(c), overlegId],
  );
  return { decisions };
});

// ---------- acties ----------

async function checkOwner(overlegId: string, ownerId: string | null) {
  if (ownerId && !(await q1(`SELECT 1 AS x FROM memberships WHERE overleg_id = $1 AND user_id = $2`, [overlegId, ownerId]))) {
    throw bad("De actiehouder moet lid zijn van dit overleg.");
  }
}

route.post("/api/meetings/:id/actions", async (c) => {
  const meetingId = uuid(c.params.id, "Vergadering");
  const { meeting } = await loadMeeting(c.user, meetingId, { edit: true });
  const b = await c.body();
  const text = str(b.text, "Actie", { max: 2000 });
  const ownerId = optUuid(b.ownerId, "Actiehouder");
  const dueDate = optDateOnly(b.dueDate, "Deadline");
  const agendaItemId = optUuid(b.agendaItemId, "Agendapunt");
  await Promise.all([checkItem(meetingId, agendaItemId), checkOwner(meeting.overlegId, ownerId)]);
  const id = randomUUID();
  await q(
    `INSERT INTO actions (id, overleg_id, meeting_id, agenda_item_id, text, owner_id, due_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8)`,
    [id, meeting.overlegId, meetingId, agendaItemId, text, ownerId, dueDate, c.user.id],
  );
  return { id };
});

async function loadAction(id: string) {
  const a = await q1<{ id: string; overlegId: string; meetingId: string; ownerId: string | null }>(
    `SELECT id, overleg_id, meeting_id, owner_id FROM actions WHERE id = $1`,
    [id],
  );
  if (!a) throw notFound("Actie niet gevonden.");
  return a;
}

// Acties leven door na de vergadering: bijwerken kan altijd, ook als de vergadering is afgerond.
route.patch("/api/actions/:id", async (c) => {
  const id = uuid(c.params.id, "Actie");
  const a = await loadAction(id);
  const role = await overlegRole(c.user, a.overlegId);
  if (!role) throw notFound("Actie niet gevonden.");
  const b = await c.body();
  const isSec = role === "secretaris";
  const onlyStatus = Object.keys(b).every((k) => k === "status");
  // De actiehouder mag zijn eigen actie afmelden; de rest is aan de secretaris.
  if (!isSec && !(a.ownerId === c.user.id && onlyStatus)) {
    throw forbidden("Je kunt alleen de status van je eigen acties wijzigen.");
  }
  const sets: string[] = ["updated_at = now()"];
  const vals: unknown[] = [id];
  const set = (col: string, v: unknown, cast = "") => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}${cast}`);
  };
  if (b.text !== undefined) set("text", str(b.text, "Actie", { max: 2000 }));
  if (b.ownerId !== undefined) {
    const ownerId = optUuid(b.ownerId, "Actiehouder");
    await checkOwner(a.overlegId, ownerId);
    set("owner_id", ownerId);
  }
  if (b.dueDate !== undefined) set("due_date", optDateOnly(b.dueDate, "Deadline"), "::date");
  if (b.status !== undefined) {
    const status = oneOf(b.status, "Status", ["open", "gereed", "vervallen"] as const);
    set("status", status);
    sets.push(status === "open" ? "done_at = NULL" : "done_at = now()");
  }
  if (sets.length === 1) throw bad("Geen wijzigingen.");
  await q(`UPDATE actions SET ${sets.join(", ")} WHERE id = $1`, vals);
  return { ok: true };
});

route.delete("/api/actions/:id", async (c) => {
  const id = uuid(c.params.id, "Actie");
  const a = await loadAction(id);
  if ((await overlegRole(c.user, a.overlegId)) !== "secretaris") throw forbidden();
  await q(`DELETE FROM actions WHERE id = $1`, [id]);
  return { ok: true };
});

const ACTION_COLUMNS = `a.id, a.text, a.status, a.due_date::text AS due_date, a.owner_id, u.name AS owner_name,
  a.overleg_id, acc.overleg_name, a.meeting_id, mt.title AS meeting_title, mt.starts_at AS meeting_starts_at, acc.role`;

route.get("/api/actions", async (c) => {
  const sp = c.url.searchParams;
  const overlegId = optUuid(sp.get("overleg"), "Overleg");
  const onlyOpen = sp.get("status") !== "alle";
  const mine = sp.get("mine") === "1";
  const actions = await q(
    `WITH ${ACC}
     SELECT ${ACTION_COLUMNS}
       FROM actions a
       JOIN acc ON acc.overleg_id = a.overleg_id
       JOIN meetings mt ON mt.id = a.meeting_id
       LEFT JOIN users u ON u.id = a.owner_id
      WHERE ${VISIBLE}
        AND CASE WHEN $3::uuid IS NULL THEN NOT acc.archived ELSE a.overleg_id = $3::uuid END
        AND (NOT $4::boolean OR a.status = 'open')
        AND (NOT $5::boolean OR a.owner_id = $1::uuid)
      ORDER BY (a.status <> 'open'), a.due_date NULLS LAST, a.created_at
      LIMIT 1000`,
    [...accParams(c), overlegId, onlyOpen, mine],
  );
  return { actions };
});

// ---------- dashboard ----------

route.get("/api/dashboard", async (c) => {
  const p = accParams(c);
  const [upcoming, myActions, recentDecisions, recentDocuments] = await Promise.all([
    q(
      `WITH ${ACC}
       SELECT mt.id, mt.title, mt.starts_at, mt.duration_min, mt.location, mt.status, mt.overleg_id, acc.overleg_name,
              (SELECT count(*)::int FROM agenda_items ai WHERE ai.meeting_id = mt.id) AS item_count,
              (SELECT count(*)::int FROM documents d WHERE d.meeting_id = mt.id AND d.status = 'ready') AS document_count,
              (SELECT status FROM attendance at WHERE at.meeting_id = mt.id AND at.user_id = $1::uuid) AS my_attendance
         FROM meetings mt JOIN acc ON acc.overleg_id = mt.overleg_id
        WHERE ${VISIBLE} AND NOT acc.archived AND mt.status <> 'afgerond'
          AND mt.starts_at >= now() - interval '3 hours'
        ORDER BY mt.starts_at LIMIT 10`,
      p,
    ),
    q(
      `WITH ${ACC}
       SELECT ${ACTION_COLUMNS}
         FROM actions a
         JOIN acc ON acc.overleg_id = a.overleg_id
         JOIN meetings mt ON mt.id = a.meeting_id
         LEFT JOIN users u ON u.id = a.owner_id
        WHERE ${VISIBLE} AND NOT acc.archived AND a.status = 'open' AND a.owner_id = $1::uuid
        ORDER BY a.due_date NULLS LAST, a.created_at LIMIT 50`,
      p,
    ),
    q(
      `WITH ${ACC}
       SELECT d.id, d.number, d.text, d.status, d.decided_on::text AS decided_on, d.overleg_id, acc.overleg_name, d.meeting_id
         FROM decisions d JOIN acc ON acc.overleg_id = d.overleg_id JOIN meetings mt ON mt.id = d.meeting_id
        WHERE ${VISIBLE} AND NOT acc.archived
        ORDER BY d.decided_on DESC, d.number DESC LIMIT 6`,
      p,
    ),
    q(
      `WITH ${ACC}
       SELECT d.id, d.name, d.mime, d.size::float8 AS size, d.uploaded_at, d.meeting_id, mt.title AS meeting_title,
              d.overleg_id, acc.overleg_name
         FROM documents d JOIN acc ON acc.overleg_id = d.overleg_id LEFT JOIN meetings mt ON mt.id = d.meeting_id
        WHERE d.status = 'ready' AND NOT acc.archived AND (mt.id IS NULL OR ${VISIBLE})
        ORDER BY d.uploaded_at DESC LIMIT 8`,
      p,
    ),
  ]);
  return { upcoming, myActions, recentDecisions, recentDocuments };
});

// ---------- zoeken ----------

route.get("/api/search", async (c) => {
  const term = (c.url.searchParams.get("q") ?? "").trim().slice(0, 100);
  if (term.length < 2) return { results: [] };
  const like = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
  const results = await q(
    `WITH ${ACC}
     SELECT * FROM (
       SELECT 'vergadering' AS type, mt.id AS id, mt.title AS title, '' AS snippet, mt.starts_at AS at,
              mt.id AS meeting_id, acc.overleg_id, acc.overleg_name, NULL::float8 AS size
         FROM meetings mt JOIN acc ON acc.overleg_id = mt.overleg_id
        WHERE ${VISIBLE} AND mt.title ILIKE $3
       UNION ALL
       SELECT 'agendapunt', ai.id, ai.title, left(ai.description, 200), mt.starts_at, mt.id, acc.overleg_id, acc.overleg_name, NULL::float8
         FROM agenda_items ai JOIN meetings mt ON mt.id = ai.meeting_id JOIN acc ON acc.overleg_id = mt.overleg_id
        WHERE ${VISIBLE} AND (ai.title ILIKE $3 OR ai.description ILIKE $3 OR ai.notes ILIKE $3)
       UNION ALL
       SELECT 'besluit', d.id, 'Besluit ' || d.number, left(d.text, 300), mt.starts_at, mt.id, acc.overleg_id, acc.overleg_name, NULL::float8
         FROM decisions d JOIN meetings mt ON mt.id = d.meeting_id JOIN acc ON acc.overleg_id = d.overleg_id
        WHERE ${VISIBLE} AND (d.text ILIKE $3 OR d.number ILIKE $3)
       UNION ALL
       SELECT 'actie', a.id, 'Actie', left(a.text, 300), mt.starts_at, mt.id, acc.overleg_id, acc.overleg_name, NULL::float8
         FROM actions a JOIN meetings mt ON mt.id = a.meeting_id JOIN acc ON acc.overleg_id = a.overleg_id
        WHERE ${VISIBLE} AND a.text ILIKE $3
       UNION ALL
       SELECT 'stuk', doc.id, doc.name, COALESCE(mt.title, 'Vast stuk'), COALESCE(mt.starts_at, doc.uploaded_at), mt.id,
              acc.overleg_id, acc.overleg_name, doc.size::float8
         FROM documents doc JOIN acc ON acc.overleg_id = doc.overleg_id LEFT JOIN meetings mt ON mt.id = doc.meeting_id
        WHERE doc.status = 'ready' AND (mt.id IS NULL OR ${VISIBLE}) AND doc.name ILIKE $3
     ) r
     ORDER BY r.at DESC
     LIMIT 100`,
    [...accParams(c), like],
  );
  return { results };
});
