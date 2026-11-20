import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorText } from "../api";
import { agendaOrder, fmtDateTime, type AgendaItem, type Meeting } from "../lib";
import { Button, Field, Form, Icon, Loader, Modal, useLoad, useRun, useToast } from "../ui";
import { Thinking, useAi } from "./Ai";

type Meta = { source: "plaud" | "tekst"; title: string; recordedAt: string | null; chars: number; createdAt: string; createdByName: string | null; body?: string };
type Job = { id: string; status: "wacht" | "bezig" | "klaar" | "mislukt" };
type PlaudStatus = { available: boolean; connected: boolean; connectedAt: string | null };
type Recording = { id: string; name: string; startAt: string | null; durationMin: number | null };

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shift = (iso: string, days: number) => {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return day(d);
};

// ---------- Plaud koppelen (Mijn account) ----------

export function PlaudCard() {
  const run = useRun();
  const toast = useToast();
  const { data, loading, error, reload } = useLoad<PlaudStatus>("/api/plaud");
  const [busy, setBusy] = useState(false);

  // Terug van Plaud: de uitkomst staat in het adres.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("plaud");
    if (!result) return;
    if (result === "gekoppeld") toast("Plaud is gekoppeld");
    else toast(result === "geweigerd" ? "Je hebt bij Plaud geen toestemming gegeven." : "Koppelen met Plaud is niet gelukt. Probeer het opnieuw.", "error");
    window.history.replaceState(null, "", window.location.pathname);
  }, [toast]);

  if (data && !data.available) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Plaud</h2>
        {data?.connected ? <span className="badge accent">Gekoppeld</span> : <span className="badge">Niet gekoppeld</span>}
      </div>
      <div className="card-body stack">
        <Loader loading={loading} error={error}>
          <p>
            Neem je vergaderingen op met Plaud? Koppel je account, dan haal je bij een vergadering het transcript van de opname op en laat je er concept-notulen
            van maken.
          </p>
          <p className="small muted">
            Het platform krijgt leestoegang tot je opnames bij Plaud en haalt alleen het transcript op dat jij bij een vergadering kiest. De koppeling is
            persoonlijk; anderen kunnen niet bij jouw opnames. {data?.connected && data.connectedAt ? `Gekoppeld op ${fmtDateTime(data.connectedAt)}.` : ""}
          </p>
          <div>
            {data?.connected ? (
              <Button
                variant="secondary"
                onClick={async () => {
                  if (!window.confirm("Plaud ontkoppelen? Transcripten die al bij vergaderingen staan, blijven staan.")) return;
                  if (await run(() => api("/api/plaud", { method: "DELETE" }), "Plaud is ontkoppeld")) void reload();
                }}
              >
                Ontkoppelen
              </Button>
            ) : (
              <Button
                busy={busy}
                onClick={async () => {
                  setBusy(true);
                  // Door naar Plaud om toestemming te geven; daarna kom je hier terug.
                  const ok = await run(async () => {
                    window.location.href = (await api<{ url: string }>("/api/plaud/connect", { method: "POST", body: {} })).url;
                  });
                  if (!ok) setBusy(false);
                }}
              >
                {busy ? "Naar Plaud…" : "Plaud koppelen"}
              </Button>
            )}
          </div>
        </Loader>
      </div>
    </section>
  );
}

// ---------- transcript bij een vergadering ----------

function PlaudPicker({ meeting, onClose, onDone }: { meeting: Meeting; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const status = useLoad<PlaudStatus>("/api/plaud");
  const [from, setFrom] = useState(() => shift(meeting.startsAt, -1));
  const [to, setTo] = useState(() => shift(meeting.startsAt, 1));
  const list = useLoad<{ recordings: Recording[] }>(status.data?.connected ? `/api/plaud/recordings?from=${from}&to=${to}` : null);
  const [fetching, setFetching] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function take(r: Recording) {
    setFetching(r.id);
    setError("");
    try {
      const res = await api<{ chars: number }>(`/api/meetings/${meeting.id}/transcript`, {
        method: "PUT",
        body: { plaudFileId: r.id, title: r.name, recordedAt: r.startAt },
      });
      toast(`Transcript opgehaald (ongeveer ${Math.round(res.chars / 6).toLocaleString("nl-NL")} woorden)`);
      onDone();
    } catch (e) {
      setError(errorText(e));
      setFetching(null);
    }
  }

  const recordings = list.data?.recordings ?? [];
  return (
    <Modal title="Transcript ophalen uit Plaud" onClose={onClose}>
      <div className="stack">
        <Loader loading={status.loading} error={status.error}>
          {!status.data?.available ? (
            <p>De koppeling met Plaud is op dit platform niet ingericht. Plak het transcript als tekst.</p>
          ) : !status.data.connected ? (
            <>
              <p>Koppel eerst je Plaud-account. Dat doe je één keer, onder Mijn account.</p>
              <div>
                <Link className="btn" to="/account">
                  Naar Mijn account
                </Link>
              </div>
            </>
          ) : (
            <>
              <div className="form-row">
                <Field label="Opnames vanaf">
                  <input className="input" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
                </Field>
                <Field label="Tot en met">
                  <input className="input" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
                </Field>
              </div>
              <Loader loading={list.loading} error={list.error}>
                {recordings.length ? (
                  <ul className="list">
                    {recordings.map((r) => (
                      <li key={r.id} style={{ alignItems: "center", paddingLeft: 0, paddingRight: 0 }}>
                        <div className="grow">
                          <strong>{r.name}</strong>
                          <div className="meta">
                            {r.startAt && <span>{fmtDateTime(r.startAt)}</span>}
                            {r.durationMin && <span>{r.durationMin} min</span>}
                          </div>
                        </div>
                        <Button small busy={fetching === r.id} disabled={!!fetching} onClick={() => void take(r)}>
                          {fetching === r.id ? "Ophalen…" : "Kiezen"}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">Geen opnames in deze periode. Kies andere datums, of controleer of de opname in de Plaud-app is gesynchroniseerd.</p>
                )}
              </Loader>
            </>
          )}
        </Loader>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

function PasteModal({ meeting, onClose, onDone }: { meeting: Meeting; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  return (
    <Modal title="Transcript als tekst" onClose={onClose}>
      <Form
        submitLabel="Transcript plaatsen"
        onCancel={onClose}
        onSubmit={async () => {
          await api(`/api/meetings/${meeting.id}/transcript`, { method: "PUT", body: { text, title } });
          onDone();
        }}
      >
        <Field label="Bestand" hint="Een tekstbestand (.txt of .srt), bijvoorbeeld de export uit Plaud, Teams of Zoom. Of plak de tekst hieronder.">
          <input
            className="input"
            type="file"
            accept=".txt,.srt,.vtt,.md,text/plain"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setText(await file.text());
              setTitle(file.name);
            }}
          />
        </Field>
        <Field label="Tekst van het transcript">
          <textarea className="input" required rows={9} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      </Form>
    </Modal>
  );
}

function ViewModal({ meeting, onClose }: { meeting: Meeting; onClose: () => void }) {
  const { data, loading, error } = useLoad<{ transcript: Meta | null }>(`/api/meetings/${meeting.id}/transcript?body`);
  return (
    <Modal title={data?.transcript?.title || "Transcript"} onClose={onClose}>
      <Loader loading={loading} error={error}>
        <div className="transcript-text pre">{data?.transcript?.body}</div>
      </Loader>
    </Modal>
  );
}

type NotesResult = { items: { agendaItemId: string; notes: string }[]; general: string };
type Row = { id: string | null; label: string; existing: string; notes: string; keep: boolean; mode: "onder" | "vervang" };

/** Laat concept-notulen maken (of toont een eerder resultaat) en legt na controle de gekozen delen vast. */
function NotesModal({
  meeting,
  items,
  jobId,
  onClose,
  onSaved,
}: {
  meeting: Meeting;
  items: AgendaItem[];
  jobId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let gone = false;
    const order = agendaOrder(items);
    (async () => {
      try {
        let id = jobId;
        if (!id) {
          const job = await api<{ jobId: string; running: boolean }>(`/api/meetings/${meeting.id}/transcript/notes`, { method: "POST", body: {} });
          id = job.jobId;
          // Start het achtergrondwerk; dit verzoek geeft direct antwoord, het resultaat volgt via de stand.
          // Loopt er al een klus (ook: dit venster twee keer geopend), dan sluiten we daarbij aan.
          if (!job.running) await api(`/api/background/jobs/${id}/run`, { method: "POST", body: {} });
        }
        for (;;) {
          const state = await api<{ status: Job["status"]; result: NotesResult | null; error: string }>(`/api/jobs/${id}`);
          if (gone) return;
          if (state.status === "mislukt") throw new Error(state.error || "Het maken van de concept-notulen is niet gelukt.");
          if (state.status === "klaar" && state.result) {
            const result = state.result;
            const list: Row[] = order
              .map(({ item, number }) => ({ item, number, found: result.items.find((r) => r.agendaItemId === item.id) }))
              .filter((x) => x.found)
              .map(({ item, number, found }) => ({ id: item.id, label: `${number} ${item.title}`, existing: item.notes, notes: found!.notes, keep: true, mode: "onder" as const }));
            if (result.general) list.push({ id: null, label: "Algemeen (niet bij één agendapunt)", existing: meeting.notes, notes: result.general, keep: true, mode: "onder" });
            setRows(list);
            return;
          }
          await new Promise((r) => setTimeout(r, 3000));
          if (gone) return;
        }
      } catch (e) {
        if (!gone) setError(errorText(e));
      }
    })();
    const timer = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => {
      gone = true;
      window.clearInterval(timer);
    };
    // Bewust alleen bij openen: de agenda en de klus liggen dan vast.
  }, []);

  const patch = (index: number, change: Partial<Row>) => setRows((list) => list!.map((r, i) => (i === index ? { ...r, ...change } : r)));
  const chosen = rows?.filter((r) => r.keep && r.notes.trim()).length ?? 0;

  async function save() {
    setSaving(true);
    setError("");
    try {
      for (const r of rows!.filter((x) => x.keep && x.notes.trim())) {
        const notes = r.mode === "onder" && r.existing.trim() ? `${r.existing.trim()}\n\n${r.notes.trim()}` : r.notes.trim();
        if (r.id) await api(`/api/items/${r.id}`, { method: "PATCH", body: { notes } });
        else await api(`/api/meetings/${meeting.id}`, { method: "PATCH", body: { notes } });
      }
      toast(`Notulen bij ${chosen} ${chosen === 1 ? "onderdeel" : "onderdelen"} overgenomen. Laat nu besluiten en acties voorstellen.`);
      onSaved();
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  }

  return (
    <Modal title="Concept-notulen uit het transcript" onClose={onClose}>
      <div className="stack">
        {!rows && !error && (
          <>
            <Thinking>{`Het transcript wordt gelezen en uitgewerkt${seconds >= 5 ? ` (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")})` : ""}.`}</Thinking>
            <p className="small muted">Dit duurt één tot enkele minuten. Je kunt dit venster sluiten; het resultaat staat daarna klaar bij het transcript.</p>
          </>
        )}
        {rows && rows.length === 0 && <p>De assistent heeft in het transcript niets gevonden dat bij de agendapunten past. Controleer of dit het juiste transcript is.</p>}
        {rows && rows.length > 0 && (
          <>
            <p className="small muted">
              <Icon name="spark" size={14} /> Concept van de AI-assistent. Een transcript bevat herkenningsfouten: loop namen, bedragen en data na, en let op{" "}
              <strong>[controleren]</strong>. Er wordt niets opgeslagen tot je op Overnemen klikt.
            </p>
            {rows.map((r, i) => (
              <div className="proposal" key={r.id ?? "algemeen"}>
                <input type="checkbox" checked={r.keep} aria-label={`${r.label} overnemen`} onChange={(e) => patch(i, { keep: e.target.checked })} />
                <div className="grow stack" style={{ gap: 6 }}>
                  <strong>{r.label}</strong>
                  <textarea className="input" rows={5} maxLength={20000} value={r.notes} disabled={!r.keep} onChange={(e) => patch(i, { notes: e.target.value })} />
                  {r.existing.trim() && (
                    <label className="small muted row" style={{ gap: 6 }}>
                      Er staan al notulen:
                      <select className="input" style={{ width: "auto", padding: "4px 8px" }} value={r.mode} disabled={!r.keep} onChange={(e) => patch(i, { mode: e.target.value as Row["mode"] })}>
                        <option value="onder">eronder toevoegen</option>
                        <option value="vervang">vervangen</option>
                      </select>
                    </label>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="form-foot">
          <Button variant="ghost" onClick={onClose}>
            {rows && chosen > 0 ? "Annuleren" : "Sluiten"}
          </Button>
          {rows && chosen > 0 && (
            <Button busy={saving} icon="check" onClick={() => void save()}>
              {saving ? "Bezig…" : `Overnemen (${chosen})`}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

type Open = { type: "plaud" } | { type: "tekst" } | { type: "bekijk" } | { type: "notulen"; jobId: string | null } | null;

/** Kaart op de vergaderpagina, alleen voor de secretaris. */
export function TranscriptCard({ meeting, items, canEdit, onChanged }: { meeting: Meeting; items: AgendaItem[]; canEdit: boolean; onChanged: () => void }) {
  const ai = useAi();
  const run = useRun();
  const toast = useToast();
  const { data, reload } = useLoad<{ transcript: Meta | null; job: Job | null }>(`/api/meetings/${meeting.id}/transcript`);
  const [open, setOpen] = useState<Open>(null);

  const transcript = data?.transcript ?? null;
  const job = data?.job ?? null;
  // Zonder transcript valt er na afronden niets meer te doen.
  if (!data || (!transcript && !canEdit)) return null;

  const placed = () => {
    setOpen(null);
    void reload();
  };
  const close = () => {
    setOpen(null);
    void reload();
  };

  return (
    <section className="card no-print">
      <div className="card-head">
        <h2 className="section-title">Transcript van de opname</h2>
        <span className="muted small">Alleen zichtbaar voor de secretaris</span>
      </div>
      <div className="card-body stack">
        {!transcript ? (
          <>
            <p>Zet het transcript van de opname bij deze vergadering. De AI-assistent maakt er concept-notulen per agendapunt van, die jij naloopt en overneemt.</p>
            <div className="row">
              <Button icon="download" onClick={() => setOpen({ type: "plaud" })}>
                Ophalen uit Plaud
              </Button>
              <Button variant="secondary" icon="file" onClick={() => setOpen({ type: "tekst" })}>
                Tekst plakken of bestand kiezen
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="doc">
              <span className="ext">{transcript.source === "plaud" ? "Plaud" : "Tekst"}</span>
              <div className="grow">
                <strong>{transcript.title || "Transcript"}</strong>
                <div className="small muted">
                  ongeveer {Math.round(transcript.chars / 6).toLocaleString("nl-NL")} woorden
                  {transcript.recordedAt ? ` · opgenomen ${fmtDateTime(transcript.recordedAt)}` : ""} · geplaatst {fmtDateTime(transcript.createdAt)}
                  {transcript.createdByName ? ` door ${transcript.createdByName}` : ""}
                </div>
              </div>
            </div>
            <div className="row">
              {canEdit && job?.status === "klaar" && (
                <Button icon="spark" onClick={() => setOpen({ type: "notulen", jobId: job.id })}>
                  Concept-notulen bekijken
                </Button>
              )}
              {canEdit && (job?.status === "wacht" || job?.status === "bezig") && (
                <Button icon="spark" onClick={() => setOpen({ type: "notulen", jobId: job.id })}>
                  Concept-notulen worden gemaakt…
                </Button>
              )}
              {canEdit && (!job || job.status === "klaar" || job.status === "mislukt") && (
                <Button
                  variant={job?.status === "klaar" ? "secondary" : "primary"}
                  icon="spark"
                  disabled={!ai || !items.length}
                  title={!ai ? "Zet de AI-assistent aan onder Toegang en beheer" : !items.length ? "Maak eerst een agenda" : undefined}
                  onClick={() => setOpen({ type: "notulen", jobId: null })}
                >
                  {job?.status === "klaar" ? "Opnieuw maken" : "Concept-notulen maken"}
                </Button>
              )}
              <Button variant="ghost" icon="eye" onClick={() => setOpen({ type: "bekijk" })}>
                Bekijken
              </Button>
              <Button
                variant="danger"
                icon="trash"
                onClick={async () => {
                  if (!window.confirm("Transcript verwijderen? De notulen die je hebt overgenomen, blijven staan.")) return;
                  if (await run(() => api(`/api/meetings/${meeting.id}/transcript`, { method: "DELETE" }), "Transcript verwijderd")) void reload();
                }}
              >
                Verwijderen
              </Button>
            </div>
            {canEdit && !ai && <p className="small muted">Concept-notulen maken kan zodra een beheerder de AI-assistent aanzet onder Toegang en beheer.</p>}
            <p className="small muted">Een transcript is een woordelijk verslag van wie wat zei. Verwijder het zodra de notulen zijn vastgesteld.</p>
          </>
        )}
      </div>
      {open?.type === "plaud" && <PlaudPicker meeting={meeting} onClose={() => setOpen(null)} onDone={placed} />}
      {open?.type === "tekst" && (
        <PasteModal
          meeting={meeting}
          onClose={() => setOpen(null)}
          onDone={() => {
            toast("Transcript geplaatst");
            placed();
          }}
        />
      )}
      {open?.type === "bekijk" && <ViewModal meeting={meeting} onClose={() => setOpen(null)} />}
      {open?.type === "notulen" && (
        <NotesModal
          meeting={meeting}
          items={items}
          jobId={open.jobId}
          onClose={close}
          onSaved={() => {
            close();
            onChanged();
          }}
        />
      )}
    </section>
  );
}
