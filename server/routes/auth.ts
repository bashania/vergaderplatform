import { randomUUID } from "node:crypto";
import {
  checkNewPassword,
  createSession,
  destroySession,
  hashPassword,
  safeEqual,
  sha256,
  verifyPassword,
} from "../auth";
import { q, q1 } from "../db";
import { bad, email, env, HttpError, notFound, optStr, str } from "../http";
import { route } from "../router";

route.get(
  "/api/session",
  async (c) => {
    const [org, anyUser] = await Promise.all([
      q1<{ value: string }>(`SELECT value FROM settings WHERE key = 'orgName'`),
      c.user ? null : q1(`SELECT 1 AS x FROM users LIMIT 1`),
    ]);
    return { user: c.user ?? null, orgName: org?.value ?? "", setupNeeded: !c.user && !anyUser };
  },
  { public: true },
);

/** Eenmalige inrichting: de eerste beheerder maakt zijn account aan met de installatiecode. */
route.post(
  "/api/setup",
  async (c) => {
    const b = await c.body();
    const code = env("SETUP_CODE");
    if (!code || typeof b.code !== "string" || !safeEqual(b.code, code)) {
      throw new HttpError(403, "De installatiecode klopt niet.");
    }
    const name = str(b.name, "Naam", { max: 120 });
    const mail = email(b.email);
    const orgName = optStr(b.orgName, "Naam organisatie", 120);
    const hash = await hashPassword(checkNewPassword(b.password));
    const id = randomUUID();
    const created = await q1(
      `INSERT INTO users (id, email, name, password_hash, is_admin, last_login_at)
       SELECT $1, $2, $3, $4, true, now() WHERE NOT EXISTS (SELECT 1 FROM users)
       RETURNING id`,
      [id, mail, name, hash],
    );
    if (!created) throw new HttpError(409, "Het platform is al ingericht. Log in met je account.");
    if (orgName) {
      await q(`INSERT INTO settings (key, value) VALUES ('orgName', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [orgName]);
    }
    c.setSession(await createSession(id));
    return { user: { id, email: mail, name, isAdmin: true } };
  },
  { public: true, audit: false },
);

route.post(
  "/api/login",
  async (c) => {
    const b = await c.body();
    const mail = typeof b.email === "string" ? b.email.trim().toLowerCase().slice(0, 200) : "";
    const password = typeof b.password === "string" ? b.password.slice(0, 200) : "";
    if (!mail || !password) throw bad("Vul je e-mailadres en wachtwoord in.");

    const recent = await q1<{ byEmail: number; byIp: number }>(
      `SELECT count(*) FILTER (WHERE email = $1 AND NOT success)::int AS by_email,
              count(*) FILTER (WHERE ip = $2 AND NOT success)::int AS by_ip
         FROM login_attempts WHERE at > now() - interval '15 minutes'`,
      [mail, c.ip],
    );
    if (recent && (recent.byEmail >= 8 || recent.byIp >= 40)) {
      throw new HttpError(429, "Te veel mislukte pogingen. Probeer het over een kwartier opnieuw.");
    }

    const u = await q1<{ id: string; email: string; name: string; isAdmin: boolean; passwordHash: string | null; active: boolean }>(
      `SELECT id, email, name, is_admin, password_hash, active FROM users WHERE lower(email) = $1`,
      [mail],
    );
    const ok = await verifyPassword(password, u?.active ? u.passwordHash : null);
    await q(`INSERT INTO login_attempts (email, ip, success) VALUES ($1, $2, $3)`, [mail, c.ip, ok]);
    if (!ok || !u) throw new HttpError(401, "E-mailadres of wachtwoord klopt niet.");

    await Promise.all([
      q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [u.id]),
      q(`DELETE FROM sessions WHERE expires_at < now()`),
      q(`DELETE FROM login_attempts WHERE at < now() - interval '7 days'`),
    ]);
    c.setSession(await createSession(u.id));
    return { user: { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin } };
  },
  { public: true, audit: false },
);

route.post(
  "/api/logout",
  async (c) => {
    await destroySession(c.req, c.url);
    c.setSession(null);
    return { ok: true };
  },
  { public: true, audit: false },
);

// ---------- uitnodigings- en resetlinks ----------

const EXPIRED = "Deze link is verlopen of al gebruikt. Vraag de beheerder om een nieuwe link.";

route.get(
  "/api/tokens/:token",
  async (c) => {
    const t = await q1<{ purpose: string; name: string; email: string }>(
      `SELECT t.purpose, u.name, u.email
         FROM user_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now() AND u.active`,
      [sha256(c.params.token)],
    );
    if (!t) throw notFound(EXPIRED);
    return t;
  },
  { public: true },
);

route.post(
  "/api/tokens/:token",
  async (c) => {
    const b = await c.body();
    const hash = await hashPassword(checkNewPassword(b.password));
    // Atomair claimen: de link werkt precies één keer.
    const claimed = await q1<{ userId: string }>(
      `UPDATE user_tokens t SET used_at = now()
        WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = t.user_id AND u.active)
        RETURNING t.user_id`,
      [sha256(c.params.token)],
    );
    if (!claimed) throw notFound(EXPIRED);
    await q(`UPDATE users SET password_hash = $2, last_login_at = now() WHERE id = $1`, [claimed.userId, hash]);
    await q(`DELETE FROM sessions WHERE user_id = $1`, [claimed.userId]);
    c.setSession(await createSession(claimed.userId));
    const user = await q1(`SELECT id, email, name, is_admin FROM users WHERE id = $1`, [claimed.userId]);
    return { user };
  },
  { public: true, audit: false },
);

// ---------- eigen account ----------

route.post("/api/account/password", async (c) => {
  const b = await c.body();
  const current = typeof b.current === "string" ? b.current : "";
  const next = checkNewPassword(b.password);
  const row = await q1<{ passwordHash: string | null }>(`SELECT password_hash FROM users WHERE id = $1`, [c.user.id]);
  if (!(await verifyPassword(current, row?.passwordHash ?? null))) throw bad("Je huidige wachtwoord klopt niet.");
  await q(`UPDATE users SET password_hash = $2 WHERE id = $1`, [c.user.id, await hashPassword(next)]);
  // Alle andere apparaten uitloggen; dit apparaat krijgt een nieuwe sessie.
  await q(`DELETE FROM sessions WHERE user_id = $1`, [c.user.id]);
  c.setSession(await createSession(c.user.id));
  return { ok: true };
});

route.patch("/api/account", async (c) => {
  const b = await c.body();
  const name = str(b.name, "Naam", { max: 120 });
  await q(`UPDATE users SET name = $2 WHERE id = $1`, [c.user.id, name]);
  return { ok: true };
});
