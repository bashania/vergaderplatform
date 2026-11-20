import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { q, q1 } from "./db";
import { currentDeployContext } from "./files";
import { env, HttpError } from "./http";
import { hasSecretKey, open, seal } from "./secret";

/**
 * Koppeling met Plaud (opnameapparaat met transcriptie), via de officiële MCP-server van Plaud.
 *
 * - Inloggen: de standaard van MCP (OAuth 2.1 met PKCE). Het platform meldt zich één keer per webadres
 *   aan als toepassing (dynamic client registration) en bewaart die aanmelding in `settings`.
 * - Per gebruiker: wie koppelt, geeft het platform leestoegang tot zijn eigen opnames. De sleutels staan
 *   versleuteld in de database en verlaten de server niet.
 * - Lezen: de gereedschappen `list_files` en `get_transcript` van de MCP-server. Het platform schrijft niets naar Plaud.
 */

const PLAUD_MCP_URL = "https://mcp.plaud.ai/mcp";

/** Alleen lokaal is de server te vervangen door een nagebouwde (scripts/fake-plaud.mjs), voor de tests. */
const mcpUrl = () => (currentDeployContext() === "dev" && env("PLAUD_MCP_URL")) || PLAUD_MCP_URL;

export const plaudAvailable = hasSecretKey;

// ---------- inloggen bij Plaud (OAuth met PKCE) ----------

type Endpoints = { authorize: string; token: string; register: string };
let endpoints: { url: string; value: Endpoints } | null = null;

async function getJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !data) {
    const detail = data && typeof data.error === "string" ? `${data.error}${data.error_description ? `: ${String(data.error_description)}` : ""}` : `status ${res.status}`;
    throw Object.assign(new Error(`Plaud ${new URL(url).pathname}: ${detail}`), { oauthError: data?.error });
  }
  return data;
}

/** Zoekt op waar je bij Plaud inlogt, volgens de MCP-standaard: eerst de server zelf, dan de inlogserver. */
async function discover(): Promise<Endpoints> {
  const url = mcpUrl();
  if (endpoints?.url === url) return endpoints.value;
  const origin = new URL(url).origin;
  const resource = await getJson(`${origin}/.well-known/oauth-protected-resource`);
  const servers = resource.authorization_servers;
  const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0].replace(/\/$/, "") : origin;
  const meta = await getJson(`${issuer}/.well-known/oauth-authorization-server`);
  const value = { authorize: String(meta.authorization_endpoint ?? ""), token: String(meta.token_endpoint ?? ""), register: String(meta.registration_endpoint ?? "") };
  // Lokaal draait de nagebouwde server op http; daarbuiten is alleen https goed.
  const safe = (u: string) => u.startsWith("https://") || (currentDeployContext() === "dev" && u.startsWith("http://localhost"));
  if (![value.authorize, value.token, value.register].every(safe)) throw new Error("Plaud: onverwachte inloggegevens van de server");
  endpoints = { url, value };
  return value;
}

/** De aanmelding van dit platform bij Plaud, per terugkeeradres (verandert als het platform verhuist). */
async function clientId(redirectUri: string): Promise<string> {
  const settingsKey = `plaud.client:${mcpUrl()}:${redirectUri}`;
  const known = await q1<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [settingsKey]);
  if (known) return known.value;
  const { register } = await discover();
  const created = await getJson(register, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Vergaderplatform",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Geen eigen geheim: de inlogpoging is beveiligd met PKCE, er hoeft dus niets extra bewaard te worden.
      token_endpoint_auth_method: "none",
    }),
  });
  const id = typeof created.client_id === "string" ? created.client_id : "";
  if (!id) throw new Error("Plaud: aanmelden als toepassing gaf geen client_id");
  await q(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [settingsKey, id]);
  return id;
}

/** Begin van het koppelen: geeft het adres bij Plaud waar de gebruiker toestemming geeft. */
export async function startConnect(userId: string, redirectUri: string): Promise<string> {
  seal("proef"); // Zonder versleutelingssleutel beginnen we er niet aan.
  const [{ authorize }, id] = await Promise.all([discover(), clientId(redirectUri)]);
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  await q(`DELETE FROM oauth_states WHERE created_at < now() - interval '1 hour'`);
  await q(`INSERT INTO oauth_states (state, user_id, code_verifier, redirect_uri) VALUES ($1, $2, $3, $4)`, [state, userId, verifier, redirectUri]);
  const url = new URL(authorize);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: id,
    redirect_uri: redirectUri,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: mcpUrl(),
  }).toString();
  return url.toString();
}

type Tokens = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
  const { token } = await discover();
  return getJson(token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...params, resource: mcpUrl() }).toString(),
  });
}

async function store(userId: string, t: Tokens, previousRefresh = ""): Promise<string> {
  const access = typeof t.access_token === "string" ? t.access_token : "";
  if (!access) throw new Error("Plaud: geen toegangssleutel ontvangen");
  // Een inlogserver mag de verversingssleutel bij elk gebruik vervangen; anders blijft de oude gelden.
  const refresh = typeof t.refresh_token === "string" && t.refresh_token ? t.refresh_token : previousRefresh;
  const seconds = typeof t.expires_in === "number" && t.expires_in > 0 ? t.expires_in : null;
  await q(
    `INSERT INTO plaud_connections (user_id, access_token, refresh_token, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4::int))
     ON CONFLICT (user_id) DO UPDATE SET access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, expires_at = EXCLUDED.expires_at`,
    [userId, seal(access), refresh ? seal(refresh) : "", seconds],
  );
  return access;
}

/** Einde van het koppelen: de code uit de terugkeer omwisselen voor sleutels. Geeft false als de poging niet (meer) klopt. */
export async function finishConnect(userId: string, state: string, code: string): Promise<boolean> {
  const row = await q1<{ codeVerifier: string; redirectUri: string }>(
    `DELETE FROM oauth_states WHERE state = $1 AND user_id = $2 AND created_at > now() - interval '15 minutes' RETURNING code_verifier, redirect_uri`,
    [state, userId],
  );
  if (!row) return false;
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: row.redirectUri,
    client_id: await clientId(row.redirectUri),
    code_verifier: row.codeVerifier,
  });
  await store(userId, tokens);
  return true;
}

export async function disconnect(userId: string): Promise<void> {
  await q(`DELETE FROM plaud_connections WHERE user_id = $1`, [userId]);
}

export function connection(userId: string) {
  return q1<{ connectedAt: string }>(`SELECT connected_at FROM plaud_connections WHERE user_id = $1`, [userId]);
}

const expired = () => new HttpError(409, "De koppeling met Plaud is verlopen. Koppel Plaud opnieuw onder Mijn account.", { code: "plaud_reconnect" });

/** Geldige toegangssleutel van de gebruiker; ververst hem als hij (bijna) verlopen is of als `force` is gezet. */
async function accessToken(userId: string, redirectUri: string, force = false): Promise<string> {
  const row = await q1<{ accessToken: string; refreshToken: string; stale: boolean }>(
    `SELECT access_token, refresh_token, (expires_at IS NOT NULL AND expires_at < now() + interval '1 minute') AS stale
       FROM plaud_connections WHERE user_id = $1`,
    [userId],
  );
  if (!row) throw new HttpError(409, "Koppel eerst je Plaud-account onder Mijn account.", { code: "plaud_reconnect" });
  let access: string;
  let refresh: string;
  try {
    access = open(row.accessToken);
    refresh = row.refreshToken ? open(row.refreshToken) : "";
  } catch {
    // Sleutel gewijzigd of gegevens beschadigd: opnieuw koppelen is de enige weg.
    await disconnect(userId);
    throw expired();
  }
  if (!force && !row.stale) return access;
  if (!refresh) {
    if (!force) return access;
    await disconnect(userId);
    throw expired();
  }
  try {
    return await store(userId, await tokenRequest({ grant_type: "refresh_token", refresh_token: refresh, client_id: await clientId(redirectUri) }), refresh);
  } catch (e) {
    // Toestemming ingetrokken of te lang niet gebruikt: de koppeling is weg. Bij een storing blijft ze staan.
    if ((e as { oauthError?: unknown }).oauthError === "invalid_grant") {
      await disconnect(userId);
      throw expired();
    }
    throw e;
  }
}

// ---------- lezen via de MCP-server ----------

type Call = (name: string, args: Record<string, unknown>) => Promise<string>;

/** Een antwoord van Plaud is tekst met de gegevens als JSON in een omhulsel; hier komt de JSON eruit. */
function payload(text: string): unknown {
  // De inleidende zin noemt de naam van het omhulsel ook al; de gegevens staan tussen de laatste
  // openingstag en de sluittag.
  const close = /<\/(untrusted-user-data-[0-9a-f]+)>/.exec(text);
  let body = text;
  if (close) {
    const open = text.lastIndexOf(`<${close[1]}`, close.index);
    body = text.slice(open >= 0 ? text.indexOf(">", open) + 1 : 0, close.index);
  }
  try {
    return JSON.parse(body.trim());
  } catch {
    return null;
  }
}

async function session<T>(token: string, work: (call: Call) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl()), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "vergaderplatform", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: 15_000 });
    return await work(async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 25_000 });
      const parts = Array.isArray(result.content) ? (result.content as { type?: string; text?: string }[]) : [];
      const text = parts.map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : "")).join("\n");
      if (result.isError) throw new HttpError(502, `Plaud meldt een fout: ${text.slice(0, 200) || "onbekend"}`);
      return text;
    });
  } finally {
    await client.close().catch(() => {});
  }
}

const isUnauthorized = (e: unknown) => e instanceof Error && (e.name === "UnauthorizedError" || /\b401\b|unauthorized|invalid_token/i.test(e.message));

/** Voert werk uit met de sleutel van de gebruiker; wordt die geweigerd, dan één keer verversen en opnieuw. */
async function withPlaud<T>(userId: string, redirectUri: string, work: (call: Call) => Promise<T>): Promise<T> {
  try {
    return await session(await accessToken(userId, redirectUri), work);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (isUnauthorized(e)) return session(await accessToken(userId, redirectUri, true), work);
    console.error("plaud", e instanceof Error ? e.message : e);
    throw new HttpError(502, "Plaud is niet bereikbaar. Probeer het over een minuut opnieuw.");
  }
}

function toIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e11 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && v) {
    const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
    if (!Number.isNaN(t)) return toIso(t);
  }
  return null;
}

export type Recording = { id: string; name: string; startAt: string | null; durationMin: number | null };

/** Opnames in een periode (datums als JJJJ-MM-DD, grenzen inbegrepen). */
export function listRecordings(userId: string, redirectUri: string, from: string, to: string): Promise<Recording[]> {
  return withPlaud(userId, redirectUri, async (call) => {
    const data = payload(await call("list_files", { date_from: from, date_to: to, page: 1, page_size: 50 }));
    const rows = Array.isArray(data) ? data : ((data as { data?: unknown } | null)?.data ?? []);
    if (!Array.isArray(rows)) return [];
    return (rows as Record<string, unknown>[])
      .filter((r) => r && (typeof r.id === "string" || typeof r.id === "number"))
      .map((r) => ({
        id: String(r.id),
        name: typeof r.name === "string" && r.name ? r.name.slice(0, 200) : "Opname zonder naam",
        startAt: toIso(r.start_at) ?? toIso(r.created_at),
        durationMin: typeof r.duration === "number" && r.duration > 0 ? Math.max(1, Math.round(r.duration / 60_000)) : null,
      }));
  });
}

const pick = (o: Record<string, unknown>, keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null && v !== "");

function clock(v: unknown): string {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  if (Number.isNaN(n)) return typeof v === "string" ? v.slice(0, 12) : "";
  // Plaud geeft tijden in milliseconden; een klein getal is in seconden.
  const s = Math.floor(n > 100_000 ? n / 1000 : n);
  const two = (x: number) => String(x).padStart(2, "0");
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

/** Eén uiting als leesbare regel: [tijd] Spreker: tekst. De veldnamen van Plaud zijn niet gedocumenteerd, vandaar de varianten. */
function line(segment: unknown): string {
  if (typeof segment === "string") return segment.trim();
  if (!segment || typeof segment !== "object") return "";
  const s = segment as Record<string, unknown>;
  const text = pick(s, ["content", "text", "sentence", "transcript"]);
  if (typeof text !== "string" || !text.trim()) return "";
  const speaker = pick(s, ["speaker", "speaker_name", "original_speaker", "name"]);
  const time = clock(pick(s, ["start_time", "start", "begin_time", "startTime", "start_ms"]));
  return `${time ? `[${time}] ` : ""}${typeof speaker === "string" && speaker ? `${speaker}: ` : ""}${text.trim()}`;
}

/** Het volledige transcript van één opname, als tekst met sprekers en tijden. */
export function getTranscript(userId: string, redirectUri: string, fileId: string): Promise<string> {
  return withPlaud(userId, redirectUri, async (call) => {
    const lines: string[] = [];
    let cursor: string | undefined;
    // Plaud levert het transcript in delen; 60 delen van 500 uitingen dekt ook een hele vergaderdag.
    for (let page = 0; page < 60; page++) {
      const raw = await call("get_transcript", { file_id: fileId, limit: 500, ...(cursor ? { cursor } : {}) });
      const data = payload(raw) as { segments?: unknown; next_cursor?: unknown } | unknown[] | null;
      const segments = Array.isArray(data) ? data : data?.segments;
      if (!Array.isArray(segments)) {
        if (page === 0) break;
        throw new HttpError(502, "Plaud gaf het transcript in een onverwachte vorm. Plak het transcript anders als tekst.");
      }
      if (page === 0 && segments[0] && typeof segments[0] === "object") console.log("plaud transcript: velden", Object.keys(segments[0] as object).join(","));
      for (const s of segments) {
        const l = line(s);
        if (l) lines.push(l);
      }
      cursor = !Array.isArray(data) && typeof data?.next_cursor === "string" ? data.next_cursor : undefined;
      if (!cursor) break;
    }
    if (!lines.length) {
      throw new HttpError(409, "Voor deze opname staat in Plaud nog geen transcript klaar. Laat Plaud de opname eerst uitschrijven.");
    }
    return lines.join("\n");
  });
}
