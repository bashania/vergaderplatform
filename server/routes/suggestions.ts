import { randomUUID } from "node:crypto";
import { loadMeeting, requireOverleg } from "../access";
import { q, q1 } from "../db";
import { bad, forbidden, HttpError, notFound, optStr, str, uuid } from "../http";
import { route } from "../router";

/**
 * Agendapunten aandragen: elke deelnemer van een overleg kan tussen de vergaderingen door een
 * onderwerp aanleveren. De secretaris zet het met één klik op een agenda, of wijst het af met een reden.
 * Scheelt het heen en weer mailen van "kan dit nog op de agenda?".
 */

route.get("/api/overleggen/:id/suggestions", async (c) => {
  const overlegId = uuid(c.params.id, "Overleg");
  await requireOverleg(c.user, overlegId);
  // Openstaande punten, plus wat de laatste zes weken is afgehandeld (zodat de aandrager ziet wat ermee is gedaan).
  const suggestions = await q(
    `SELECT s.id, s.title, s.description, s.status, s.reply, s.created_at, s.created_by, u.name AS created_by_name,
            s.handled_at, mt.id AS meeting_id, mt.title AS meeting_title, mt.starts_at AS meeting_starts_at
       FROM suggestions s
       LEFT JOIN users u ON u.id = s.created_by
       LEFT JOIN agenda_items ai ON ai.id = s.agenda_item_id
       LEFT JOIN meetings mt ON mt.id = ai.meeting_id
      WHERE s.overleg_id = $1 AND (s.status = 'open' OR s.handled_at > now() - interval '42 days')
      ORDER BY (s.status = 'open') DESC, s.created_at DESC
      LIMIT 100`,
    [overlegId],
  );
  return { suggestions };
});

route.post("/api/overleggen/:id/suggestions", async (c) => {
  const overlegId = uuid(c.params.id, "Overleg");
  await requireOverleg(c.user, overlegId);
  const b = await c.body();
  const title = str(b.title, "Onderwerp", { max: 200 });
  const description = optStr(b.description, "Toelichting", 5000);
  const open = await q1<{ n: number }>(`SELECT count(*)::int AS n FROM suggestions WHERE overleg_id = $1 AND status = 'open'`, [overlegId]);
  if (open && open.n >= 100) throw new HttpError(409, "Er staan al veel aangedragen punten open. Laat de secretaris die eerst afhandelen.");
  const id = randomUUID();
  await q(`INSERT INTO suggestions (id, overleg_id, title, description, created_by) VALUES ($1, $2, $3, $4, $5)`, [id, overlegId, title, description, c.user.id]);
  return { id };
});

async function loadSuggestion(id: string) {
  const s = await q1<{ id: string; overlegId: string; title: string; description: string; status: string; createdBy: string | null; createdByName: string | null }>(
    `SELECT s.id, s.overleg_id, s.title, s.description, s.status, s.created_by, u.name AS created_by_name
       FROM suggestions s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = $1`,
    [id],
  );
  if (!s) throw notFound("Aangedragen punt niet gevonden.");
  return s;
}

/** Intrekken door de aandrager (zolang het open staat) of opruimen door de secretaris. */
route.delete("/api/suggestions/:id", async (c) => {
  const s = await loadSuggestion(uuid(c.params.id, "Aangedragen punt"));
  const role = await requireOverleg(c.user, s.overlegId);
  if (role !== "secretaris" && !(s.createdBy === c.user.id && s.status === "open")) throw forbidden("Je kunt alleen je eigen openstaande punt intrekken.");
  await q(`DELETE FROM suggestions WHERE id = $1`, [s.id]);
  return { ok: true };
});

/** Op de agenda van een vergadering zetten: wordt een agendapunt achteraan, met de aandrager als inbrenger. */
route.post("/api/suggestions/:id/place", async (c) => {
  const s = await loadSuggestion(uuid(c.params.id, "Aangedragen punt"));
  const meetingId = uuid((await c.body()).meetingId, "Vergadering");
  const { meeting } = await loadMeeting(c.user, meetingId, { edit: true });
  if (meeting.overlegId !== s.overlegId) throw bad("Deze vergadering hoort bij een ander overleg.");
  if (s.status !== "open") throw new HttpError(409, "Dit punt is al afgehandeld.");
  const itemId = randomUUID();
  await q(
    `INSERT INTO agenda_items (id, meeting_id, position, title, presenter, description)
     VALUES ($1, $2, (SELECT COALESCE(max(position), 0) + 1 FROM agenda_items WHERE meeting_id = $2 AND parent_id IS NULL), $3, $4, $5)`,
    [itemId, meetingId, s.title, (s.createdByName ?? "").slice(0, 120), s.description],
  );
  await q(`UPDATE suggestions SET status = 'geplaatst', agenda_item_id = $2, handled_by = $3, handled_at = now() WHERE id = $1`, [s.id, itemId, c.user.id]);
  return { itemId };
});

route.post("/api/suggestions/:id/dismiss", async (c) => {
  const s = await loadSuggestion(uuid(c.params.id, "Aangedragen punt"));
  await requireOverleg(c.user, s.overlegId, true);
  if (s.status !== "open") throw new HttpError(409, "Dit punt is al afgehandeld.");
  const reply = optStr((await c.body()).reply, "Reden", 1000);
  await q(`UPDATE suggestions SET status = 'afgewezen', reply = $2, handled_by = $3, handled_at = now() WHERE id = $1`, [s.id, reply, c.user.id]);
  return { ok: true };
});
