import { randomBytes } from "node:crypto";
import { loadMeeting } from "../access";
import { q, q1 } from "../db";
import { chunkKey, store } from "../files";
import { HttpError, int, notFound, uuid } from "../http";
import { route } from "../router";

/**
 * Het scherm van de vergadering: wat iedereen in de zaal mag zien. De agenda, het actuele punt, de klok
 * en het stuk dat de secretaris op het scherm zet. Geen notulen, besluiten, acties of andere stukken.
 *
 * Twee ingangen leveren dezelfde toestand:
 * - /api/meetings/:id/screen  voor wie is ingelogd: het presentatiescherm op de beamer;
 * - /api/meekijken/:token     zonder account, met de QR-code of code die de secretaris per vergadering aanzet.
 *
 * Meekijken zonder account bestaat alleen zolang de vergadermodus loopt, hooguit twaalf uur, en niet bij
 * een besloten overleg. De toestand voor meekijkers is voor iedereen gelijk en wordt daarom heel kort
 * door het netwerk van Netlify bewaard: honderd meekijkers kosten zo niet meer dan één.
 */

/** Alleen wat op het scherm hoort. Verandert hier iets, dan verandert het voor meekijkers zonder account. */
function screenState(meetingId: string) {
  return q1<{ doc: { id: string } | null }>(
    `SELECT json_build_object('title', mt.title, 'overlegName', o.name, 'organisationName', org.name,
                              'startsAt', mt.starts_at, 'durationMin', mt.duration_min, 'status', mt.status) AS meeting,
            COALESCE((SELECT json_agg(json_build_object('id', i.id, 'parentId', i.parent_id, 'position', i.position, 'title', i.title,
                                'kind', i.kind, 'presenter', i.presenter, 'durationMin', i.duration_min, 'spentSec', i.spent_sec,
                                'description', i.description) ORDER BY i.position, i.title)
                        FROM agenda_items i WHERE i.meeting_id = mt.id), '[]'::json) AS items,
            json_build_object('startedAt', mt.live_started_at, 'itemId', mt.live_item_id, 'itemStartedAt', mt.live_item_started_at,
                              'docPage', mt.live_doc_page) AS live,
            (SELECT json_build_object('id', d.id, 'name', d.name, 'mime', d.mime, 'size', d.size::float8, 'chunkCount', d.chunk_count)
               FROM documents d WHERE d.id = mt.live_doc_id AND d.meeting_id = mt.id AND d.status = 'ready') AS doc,
            now() AS now
       FROM meetings mt
       JOIN overleggen o ON o.id = mt.overleg_id
       JOIN organisations org ON org.id = o.organisation_id
      WHERE mt.id = $1`,
    [meetingId],
  );
}

type Watch = { token: string; code: string } | null;

async function watchOf(meetingId: string): Promise<Watch> {
  const row = await q1<{ watchToken: string | null; watchCode: string | null }>(
    `SELECT watch_token, watch_code FROM meetings WHERE id = $1 AND watch_until > now() AND live_started_at IS NOT NULL`,
    [meetingId],
  );
  return row?.watchToken && row.watchCode ? { token: row.watchToken, code: row.watchCode } : null;
}

// ---------- ingelogd: het presentatiescherm ----------

route.get("/api/meetings/:id/screen", async (c) => {
  const id = uuid(c.params.id, "Vergadering");
  await loadMeeting(c.user, id);
  const [state, watch] = await Promise.all([screenState(id), watchOf(id)]);
  // De code staat op het scherm in de zaal, zodat aanwezigen hem kunnen scannen.
  return { ...state, watch };
});

// ---------- meekijken aan en uit (secretaris) ----------

/** Zonder letters en cijfers die op elkaar lijken (0/O, 1/I): de code wordt ook overgetypt. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("");

route.get("/api/meetings/:id/watch", async (c) => {
  const id = uuid(c.params.id, "Vergadering");
  await loadMeeting(c.user, id, { edit: true });
  return { watch: await watchOf(id) };
});

route.post("/api/meetings/:id/watch", async (c) => {
  const id = uuid(c.params.id, "Vergadering");
  const { meeting } = await loadMeeting(c.user, id, { edit: true });
  if ((await c.body()).on !== true) {
    await q(`UPDATE meetings SET watch_token = NULL, watch_code = NULL, watch_until = NULL WHERE id = $1`, [id]);
    return { watch: null };
  }
  if (meeting.besloten) throw new HttpError(409, "Meekijken zonder account kan niet bij een besloten overleg.");
  if (!meeting.liveStartedAt) throw new HttpError(409, "Start eerst de vergadermodus. Meekijken kan alleen tijdens de vergadering.");
  // Staat het al aan, dan blijft dezelfde code gelden: die staat al op het scherm in de zaal.
  await q(
    `UPDATE meetings
        SET watch_token = CASE WHEN watch_until > now() THEN COALESCE(watch_token, $2) ELSE $2 END,
            watch_code = CASE WHEN watch_until > now() THEN COALESCE(watch_code, $3) ELSE $3 END,
            watch_until = now() + interval '12 hours'
      WHERE id = $1`,
    [id, randomBytes(24).toString("base64url"), newCode()],
  );
  return { watch: await watchOf(id) };
});

// ---------- zonder account ----------

/** Antwoord dat voor elke meekijker gelijk is: het netwerk bewaart het kort en deelt het uit. */
function shared(data: unknown, status: number, seconds: number, stale = 0): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // De browser bewaart niets; alleen het netwerk van Netlify, en maar heel even.
      "cache-control": "public, max-age=0, must-revalidate",
      "netlify-cdn-cache-control": `public, durable, max-age=${seconds}${stale ? `, stale-while-revalidate=${stale}` : ""}`,
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

const TOKEN = /^[A-Za-z0-9_-]{24,64}$/;

/** De vergadering waar deze link bij hoort, alleen zolang meekijken aan staat en de vergadering loopt. */
async function watched(token: string) {
  if (!TOKEN.test(token)) return null;
  return q1<{ id: string; liveDocId: string | null }>(
    `SELECT id, live_doc_id FROM meetings WHERE watch_token = $1 AND watch_until > now() AND live_started_at IS NOT NULL`,
    [token],
  );
}

/** Wie de code intypt, krijgt de link waarmee de pagina de toestand ophaalt. */
route.post(
  "/api/meekijken",
  async (c) => {
    const code = String((await c.body()).code ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 16);
    // Raden uitsluiten: per adres en in totaal een grens op mislukte pogingen.
    const recent = await q1<{ byIp: number; total: number }>(
      `SELECT count(*) FILTER (WHERE ip = $1)::int AS by_ip, count(*)::int AS total
         FROM login_attempts WHERE email = 'meekijken' AND NOT success AND at > now() - interval '15 minutes'`,
      [c.ip],
    );
    if (recent && (recent.byIp >= 20 || recent.total >= 300)) {
      throw new HttpError(429, "Te veel pogingen. Scan de QR-code, of probeer het over een kwartier opnieuw.");
    }
    const row =
      code.length === 8
        ? await q1<{ watchToken: string }>(
            `SELECT watch_token FROM meetings WHERE watch_code = $1 AND watch_until > now() AND live_started_at IS NOT NULL`,
            [code],
          )
        : null;
    await q(`INSERT INTO login_attempts (email, ip, success) VALUES ('meekijken', $1, $2)`, [c.ip, !!row]);
    if (!row) throw new HttpError(404, "Deze code klopt niet, of het meekijken is gestopt.");
    return { token: row.watchToken };
  },
  { public: true, audit: false },
);

route.get(
  "/api/meekijken/:token",
  async (c) => {
    const m = await watched(c.params.token);
    if (!m) return shared({ error: "Het meekijken is gestopt, of de link klopt niet." }, 404, 2);
    return shared(await screenState(m.id), 200, 1, 4);
  },
  { public: true },
);

/**
 * Een deel van het stuk dat nu op het scherm staat. Alleen dat stuk: het nummer in het adres moet
 * het getoonde stuk zijn, anders bestaat het voor de meekijker niet.
 */
route.get(
  "/api/meekijken/:token/doc/:docId/:n",
  async (c) => {
    const m = await watched(c.params.token);
    const docId = uuid(c.params.docId, "Stuk");
    if (!m || m.liveDocId !== docId) throw notFound("Dit stuk staat niet op het scherm.");
    const doc = await q1<{ chunkCount: number }>(`SELECT chunk_count FROM documents WHERE id = $1 AND status = 'ready'`, [docId]);
    if (!doc) throw notFound("Dit stuk staat niet op het scherm.");
    const n = int(c.params.n, "Deel", 0, doc.chunkCount - 1);
    const part = await store().get(chunkKey(docId, n), { type: "arrayBuffer" });
    if (!part) throw notFound("Dit deel van het bestand ontbreekt.");
    return new Response(part, {
      headers: {
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
        "cache-control": "public, max-age=0, must-revalidate",
        // Alle meekijkers halen hetzelfde stuk op: één keer uit de opslag, daarna uit het netwerk.
        "netlify-cdn-cache-control": "public, durable, max-age=120",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  },
  { public: true },
);
