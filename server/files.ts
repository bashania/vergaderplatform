import { getStore } from "@netlify/blobs";
import { env } from "./http";

/**
 * Stukken staan in delen (chunks) in Netlify Blobs: Netlify Functions accepteren
 * maximaal ~4,5 MB binaire data per request, dus grotere bestanden gaan in stukken.
 *
 * LET OP: de regio moet bij elke aanroep gelijk zijn. Een andere regio "ziet" de
 * bestaande bestanden niet en verplaatst ze ook niet.
 */
export const CHUNK_SIZE = 3_500_000;
export const MAX_FILE_SIZE = 100 * 1024 * 1024;
/** Tot deze grootte streamt de server het bestand in één keer (limiet Netlify: 20 MB). */
export const MAX_STREAM_SIZE = 18 * 1024 * 1024;

type Region = NonNullable<Exclude<Parameters<typeof getStore>[0], string>["region"]>;

let deployContext = "production";

/** Door de router gezet bij elk request: "production", "deploy-preview", "branch-deploy" of "dev". */
export function setDeployContext(context: string | undefined) {
  deployContext = context || "production";
}

/**
 * Site-brede Blobs-stores zijn gedeeld over alle deploy-contexten. Previews en lokaal
 * krijgen daarom een eigen store, zodat testen nooit productiestukken raakt.
 */
export function store() {
  const region = (env("BLOB_REGION") ?? "eu-central-1") as Region;
  const name = deployContext === "production" ? "stukken" : `stukken-${deployContext}`;
  return getStore({ name, consistency: "strong", region });
}

export const chunkKey = (docId: string, n: number) => `${docId}/${String(n).padStart(5, "0")}`;

export async function deleteDocumentBlobs(docId: string): Promise<void> {
  const s = store();
  const { blobs } = await s.list({ prefix: `${docId}/` });
  await Promise.all(blobs.map((b) => s.delete(b.key)));
}

/** Types die de browser direct mag tonen. Al het andere wordt als download aangeboden (geen HTML/SVG inline). */
const INLINE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"]);

export function fileHeaders(name: string, mime: string, size: number, forceDownload: boolean): Headers {
  const inline = INLINE_TYPES.has(mime) && !forceDownload;
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Headers({
    "content-type": inline ? (mime === "text/plain" ? "text/plain; charset=utf-8" : mime) : "application/octet-stream",
    "content-length": String(size),
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  });
}
