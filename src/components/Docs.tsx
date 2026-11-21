import { useRef, useState, type ReactNode } from "react";
import { api, canOpenDirect, downloadInParts, errorText, fileUrl, uploadFile, type UploadTarget } from "../api";
import { fileExt, fmtDate, fmtSize, type Doc } from "../lib";
import { Button, Icon, useRun, useToast } from "../ui";
import { canSummarize, SummaryModal, useAi } from "./Ai";

function DocRow({ doc, canManage, onChanged, extra }: { doc: Doc; canManage: boolean; onChanged: () => void; extra?: ReactNode }) {
  const run = useRun();
  const toast = useToast();
  const [progress, setProgress] = useState<number | null>(null);
  const [summary, setSummary] = useState(false);
  const ai = useAi();
  const direct = canOpenDirect(doc);
  // Een bestaande samenvatting blijft leesbaar, ook als de assistent later is uitgezet.
  const showSummary = doc.hasSummary || (ai && canSummarize(doc));

  // Grote bestanden passen niet in één antwoord van de server: in delen ophalen.
  async function downloadLarge() {
    setProgress(0);
    try {
      await downloadInParts(doc, setProgress);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="doc">
      <span className="ext">{fileExt(doc.name)}</span>
      <div className="grow">
        {direct ? (
          <a className="name" href={fileUrl(doc)} target="_blank" rel="noopener">
            {doc.name}
          </a>
        ) : (
          <button className="name" onClick={downloadLarge} disabled={progress !== null}>
            {doc.name}
          </button>
        )}
        <div className="small muted">
          {fmtSize(doc.size)}
          {doc.uploadedByName ? ` · ${doc.uploadedByName}` : ""} · {fmtDate(doc.uploadedAt)}
        </div>
        {progress !== null && (
          <div className="progress" aria-label="Voortgang download">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>
      {extra}
      {showSummary && (
        <Button variant="ghost" small icon="spark" className="no-print" title="Samenvatting door de AI-assistent" aria-label="Samenvatting" onClick={() => setSummary(true)}>
          <span className="doc-label">Samenvatting</span>
        </Button>
      )}
      {direct ? (
        <a className="btn ghost icon no-print" href={fileUrl(doc, true)} aria-label={`Download ${doc.name}`} title="Downloaden">
          <Icon name="download" size={17} />
        </a>
      ) : (
        <Button variant="ghost" icon="download" className="no-print" aria-label={`Download ${doc.name}`} title="Downloaden" onClick={downloadLarge} />
      )}
      {canManage && (
        <Button
          variant="danger"
          icon="trash"
          className="no-print"
          aria-label={`Verwijder ${doc.name}`}
          title="Verwijderen"
          onClick={async () => {
            if (!window.confirm(`"${doc.name}" definitief verwijderen?`)) return;
            if (await run(() => api(`/api/documents/${doc.id}`, { method: "DELETE" }), "Stuk verwijderd")) onChanged();
          }}
        />
      )}
      {summary && <SummaryModal doc={doc} canRefresh={canManage} onClose={() => setSummary(false)} onChanged={onChanged} />}
    </div>
  );
}

export function DocList({
  docs,
  canManage,
  onChanged,
  extra,
}: {
  docs: Doc[];
  canManage: (d: Doc) => boolean;
  onChanged: () => void;
  /** Een extra knop per stuk, bijvoorbeeld "Op het scherm" in de vergadermodus. */
  extra?: (d: Doc) => ReactNode;
}) {
  if (!docs.length) return null;
  return (
    <div>
      {docs.map((d) => (
        <DocRow key={d.id} doc={d} canManage={canManage(d)} onChanged={onChanged} extra={extra?.(d)} />
      ))}
    </div>
  );
}

export function UploadButton({
  target,
  onDone,
  label = "Stuk toevoegen",
  variant = "secondary",
}: {
  target: UploadTarget;
  onDone: () => void;
  label?: string;
  variant?: "secondary" | "ghost";
}) {
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const [status, setStatus] = useState<{ name: string; fraction: number } | null>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    let done = 0;
    try {
      for (const file of Array.from(files)) {
        setStatus({ name: file.name, fraction: 0 });
        await uploadFile(file, target, (fraction) => setStatus({ name: file.name, fraction }));
        done++;
      }
      toast(done === 1 ? "Stuk toegevoegd" : `${done} stukken toegevoegd`);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setStatus(null);
      if (input.current) input.current.value = "";
      if (done) onDone();
    }
  }

  return (
    <span className="no-print">
      <input ref={input} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
      <Button variant={variant} small icon="upload" busy={!!status} onClick={() => input.current?.click()}>
        {status ? `Uploaden… ${Math.round(status.fraction * 100)}%` : label}
      </Button>
    </span>
  );
}
