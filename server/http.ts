export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export const bad = (message: string) => new HttpError(400, message);
export const forbidden = (message = "Je hebt hier geen rechten voor.") => new HttpError(403, message);
export const notFound = (message = "Niet gevonden.") => new HttpError(404, message);

export function env(key: string): string | undefined {
  const g = globalThis as { Netlify?: { env: { get(k: string): string | undefined } } };
  return g.Netlify?.env.get(key) ?? process.env[key];
}

// ---------- invoervalidatie ----------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function str(v: unknown, field: string, opts: { min?: number; max?: number } = {}): string {
  const { min = 1, max = 300 } = opts;
  if (typeof v !== "string") throw bad(`${field} ontbreekt.`);
  const s = v.trim();
  if (s.length < min) throw bad(`${field} is verplicht.`);
  if (s.length > max) throw bad(`${field} is te lang (maximaal ${max} tekens).`);
  return s;
}

export function optStr(v: unknown, field: string, max = 300): string {
  if (v === undefined || v === null) return "";
  return str(v, field, { min: 0, max });
}

export function uuid(v: unknown, field: string): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw bad(`${field} is ongeldig.`);
  return v.toLowerCase();
}

export function optUuid(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  return uuid(v, field);
}

export function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) throw bad(`${field} is ongeldig.`);
  return v as T;
}

export function int(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw bad(`${field} moet een geheel getal zijn tussen ${min} en ${max}.`);
  }
  return n;
}

export function optInt(v: unknown, field: string, min: number, max: number): number | null {
  if (v === undefined || v === null || v === "") return null;
  return int(v, field, min, max);
}

export function dateOnly(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw bad(`${field} is geen geldige datum.`);
  }
  return v;
}

export function optDateOnly(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  return dateOnly(v, field);
}

export function dateTime(v: unknown, field: string): string {
  if (typeof v !== "string") throw bad(`${field} ontbreekt.`);
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw bad(`${field} is geen geldig tijdstip.`);
  return new Date(t).toISOString();
}

export function email(v: unknown): string {
  const s = str(v, "E-mailadres", { max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad("E-mailadres is ongeldig.");
  return s;
}

export function httpUrl(v: unknown, field: string): string {
  const s = optStr(v, field, 500);
  if (!s) return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad(`${field} is geen geldige link (begin met https://).`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw bad(`${field} moet met https:// beginnen.`);
  return u.toString();
}
