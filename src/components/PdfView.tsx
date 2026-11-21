import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";

type Lib = typeof import("pdfjs-dist");
let lib: Promise<Lib> | null = null;

/** De pdf-weergave wordt pas opgehaald als er een pdf op het scherm komt; de rest van het platform blijft licht. */
function pdfjs(): Promise<Lib> {
  lib ??= Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")])
    .then(([m, worker]) => {
      m.GlobalWorkerOptions.workerSrc = worker.default;
      return m as unknown as Lib;
    })
    .catch((e) => {
      // Mislukt ophalen (verbinding weg): de volgende keer opnieuw proberen.
      lib = null;
      throw e;
    });
  return lib;
}

/**
 * Eén pagina van een pdf, passend in de beschikbare ruimte. `fit` "page" toont de hele pagina,
 * "width" vult de breedte (dan scrolt het vak eromheen).
 */
export function PdfView({ data, page, fit, onPages }: { data: Uint8Array; page: number; fit: "page" | "width"; onPages?: (pages: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const report = useRef(onPages);
  report.current = onPages;

  useEffect(() => {
    let gone = false;
    // De laadtaak ruimt bij het sluiten ook het geopende document en de achtergrondtaak op.
    let task: { destroy: () => Promise<void> } | null = null;
    setPdf(null);
    setError(false);
    pdfjs()
      .then((m) => {
        // Een kopie: de gegevens verhuizen naar de achtergrondtaak en zijn daarna hier niet meer bruikbaar.
        const loading = m.getDocument({ data: data.slice(), useWasm: false, wasmUrl: "/pdfjs/wasm/", standardFontDataUrl: "/pdfjs/standard_fonts/" });
        task = loading;
        if (gone) void loading.destroy();
        return loading.promise;
      })
      .then((doc) => {
        if (gone) return;
        setPdf(doc);
        report.current?.(doc.numPages);
      })
      .catch((e) => {
        if (gone) return;
        console.error("pdf", e);
        setError(true);
      });
    return () => {
      gone = true;
      void task?.destroy().catch(() => {});
    };
  }, [data]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // De ruimte binnen de rand: zo blijft er rondom de pagina wat lucht.
    const observer = new ResizeObserver(([entry]) => setSize({ w: Math.floor(entry.contentRect.width), h: Math.floor(entry.contentRect.height) }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Eén tekenbeurt tegelijk op het doek; een verzoek dat intussen is achterhaald, wordt overgeslagen.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const wanted = useRef(0);
  useEffect(() => {
    if (!pdf || size.w < 40) return;
    const ticket = ++wanted.current;
    queue.current = queue.current
      .then(async () => {
        const target = canvas.current;
        if (ticket !== wanted.current || !target) return;
        const p = await pdf.getPage(Math.min(Math.max(1, page), pdf.numPages));
        const base = p.getViewport({ scale: 1 });
        const scale = fit === "width" ? size.w / base.width : Math.min(size.w / base.width, Math.max(120, size.h) / base.height);
        // Scherp op schermen met een hoge dichtheid, zonder een telefoon te laten zwoegen.
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = p.getViewport({ scale: scale * ratio });
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        target.style.width = `${Math.floor(viewport.width / ratio)}px`;
        target.style.height = `${Math.floor(viewport.height / ratio)}px`;
        await p.render({ canvas: target, viewport }).promise;
      })
      .catch((e) => console.error("pdf-pagina", e));
  }, [pdf, page, fit, size.w, size.h]);

  return (
    <div className="pdf-box" ref={box}>
      {error ? (
        <div className="stage-msg">Dit pdf-bestand kan niet worden getoond. Download het stuk om het te lezen.</div>
      ) : (
        <>
          {!pdf && <div className="stage-msg">Pdf openen…</div>}
          <canvas ref={canvas} hidden={!pdf} aria-label={`Pagina ${page}`} />
        </>
      )}
    </div>
  );
}
