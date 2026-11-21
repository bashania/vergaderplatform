import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env, HttpError } from "./http";

/**
 * Versleuteling van gevoelige gegevens die het platform zelf moet kunnen teruglezen
 * (toegang tot Plaud, het wachtwoord van de mailserver). AES-256-GCM met de sleutel uit TOKEN_KEY.
 * Zonder die sleutel slaan we zulke gegevens niet op.
 */

export const hasSecretKey = () => !!env("TOKEN_KEY");

function key(): Buffer {
  const secret = env("TOKEN_KEY");
  if (!secret) throw new HttpError(503, "Dit onderdeel is op dit platform niet ingericht (de versleutelingssleutel ontbreekt).");
  return createHash("sha256").update(secret).digest();
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function open(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || data === undefined) throw new Error("onbekend formaat");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** Sleutel voor interne taken (de dagelijkse herinneringen): afgeleid, zodat TOKEN_KEY zelf nergens heen gaat. */
export const taskKey = (name: string) => createHash("sha256").update(`${name}:${env("TOKEN_KEY") ?? ""}`).digest("hex");

/**
 * Handtekening onder gegevens in een link (aan- of afmelden vanuit de mail): wie de link heeft,
 * kan precies dat ene doen, zonder in te loggen. Per doel een eigen afgeleide sleutel.
 */
export function sign(purpose: string, data: string): string {
  return createHmac("sha256", taskKey(purpose)).update(data).digest("base64url").slice(0, 32);
}

export function verify(purpose: string, data: string, signature: string): boolean {
  const expected = Buffer.from(sign(purpose, data));
  const given = Buffer.from(signature);
  return hasSecretKey() && expected.length === given.length && timingSafeEqual(expected, given);
}
