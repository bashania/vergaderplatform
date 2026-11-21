import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { fmtDay, isOverdue, type Action, type Decision, type Member } from "../lib";
import { Button, Empty, Field, Form, Modal, TableWrap, useRun } from "../ui";

// ---------- acties ----------

export function ActionItem({
  action,
  canToggle,
  onChanged,
  onEdit,
  context,
}: {
  action: Action;
  canToggle: boolean;
  onChanged: () => void;
  onEdit?: () => void;
  /** Toon uit welk overleg/welke vergadering de actie komt. */
  context?: boolean;
}) {
  const run = useRun();
  const done = action.status !== "open";
  const overdue = !done && isOverdue(action.dueDate);

  async function toggle() {
    const status = done ? "open" : "gereed";
    if (await run(() => api(`/api/actions/${action.id}`, { method: "PATCH", body: { status } }))) onChanged();
  }

  return (
    <div className="action">
      <input
        type="checkbox"
        checked={done}
        disabled={!canToggle || action.status === "vervallen"}
        onChange={toggle}
        aria-label={done ? "Actie heropenen" : "Actie afmelden als gereed"}
      />
      <div className="grow">
        <div className={`pre ${done ? "strike" : ""}`}>{action.text}</div>
        <div className="meta">
          <span>{action.ownerName ?? "Nog geen actiehouder"}</span>
          {action.dueDate && <span className={overdue ? "overdue" : ""}>{overdue ? "Te laat: " : "Deadline "}{fmtDay(action.dueDate)}</span>}
          {action.status === "vervallen" && <span className="badge">Vervallen</span>}
          {context && action.meetingId && (
            <Link to={`/vergaderingen/${action.meetingId}`}>
              {action.overlegName ? `${action.overlegName}: ` : ""}
              {action.meetingTitle}
            </Link>
          )}
        </div>
      </div>
      {onEdit && <Button variant="ghost" small icon="edit" className="no-print" aria-label="Actie bewerken" onClick={onEdit} />}
    </div>
  );
}

export function ActionList({
  actions,
  userId,
  onChanged,
  emptyTitle = "Geen acties",
}: {
  actions: Action[];
  userId: string;
  onChanged: () => void;
  emptyTitle?: string;
}) {
  if (!actions.length) return <Empty title={emptyTitle} />;
  return (
    <div className="card-body">
      {actions.map((a) => (
        <ActionItem key={a.id} action={a} context canToggle={a.role === "secretaris" || a.ownerId === userId} onChanged={onChanged} />
      ))}
    </div>
  );
}

export function ActionModal({
  meetingId,
  agendaItemId,
  action,
  members,
  onClose,
  onSaved,
}: {
  meetingId: string;
  agendaItemId: string | null;
  action?: Action;
  members: Member[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const run = useRun();
  const [text, setText] = useState(action?.text ?? "");
  const [ownerId, setOwnerId] = useState(action?.ownerId ?? "");
  const [dueDate, setDueDate] = useState(action?.dueDate ?? "");
  const [status, setStatus] = useState(action?.status ?? "open");

  return (
    <Modal title={action ? "Actie bewerken" : "Actie vastleggen"} onClose={onClose}>
      <Form
        onCancel={onClose}
        onSubmit={async () => {
          const body = { text, ownerId: ownerId || null, dueDate: dueDate || null };
          if (action) await api(`/api/actions/${action.id}`, { method: "PATCH", body: { ...body, status } });
          else await api(`/api/meetings/${meetingId}/actions`, { method: "POST", body: { ...body, agendaItemId } });
          onSaved();
        }}
        extra={
          action && (
            <Button
              variant="danger"
              icon="trash"
              onClick={async () => {
                if (!window.confirm("Deze actie verwijderen?")) return;
                if (await run(() => api(`/api/actions/${action.id}`, { method: "DELETE" }), "Actie verwijderd")) onSaved();
              }}
            >
              Verwijderen
            </Button>
          )
        }
      >
        <Field label="Wat moet er gebeuren?">
          <textarea className="input" required autoFocus maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <div className="form-row">
          <Field label="Actiehouder">
            <select className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">Nog niet toegewezen</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Deadline">
            <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          {action && (
            <Field label="Status">
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value as Action["status"])}>
                <option value="open">Open</option>
                <option value="gereed">Gereed</option>
                <option value="vervallen">Vervallen</option>
              </select>
            </Field>
          )}
        </div>
      </Form>
    </Modal>
  );
}

// ---------- besluiten ----------

export function DecisionModal({
  meetingId,
  agendaItemId,
  decision,
  onClose,
  onSaved,
}: {
  meetingId: string;
  agendaItemId: string | null;
  decision?: Decision;
  onClose: () => void;
  onSaved: () => void;
}) {
  const run = useRun();
  const [text, setText] = useState(decision?.text ?? "");
  const [status, setStatus] = useState(decision?.status ?? "genomen");
  return (
    <Modal title={decision ? `Besluit ${decision.number} bewerken` : "Besluit vastleggen"} onClose={onClose}>
      <Form
        onCancel={onClose}
        onSubmit={async () => {
          if (decision) await api(`/api/decisions/${decision.id}`, { method: "PATCH", body: { text, status } });
          else await api(`/api/meetings/${meetingId}/decisions`, { method: "POST", body: { text, agendaItemId } });
          onSaved();
        }}
        extra={
          decision && (
            <Button
              variant="danger"
              icon="trash"
              onClick={async () => {
                if (!window.confirm(`Besluit ${decision.number} verwijderen? Het nummer wordt niet opnieuw uitgegeven.`)) return;
                if (await run(() => api(`/api/decisions/${decision.id}`, { method: "DELETE" }), "Besluit verwijderd")) onSaved();
              }}
            >
              Verwijderen
            </Button>
          )
        }
      >
        <Field
          label="Besluit"
          hint={decision ? undefined : "Formuleer het zo dat iemand die er niet bij was het begrijpt. Het nummer wordt automatisch toegekend."}
        >
          <textarea className="input" required autoFocus maxLength={5000} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        {decision && (
          <Field label="Status">
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value as Decision["status"])}>
              <option value="genomen">Genomen</option>
              <option value="ingetrokken">Ingetrokken</option>
            </select>
          </Field>
        )}
      </Form>
    </Modal>
  );
}

export function DecisionTable({ decisions, showOverleg }: { decisions: Decision[]; showOverleg?: boolean }) {
  if (!decisions.length) return <Empty title="Nog geen besluiten">Besluiten leg je vast in de vergadering, bij het agendapunt.</Empty>;
  return (
    <TableWrap label="Besluiten">
      <table className="table">
        <thead>
          <tr>
            <th>Nummer</th>
            <th>Datum</th>
            <th>Besluit</th>
            <th>Vergadering</th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((d) => (
            <tr key={d.id}>
              <td className="nowrap">
                <strong className="nr-pill">{d.number}</strong>
              </td>
              <td className="nowrap">{fmtDay(d.decidedOn)}</td>
              <td style={{ minWidth: 260 }}>
                <div className={`pre ${d.status === "ingetrokken" ? "strike" : ""}`}>{d.text}</div>
                {d.status === "ingetrokken" && <span className="badge warm">Ingetrokken</span>}
              </td>
              <td>
                <Link to={`/vergaderingen/${d.meetingId}`}>{d.meetingTitle}</Link>
                {showOverleg && <div className="small muted">{d.overlegName}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}
