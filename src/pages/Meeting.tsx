import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { countItems, parseAgenda } from "../agendaParse";
import { api, saveBlob } from "../api";
import { useAuth, useUser } from "../auth";
import { ProposalsModal, useAi } from "../components/Ai";
import { AgendaPaste } from "../components/AgendaPaste";
import { DocList, UploadButton } from "../components/Docs";
import { ActionItem, ActionModal, DecisionModal } from "../components/Records";
import {
  addMinutes,
  fmtDate,
  fmtDateLong,
  fmtTime,
  fromLocalInput,
  LABELS,
  labelTone,
  STATUS_LABEL,
  timeRange,
  toLocalInput,
  type Action,
  type AgendaItem,
  type Decision,
  type Doc,
  type Meeting,
  type MeetingDetail,
  type MeetingStatus,
} from "../lib";
import { Button, Empty, Field, Form, Icon, Loader, Modal, useLoad, useRun } from "../ui";

type ModalState =
  | { type: "meeting" }
  | { type: "item"; item?: AgendaItem; parent?: AgendaItem }
  | { type: "import" }
  | { type: "decision"; itemId: string | null; decision?: Decision }
  | { type: "action"; itemId: string | null; action?: Action }
  | { type: "proposals" }
  | null;

// ---------- formulieren ----------

function MeetingForm({ meeting, onClose, onSaved }: { meeting: Meeting; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(meeting.title);
  const [startsAt, setStartsAt] = useState(toLocalInput(meeting.startsAt));
  const [durationMin, setDurationMin] = useState(meeting.durationMin);
  const [location, setLocation] = useState(meeting.location);
  const [onlineUrl, setOnlineUrl] = useState(meeting.onlineUrl);
  const [description, setDescription] = useState(meeting.description);
  return (
    <Modal title="Vergadering bewerken" onClose={onClose}>
      <Form
        onCancel={onClose}
        onSubmit={async () => {
          await api(`/api/meetings/${meeting.id}`, {
            method: "PATCH",
            body: { title, startsAt: fromLocalInput(startsAt), durationMin, location, onlineUrl, description },
          });
          onSaved();
        }}
      >
        <Field label="Titel">
          <input className="input" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="form-row">
          <Field label="Datum en tijd">
            <input className="input" type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </Field>
          <Field label="Duur (minuten)">
            <input className="input" type="number" required min={5} max={1440} step={5} value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))} />
          </Field>
        </div>
        <Field label="Locatie">
          <input className="input" maxLength={200} value={location} onChange={(e) => setLocation(e.target.value)} />
        </Field>
        <Field label="Online link">
          <input className="input" type="url" placeholder="https://" value={onlineUrl} onChange={(e) => setOnlineUrl(e.target.value)} />
        </Field>
        <Field label="Toelichting bij de agenda" hint="Staat boven de agenda en op de afdruk. Bijvoorbeeld wat er van de deelnemers wordt verwacht of waar de stukken staan.">
          <textarea className="input" maxLength={10000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </Form>
    </Modal>
  );
}

function ItemForm({
  meetingId,
  item,
  parent,
  childCount,
  onClose,
  onSaved,
}: {
  meetingId: string;
  item?: AgendaItem;
  /** Nieuw subpunt onder dit hoofdpunt. */
  parent?: AgendaItem;
  childCount: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const run = useRun();
  const [title, setTitle] = useState(item?.title ?? "");
  const [kind, setKind] = useState(item?.kind ?? "");
  const [presenter, setPresenter] = useState(item?.presenter ?? "");
  const [durationMin, setDurationMin] = useState(item?.durationMin?.toString() ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const heading = item ? "Agendapunt bewerken" : parent ? `Subpunt bij "${parent.title}"` : "Agendapunt toevoegen";
  return (
    <Modal title={heading} onClose={onClose}>
      <Form
        onCancel={onClose}
        onSubmit={async () => {
          const body = { title, kind, presenter, durationMin: durationMin === "" ? null : Number(durationMin), description };
          if (item) await api(`/api/items/${item.id}`, { method: "PATCH", body });
          else await api(`/api/meetings/${meetingId}/items`, { method: "POST", body: { ...body, parentId: parent?.id ?? null } });
          onSaved();
        }}
        extra={
          item && (
            <Button
              variant="danger"
              icon="trash"
              onClick={async () => {
                const subs = childCount ? ` De ${childCount} ${childCount === 1 ? "subpunt verdwijnt" : "subpunten verdwijnen"} mee.` : "";
                if (!window.confirm(`Agendapunt "${item.title}" verwijderen?${subs} Stukken, besluiten en acties blijven bij de vergadering staan.`)) return;
                if (await run(() => api(`/api/items/${item.id}`, { method: "DELETE" }), "Agendapunt verwijderd")) onSaved();
              }}
            >
              Verwijderen
            </Button>
          )
        }
      >
        <Field label="Onderwerp">
          <input className="input" required autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="form-row">
          <Field label="Label" hint="Kies of typ zelf, bijvoorbeeld Ter vaststelling. Mag leeg.">
            <input className="input" list="labels" maxLength={80} value={kind} onChange={(e) => setKind(e.target.value)} />
            <datalist id="labels">
              {LABELS.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </Field>
          <Field label="Inbrenger">
            <input className="input" maxLength={120} value={presenter} onChange={(e) => setPresenter(e.target.value)} />
          </Field>
          <Field label="Duur (minuten)">
            <input className="input" type="number" min={1} max={600} value={durationMin} onChange={(e) => setDurationMin(e.target.value)} />
          </Field>
        </div>
        <Field label="Toelichting" hint="Wat wordt er gevraagd van de deelnemers? Bij een besluit: het voorgestelde besluit.">
          <textarea className="input" maxLength={10000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </Form>
    </Modal>
  );
}

/** Een bestaande agenda (uit Word, pdf of e-mail) in één keer overnemen. */
function ImportForm({ meetingId, startAt, onClose, onSaved }: { meetingId: string; startAt: number; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState("");
  const count = countItems(parseAgenda(text));
  return (
    <Modal title="Agenda plakken" onClose={onClose}>
      <Form
        submitLabel={count ? `${count} ${count === 1 ? "punt" : "punten"} toevoegen` : "Toevoegen"}
        onCancel={onClose}
        onSubmit={async () => {
          const items = parseAgenda(text);
          if (!items.length) throw new Error("Er zijn geen agendapunten herkend. Plak de agenda met op elke regel één punt.");
          await api(`/api/meetings/${meetingId}/items/bulk`, { method: "POST", body: { items } });
          onSaved();
        }}
      >
        <AgendaPaste value={text} onChange={setText} startAt={startAt} autoFocus />
      </Form>
    </Modal>
  );
}

/** Notulen: leesbaar voor iedereen, bewerkbaar door de secretaris. */
function Notes({ value, canEdit, onSave, label }: { value: string; canEdit: boolean; onSave: (v: string) => Promise<boolean>; label: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  if (editing) {
    return (
      <div className="sub no-print">
        <span className="sub-label">{label}</span>
        <textarea className="input" autoFocus rows={5} maxLength={50000} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <div className="row">
          <Button
            small
            busy={busy}
            onClick={async () => {
              setBusy(true);
              const ok = await onSave(draft);
              setBusy(false);
              if (ok) setEditing(false);
            }}
          >
            Opslaan
          </Button>
          <Button small variant="ghost" onClick={() => setEditing(false)}>
            Annuleren
          </Button>
        </div>
      </div>
    );
  }
  if (!value && !canEdit) return null;
  return (
    <div className="sub only-verslag">
      {value && (
        <>
          <span className="sub-label">{label}</span>
          <div className="note pre">{value}</div>
        </>
      )}
      {canEdit && (
        <div className="no-print">
          <Button
            small
            variant="ghost"
            icon="edit"
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
          >
            {value ? `${label} bewerken` : `${label} toevoegen`}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------- hulpfuncties ----------

/** Begintijd per agendapunt (in agendavolgorde), zolang alle voorgaande punten een duur hebben. */
function itemTimes(startsAt: string, ordered: AgendaItem[]): Map<string, string> {
  const times = new Map<string, string>();
  let t: Date | null = new Date(startsAt);
  for (const it of ordered) {
    if (!t) break;
    times.set(it.id, fmtTime(t));
    t = it.durationMin ? addMinutes(t.toISOString(), it.durationMin) : null;
  }
  return times;
}

function icsStamp(d: Date) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/[,;]/g, "\\$&").replace(/\r?\n/g, "\\n");

function downloadIcs(m: Meeting) {
  const url = `${window.location.origin}/vergaderingen/${m.id}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Vergaderplatform//NL",
    "BEGIN:VEVENT",
    `UID:${m.id}@${window.location.host}`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(new Date(m.startsAt))}`,
    `DTEND:${icsStamp(addMinutes(m.startsAt, m.durationMin))}`,
    `SUMMARY:${icsText(m.title)}`,
    `LOCATION:${icsText(m.location || m.onlineUrl)}`,
    `DESCRIPTION:${icsText(`Agenda en stukken: ${url}${m.onlineUrl ? `\nOnline deelnemen: ${m.onlineUrl}` : ""}`)}`,
    `URL:${url}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  saveBlob(new Blob([lines.join("\r\n")], { type: "text/calendar" }), `${m.title}.ics`);
}

function print(mode: "agenda" | "verslag") {
  document.body.dataset.print = mode;
  const reset = () => {
    delete document.body.dataset.print;
    window.removeEventListener("afterprint", reset);
  };
  window.addEventListener("afterprint", reset);
  window.print();
}

// ---------- pagina ----------

export default function MeetingPage() {
  const { id } = useParams();
  const user = useUser();
  const { ensureOrg } = useAuth();
  const navigate = useNavigate();
  const run = useRun();
  const ai = useAi();
  const { data, loading, error, reload } = useLoad<MeetingDetail>(`/api/meetings/${id}`);
  const [modal, setModal] = useState<ModalState>(null);
  const [showPresence, setShowPresence] = useState(false);

  const saved = () => {
    setModal(null);
    void reload();
  };

  // Geopend via een directe link: werk dan verder in de organisatie van deze vergadering.
  const organisationId = data?.meeting.organisationId;
  useEffect(() => {
    if (organisationId) ensureOrg(organisationId);
  }, [organisationId, ensureOrg]);

  if (!data) {
    return (
      <div className="page">
        <Loader loading={loading} error={error}>
          {null}
        </Loader>
      </div>
    );
  }

  const { meeting, items, documents, decisions, actions, members, carriedActions } = data;
  const isSec = data.role === "secretaris";
  const locked = meeting.status === "afgerond";
  const canEdit = isSec && !locked;

  // Hoofdpunten met hun subpunten, in agendavolgorde.
  const tops = items.filter((i) => !i.parentId);
  const childrenOf = (parentId: string) => items.filter((i) => i.parentId === parentId);
  const times = itemTimes(meeting.startsAt, tops.flatMap((t) => [t, ...childrenOf(t.id)]));
  const planned = items.reduce((sum, it) => sum + (it.durationMin ?? 0), 0);
  const isLive = !!meeting.liveStartedAt;
  const hasNotes = !!meeting.notes.trim() || items.some((it) => it.notes.trim());

  const me = members.find((m) => m.id === user.id);
  const present = members.filter((m) => m.attendance === "aanwezig").length;
  const absent = members.filter((m) => m.attendance === "afwezig").length;

  const canManageDoc = (d: Doc) => !locked && (isSec || d.uploadedBy === user.id);
  const docsOf = (itemId: string | null) => documents.filter((d) => (d.agendaItemId ?? null) === itemId);
  const decisionsOf = (itemId: string | null) => decisions.filter((d) => (d.agendaItemId ?? null) === itemId);
  const actionsOf = (itemId: string | null) => actions.filter((a) => (a.agendaItemId ?? null) === itemId);

  const setStatus = (status: MeetingStatus, message: string) =>
    run(() => api(`/api/meetings/${meeting.id}`, { method: "PATCH", body: { status } }), message).then((ok) => {
      if (ok) void reload();
    });

  const setAttendance = (userId: string, status: "aanwezig" | "afwezig" | null) =>
    run(() => api(`/api/meetings/${meeting.id}/attendance`, { method: "PUT", body: { userId, status } })).then((ok) => {
      if (ok) void reload();
    });

  /** Verplaatst een punt binnen zijn eigen niveau: hoofdpunten onderling, subpunten binnen hun hoofdpunt. */
  async function move(siblings: AgendaItem[], index: number, delta: number, parentId: string | null) {
    const ids = siblings.map((i) => i.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved);
    if (await run(() => api(`/api/meetings/${meeting.id}/order`, { method: "PUT", body: { ids, parentId } }))) void reload();
  }

  async function remove() {
    if (!window.confirm(`Vergadering "${meeting.title}" met agenda en stukken definitief verwijderen?`)) return;
    if (await run(() => api(`/api/meetings/${meeting.id}`, { method: "DELETE" }), "Vergadering verwijderd")) {
      navigate(`/overleggen/${meeting.overlegId}`);
    }
  }

  const link = `${window.location.origin}/vergaderingen/${meeting.id}`;
  const mailto = `mailto:${members.map((m) => m.email).join(",")}?subject=${encodeURIComponent(
    `${meeting.title}, ${fmtDateLong(meeting.startsAt)}`,
  )}&body=${encodeURIComponent(
    `Beste deelnemers,\n\nDe agenda en stukken voor ${meeting.title} staan klaar.\n\nDatum: ${fmtDateLong(meeting.startsAt)}\nTijd: ${timeRange(
      meeting.startsAt,
      meeting.durationMin,
    )}${meeting.location ? `\nLocatie: ${meeting.location}` : ""}${meeting.onlineUrl ? `\nOnline: ${meeting.onlineUrl}` : ""}\n\nAgenda en stukken: ${link}\n\nMet vriendelijke groet,\n${user.name}`,
  )}`;

  const renderRecords = (itemId: string | null) => (
    <>
      {decisionsOf(itemId).length > 0 && (
        <div className="sub only-verslag">
          <span className="sub-label">Besluiten</span>
          {decisionsOf(itemId).map((d) => (
            <div className="decision" key={d.id}>
              <span className="nr">{d.number}</span>
              <div className="grow">
                <div className={`pre ${d.status === "ingetrokken" ? "strike" : ""}`}>{d.text}</div>
                {d.status === "ingetrokken" && <span className="badge warm">Ingetrokken</span>}
              </div>
              {isSec && (
                <Button
                  variant="ghost"
                  small
                  icon="edit"
                  className="no-print"
                  aria-label={`Besluit ${d.number} bewerken`}
                  onClick={() => setModal({ type: "decision", itemId, decision: d })}
                />
              )}
            </div>
          ))}
        </div>
      )}
      {actionsOf(itemId).length > 0 && (
        <div className="sub only-verslag">
          <span className="sub-label">Acties</span>
          {actionsOf(itemId).map((a) => (
            <ActionItem
              key={a.id}
              action={a}
              canToggle={isSec || a.ownerId === user.id}
              onChanged={reload}
              onEdit={isSec ? () => setModal({ type: "action", itemId, action: a }) : undefined}
            />
          ))}
        </div>
      )}
    </>
  );

  /** Inhoud van één agendapunt; hoofd- en subpunten hebben dezelfde mogelijkheden. */
  const renderItem = (it: AgendaItem, siblings: AgendaItem[], index: number, parent: AgendaItem | null) => (
    <div className="agenda-main">
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div className="grow">
          {parent ? <strong>{it.title}</strong> : <h3>{it.title}</h3>}
          {(it.kind || times.get(it.id) || it.durationMin || it.presenter || it.spentSec >= 60) && (
            <div className="meta">
              {it.kind && <span className={`badge ${labelTone(it.kind)}`}>{it.kind}</span>}
              {times.get(it.id) && (
                <span>
                  {times.get(it.id)}
                  {it.durationMin ? ` · ${it.durationMin} min` : ""}
                </span>
              )}
              {!times.get(it.id) && it.durationMin && <span>{it.durationMin} min</span>}
              {it.spentSec >= 60 && <span className="only-verslag">Besteed: {Math.round(it.spentSec / 60)} min</span>}
              {it.presenter && <span>Inbrenger: {it.presenter}</span>}
            </div>
          )}
        </div>
        {canEdit && (
          <div className="row no-print" style={{ gap: 2 }}>
            <Button variant="ghost" icon="up" aria-label={`${it.title} omhoog`} disabled={index === 0} onClick={() => move(siblings, index, -1, parent?.id ?? null)} />
            <Button
              variant="ghost"
              icon="down"
              aria-label={`${it.title} omlaag`}
              disabled={index === siblings.length - 1}
              onClick={() => move(siblings, index, 1, parent?.id ?? null)}
            />
            <Button variant="ghost" icon="edit" aria-label={`Agendapunt ${it.title} bewerken`} onClick={() => setModal({ type: "item", item: it })} />
          </div>
        )}
      </div>

      {it.description && <div className="pre">{it.description}</div>}

      {(docsOf(it.id).length > 0 || !locked) && (
        <div className="sub">
          {docsOf(it.id).length > 0 && <span className="sub-label">Stukken</span>}
          <DocList docs={docsOf(it.id)} canManage={canManageDoc} onChanged={reload} />
          {!locked && (
            <div>
              <UploadButton variant="ghost" target={{ meetingId: meeting.id, agendaItemId: it.id }} onDone={reload} />
            </div>
          )}
        </div>
      )}

      <Notes
        label="Notulen"
        value={it.notes}
        canEdit={canEdit}
        onSave={(notes) => run(() => api(`/api/items/${it.id}`, { method: "PATCH", body: { notes } }), "Notulen opgeslagen").then((ok) => (ok && void reload(), ok))}
      />

      {renderRecords(it.id)}

      {canEdit && (
        <div className="row no-print">
          <Button small variant="secondary" icon="decision" onClick={() => setModal({ type: "decision", itemId: it.id })}>
            Besluit vastleggen
          </Button>
          <Button small variant="secondary" icon="tasks" onClick={() => setModal({ type: "action", itemId: it.id })}>
            Actie vastleggen
          </Button>
          {!parent && (
            <Button small variant="ghost" icon="plus" onClick={() => setModal({ type: "item", parent: it })}>
              Subpunt
            </Button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="page">
      <div className="print-only">
        <strong>{[meeting.organisationName, meeting.overlegName].filter(Boolean).join(" · ")}</strong>
      </div>

      <div className="page-head">
        <div>
          <div className="crumb no-print">
            <Link to="/overleggen">Overleggen</Link> › <Link to={`/overleggen/${meeting.overlegId}`}>{meeting.overlegName}</Link>
          </div>
          <div className="row">
            <h1>{meeting.title}</h1>
            <span className={`badge ${meeting.status === "concept" ? "warm" : meeting.status === "gepubliceerd" ? "accent" : ""} no-print`}>
              {STATUS_LABEL[meeting.status]}
            </span>
          </div>
          <div className="meta" style={{ fontSize: "1rem", color: "var(--text-2)", marginTop: 6 }}>
            <span>
              <Icon name="calendar" size={16} />
              {fmtDateLong(meeting.startsAt)}
            </span>
            <span>
              <Icon name="clock" size={16} />
              {timeRange(meeting.startsAt, meeting.durationMin)}
            </span>
            {meeting.location && (
              <span>
                <Icon name="pin" size={16} />
                {meeting.location}
              </span>
            )}
            {meeting.onlineUrl && (
              <a href={meeting.onlineUrl} target="_blank" rel="noopener noreferrer">
                <Icon name="video" size={16} />
                Online deelnemen
              </a>
            )}
          </div>
          {meeting.description && (
            <p className="lead pre" style={{ marginTop: 10 }}>
              {meeting.description}
            </p>
          )}
        </div>
      </div>

      <div className="actions no-print">
        {canEdit && (
          <Button variant="secondary" icon="edit" onClick={() => setModal({ type: "meeting" })}>
            Bewerken
          </Button>
        )}
        {isSec && meeting.status === "concept" && (
          <Button icon="check" onClick={() => setStatus("gepubliceerd", "Gepubliceerd: de deelnemers kunnen de agenda nu zien")}>
            Publiceren
          </Button>
        )}
        {meeting.status === "gepubliceerd" && (isSec || isLive) && (
          <Link className="btn" to={`/vergaderingen/${meeting.id}/live`}>
            <Icon name={isSec && !isLive ? "play" : "eye"} size={17} />
            {isLive ? (isSec ? "Naar de vergadermodus" : "Meelopen met de vergadering") : "Vergadermodus"}
          </Link>
        )}
        {canEdit && ai && (
          <Button
            variant="secondary"
            icon="spark"
            disabled={!hasNotes}
            title={hasNotes ? "Laat de AI-assistent besluiten en acties voorstellen uit de notulen" : "Leg eerst notulen vast"}
            onClick={() => setModal({ type: "proposals" })}
          >
            Voorstellen uit notulen
          </Button>
        )}
        {isSec && meeting.status === "gepubliceerd" && (
          <>
            <a className="btn secondary" href={mailto}>
              <Icon name="mail" size={17} />
              Deelnemers mailen
            </a>
            <Button
              variant={isLive ? "secondary" : "primary"}
              icon="lock"
              onClick={() => {
                if (window.confirm("Vergadering afronden? Agenda, notulen en besluiten worden vergrendeld. Acties kunnen nog wel worden afgemeld.")) {
                  void setStatus("afgerond", "Vergadering afgerond en vergrendeld");
                }
              }}
            >
              Afronden
            </Button>
            <Button variant="ghost" onClick={() => setStatus("concept", "Teruggezet naar concept")}>
              Terug naar concept
            </Button>
          </>
        )}
        {isSec && locked && (
          <Button variant="secondary" onClick={() => setStatus("gepubliceerd", "Vergadering heropend")}>
            Heropenen
          </Button>
        )}
        <Button variant="ghost" icon="calendar" onClick={() => downloadIcs(meeting)}>
          Zet in mijn agenda
        </Button>
        <Button variant="ghost" icon="printer" onClick={() => print("agenda")}>
          Agenda afdrukken
        </Button>
        <Button variant="ghost" icon="printer" onClick={() => print("verslag")}>
          Verslag afdrukken
        </Button>
        {canEdit && (
          <Button variant="danger" icon="trash" onClick={remove}>
            Verwijderen
          </Button>
        )}
      </div>

      {isLive && (
        <div className="notice accent live-banner no-print">
          <span>
            <strong>De vergadering is bezig.</strong> In de vergadermodus zie je het actuele punt, de stukken en de tijd.
          </span>
          <Link className="btn small" to={`/vergaderingen/${meeting.id}/live`}>
            <Icon name="eye" size={16} />
            {isSec ? "Naar de vergadermodus" : "Meelopen"}
          </Link>
        </div>
      )}
      {meeting.status === "concept" && (
        <div className="notice warm no-print">
          <strong>Concept.</strong> Alleen de secretaris ziet deze vergadering. Publiceer om agenda en stukken met de deelnemers te delen.
        </div>
      )}
      {locked && (
        <div className="notice no-print">
          <strong>Afgerond.</strong> Agenda, notulen en besluiten zijn vergrendeld.{isSec ? " Heropen de vergadering om nog iets te wijzigen." : ""}
        </div>
      )}

      <section className="card only-verslag">
        <div className="card-head">
          <h2 className="section-title">Aanwezigheid</h2>
          <span className="muted small">
            {present} aanwezig · {absent} afgemeld · {members.length - present - absent} onbekend
          </span>
        </div>
        <div className="card-body stack">
          {me && !locked && (
            <div className="row no-print">
              <span>Ben je erbij?</span>
              <div className="rsvp" role="group" aria-label="Mijn aanwezigheid">
                <button type="button" aria-pressed={me.attendance === "aanwezig"} onClick={() => setAttendance(me.id, me.attendance === "aanwezig" ? null : "aanwezig")}>
                  Ik ben erbij
                </button>
                <button type="button" className="no" aria-pressed={me.attendance === "afwezig"} onClick={() => setAttendance(me.id, me.attendance === "afwezig" ? null : "afwezig")}>
                  Ik ben verhinderd
                </button>
              </div>
            </div>
          )}
          <div className={showPresence ? "" : "print-only"}>
            {members.map((m) => (
              <div className="spread" key={m.id} style={{ padding: "4px 0" }}>
                <span>
                  {m.name} {m.role === "secretaris" && <span className="muted small">(secretaris)</span>}
                </span>
                {canEdit ? (
                  <select
                    className="input no-print"
                    style={{ width: "auto" }}
                    aria-label={`Aanwezigheid van ${m.name}`}
                    value={m.attendance ?? ""}
                    onChange={(e) => setAttendance(m.id, (e.target.value || null) as "aanwezig" | "afwezig" | null)}
                  >
                    <option value="">Onbekend</option>
                    <option value="aanwezig">Aanwezig</option>
                    <option value="afwezig">Afwezig</option>
                  </select>
                ) : null}
                <span className={`badge ${m.attendance === "aanwezig" ? "accent" : m.attendance === "afwezig" ? "warm" : ""} ${canEdit ? "print-only" : ""}`}>
                  {m.attendance === "aanwezig" ? "Aanwezig" : m.attendance === "afwezig" ? "Afwezig" : "Onbekend"}
                </span>
              </div>
            ))}
          </div>
          <div className="no-print">
            <Button small variant="ghost" icon={showPresence ? "up" : "down"} onClick={() => setShowPresence(!showPresence)}>
              {showPresence ? "Presentielijst verbergen" : "Presentielijst tonen"}
            </Button>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">Agenda</h2>
          {planned > 0 && (
            <span className={`small ${planned > meeting.durationMin ? "overdue" : "muted"}`}>
              {planned} van {meeting.durationMin} minuten ingepland
            </span>
          )}
        </div>
        {tops.length === 0 && (
          <Empty title="Nog geen agendapunten">
            {canEdit ? "Voeg het eerste agendapunt toe, of plak een bestaande agenda in één keer." : "De secretaris heeft de agenda nog niet gevuld."}
          </Empty>
        )}
        {tops.map((top, i) => {
          const subs = childrenOf(top.id);
          return (
            <article className="agenda-item" key={top.id}>
              <div className="agenda-nr">{i + 1}</div>
              <div className="agenda-main">
                {renderItem(top, tops, i, null)}
                {subs.length > 0 && (
                  <div className="subitems">
                    {subs.map((s, j) => (
                      <div className="subitem" key={s.id}>
                        <div className="subitem-nr">
                          {i + 1}.{j + 1}
                        </div>
                        {renderItem(s, subs, j, top)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </article>
          );
        })}
        {canEdit && (
          <div className="card-body row no-print" style={{ borderTop: tops.length ? "1px solid var(--line)" : undefined }}>
            <Button icon="plus" onClick={() => setModal({ type: "item" })}>
              Agendapunt toevoegen
            </Button>
            <Button variant="secondary" icon="copy" onClick={() => setModal({ type: "import" })}>
              Agenda plakken
            </Button>
          </div>
        )}
      </section>

      {(docsOf(null).length > 0 || !locked) && (
        <section className="card">
          <div className="card-head">
            <h2 className="section-title">Algemene stukken</h2>
            {!locked && <UploadButton target={{ meetingId: meeting.id }} onDone={reload} />}
          </div>
          {docsOf(null).length ? (
            <div className="card-body">
              <DocList docs={docsOf(null)} canManage={canManageDoc} onChanged={reload} />
            </div>
          ) : (
            <Empty title="Geen algemene stukken">Stukken die bij één agendapunt horen, voeg je bij dat agendapunt toe.</Empty>
          )}
        </section>
      )}

      {carriedActions.length > 0 && (
        <section className="card only-verslag">
          <div className="card-head">
            <h2 className="section-title">Actielijst uit eerdere vergaderingen</h2>
            <span className="muted small">{carriedActions.length} open</span>
          </div>
          <div className="card-body">
            {carriedActions.map((a) => (
              <ActionItem key={a.id} action={{ ...a, meetingTitle: `${a.meetingTitle} (${fmtDate(a.meetingStartsAt!)})` }} context canToggle={isSec || a.ownerId === user.id} onChanged={reload} />
            ))}
          </div>
        </section>
      )}

      {(decisionsOf(null).length > 0 || actionsOf(null).length > 0 || canEdit) && (
        <section className="card only-verslag">
          <div className="card-head">
            <h2 className="section-title">Overige besluiten en acties</h2>
            {canEdit && (
              <div className="row no-print">
                <Button small variant="secondary" icon="decision" onClick={() => setModal({ type: "decision", itemId: null })}>
                  Besluit
                </Button>
                <Button small variant="secondary" icon="tasks" onClick={() => setModal({ type: "action", itemId: null })}>
                  Actie
                </Button>
              </div>
            )}
          </div>
          {decisionsOf(null).length + actionsOf(null).length ? (
            <div className="card-body stack">{renderRecords(null)}</div>
          ) : (
            <Empty title="Geen besluiten of acties buiten de agendapunten" />
          )}
        </section>
      )}

      {(meeting.notes || canEdit) && (
        <section className="card only-verslag">
          <div className="card-head">
            <h2 className="section-title">Algemene notulen</h2>
          </div>
          <div className="card-body">
            <Notes
              label="Algemene notulen"
              value={meeting.notes}
              canEdit={canEdit}
              onSave={(notes) => run(() => api(`/api/meetings/${meeting.id}`, { method: "PATCH", body: { notes } }), "Notulen opgeslagen").then((ok) => (ok && void reload(), ok))}
            />
          </div>
        </section>
      )}

      {modal?.type === "meeting" && <MeetingForm meeting={meeting} onClose={() => setModal(null)} onSaved={saved} />}
      {modal?.type === "item" && (
        <ItemForm
          meetingId={meeting.id}
          item={modal.item}
          parent={modal.parent}
          childCount={modal.item ? childrenOf(modal.item.id).length : 0}
          onClose={() => setModal(null)}
          onSaved={saved}
        />
      )}
      {modal?.type === "import" && <ImportForm meetingId={meeting.id} startAt={tops.length + 1} onClose={() => setModal(null)} onSaved={saved} />}
      {modal?.type === "decision" && (
        <DecisionModal meetingId={meeting.id} agendaItemId={modal.itemId} decision={modal.decision} onClose={() => setModal(null)} onSaved={saved} />
      )}
      {modal?.type === "action" && (
        <ActionModal meetingId={meeting.id} agendaItemId={modal.itemId} action={modal.action} members={members} onClose={() => setModal(null)} onSaved={saved} />
      )}
      {modal?.type === "proposals" && <ProposalsModal meetingId={meeting.id} items={items} members={members} onClose={() => setModal(null)} onSaved={saved} />}
    </div>
  );
}
