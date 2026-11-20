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
import { aiAvailable } from "../ai";
import { q, q1 } from "../db";
import { bad, email, env, HttpError, notFound, optStr, str } from "../http";
import { route } from "../router";

/** Organisaties waar de gebruiker bij mag: als beheerder, of via deelname aan een overleg. */
function myOrganisations(userId: string) {
  return q(
    `SELECT org.id, org.name, org.require_passkey, org.ai_enabled, CASE WHEN adm.is_admin THEN 'beheerder' ELSE 'lid' END AS role
       FROM organisations org
       CROSS JOIN LATERAL (
         SELECT EXISTS (SELECT 1 FROM organisation_admins a WHERE a.organisation_id = org.id AND a.user_id = $1) AS is_admin
       ) adm
      WHERE NOT org.archived
        AND (adm.is_admin OR EXISTS (
              SELECT 1 FROM memberships m JOIN overleggen o ON o.id = m.overleg_id
               WHERE o.organisation_id = org.id AND m.user_id = $1))
      ORDER BY lower(org.name)`,
    [userId],
  );
}

route.get(
  "/api/session",
  async (c) => {
    const [org, anyUser, organisations, account] = await Promise.all([
      q1<{ value: string }>(`SELECT value FROM settings WHERE key = 'orgName'`),
      c.user ? null : q1(`SELECT 1 AS x FROM users LIMIT 1`),
      c.user ? myOrganisations(c.user.id) : [],
      c.user
        ? q1<{ hasPassword: boolean; passkeys: number }>(
            `SELECT (password_hash IS NOT NULL) AS has_password,
                    (SELECT count(*)::int FROM passkeys WHERE user_id = users.id) AS passkeys
               FROM users WHERE id = $1`,
            [c.user.id],
          )
        : null,
    ]);
    // strong = deze sessie is met een passkey ingelogd; alleen die opent organisaties met passkey-eis.
    const user = c.user ? { ...c.user, hasPassword: account?.hasPassword ?? false, passkeys: account?.passkeys ?? 0 } : null;
    return { user, orgName: org?.value ?? "", setupNeeded: !c.user && !anyUser, organisations, aiAvailable: !!c.user && aiAvailable() };
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
    const organisation = optStr(b.organisation, "Naam organisatie", 120);
    const hash = await hashPassword(checkNewPassword(b.password));
    const id = randomUUID();
    const created = await q1(
      `INSERT INTO users (id, email, name, password_hash, is_admin, last_login_at)
       SELECT $1, $2, $3, $4, true, now() WHERE NOT EXISTS (SELECT 1 FROM users)
       RETURNING id`,
      [id, mail, name, hash],
    );
    if (!created) throw new HttpError(409, "Het platform is al ingericht. Log in met je account.");
    if (organisation) {
      // De eerste organisatie, met de nieuwe beheerder als beheerder: direct een werkende omgeving.
      const orgId = randomUUID();
      await q(`INSERT INTO organisations (id, name) VALUES ($1, $2)`, [orgId, organisation]);
      await q(`INSERT INTO organisation_admins (organisation_id, user_id) VALUES ($1, $2)`, [orgId, id]);
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
    const t = await q1<{ purpose: string; name: string; email: string; canUsePasskey: boolean }>(
      `SELECT t.purpose, u.name, u.email, NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = u.id) AS can_use_passkey
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
  if (!row?.passwordHash) {
    // Account zonder wachtwoord (alleen passkey): instellen mag vanuit een passkey-sessie.
    if (!c.user.strong) throw bad("Log in met je passkey om een wachtwoord in te stellen.");
  } else if (!(await verifyPassword(current, row.passwordHash))) {
    throw bad("Je huidige wachtwoord klopt niet.");
  }
  await q(`UPDATE users SET password_hash = $2 WHERE id = $1`, [c.user.id, await hashPassword(next)]);
  // Alle andere apparaten uitloggen; dit apparaat krijgt een nieuwe sessie.
  await q(`DELETE FROM sessions WHERE user_id = $1`, [c.user.id]);
  // De nieuwe sessie houdt dezelfde zekerheid: een passkey-sessie blijft een passkey-sessie.
  c.setSession(await createSession(c.user.id, c.user.strong ? "passkey" : "password"));
  return { ok: true };
});

route.patch("/api/account", async (c) => {
  const b = await c.body();
  const name = str(b.name, "Naam", { max: 120 });
  await q(`UPDATE users SET name = $2 WHERE id = $1`, [c.user.id, name]);
  return { ok: true };
});
