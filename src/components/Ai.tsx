import { useEffect, useState } from "react";
import { api, errorText, fileUrl } from "../api";
import { useAuth } from "../auth";
import { agendaOrder, fmtDateTime, type AgendaItem, type Doc, type Member } from "../lib";
import { Button, Icon, Modal, useToast } from "../ui";

/** De AI-assistent is bruikbaar in de organisatie waarin de gebruiker nu werkt. */
export function useAi(): boolean {
  const { org, aiAvailable } = useAuth();
  return !!aiAvailable && !!org?.aiEnabled;
}

export const canSummarize = (d: Doc) => d.mime === "application/pdf" || d.mime.startsWith("text/") || /\.(pdf|txt|md|csv)$/i.test(d.name);

function Thinking({ children }: { children: string }) {
  return (
    <div className="ai-wait" role="status">
      <span className="ai-dot" />
      <span className="ai-dot" />
      <span className="ai-dot" />
      <span>{children}</span>
    </div>
  );
}

// ---------- samenvatting van een stuk ----------

/** Zet de platte tekst van het model om in kopjes, alinea's en opsommingen. */
function SummaryText({ text }: { text: string }) {
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.split("\n").map((l) => l.trim()).filter(Boolean))
    .filter((b) => b.length);
  return (
    <div className="ai-text">
      {blocks.map((lines, i) => {
        // Eerste regel zonder punt of streepje, gevolgd door inhoud: een kopje.
        const [first, ...rest] = lines;
        const heading = rest.length > 0 && first.length <= 60 && !first.startsWith("- ") && !/[.:;]$/.test(first);
        const body = heading ? rest : lines;
        const bullets = body.filter((l) => l.startsWith("- "));
        const plain = body.filter((l) => !l.startsWith("- "));
        return (
          <section key={i}>
            {heading && <h3>{first}</h3>}
            {plain.length > 0 && <p>{plain.join(" ")}</p>}
            {bullets.length > 0 && (
              <ul>
                {bullets.map((l, j) => (
                  <li key={j}>{l.slice(2)}</li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

type Summary = { summary: string; at: string | null; cached: boolean };

export function SummaryModal({ doc, canRefresh, onClose, onChanged }: { doc: Doc; canRefresh: boolean; onClose: () => void; onChanged: () => void }) {
  const ai = useAi();
  const [state, setState] = useState<{ data?: Summary; error?: string; busy: boolean }>({ busy: true });

  async function load(refresh: boolean) {
    setState((s) => ({ ...s, error: undefined, busy: true }));
    try {
      const data = await api<Summary>(`/api/documents/${doc.id}/ai/summary`, { method: "POST", body: { refresh } });
      setState({ data, busy: false });
      if (!data.cached) onChanged();
    } catch (e) {
      setState((s) => ({ ...s, error: errorText(e), busy: false }));
    }
  }

  useEffect(() => {
    void load(false);
    // Eén keer bij openen; `load` hangt alleen van het stuk af.
  }, [doc.id]);

  return (
    <Modal title={`Samenvatting: ${doc.name}`} onClose={onClose}>
      <div className="stack">
        {state.busy && <Thinking>{doc.hasSummary ? "Samenvatting ophalen…" : "Het stuk wordt gelezen. Dit duurt meestal 10 tot 30 seconden."}</Thinking>}
        {state.error && (
          <div className="form-error" role="alert">
            {state.error}
          </div>
        )}
        {!state.busy && state.data && (
          <>
            <SummaryText text={state.data.summary} />
            <p className="small muted">
              <Icon name="spark" size={14} /> Gemaakt door de AI-assistent{state.data.at ? ` op ${fmtDateTime(state.data.at)}` : ""}. Een samenvatting kan iets missen of
              verkeerd weergeven; het stuk zelf blijft leidend.
            </p>
          </>
        )}
        <div className="form-foot">
          {canRefresh && ai && !state.busy && state.data && (
            <Button variant="ghost" onClick={() => void load(true)}>
              Opnieuw maken
            </Button>
          )}
          <a className="btn secondary" href={fileUrl(doc)} target="_blank" rel="noopener">
            Stuk openen
          </a>
          <Button onClick={onClose}>Sluiten</Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- voorstellen voor besluiten en acties ----------

type DecisionProposal = { agendaItemId: string | null; text: string };
type ActionProposal = { agendaItemId: string | null; text: string; ownerId: string | null; dueDate: string | null };
type Row<T> = T & { key: number; keep: boolean };

export function ProposalsModal({
  meetingId,
  items,
  members,
  onClose,
  onSaved,
}: {
  meetingId: string;
  items: AgendaItem[];
  members: Member[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [decisions, setDecisions] = useState<Row<DecisionProposal>[]>([]);
  const [actions, setActions] = useState<Row<ActionProposal>[]>([]);

  useEffect(() => {
    let gone = false;
    api<{ decisions: DecisionProposal[]; actions: ActionProposal[] }>(`/api/meetings/${meetingId}/ai/proposals`, { method: "POST", body: {} })
      .then((r) => {
        if (gone) return;
        setDecisions(r.decisions.map((d, key) => ({ ...d, key, keep: true })));
        setActions(r.actions.map((a, key) => ({ ...a, key, keep: true })));
      })
      .catch((e) => !gone && setError(errorText(e)))
      .finally(() => !gone && setBusy(false));
    return () => {
      gone = true;
    };
  }, [meetingId]);

  const order = agendaOrder(items);
  const label = (itemId: string | null) => {
    const found = order.find((o) => o.item.id === itemId);
    return found ? `${found.number} ${found.item.title}` : "Algemeen";
  };
  const chosen = decisions.filter((d) => d.keep && d.text.trim()).length + actions.filter((a) => a.keep && a.text.trim()).length;

  const patch = <T,>(set: (fn: (rows: Row<T>[]) => Row<T>[]) => void, key: number, change: Partial<Row<T>>) =>
    set((rows) => rows.map((r) => (r.key === key ? { ...r, ...change } : r)));

  async function save() {
    setSaving(true);
    setError("");
    let done = 0;
    try {
      // Eén voor één: besluiten krijgen dan oplopende nummers in de volgorde van de agenda.
      for (const d of decisions.filter((x) => x.keep && x.text.trim())) {
        await api(`/api/meetings/${meetingId}/decisions`, { method: "POST", body: { text: d.text.trim(), agendaItemId: d.agendaItemId } });
        setDecisions((rows) => rows.filter((r) => r.key !== d.key));
        done++;
      }
      for (const a of actions.filter((x) => x.keep && x.text.trim())) {
        await api(`/api/meetings/${meetingId}/actions`, {
          method: "POST",
          body: { text: a.text.trim(), agendaItemId: a.agendaItemId, ownerId: a.ownerId, dueDate: a.dueDate },
        });
        setActions((rows) => rows.filter((r) => r.key !== a.key));
        done++;
      }
      toast(done === 1 ? "1 voorstel overgenomen" : `${done} voorstellen overgenomen`);
      onSaved();
    } catch (e) {
      // Wat al is vastgelegd, is uit de lijst verdwenen; de rest kan opnieuw.
      setError(`${errorText(e)}${done ? ` (${done} al vastgelegd)` : ""}`);
      setSaving(false);
    }
  }

  const empty = !busy && !error && !decisions.length && !actions.length;
  return (
    <Modal title="Voorstellen uit de notulen" onClose={onClose}>
      <div className="stack">
        {busy && <Thinking>De notulen worden gelezen. Dit duurt meestal 10 tot 30 seconden.</Thinking>}
        {empty && <p>Er staan geen nieuwe besluiten of acties in de notulen. Wat al is vastgelegd, wordt niet opnieuw voorgesteld.</p>}
        {!busy && (decisions.length > 0 || actions.length > 0) && (
          <p className="small muted">
            <Icon name="spark" size={14} /> Voorstellen van de AI-assistent. Controleer de formulering, pas aan wat niet klopt en vink uit wat je niet wilt
            vastleggen. Er wordt niets opgeslagen tot je op Overnemen klikt.
          </p>
        )}
        {decisions.length > 0 && (
          <div className="sub">
            <span className="sub-label">Besluiten</span>
            {decisions.map((d) => (
              <div className="proposal" key={d.key}>
                <input type="checkbox" checked={d.keep} aria-label="Besluit overnemen" onChange={(e) => patch(setDecisions, d.key, { keep: e.target.checked })} />
                <div className="grow stack" style={{ gap: 6 }}>
                  <textarea className="input" rows={2} maxLength={5000} value={d.text} disabled={!d.keep} onChange={(e) => patch(setDecisions, d.key, { text: e.target.value })} />
                  <span className="small muted">Bij: {label(d.agendaItemId)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {actions.length > 0 && (
          <div className="sub">
            <span className="sub-label">Acties</span>
            {actions.map((a) => (
              <div className="proposal" key={a.key}>
                <input type="checkbox" checked={a.keep} aria-label="Actie overnemen" onChange={(e) => patch(setActions, a.key, { keep: e.target.checked })} />
                <div className="grow stack" style={{ gap: 6 }}>
                  <textarea className="input" rows={2} maxLength={2000} value={a.text} disabled={!a.keep} onChange={(e) => patch(setActions, a.key, { text: e.target.value })} />
                  <div className="row">
                    <select
                      className="input"
                      aria-label="Actiehouder"
                      value={a.ownerId ?? ""}
                      disabled={!a.keep}
                      onChange={(e) => patch(setActions, a.key, { ownerId: e.target.value || null })}
                    >
                      <option value="">Nog niet toegewezen</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input"
                      type="date"
                      aria-label="Deadline"
                      value={a.dueDate ?? ""}
                      disabled={!a.keep}
                      onChange={(e) => patch(setActions, a.key, { dueDate: e.target.value || null })}
                    />
                  </div>
                  <span className="small muted">Bij: {label(a.agendaItemId)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="form-foot">
          <Button variant="ghost" onClick={onClose}>
            {empty ? "Sluiten" : "Annuleren"}
          </Button>
          {!busy && chosen > 0 && (
            <Button busy={saving} icon="check" onClick={() => void save()}>
              {saving ? "Bezig…" : `Overnemen (${chosen})`}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
