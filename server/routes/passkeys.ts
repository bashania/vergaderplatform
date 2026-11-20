import { createSession, destroySession, sha256 } from "../auth";
import { q, q1 } from "../db";
import { bad, forbidden, HttpError, notFound, str, uuid } from "../http";
import { route } from "../router";
import { loginOptions, registrationOptions, storePasskey, verifyLogin, verifyRegistration } from "../webauthn";

const countPasskeys = async (userId: string) =>
  (await q1<{ n: number }>(`SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1`, [userId]))?.n ?? 0;

// ---------- inloggen met een passkey (zonder wachtwoord) ----------

route.post("/api/passkeys/login/options", async (c) => loginOptions(c.url), { public: true, audit: false });

route.post(
  "/api/passkeys/login",
  async (c) => {
    const { userId } = await verifyLogin(c.url, await c.body());
    await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
    c.setSession(await createSession(userId, "passkey"));
    const user = await q1(`SELECT id, email, name, is_admin FROM users WHERE id = $1`, [userId]);
    return { user };
  },
  { public: true, audit: false },
);

// ---------- eigen passkeys beheren ----------

route.get("/api/account/passkeys", async (c) => {
  const passkeys = await q(`SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = $1 ORDER BY created_at`, [c.user.id]);
  return { passkeys };
});

/**
 * Een extra passkey toevoegen mag alleen vanuit een passkey-sessie. Anders zou iemand
 * met alleen een buitgemaakt wachtwoord zijn eigen passkey aan het account kunnen hangen.
 * De eerste passkey kan wel vanuit een wachtwoordsessie: er is dan nog niets sterkers.
 */
async function assertMayAdd(userId: string, strong: boolean) {
  if (!strong && (await countPasskeys(userId)) > 0) {
    throw forbidden("Log eerst in met een bestaande passkey om er een toe te voegen.");
  }
}

route.post(
  "/api/account/passkeys/options",
  async (c) => {
    await assertMayAdd(c.user.id, c.user.strong);
    return registrationOptions(c.url, c.user);
  },
  { audit: false },
);

route.post("/api/account/passkeys", async (c) => {
  await assertMayAdd(c.user.id, c.user.strong);
  const passkey = await verifyRegistration(c.url, c.user.id, await c.body());
  await storePasskey(c.user.id, passkey);
  if (!c.user.strong) {
    // De gebruiker heeft zich zojuist met deze passkey geverifieerd: de sessie telt vanaf nu als passkey-sessie.
    await destroySession(c.req, c.url);
    c.setSession(await createSession(c.user.id, "passkey"));
  }
  return { id: passkey.id };
});

/** Verwijderen kan alleen vanuit een passkey-sessie, en nooit de laatste inlogmogelijkheid. */
route.delete("/api/account/passkeys/:id", async (c) => {
  if (!c.user.strong) throw forbidden("Log in met een passkey om passkeys te verwijderen.");
  const state = await q1<{ hasPassword: boolean; passkeys: number }>(
    `SELECT (password_hash IS NOT NULL) AS has_password,
            (SELECT count(*)::int FROM passkeys WHERE user_id = users.id) AS passkeys
       FROM users WHERE id = $1`,
    [c.user.id],
  );
  if (state && !state.hasPassword && state.passkeys <= 1) {
    throw new HttpError(409, "Dit is je enige manier om in te loggen. Voeg eerst een andere passkey toe of stel een wachtwoord in.");
  }
  const removed = await q(`DELETE FROM passkeys WHERE id = $1 AND user_id = $2 RETURNING id`, [c.params.id, c.user.id]);
  if (!removed.length) throw notFound("Passkey niet gevonden.");
  return { ok: true };
});

route.patch("/api/account/passkeys/:id", async (c) => {
  const name = str((await c.body()).name, "Naam", { max: 60 });
  const updated = await q(`UPDATE passkeys SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING id`, [c.params.id, c.user.id, name]);
  if (!updated.length) throw notFound("Passkey niet gevonden.");
  return { ok: true };
});

/** Wachtwoord verwijderen: daarna kan alleen nog met een passkey worden ingelogd. */
route.delete("/api/account/password", async (c) => {
  if (!c.user.strong) throw forbidden("Log in met een passkey om je wachtwoord te verwijderen.");
  if ((await countPasskeys(c.user.id)) === 0) throw bad("Maak eerst een passkey aan.");
  await q(`UPDATE users SET password_hash = NULL WHERE id = $1`, [c.user.id]);
  return { ok: true };
});

// ---------- uitnodiging accepteren met een passkey in plaats van een wachtwoord ----------

async function invitedUser(token: string) {
  const u = await q1<{ id: string; email: string; name: string; passkeys: number }>(
    `SELECT u.id, u.email, u.name, (SELECT count(*)::int FROM passkeys WHERE user_id = u.id) AS passkeys
       FROM user_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now() AND u.active`,
    [sha256(token)],
  );
  if (!u) throw notFound("Deze link is verlopen of al gebruikt. Vraag om een nieuwe link.");
  // Heeft het account al passkeys, dan is een link geen manier om er een bij te maken.
  if (u.passkeys > 0) throw forbidden("Dit account heeft al een passkey. Log daarmee in.");
  return u;
}

route.post(
  "/api/tokens/:token/passkey/options",
  async (c) => registrationOptions(c.url, await invitedUser(c.params.token)),
  { public: true, audit: false },
);

route.post(
  "/api/tokens/:token/passkey",
  async (c) => {
    const u = await invitedUser(c.params.token);
    const passkey = await verifyRegistration(c.url, u.id, await c.body());
    // Atomair claimen: de link werkt precies één keer.
    const claimed = await q(
      `UPDATE user_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
      [sha256(c.params.token)],
    );
    if (!claimed.length) throw notFound("Deze link is verlopen of al gebruikt. Vraag om een nieuwe link.");
    await storePasskey(u.id, passkey);
    await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [u.id]);
    await q(`DELETE FROM sessions WHERE user_id = $1`, [u.id]);
    c.setSession(await createSession(u.id, "passkey"));
    return { user: await q1(`SELECT id, email, name, is_admin FROM users WHERE id = $1`, [u.id]) };
  },
  { public: true, audit: false },
);

// ---------- platformbeheerder: herstel bij een verloren apparaat ----------

route.delete(
  "/api/users/:id/passkeys",
  async (c) => {
    const id = uuid(c.params.id, "Gebruiker");
    if (!(await q1(`SELECT 1 AS x FROM users WHERE id = $1`, [id]))) throw notFound("Gebruiker niet gevonden.");
    await q(`DELETE FROM passkeys WHERE user_id = $1`, [id]);
    await q(`DELETE FROM sessions WHERE user_id = $1`, [id]);
    return { ok: true };
  },
  { admin: true },
);
