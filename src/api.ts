import type { Doc } from "./lib";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Options = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown };

/** De organisatie waarin de gebruiker werkt; gaat mee met elk verzoek zodat overzichten daarop filteren. */
let organisationId: string | null = null;
export function setApiOrganisation(id: string | null) {
  organisationId = id;
}

export async function api<T = unknown>(path: string, { method = "GET", body }: Options = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(organisationId ? { "x-organisation": organisationId } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Geen verbinding met de server. Controleer je internetverbinding.");
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) {
    // Sessie verlopen: terug naar het inlogscherm (niet bij de inlogpoging zelf).
    if (res.status === 401 && !path.startsWith("/api/login")) window.dispatchEvent(new Event("vp:unauthorized"));
    throw new ApiError(res.status, data?.error ?? "Er ging iets mis. Probeer het opnieuw.");
  }
  return data as T;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : "Er ging iets mis.");

// ---------- stukken ----------

/** Moet gelijk zijn aan MAX_FILE_SIZE en MAX_STREAM_SIZE in server/files.ts. */
export const MAX_FILE_SIZE = 100 * 1024 * 1024;
const DIRECT_LIMIT = 18 * 1024 * 1024;

export const canOpenDirect = (doc: Pick<Doc, "size">) => doc.size <= DIRECT_LIMIT;
export const fileUrl = (doc: Pick<Doc, "id">, download = false) => `/api/documents/${doc.id}/file${download ? "?download=1" : ""}`;

export type UploadTarget = { meetingId?: string; overlegId?: string; agendaItemId?: string | null };

async function sendChunk(id: string, n: number, part: Blob): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`/api/documents/${id}/chunks/${n}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/octet-stream" },
        body: part,
      });
      if (res.ok) return;
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      lastError = new ApiError(res.status, data?.error ?? "Uploaden is mislukt.");
      if (res.status < 500) break;
    } catch {
      lastError = new ApiError(0, "De verbinding viel weg tijdens het uploaden.");
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw lastError;
}

/** Uploadt een bestand in delen; grote bestanden passen niet in één request. */
export async function uploadFile(file: File, target: UploadTarget, onProgress?: (fraction: number) => void): Promise<void> {
  if (file.size === 0) throw new ApiError(400, `"${file.name}" is leeg.`);
  if (file.size > MAX_FILE_SIZE) throw new ApiError(400, `"${file.name}" is groter dan 100 MB.`);
  const { id, chunkSize, chunkCount } = await api<{ id: string; chunkSize: number; chunkCount: number }>("/api/documents", {
    method: "POST",
    body: { ...target, name: file.name, mime: file.type, size: file.size },
  });
  for (let n = 0; n < chunkCount; n++) {
    await sendChunk(id, n, file.slice(n * chunkSize, Math.min(file.size, (n + 1) * chunkSize)));
    onProgress?.((n + 1) / chunkCount);
  }
  await api(`/api/documents/${id}/complete`, { method: "POST" });
}

/** Groot bestand: delen ophalen, in de browser samenvoegen en als download aanbieden. */
export async function downloadInParts(doc: Pick<Doc, "id" | "name" | "size" | "mime">, onProgress?: (fraction: number) => void) {
  const parts: Blob[] = [];
  let received = 0;
  for (let n = 0; received < doc.size; n++) {
    const res = await fetch(`/api/documents/${doc.id}/chunks/${n}`, { credentials: "same-origin" });
    if (!res.ok) throw new ApiError(res.status, "Downloaden is mislukt. Probeer het opnieuw.");
    const part = await res.blob();
    if (part.size === 0) throw new ApiError(500, "Het bestand is onvolledig.");
    parts.push(part);
    received += part.size;
    onProgress?.(Math.min(1, received / doc.size));
  }
  saveBlob(new Blob(parts, { type: "application/octet-stream" }), doc.name);
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
