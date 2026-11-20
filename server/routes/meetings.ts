import { randomUUID } from "node:crypto";
import { loadMeeting, requireOverleg } from "../access";
import { q, q1 } from "../db";
import { deleteDocumentBlobs } from "../files";
import { bad, dateTime, forbidden, HttpError, httpUrl, int, notFound, oneOf, optInt, optStr, optUuid, str, uuid } from "../http";

type NewItem = { title: string; kind: string; description: string; children: NewItem[] };

/** Agendapunten uit een geplakte of aangeleverde agenda: hoofdpunten met maximaal één niveau subpunten. */
function parseItems(raw: unknown, depth = 0): NewItem[] {
  if (!Array.isArray(raw)) throw bad("De agendapunten zijn ongeldig.");
  if (raw.length > 60) throw bad("Te veel agendapunten in één keer (maximaal 60 per niveau).");
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      title: str(o.title, "Onderwerp", { max: 200 }),
      kind: optStr(o.kind, "Label", 80),
      description: optStr(o.description, "Toelichting", 10_000),
      children: depth === 0 && o.children !== undefined ? parseItems(o.children, 1) : [],
    };
  });
}

/** Voegt de punten achteraan de agenda toe en geeft het aantal toegevoegde punten terug. */
async function insertItems(meetingId: string, items: NewItem[]): Promise<number> {
  const start = await q1<{ n: number }>(
    `SELECT COALESCE(max(position), 0)::int AS n FROM agenda_items WHERE meeting_id = $1 AND parent_id IS NULL`,
    [meetingId],
  );
  let count = 0;
  let position = start?.n ?? 0;
  for (const item of items) {
    const id = randomUUID();
    await q(
      `INSERT INTO agenda_items (id, meeting_id, position, title, kind, description) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, meetingId, ++position, item.title, item.kind, item.description],
    );
    count++;
    let childPosition = 0;
    for (const child of item.children) {
      await q(
        `INSERT INTO agenda_items (id, meeting_id, parent_id, position, title, kind, description) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), meetingId, id, ++childPosition, child.title, child.kind, child.description],
      );
      count++;
    }
  }
  return count;
}
import { route } from "../router";

const STATUSES = ["concept", "gepubliceerd", "afgerond"] as const;

route.post("/api/overleggen/:id/meetings", async (c) => {
  const overlegId = uuid(c.params.id, "Overleg");
  await requireOverleg(c.user, overlegId, true);
  const b = await c.body();
  const title = str(b.title, "Titel", { max: 200 });
  const startsAt = dateTime(b.startsAt, "Datum en tijd");
  const durationMin = int(b.durationMin ?? 60, "Duur", 5, 1440);
  const location = optStr(b.location, "Locatie", 200);
  const onlineUrl = httpUrl(b.onlineUrl, "Online link");
  const description = optStr(b.description, "Toelichting", 10_000);
  // Een geplakte agenda gaat voor op overnemen van de vorige vergadering.
  const items = b.items !== undefined ? parseItems(b.items) : [];
  const copyFromId = items.length ? null : optUuid(b.copyFromId, "Vorige vergadering");

  if (copyFromId && !(await q1(`SELECT 1 AS x FROM meetings WHERE id = $1 AND overleg_id = $2`, [copyFromId, overlegId]))) {
    throw bad("De vergadering om de agenda van over te nemen bestaat niet in dit overleg.");
  }
  const id = randomUUID();
  await q(
    `INSERT INTO meetings (id, overleg_id, title, starts_at, duration_min, location, online_url, description, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, overlegId, title, startsAt, durationMin, location, onlineUrl, description, c.user.id],
  );
  if (items.length) await insertItems(id, items);
  if (copyFromId) {
    // Agendastructuur overnemen (zonder notulen, stukken en besluiten): scheelt elke keer opnieuw opbouwen.
    const source = await q<{ id: string; parentId: string | null; position: number; title: string; kind: string; presenter: string; durationMin: number | null; description: string }>(
      `SELECT id, parent_id, position, title, kind, presenter, duration_min, description FROM agenda_items WHERE meeting_id = $1`,
      [copyFromId],
    );
    const newId = new Map(source.map((s) => [s.id, randomUUID()]));
    // Eerst de hoofdpunten, dan de subpunten (die verwijzen naar hun nieuwe hoofdpunt).
    for (const s of [...source.filter((x) => !x.parentId), ...source.filter((x) => x.parentId)]) {
      await q(
        `INSERT INTO agenda_items (id, meeting_id, parent_id, position, title, kind, presenter, duration_min, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [newId.get(s.id), id, s.parentId ? newId.get(s.parentId) : null, s.position, s.title, s.kind, s.presenter, s.durationMin, s.description],
      );
    }
  }
  return { id };
});

route.get("/api/meetings/:id", async (c) => {
  const id = uuid(c.params.id, "Vergadering");
  const { meeting, role } = await loadMeeting(c.user, id);
  const [items, documents, decisions, actions, members, carriedActions] = await Promise.all([
    q(
      `SELECT id, parent_id, position, title, kind, presenter, duration_min, description, notes
         FROM agenda_items WHERE meeting_id = $1 ORDER BY position, title`,
      [id],
    ),
    q(
      `SELECT d.id, d.agenda_item_id, d.name, d.mime, d.size::float8 AS size, d.uploaded_at, d.uploaded_by, u.name AS uploaded_by_name
         FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
        WHERE d.meeting_id = $1 AND d.status = 'ready' ORDER BY d.uploaded_at`,
      [id],
    ),
    q(
      `SELECT id, agenda_item_id, number, text, status, decided_on::text AS decided_on
         FROM decisions WHERE meeting_id = $1 ORDER BY number`,
      [id],
    ),
    q(
      `SELECT a.id, a.agenda_item_id, a.text, a.owner_id, u.name AS owner_name, a.due_date::text AS due_date, a.status
         FROM actions a LEFT JOIN users u ON u.id = a.owner_id
        WHERE a.meeting_id = $1 ORDER BY a.created_at`,
      [id],
    ),
    q(
      `SELECT u.id, u.name, u.email, m.role, a.status AS attendance
         FROM memberships m JOIN users u ON u.id = m.user_id
         LEFT JOIN attendance a ON a.meeting_id = $2 AND a.user_id = u.id
        WHERE m.overleg_id = $1 AND u.active ORDER BY lower(u.name)`,
      [meeting.overlegId, id],
    ),
    // Openstaande acties uit eerdere vergaderingen van dit overleg: de actielijst om door te nemen.
    q(
      `SELECT a.id, a.text, a.owner_id, u.name AS owner_name, a.due_date::text AS due_date, a.status,
              a.meeting_id, mt.title AS meeting_title, mt.starts_at AS meeting_starts_at
         FROM actions a JOIN meetings mt ON mt.id = a.meeting_id LEFT JOIN users u ON u.id = a.owner_id
        WHERE a.overleg_id = $1 AND a.meeting_id <> $2 AND a.status = 'open' AND mt.starts_at < $3
        ORDER BY a.due_date NULLS LAST, a.created_at`,
      [meeting.overlegId, id, meeting.startsAt],
    ),
  ]);
  return { meeting, role, items, documents, decisions, actions, members, carriedActions };
});

route.patch("/api/meetings/:id", async (c) => {
  const id = uuid(c.params.id, "Vergadering");
  const b = await c.body();
  const onlyStatus = Object.keys(b).every((k) => k === "status");
  // Een afgeronde vergadering is vergrendeld; alleen de status mag terug (heropenen).
  await loadMeeting(c.user, id, { edit: true, allowClosed: onlyStatus });

  const sets: string[] = ["updated_at = now()"];
  const vals: unknown[] = [id];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (b.title !== undefined) set("title", str(b.title, "Titel", { max: 200 }));
  if (b.startsAt !== undefined) set("starts_at", dateTime(b.startsAt, "Datum en tijd"));
  if (b.durationMin !== undefined) set("duration_min", int(b.durationMin, "Duur", 5, 1440));
  if (b.location !== undefined) set("location", optStr(b.location, "Locatie", 200));
  if (b.onlineUrl !== undefined) set("online_url", httpUrl(b.onlineUrl, "Online link"));
  if (b.description !== undefined) set("description", optStr(b.description, "Toelichting", 10_000));
  if (b.notes !== undefined) set("notes", optStr(b.notes, "Notulen", 50_000));
  if (b.status !== undefined) set("status", oneOf(b.status, "Status", STATUSES));
  if (sets.length === 1) throw bad("Geen wijzigingen.");
  await q(`UPDATE meetings SET ${sets.join(", ")} WHERE id = $1`, vals);
  return { ok: true };
});

route.delete("/api/meetings/:id", async (c) => {
  const id = uuid(c.params.id, "Vergadering");
  await loadMeeting(c.user, id, { edit: true });
  const used = await q1<{ decisions: number; actions: number }>(
    `SELECT (SELECT count(*)::int FROM decisions WHERE meeting_id = $1) AS decisions,
            (SELECT count(*)::int FROM actions WHERE meeting_id = $1) AS actions`,
    [id],
  );
  if (used && (used.decisions > 0 || used.actions > 0)) {
    throw new HttpError(
      409,
      "Deze vergadering heeft besluiten of acties en kan daarom niet worden verwijderd. Verwijder die eerst, of laat de vergadering staan.",
    );
  }
  const docs = await q<{ id: string }>(`SELECT id FROM documents WHERE meeting_id = $1`, [id]);
  await Promise.all(docs.map((d) => deleteDocumentBlobs(d.id)));
  await q(`DELETE FROM meetings WHERE id = $1`, [id]);
  return { ok: true };
});

// ---------- agendapunten ----------

function itemFields(b: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || b.title !== undefined) out.title = str(b.title, "Titel", { max: 200 });
  if (!partial || b.kind !== undefined) out.kind = optStr(b.kind, "Label", 80);
  if (!partial || b.presenter !== undefined) out.presenter = optStr(b.presenter, "Inbrenger", 120);
  if (!partial || b.durationMin !== undefined) out.duration_min = optInt(b.durationMin, "Duur", 1, 600);
  if (!partial || b.description !== undefined) out.description = optStr(b.description, "Toelichting", 10_000);
  if (b.notes !== undefined) out.notes = optStr(b.notes, "Notulen", 50_000);
  return out;
}

route.post("/api/meetings/:id/items", async (c) => {
  const meetingId = uuid(c.params.id, "Vergadering");
  await loadMeeting(c.user, meetingId, { edit: true });
  const b = await c.body();
  const f = itemFields(b, false);
  const parentId = optUuid(b.parentId, "Hoofdpunt");
  if (parentId && !(await q1(`SELECT 1 AS x FROM agenda_items WHERE id = $1 AND meeting_id = $2 AND parent_id IS NULL`, [parentId, meetingId]))) {
    throw bad("Een subpunt kan alleen onder een hoofdpunt van deze vergadering.");
  }
  const id = randomUUID();
  await q(
    `INSERT INTO agenda_items (id, meeting_id, parent_id, position, title, kind, presenter, duration_min, description, notes)
     VALUES ($1, $2, $3::uuid,
             (SELECT COALESCE(max(position), 0) + 1 FROM agenda_items
               WHERE meeting_id = $2 AND parent_id IS NOT DISTINCT FROM $3::uuid),
             $4, $5, $6, $7, $8, $9)`,
    [id, meetingId, parentId, f.title, f.kind, f.presenter, f.duration_min, f.description, f.notes ?? ""],
  );
  return { id };
});

/** Een bestaande agenda in één keer overnemen (geplakt uit een document). */
route.post("/api/meetings/:id/items/bulk", async (c) => {
  const meetingId = uuid(c.params.id, "Vergadering");
  await loadMeeting(c.user, meetingId, { edit: true });
  const items = parseItems((await c.body()).items);
  if (!items.length) throw bad("Er zijn geen agendapunten herkend.");
  return { count: await insertItems(meetingId, items) };
});

async function meetingOfItem(itemId: string): Promise<string> {
  const row = await q1<{ meetingId: string }>(`SELECT meeting_id FROM agenda_items WHERE id = $1`, [itemId]);
  if (!row) throw notFound("Agendapunt niet gevonden.");
  return row.meetingId;
}

route.patch("/api/items/:id", async (c) => {
  const id = uuid(c.params.id, "Agendapunt");
  await loadMeeting(c.user, await meetingOfItem(id), { edit: true });
  const f = itemFields(await c.body(), true);
  const cols = Object.keys(f);
  if (!cols.length) throw bad("Geen wijzigingen.");
  await q(`UPDATE agenda_items SET ${cols.map((col, i) => `${col} = $${i + 2}`).join(", ")} WHERE id = $1`, [
    id,
    ...cols.map((col) => f[col]),
  ]);
  return { ok: true };
});

route.delete("/api/items/:id", async (c) => {
  const id = uuid(c.params.id, "Agendapunt");
  await loadMeeting(c.user, await meetingOfItem(id), { edit: true });
  // Stukken, besluiten en acties van dit punt blijven bij de vergadering bewaard (koppeling vervalt).
  await q(`DELETE FROM agenda_items WHERE id = $1`, [id]);
  return { ok: true };
});

route.put("/api/meetings/:id/order", async (c) => {
  const meetingId = uuid(c.params.id, "Vergadering");
  await loadMeeting(c.user, meetingId, { edit: true });
  const b = await c.body();
  if (!Array.isArray(b.ids)) throw bad("Volgorde ontbreekt.");
  const ids = b.ids.map((v) => uuid(v, "Agendapunt"));
  const parentId = optUuid(b.parentId, "Hoofdpunt");
  const existing = await q<{ id: string }>(
    `SELECT id FROM agenda_items WHERE meeting_id = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid`,
    [meetingId, parentId],
  );
  const known = new Set(existing.map((r) => r.id));
  if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((i) => known.has(i))) {
    throw new HttpError(409, "De agenda is intussen gewijzigd. Ververs de pagina en probeer het opnieuw.");
  }
  await q(
    `UPDATE agenda_items a SET position = v.pos::int
       FROM unnest($2::uuid[]) WITH ORDINALITY AS v(id, pos)
      WHERE a.id = v.id AND a.meeting_id = $1`,
    [meetingId, ids],
  );
  return { ok: true };
});

// ---------- aanwezigheid ----------

route.put("/api/meetings/:id/attendance", async (c) => {
  const meetingId = uuid(c.params.id, "Vergadering");
  const b = await c.body();
  const targetId = b.userId ? uuid(b.userId, "Gebruiker") : c.user.id;
  const { meeting, role } = await loadMeeting(c.user, meetingId);
  if (targetId !== c.user.id && role !== "secretaris") throw forbidden("Je kunt alleen je eigen aanwezigheid doorgeven.");
  if (!(await q1(`SELECT 1 AS x FROM memberships WHERE overleg_id = $1 AND user_id = $2`, [meeting.overlegId, targetId]))) {
    throw bad("Alleen leden van dit overleg staan op de presentielijst.");
  }
  if (b.status === null || b.status === "") {
    await q(`DELETE FROM attendance WHERE meeting_id = $1 AND user_id = $2`, [meetingId, targetId]);
  } else {
    const status = oneOf(b.status, "Status", ["aanwezig", "afwezig"] as const);
    await q(
      `INSERT INTO attendance (meeting_id, user_id, status) VALUES ($1, $2, $3)
       ON CONFLICT (meeting_id, user_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
      [meetingId, targetId, status],
    );
  }
  return { ok: true };
});
