import { randomUUID } from "node:crypto";
import { createUserToken } from "../auth";
import { dbHost, q, q1 } from "../db";
import { bad, email, env, forbidden, HttpError, json, notFound, oneOf, str, uuid } from "../http";
import { store } from "../files";
import { route } from "../router";

/**
 * Alleen-lezen controle voor bewaking en na een deploy: werkt de database (inclusief
 * de datatypes die de app gebruikt) en is de opslag van stukken bereikbaar?
 * Schrijft niets en geeft geen gegevens prijs.
 */
route.get(
  "/api/health",
  async () => {
    const ids = [randomUUID(), randomUUID()];
    let dbOk = false;
    let blobsOk = false;
    try {
      const row = await q1(
        `SELECT $1::uuid[] AS ids, $2::jsonb AS doc, $3::int + 1 AS n, $4::boolean AS flag,
                '2026-01-31'::date::text AS day, now() AS at,
                (SELECT count(*)::int FROM users) >= 0 AS has_schema`,
        [ids, JSON.stringify({ a: 1 }), 41, true],
      );
      dbOk =
        Array.isArray(row?.ids) &&
        row.ids.join() === ids.join() &&
        row.doc?.a === 1 &&
        row.n === 42 &&
        row.flag === true &&
        row.day === "2026-01-31" &&
        !Number.isNaN(new Date(row.at).getTime()) &&
        row.hasSchema === true;
    } catch (e) {
      console.error("health db", e);
    }
    try {
      blobsOk = (await store().get("health-check")) === null;
    } catch (e) {
      console.error("health blobs", e);
    }
    const body = { db: dbOk ? "ok" : "fout", blobs: blobsOk ? "ok" : "fout" };
    return dbOk && blobsOk ? body : json(body, 503);
  },
  { public: true },
);

const ROLES = ["secretaris", "deelnemer"] as const;

route.get(
  "/api/users",
  async () => {
    const users = await q(
      `SELECT u.id, u.email, u.name, u.is_admin, u.active, u.created_at, u.last_login_at,
              (u.password_hash IS NOT NULL) AS has_password,
              COALESCE((SELECT json_agg(json_build_object('overlegId', m.overleg_id, 'overlegName', o.name, 'role', m.role) ORDER BY o.name)
                          FROM memberships m JOIN overleggen o ON o.id = m.overleg_id
                         WHERE m.user_id = u.id), '[]'::json) AS memberships
         FROM users u ORDER BY lower(u.name)`,
    );
    return { users };
  },
  { admin: true },
);

/** Namenlijst om leden aan een overleg toe te voegen (voor beheerders en secretarissen). */
route.get("/api/users/directory", async (c) => {
  if (!c.user.isAdmin) {
    const sec = await q1(`SELECT 1 AS x FROM memberships WHERE user_id = $1 AND role = 'secretaris' LIMIT 1`, [c.user.id]);
    if (!sec) throw forbidden();
  }
  const users = await q(`SELECT id, name, email FROM users WHERE active ORDER BY lower(name)`);
  return { users };
});

route.post(
  "/api/users",
  async (c) => {
    const b = await c.body();
    const name = str(b.name, "Naam", { max: 120 });
    const mail = email(b.email);
    const isAdmin = b.isAdmin === true;
    const memberships = Array.isArray(b.memberships) ? b.memberships : [];
    const parsed = memberships.map((m: Record<string, unknown>) => ({
      overlegId: uuid(m?.overlegId, "Overleg"),
      role: oneOf(m?.role, "Rol", ROLES),
    }));

    if (await q1(`SELECT 1 AS x FROM users WHERE lower(email) = $1`, [mail])) {
      throw new HttpError(409, "Er bestaat al een account met dit e-mailadres.");
    }
    const id = randomUUID();
    await q(`INSERT INTO users (id, email, name, is_admin) VALUES ($1, $2, $3, $4)`, [id, mail, name, isAdmin]);
    for (const m of parsed) {
      await q(
        `INSERT INTO memberships (overleg_id, user_id, role)
         SELECT o.id, $2, $3 FROM overleggen o WHERE o.id = $1
         ON CONFLICT DO NOTHING`,
        [m.overlegId, id, m.role],
      );
    }
    const link = await createUserToken(id, "invite", c.user.id);
    return { id, ...link };
  },
  { admin: true },
);

route.patch(
  "/api/users/:id",
  async (c) => {
    const id = uuid(c.params.id, "Gebruiker");
    const b = await c.body();
    const target = await q1<{ id: string; email: string }>(`SELECT id, email FROM users WHERE id = $1`, [id]);
    if (!target) throw notFound("Gebruiker niet gevonden.");

    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };

    if (b.name !== undefined) set("name", str(b.name, "Naam", { max: 120 }));
    if (b.email !== undefined) {
      const mail = email(b.email);
      if (await q1(`SELECT 1 AS x FROM users WHERE lower(email) = $1 AND id <> $2`, [mail, id])) {
        throw new HttpError(409, "Er bestaat al een account met dit e-mailadres.");
      }
      set("email", mail);
    }
    if (b.isAdmin !== undefined || b.active !== undefined) {
      // Voorkomt dat je jezelf buitensluit of dat er geen beheerder meer overblijft.
      if (id === c.user.id) throw bad("Je kunt je eigen beheerdersrol of status niet wijzigen. Vraag een andere beheerder.");
      if (b.isAdmin !== undefined) set("is_admin", b.isAdmin === true);
      if (b.active !== undefined) set("active", b.active === true);
    }
    if (!sets.length) throw bad("Geen wijzigingen.");
    await q(`UPDATE users SET ${sets.join(", ")} WHERE id = $1`, vals);
    if (b.active === false) await q(`DELETE FROM sessions WHERE user_id = $1`, [id]);
    return { ok: true };
  },
  { admin: true },
);

/** Nieuwe eenmalige link: uitnodiging (nog geen wachtwoord) of wachtwoord-reset. */
route.post(
  "/api/users/:id/token",
  async (c) => {
    const id = uuid(c.params.id, "Gebruiker");
    const u = await q1<{ hasPassword: boolean; active: boolean }>(
      `SELECT (password_hash IS NOT NULL) AS has_password, active FROM users WHERE id = $1`,
      [id],
    );
    if (!u) throw notFound("Gebruiker niet gevonden.");
    if (!u.active) throw bad("Dit account is geblokkeerd. Activeer het eerst.");
    return createUserToken(id, u.hasPassword ? "reset" : "invite", c.user.id);
  },
  { admin: true },
);

route.put(
  "/api/settings",
  async (c) => {
    const b = await c.body();
    const orgName = str(b.orgName, "Naam organisatie", { max: 120 });
    await q(
      `INSERT INTO settings (key, value) VALUES ('orgName', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [orgName],
    );
    return { ok: true };
  },
  { admin: true },
);

route.get(
  "/api/audit",
  async () => {
    const entries = await q(`SELECT id, at, user_name, action, detail FROM audit_log ORDER BY id DESC LIMIT 200`);
    return { entries };
  },
  { admin: true },
);

/** Waar draait het en waar staat de data: voor controle op regio (AVG) en snelheid. */
route.get(
  "/api/admin/diagnostics",
  async (c) => {
    const t0 = Date.now();
    await q(`SELECT 1 AS ok`);
    const dbMs = Date.now() - t0;
    const version = await q1<{ v: string }>(`SELECT version() AS v`);
    return {
      functionRegion: c.serverRegion,
      dbHost: dbHost(),
      dbRoundTripMs: dbMs,
      dbVersion: version?.v ?? "",
      blobRegion: env("BLOB_REGION") ?? "eu-central-1",
    };
  },
  { admin: true },
);
