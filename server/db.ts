import { getDatabase } from "@netlify/database";

// Eén client per functie-instantie (module-scope), nooit per request.
let client: ReturnType<typeof getDatabase> | undefined;
const db = () => (client ??= getDatabase());

const camelKey = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** snake_case-kolommen → camelCase, ook in geneste json-resultaten. */
function camel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camel);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[camelKey(k)] = camel(v);
    return out;
  }
  return value;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const rows = await db().sql.unsafe(text, params as any[]);
  return camel(rows) as T[];
}

export async function q1<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  return (await q<T>(text, params))[0] ?? null;
}

/** Hostnaam van de database (zonder inloggegevens), voor de diagnosepagina. */
export function dbHost(): string {
  try {
    return new URL(db().connectionString).hostname;
  } catch {
    return "onbekend";
  }
}
