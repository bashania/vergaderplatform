import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Button, Icon } from "../ui";

/**
 * De eigen aantekeningen van de gebruiker bij de agendapunten van één vergadering. Wat op dit apparaat is
 * getypt, gaat voor op wat eerder van de server kwam: zo staat een aantekening er nog als je in de
 * vergadermodus naar een ander punt gaat en terugkomt.
 */
export function useMyNotes(fromServer: { agendaItemId: string; text: string }[] | undefined) {
  const local = useRef(new Map<string, string>());
  const get = useCallback((itemId: string) => local.current.get(itemId) ?? fromServer?.find((n) => n.agendaItemId === itemId)?.text ?? "", [fromServer]);
  const set = useCallback((itemId: string, text: string) => void local.current.set(itemId, text), []);
  return { get, set };
}

/**
 * Eigen aantekening bij een agendapunt: alleen zichtbaar voor wie hem schrijft. Slaat vanzelf op.
 * Staat niet op de afdruk; een agenda die je uitdeelt, bevat je eigen aantekeningen niet.
 */
export function MyNote({ itemId, initial, onSaved, open: startOpen }: { itemId: string; initial: string; onSaved: (itemId: string, text: string) => void; open?: boolean }) {
  const [open, setOpen] = useState(startOpen || !!initial);
  const [draft, setDraft] = useState(initial);
  const [state, setState] = useState<"rust" | "bezig" | "opgeslagen" | "fout">("rust");
  const saved = useRef(initial);
  const latest = useRef(draft);
  latest.current = draft;
  const report = useRef(onSaved);
  report.current = onSaved;

  const save = useCallback(
    async (text: string) => {
      await api(`/api/items/${itemId}/my-note`, { method: "PUT", body: { text } });
      saved.current = text;
      report.current(itemId, text);
    },
    [itemId],
  );

  useEffect(() => {
    if (draft === saved.current) return;
    const timer = window.setTimeout(async () => {
      setState("bezig");
      try {
        await save(draft);
        setState("opgeslagen");
      } catch {
        setState("fout");
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [draft, save]);

  // Bij het verlaten van het punt: wat nog niet is opgeslagen alsnog wegschrijven.
  useEffect(
    () => () => {
      if (latest.current !== saved.current) {
        report.current(itemId, latest.current);
        void save(latest.current).catch(() => {});
      }
    },
    [itemId, save],
  );

  if (!open) {
    return (
      <div className="no-print">
        <Button small variant="ghost" icon="edit" onClick={() => setOpen(true)}>
          Eigen aantekening
        </Button>
      </div>
    );
  }
  return (
    <div className="sub my-note no-print">
      <div className="spread">
        <label className="sub-label" htmlFor={`aantekening-${itemId}`}>
          <Icon name="lock" size={12} /> Eigen aantekening
        </label>
        <span className={`small ${state === "fout" ? "overdue" : "muted"}`} aria-live="polite">
          {state === "bezig" ? "Opslaan…" : state === "fout" ? "Opslaan mislukt. Typ verder om het opnieuw te proberen." : state === "opgeslagen" && draft === saved.current ? "Opgeslagen · alleen jij ziet dit" : "Alleen jij ziet dit"}
        </span>
      </div>
      <textarea
        id={`aantekening-${itemId}`}
        className="input"
        rows={3}
        maxLength={20000}
        autoFocus={!initial && !startOpen}
        placeholder="Je vragen, opmerkingen of wat je wilt inbrengen bij dit punt."
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
    </div>
  );
}
