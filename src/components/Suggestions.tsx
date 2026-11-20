import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useUser } from "../auth";
import { fmtDate, type MeetingSummary } from "../lib";
import { Button, Field, Form, Modal, useLoad, useRun } from "../ui";

export type Suggestion = {
  id: string;
  title: string;
  description: string;
  status: "open" | "geplaatst" | "afgewezen";
  reply: string;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  meetingId: string | null;
  meetingTitle: string | null;
  meetingStartsAt: string | null;
};

function SuggestModal({ overlegId, onClose, onSaved }: { overlegId: string; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  return (
    <Modal title="Agendapunt aandragen" onClose={onClose}>
      <Form
        submitLabel="Aandragen"
        onCancel={onClose}
        onSubmit={async () => {
          await api(`/api/overleggen/${overlegId}/suggestions`, { method: "POST", body: { title, description } });
          onSaved();
        }}
      >
        <Field label="Onderwerp">
          <input className="input" required autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Toelichting (optioneel)" hint="Wat wil je bespreken en wat vraag je van de vergadering?">
          <textarea className="input" rows={4} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <p className="small muted">De secretaris zet je punt op de agenda van een vergadering, of laat weten waarom niet.</p>
      </Form>
    </Modal>
  );
}

function Row({ s, isSec, meetings, meetingId, onChanged }: { s: Suggestion; isSec: boolean; meetings: MeetingSummary[]; meetingId?: string; onChanged: () => void }) {
  const user = useUser();
  const run = useRun();
  const [target, setTarget] = useState(meetingId ?? meetings[0]?.id ?? "");

  const place = () => run(() => api(`/api/suggestions/${s.id}/place`, { method: "POST", body: { meetingId: target } }), "Op de agenda gezet").then((ok) => ok && onChanged());
  async function dismiss() {
    const reply = window.prompt(`"${s.title}" niet op de agenda zetten. Reden voor ${s.createdByName ?? "de aandrager"} (mag leeg blijven):`);
    if (reply === null) return;
    if (await run(() => api(`/api/suggestions/${s.id}/dismiss`, { method: "POST", body: { reply } }), "Afgewezen")) onChanged();
  }

  return (
    <li style={{ alignItems: "flex-start" }}>
      <div className="grow">
        <strong>{s.title}</strong>
        {s.description && <div className="pre small">{s.description}</div>}
        <div className="meta">
          <span>
            {s.createdByName ?? "Onbekend"} · {fmtDate(s.createdAt)}
          </span>
          {s.status === "geplaatst" &&
            (s.meetingId ? (
              <span className="badge accent">
                Op de agenda: <Link to={`/vergaderingen/${s.meetingId}`}>{s.meetingTitle}</Link>
              </span>
            ) : (
              <span className="badge accent">Op de agenda gezet</span>
            ))}
          {s.status === "afgewezen" && <span className="badge warm">Niet op de agenda{s.reply ? `: ${s.reply}` : ""}</span>}
        </div>
      </div>
      {s.status === "open" && (
        <div className="row no-print" style={{ gap: 6, justifyContent: "flex-end" }}>
          {isSec && !meetingId && meetings.length > 1 && (
            <select className="input" style={{ width: "auto", maxWidth: 220 }} aria-label="Vergadering" value={target} onChange={(e) => setTarget(e.target.value)}>
              {meetings.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title} ({new Date(m.startsAt).toLocaleDateString("nl-NL")})
                </option>
              ))}
            </select>
          )}
          {isSec && (
            <Button small icon="plus" disabled={!target} title={!target ? "Plan eerst een vergadering" : undefined} onClick={() => void place()}>
              {meetingId ? "Op deze agenda" : "Op de agenda"}
            </Button>
          )}
          {isSec && (
            <Button small variant="ghost" onClick={() => void dismiss()}>
              Afwijzen
            </Button>
          )}
          {!isSec && s.createdBy === user.id && (
            <Button small variant="ghost" onClick={() => run(() => api(`/api/suggestions/${s.id}`, { method: "DELETE" }), "Ingetrokken").then((ok) => ok && onChanged())}>
              Intrekken
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** Op de pagina van het overleg: iedereen kan aandragen, de secretaris handelt af. */
export function SuggestionsCard({ overlegId, isSec, meetings, onPlaced }: { overlegId: string; isSec: boolean; meetings: MeetingSummary[]; onPlaced: () => void }) {
  const { data, reload } = useLoad<{ suggestions: Suggestion[] }>(`/api/overleggen/${overlegId}/suggestions`);
  const [adding, setAdding] = useState(false);
  const list = data?.suggestions ?? [];
  const open = list.filter((s) => s.status === "open");
  // Alleen vergaderingen waar nog iets aan de agenda kan veranderen, de eerstvolgende bovenaan.
  const targets = meetings.filter((m) => m.status !== "afgerond").reverse();
  const changed = () => {
    void reload();
    onPlaced();
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Aangedragen agendapunten</h2>
        <Button small variant="secondary" icon="plus" onClick={() => setAdding(true)}>
          Punt aandragen
        </Button>
      </div>
      {list.length ? (
        <ul className="list">
          {list.map((s) => (
            <Row key={s.id} s={s} isSec={isSec} meetings={targets} onChanged={changed} />
          ))}
        </ul>
      ) : (
        <div className="card-body">
          <p className="muted">
            Heb je een onderwerp voor een volgende vergadering? Draag het hier aan.{isSec ? " Als secretaris zet je aangedragen punten met één klik op de agenda." : ""}
          </p>
        </div>
      )}
      {isSec && open.length > 0 && !targets.length && (
        <div className="card-body" style={{ borderTop: "1px solid var(--line)" }}>
          <p className="small muted">Plan een vergadering om deze punten op de agenda te kunnen zetten.</p>
        </div>
      )}
      {adding && (
        <SuggestModal
          overlegId={overlegId}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void reload();
          }}
        />
      )}
    </section>
  );
}

/** Op de vergaderpagina, voor de secretaris: openstaande punten die nog op deze agenda kunnen. */
export function MeetingSuggestions({ overlegId, meetingId, onPlaced }: { overlegId: string; meetingId: string; onPlaced: () => void }) {
  const { data, reload } = useLoad<{ suggestions: Suggestion[] }>(`/api/overleggen/${overlegId}/suggestions`);
  const open = (data?.suggestions ?? []).filter((s) => s.status === "open");
  if (!open.length) return null;
  return (
    <section className="card no-print">
      <div className="card-head">
        <h2 className="section-title">Aangedragen door deelnemers</h2>
        <span className="muted small">
          {open.length} {open.length === 1 ? "punt" : "punten"} nog niet op een agenda
        </span>
      </div>
      <ul className="list">
        {open.map((s) => (
          <Row
            key={s.id}
            s={s}
            isSec
            meetings={[]}
            meetingId={meetingId}
            onChanged={() => {
              void reload();
              onPlaced();
            }}
          />
        ))}
      </ul>
    </section>
  );
}
