import { useEffect, useMemo, useRef, useState } from "react";
import { PdfView } from "./PdfView";

export type StageDoc = { id: string; name: string; mime: string; size: number };

const isPdf = (d: { mime: string; name: string }) => d.mime === "application/pdf" || /\.pdf$/i.test(d.name);
const isImage = (d: { mime: string }) => /^image\/(png|jpeg|gif|webp)$/.test(d.mime);

/** Een pdf of afbeelding kan op het scherm; andere bestanden (Word, Excel) opent ieder zelf. */
export const canStage = (d: { mime: string; name: string }) => isPdf(d) || isImage(d);

// Wisselen tussen agenda en stuk hoeft het bestand niet opnieuw op te halen.
const cache = new Map<string, Uint8Array>();

async function load(doc: StageDoc, chunkUrl: (n: number) => string, onProgress: (fraction: number) => void): Promise<Uint8Array> {
  const hit = cache.get(doc.id);
  if (hit) return hit;
  const parts: Uint8Array[] = [];
  let received = 0;
  for (let n = 0; received < doc.size; n++) {
    const res = await fetch(chunkUrl(n), { credentials: "same-origin" });
    if (!res.ok) throw new Error(res.status === 404 ? "Dit stuk staat niet meer op het scherm." : "Het stuk kon niet worden opgehaald.");
    const part = new Uint8Array(await res.arrayBuffer());
    if (!part.length) throw new Error("Het bestand is onvolledig.");
    parts.push(part);
    received += part.length;
    onProgress(Math.min(1, received / doc.size));
  }
  const all = new Uint8Array(received);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  if (cache.size >= 3) cache.delete(cache.keys().next().value as string);
  cache.set(doc.id, all);
  return all;
}

/**
 * Vangnet als de pdf hier niet te tekenen is (een oudere browser, een beschadigd bestand): een gewone
 * koppeling naar het bestand, dat al is opgehaald. Openen in de pdf-lezer van het toestel geeft dus geen
 * extra toegang. Een koppeling in plaats van een venster dat via script opent: dat laatste houden
 * telefoons vaak tegen.
 */
function OpenOwn({ data }: { data: Uint8Array }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([data as BlobPart], { type: "application/pdf" })), [data]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <>
      <p>Dit toestel kan de pdf niet in het scherm tonen.</p>
      <a className="btn secondary" href={url} target="_blank" rel="noopener">
        Open het stuk in je eigen pdf-lezer
      </a>
    </>
  );
}

/**
 * Het stuk dat op het scherm staat. `chunkUrl` bepaalt waar de delen vandaan komen: voor wie is
 * ingelogd het gewone adres van het stuk, voor een meekijker het adres dat alleen het getoonde stuk geeft.
 */
export function DocStage({
  doc,
  page,
  chunkUrl,
  onPages,
  tall,
}: {
  doc: StageDoc;
  page: number;
  chunkUrl: (n: number) => string;
  onPages?: (pages: number) => void;
  /** Vult de hele beschikbare hoogte (presentatiescherm) in plaats van een vak in de pagina. */
  tall?: boolean;
}) {
  const [state, setState] = useState<{ data?: Uint8Array; progress: number; error?: string }>({ progress: 0 });
  const [fit, setFit] = useState<"page" | "width">(() => (window.innerWidth < 700 ? "width" : "page"));
  const url = useRef(chunkUrl);
  url.current = chunkUrl;

  useEffect(() => {
    let gone = false;
    setState({ progress: 0 });
    load(doc, (n) => url.current(n), (progress) => !gone && setState((s) => ({ ...s, progress })))
      .then((data) => !gone && setState({ data, progress: 1 }))
      .catch((e) => !gone && setState({ progress: 0, error: e instanceof Error ? e.message : "Het stuk kon niet worden getoond." }));
    return () => {
      gone = true;
    };
    // Alleen opnieuw ophalen als er een ander stuk op het scherm komt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.size]);

  const pdf = isPdf(doc);
  const image = useMemo(() => (state.data && !pdf && isImage(doc) ? URL.createObjectURL(new Blob([state.data as BlobPart], { type: doc.mime })) : null), [state.data, pdf, doc]);
  useEffect(() => () => void (image && URL.revokeObjectURL(image)), [image]);
  useEffect(() => {
    if (state.data && !pdf) onPages?.(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.data, pdf]);

  return (
    <div className={`stage fit-${fit}${tall ? " tall" : ""}`}>
      {state.error ? (
        <div className="stage-msg">{state.error}</div>
      ) : !state.data ? (
        <div className="stage-msg">Stuk ophalen… {Math.round(state.progress * 100)}%</div>
      ) : pdf ? (
        <PdfView
          data={state.data}
          page={page}
          fit={fit}
          onPages={onPages}
          fallback={<OpenOwn data={state.data} />}
        />
      ) : image ? (
        <img src={image} alt={doc.name} />
      ) : (
        <div className="stage-msg">Dit bestandstype kan niet op het scherm worden getoond.</div>
      )}
      {state.data && !state.error && (
        <button type="button" className="stage-fit" onClick={() => setFit(fit === "page" ? "width" : "page")}>
          {fit === "page" ? "Vul de breedte" : "Hele pagina"}
        </button>
      )}
    </div>
  );
}
