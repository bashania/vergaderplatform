import { randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { q, q1 } from "./db";
import { bad, env, HttpError, optStr } from "./http";

/**
 * Passkeys (WebAuthn).
 *
 * Een passkey is gebonden aan het domein waarop hij is aangemaakt (de "RP ID").
 * Standaard is dat de hostnaam van de site. Verhuist het platform naar een eigen
 * domein, zet dan RP_ID vóórdat mensen passkeys aanmaken: passkeys van het oude
 * domein werken op het nieuwe niet.
 */
const RP_NAME = "Vergaderplatform";
const CHALLENGE_MINUTES = 5;

const rp = (url: URL) => ({ id: env("RP_ID") ?? url.hostname, origin: url.origin });

const INVALID = "De passkey kon niet worden gecontroleerd. Probeer het opnieuw.";

async function saveChallenge(challenge: string, kind: "register" | "login", userId: string | null): Promise<string> {
  const id = randomUUID();
  await q(`DELETE FROM webauthn_challenges WHERE expires_at < now()`);
  await q(
    `INSERT INTO webauthn_challenges (id, challenge, kind, user_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
    [id, challenge, kind, userId, CHALLENGE_MINUTES],
  );
  return id;
}

/** Haalt de uitdaging op en verbruikt haar: elke uitdaging werkt precies één keer. */
async function takeChallenge(rawId: unknown, kind: "register" | "login", userId: string | null): Promise<string> {
  if (typeof rawId !== "string" || !/^[0-9a-f-]{36}$/i.test(rawId)) throw bad(INVALID);
  const row = await q1<{ challenge: string }>(
    `DELETE FROM webauthn_challenges
      WHERE id = $1 AND kind = $2 AND expires_at > now() AND user_id IS NOT DISTINCT FROM $3::uuid
      RETURNING challenge`,
    [rawId, kind, userId],
  );
  if (!row) throw bad("De aanvraag is verlopen. Probeer het opnieuw.");
  return row.challenge;
}

// ---------- registreren ----------

export async function registrationOptions(url: URL, user: { id: string; email: string; name: string }) {
  const existing = await q<{ id: string; transports: string }>(`SELECT id, transports FROM passkeys WHERE user_id = $1`, [user.id]);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp(url).id,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    // Voorkomt een tweede passkey op hetzelfde apparaat.
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ? p.transports.split(",") : undefined })),
    // Vindbaar zonder gebruikersnaam, en altijd met vingerafdruk, gezicht of pincode.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  return { challengeId: await saveChallenge(options.challenge, "register", user.id), options };
}

export type NewPasskey = { id: string; publicKey: string; counter: number; transports: string; name: string };

/** Controleert het antwoord van de browser. Slaat nog niets op. */
export async function verifyRegistration(url: URL, userId: string, body: Record<string, unknown>): Promise<NewPasskey> {
  const expectedChallenge = await takeChallenge(body.challengeId, "register", userId);
  const name = optStr(body.name, "Naam", 60) || "Passkey";
  let result;
  try {
    result = await verifyRegistrationResponse({
      response: body.response as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: rp(url).origin,
      expectedRPID: rp(url).id,
      requireUserVerification: true,
    });
  } catch (e) {
    console.error("passkey registratie", e);
    throw bad(INVALID);
  }
  if (!result.verified) throw bad(INVALID);
  const { credential } = result.registrationInfo;
  return {
    id: credential.id,
    publicKey: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    transports: (credential.transports ?? []).join(","),
    name,
  };
}

export async function storePasskey(userId: string, p: NewPasskey): Promise<void> {
  const stored = await q(
    `INSERT INTO passkeys (id, user_id, public_key, counter, transports, name) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [p.id, userId, p.publicKey, p.counter, p.transports, p.name],
  );
  if (!stored.length) throw new HttpError(409, "Deze passkey is al geregistreerd.");
}

// ---------- inloggen ----------

export async function loginOptions(url: URL) {
  // Geen lijst met toegestane passkeys: de passkey zelf bepaalt welk account inlogt.
  const options = await generateAuthenticationOptions({ rpID: rp(url).id, userVerification: "required" });
  return { challengeId: await saveChallenge(options.challenge, "login", null), options };
}

/** Controleert een inlogpoging met een passkey en geeft de gebruiker terug. */
export async function verifyLogin(url: URL, body: Record<string, unknown>): Promise<{ userId: string }> {
  const expectedChallenge = await takeChallenge(body.challengeId, "login", null);
  const response = body.response as AuthenticationResponseJSON;
  if (!response || typeof response.id !== "string") throw bad(INVALID);
  const pk = await q1<{ id: string; userId: string; publicKey: string; counter: string; transports: string }>(
    `SELECT p.id, p.user_id, p.public_key, p.counter::text AS counter, p.transports
       FROM passkeys p JOIN users u ON u.id = p.user_id
      WHERE p.id = $1 AND u.active`,
    [response.id],
  );
  if (!pk) throw new HttpError(401, "Deze passkey hoort niet (meer) bij een account op dit platform.");
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp(url).origin,
      expectedRPID: rp(url).id,
      credential: {
        id: pk.id,
        publicKey: isoBase64URL.toBuffer(pk.publicKey),
        counter: Number(pk.counter),
        transports: pk.transports ? (pk.transports.split(",") as never) : undefined,
      },
      requireUserVerification: true,
    });
  } catch (e) {
    console.error("passkey login", e);
    throw new HttpError(401, INVALID);
  }
  if (!result.verified) throw new HttpError(401, INVALID);
  await q(`UPDATE passkeys SET counter = $2, last_used_at = now() WHERE id = $1`, [pk.id, result.authenticationInfo.newCounter]);
  return { userId: pk.userId };
}
