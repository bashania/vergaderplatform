import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { q, q1 } from "./db";
import { bad } from "./http";

/** strong = deze sessie is met een passkey ingelogd (telt als tweestapsverificatie). */
export type User = { id: string; email: string; name: string; isAdmin: boolean; strong: boolean };
export type SessionMethod = "password" | "passkey";

/**
 * SQL-voorwaarde: het account is geactiveerd, dus de uitnodiging is geaccepteerd
 * met een wachtwoord of een passkey.
 */
export const activated = (alias: string) =>
  `(${alias}.password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM passkeys pk WHERE pk.user_id = ${alias}.id))`;

// ---------- wachtwoorden (scrypt, OWASP-profiel N=2^15, r=8, p=3) ----------

const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 96 * 1024 * 1024 };
const KEYLEN = 32;

function derive(password: string, salt: Buffer, params = SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEYLEN, params, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    // Zelfde rekentijd als bij een bestaand account, zodat de responstijd niets verraadt.
    await derive(password, Buffer.alloc(16));
    return false;
  }
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function checkNewPassword(v: unknown): string {
  if (typeof v !== "string" || v.length < 10) throw bad("Kies een wachtwoord van minimaal 10 tekens.");
  if (v.length > 200) throw bad("Wachtwoord is te lang.");
  return v;
}

// ---------- tokens en sessies ----------

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

const SESSION_DAYS = 60;
const SESSION_SECONDS = SESSION_DAYS * 24 * 3600;

// __Host- dwingt Secure + Path=/ af en voorkomt overschrijven vanaf een subdomein.
// Lokaal (http) kan dat prefix niet, daar gebruiken we een gewone cookienaam.
const cookieName = (url: URL) => (url.protocol === "https:" ? "__Host-vp_session" : "vp_session");

export function sessionCookie(url: URL, token: string | null): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const value = token ?? "";
  const maxAge = token ? SESSION_SECONDS : 0;
  return `${cookieName(url)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function readSessionToken(req: Request, url: URL): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const name = cookieName(url);
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

export async function createSession(userId: string, method: SessionMethod = "password"): Promise<string> {
  const token = newToken();
  await q(
    `INSERT INTO sessions (token_hash, user_id, method, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [sha256(token), userId, method, SESSION_DAYS],
  );
  return token;
}

export async function destroySession(req: Request, url: URL): Promise<void> {
  const token = readSessionToken(req, url);
  if (token) await q(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
}

/**
 * Ingelogde gebruiker bij dit request. `renew` = cookie en sessie verlengen (schuivende sessie).
 * orgLocked = de gekozen organisatie eist een passkey en deze sessie heeft die niet.
 */
export async function userFromRequest(
  req: Request,
  url: URL,
  orgId: string | null,
): Promise<{ user: User; renew: string | null; orgLocked: boolean } | null> {
  const token = readSessionToken(req, url);
  if (!token) return null;
  const hash = sha256(token);
  const row = await q1<User & { stale: boolean; orgRequiresPasskey: boolean | null }>(
    `SELECT u.id, u.email, u.name, u.is_admin, (s.method = 'passkey') AS strong,
            s.last_seen_at < now() - interval '12 hours' AS stale,
            (SELECT require_passkey FROM organisations WHERE id = $2::uuid) AS org_requires_passkey
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [hash, orgId],
  );
  if (!row) return null;
  const { stale, orgRequiresPasskey, ...user } = row;
  if (stale) {
    await q(
      `UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => $2) WHERE token_hash = $1`,
      [hash, SESSION_DAYS],
    );
  }
  return { user, renew: stale ? token : null, orgLocked: !!orgRequiresPasskey && !user.strong };
}

// ---------- eenmalige links (uitnodiging / wachtwoord-reset) ----------

export async function createUserToken(userId: string, purpose: "invite" | "reset", createdBy: string | null) {
  const token = newToken();
  const days = purpose === "invite" ? 14 : 2;
  // Oude, ongebruikte links van deze gebruiker vervallen.
  await q(`DELETE FROM user_tokens WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  await q(
    `INSERT INTO user_tokens (token_hash, user_id, purpose, created_by, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [sha256(token), userId, purpose, createdBy, days],
  );
  return { token, purpose, validDays: days };
}
