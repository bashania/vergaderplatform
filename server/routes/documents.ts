import { randomUUID } from "node:crypto";
import { loadMeeting, requireOverleg } from "../access";
import type { User } from "../auth";
import { q, q1 } from "../db";
import { CHUNK_SIZE, chunkKey, deleteDocumentBlobs, fileHeaders, MAX_FILE_SIZE, MAX_STREAM_SIZE, store } from "../files";
import { bad, forbidden, HttpError, int, notFound, optUuid, str, uuid } from "../http";
import { route } from "../router";

type Doc = {
  id: string;
  overlegId: string;
  meetingId: string | null;
  agendaItemId: string | null;
  name: string;
  mime: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  status: "uploading" | "ready";
  uploadedBy: string | null;
};

const DOC_COLUMNS = `id, overleg_id, meeting_id, agenda_item_id, name, mime, size::float8 AS size, chunk_size, chunk_count, status, uploaded_by`;

/**
 * view: iedereen die de vergadering/het overleg mag zien.
 * manage: de secretaris, of de uploader zolang de vergadering niet is afgerond.
 */
async function loadDoc(user: User, id: string, mode: "view" | "manage"): Promise<Doc> {
  const doc = await q1<Doc>(`SELECT ${DOC_COLUMNS} FROM documents WHERE id = $1`, [id]);
  if (!doc) throw notFound("Stuk niet gevonden.");
  if (doc.meetingId) {
    const { meeting, role } = await loadMeeting(user, doc.meetingId);
    if (mode === "manage") {
      if (meeting.status === "afgerond") {
        throw new HttpError(409, "Deze vergadering is afgerond. Heropen de vergadering om stukken te wijzigen.");
      }
      if (role !== "secretaris" && doc.uploadedBy !== user.id) throw forbidden("Je kunt alleen je eigen stukken wijzigen.");
    }
  } else {
    await requireOverleg(user, doc.overlegId, mode === "manage");
  }
  return doc;
}

const cleanName = (v: unknown) =>
  str(v, "Bestandsnaam", { max: 200 })
    .replace(/[\\/\u0000-\u001f]/g, "_")
    .trim() || "bestand";

route.post("/api/documents", async (c) => {
  const b = await c.body();
  const name = cleanName(b.name);
  const size = int(b.size, "Bestandsgrootte", 1, MAX_FILE_SIZE);
  const mime = typeof b.mime === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(b.mime) ? b.mime.toLowerCase() : "application/octet-stream";
  const meetingId = optUuid(b.meetingId, "Vergadering");
  const agendaItemId = optUuid(b.agendaItemId, "Agendapunt");

  let overlegId: string;
  if (meetingId) {
    // Ook deelnemers kunnen stukken aanleveren, zolang de vergadering niet is afgerond.
    const { meeting } = await loadMeeting(c.user, meetingId);
    if (meeting.status === "afgerond") {
      throw new HttpError(409, "Deze vergadering is afgerond. Heropen de vergadering om stukken toe te voegen.");
    }
    if (agendaItemId && !(await q1(`SELECT 1 AS x FROM agenda_items WHERE id = $1 AND meeting_id = $2`, [agendaItemId, meetingId]))) {
      throw bad("Het agendapunt hoort niet bij deze vergadering.");
    }
    overlegId = meeting.overlegId;
  } else {
    // Vaste stukken van het overleg beheert de secretaris.
    overlegId = uuid(b.overlegId, "Overleg");
    await requireOverleg(c.user, overlegId, true);
  }

  // Opruimen: afgebroken uploads van meer dan een dag oud.
  const stale = await q<{ id: string }>(
    `SELECT id FROM documents WHERE status = 'uploading' AND uploaded_at < now() - interval '1 day' LIMIT 5`,
  );
  for (const s of stale) {
    await deleteDocumentBlobs(s.id);
    await q(`DELETE FROM documents WHERE id = $1 AND status = 'uploading'`, [s.id]);
  }

  const id = randomUUID();
  const chunkCount = Math.ceil(size / CHUNK_SIZE);
  await q(
    `INSERT INTO documents (id, overleg_id, meeting_id, agenda_item_id, name, mime, size, chunk_size, chunk_count, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, overlegId, meetingId, meetingId ? agendaItemId : null, name, mime, size, CHUNK_SIZE, chunkCount, c.user.id],
  );
  return { id, chunkSize: CHUNK_SIZE, chunkCount };
});

route.put(
  "/api/documents/:id/chunks/:n",
  async (c) => {
    const id = uuid(c.params.id, "Stuk");
    const doc = await q1<Doc>(`SELECT ${DOC_COLUMNS} FROM documents WHERE id = $1`, [id]);
    if (!doc || doc.status !== "uploading" || doc.uploadedBy !== c.user.id) throw notFound("Upload niet gevonden.");
    const n = int(c.params.n, "Deel", 0, doc.chunkCount - 1);
    const expected = n < doc.chunkCount - 1 ? doc.chunkSize : doc.size - doc.chunkSize * (doc.chunkCount - 1);
    const data = await c.req.arrayBuffer();
    if (data.byteLength !== expected) throw bad("Het geüploade deel heeft niet de verwachte grootte.");
    await store().set(chunkKey(id, n), data);
    return { ok: true };
  },
  { audit: false },
);

route.post("/api/documents/:id/complete", async (c) => {
  const id = uuid(c.params.id, "Stuk");
  const doc = await q1<Doc>(`SELECT ${DOC_COLUMNS} FROM documents WHERE id = $1`, [id]);
  if (!doc || doc.status !== "uploading" || doc.uploadedBy !== c.user.id) throw notFound("Upload niet gevonden.");
  const { blobs } = await store().list({ prefix: `${id}/` });
  if (blobs.length !== doc.chunkCount) throw new HttpError(409, "De upload is niet compleet. Probeer het opnieuw.");
  await q(`UPDATE documents SET status = 'ready', uploaded_at = now() WHERE id = $1`, [id]);
  return { id };
});

/** Bestand in één keer streamen: opent direct in de browser (PDF, afbeelding) of downloadt. */
route.get("/api/documents/:id/file", async (c) => {
  const doc = await loadDoc(c.user, uuid(c.params.id, "Stuk"), "view");
  if (doc.status !== "ready") throw notFound("Stuk niet gevonden.");
  if (doc.size > MAX_STREAM_SIZE) throw new HttpError(413, "Dit bestand is te groot om direct te openen; download het in delen.");
  const s = store();
  let n = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (n >= doc.chunkCount) {
        controller.close();
        return;
      }
      const part = await s.get(chunkKey(doc.id, n++), { type: "arrayBuffer" });
      if (!part) {
        controller.error(new Error(`deel ${n - 1} van stuk ${doc.id} ontbreekt`));
        return;
      }
      controller.enqueue(new Uint8Array(part));
    },
  });
  return new Response(body, { headers: fileHeaders(doc.name, doc.mime, doc.size, c.url.searchParams.has("download")) });
});

/** Eén deel ophalen: voor bestanden boven de streamlimiet zet de browser de delen zelf aan elkaar. */
route.get("/api/documents/:id/chunks/:n", async (c) => {
  const doc = await loadDoc(c.user, uuid(c.params.id, "Stuk"), "view");
  if (doc.status !== "ready") throw notFound("Stuk niet gevonden.");
  const n = int(c.params.n, "Deel", 0, doc.chunkCount - 1);
  const part = await store().get(chunkKey(doc.id, n), { type: "arrayBuffer" });
  if (!part) throw notFound("Dit deel van het bestand ontbreekt.");
  return new Response(part, {
    headers: {
      "content-type": "application/octet-stream",
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
});

route.patch("/api/documents/:id", async (c) => {
  const doc = await loadDoc(c.user, uuid(c.params.id, "Stuk"), "manage");
  const b = await c.body();
  const sets: string[] = [];
  const vals: unknown[] = [doc.id];
  if (b.name !== undefined) {
    vals.push(cleanName(b.name));
    sets.push(`name = $${vals.length}`);
  }
  if (b.agendaItemId !== undefined && doc.meetingId) {
    const itemId = optUuid(b.agendaItemId, "Agendapunt");
    if (itemId && !(await q1(`SELECT 1 AS x FROM agenda_items WHERE id = $1 AND meeting_id = $2`, [itemId, doc.meetingId]))) {
      throw bad("Het agendapunt hoort niet bij deze vergadering.");
    }
    vals.push(itemId);
    sets.push(`agenda_item_id = $${vals.length}`);
  }
  if (!sets.length) throw bad("Geen wijzigingen.");
  await q(`UPDATE documents SET ${sets.join(", ")} WHERE id = $1`, vals);
  return { ok: true };
});

route.delete("/api/documents/:id", async (c) => {
  const doc = await loadDoc(c.user, uuid(c.params.id, "Stuk"), "manage");
  await deleteDocumentBlobs(doc.id);
  await q(`DELETE FROM documents WHERE id = $1`, [doc.id]);
  return { ok: true };
});
