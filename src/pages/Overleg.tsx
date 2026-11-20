import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useUser } from "../auth";
import { DocList, UploadButton } from "../components/Docs";
import { ActionList, DecisionTable } from "../components/Records";
import { fromLocalInput, toLocalInput, type Action, type Decision, type Doc, type Member, type MeetingSummary, type Role } from "../lib";
import { Button, Empty, Field, Form, Loader, Modal, useLoad, useRun } from "../ui";
import { MeetingRow } from "./Dashboard";

type OverlegDetail = {
  overleg: { id: string; name: string; description: string; archived: boolean };
  role: Role;
  members: Member[];
  meetings: MeetingSummary[];
  documents: Doc[];
};

const TABS = [
  ["vergaderingen", "Vergaderingen"],
  ["besluiten", "Besluiten"],
  ["acties", "Acties"],
  ["stukken", "Vaste stukken"],
  ["leden", "Deelnemers"],
] as const;

/** Standaard: volgende week dezelfde dag, 09:00. */
function defaultStart(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(9, 0, 0, 0);
  return toLocalInput(d.toISOString());
}

function NewMeeting({ data, onClose }: { data: OverlegDetail; onClose: () => void }) {
  const navigate = useNavigate();
  const last = data.meetings[0];
  const [title, setTitle] = useState(data.overleg.name);
  const [startsAt, setStartsAt] = useState(defaultStart);
  const [durationMin, setDurationMin] = useState(last?.durationMin ?? 60);
  const [location, setLocation] = useState(last?.location ?? "");
  const [onlineUrl, setOnlineUrl] = useState("");
  const [copyFromId, setCopyFromId] = useState(last?.id ?? "");
  return (
    <Modal title="Nieuwe vergadering" onClose={onClose}>
      <Form
        submitLabel="Aanmaken"
        onCancel={onClose}
        onSubmit={async () => {
          const { id } = await api<{ id: string }>(`/api/overleggen/${data.overleg.id}/meetings`, {
            method: "POST",
            body: { title, startsAt: fromLocalInput(startsAt), durationMin, location, onlineUrl, copyFromId: copyFromId || null },
          });
          navigate(`/vergaderingen/${id}`);
        }}
      >
        <Field label="Titel">
          <input className="input" required autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="form-row">
          <Field label="Datum en tijd">
            <input className="input" type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </Field>
          <Field label="Duur (minuten)">
            <input
              className="input"
              type="number"
              required
              min={5}
              max={1440}
              step={5}
              value={durationMin}
              onChange={(e) => setDurationMin(Number(e.target.value))}
            />
          </Field>
        </div>
        <Field label="Locatie (optioneel)">
          <input className="input" maxLength={200} value={location} onChange={(e) => setLocation(e.target.value)} />
        </Field>
        <Field label="Online link (optioneel)" hint="Bijvoorbeeld de Teams-link.">
          <input className="input" type="url" placeholder="https://" value={onlineUrl} onChange={(e) => setOnlineUrl(e.target.value)} />
        </Field>
        {data.meetings.length > 0 && (
          <Field label="Agenda overnemen van" hint="Neemt de agendapunten over, zonder notulen, stukken en besluiten.">
            <select className="input" value={copyFromId} onChange={(e) => setCopyFromId(e.target.value)}>
              <option value="">Niet overnemen, lege agenda</option>
              {data.meetings.slice(0, 12).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title} ({new Date(m.startsAt).toLocaleDateString("nl-NL")})
                </option>
              ))}
            </select>
          </Field>
        )}
        <p className="small muted">De vergadering start als concept. Deelnemers zien de agenda pas nadat je publiceert.</p>
      </Form>
    </Modal>
  );
}

function EditOverleg({ data, onClose, onSaved }: { data: OverlegDetail; onClose: () => void; onSaved: () => void }) {
  const user = useUser();
  const [name, setName] = useState(data.overleg.name);
  const [description, setDescription] = useState(data.overleg.description);
  const [archived, setArchived] = useState(data.overleg.archived);
  return (
    <Modal title="Overleg bewerken" onClose={onClose}>
      <Form
        onCancel={onClose}
        onSubmit={async () => {
          const body: Record<string, unknown> = { name, description };
          if (user.isAdmin) body.archived = archived;
          await api(`/api/overleggen/${data.overleg.id}`, { method: "PATCH", body });
          onSaved();
        }}
      >
        <Field label="Naam">
          <input className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Omschrijving">
          <textarea className="input" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {user.isAdmin && (
          <label className="check">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
            Gearchiveerd (blijft raadpleegbaar, verdwijnt uit de overzichten)
          </label>
        )}
      </Form>
    </Modal>
  );
}

function Members({ data, canEdit, onChanged }: { data: OverlegDetail; canEdit: boolean; onChanged: () => void }) {
  const user = useUser();
  const run = useRun();
  const directory = useLoad<{ users: { id: string; name: string; email: string }[] }>(canEdit ? "/api/users/directory" : null);
  const [addId, setAddId] = useState("");
  const [addRole, setAddRole] = useState<Role>("deelnemer");
  const base = `/api/overleggen/${data.overleg.id}/members`;
  const candidates = (directory.data?.users ?? []).filter((u) => !data.members.some((m) => m.id === u.id));

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Deelnemers</h2>
        <span className="muted small">
          {data.members.length} {data.members.length === 1 ? "persoon" : "personen"}
        </span>
      </div>
      {data.members.length ? (
        <ul className="list">
          {data.members.map((m) => (
            <li key={m.id} style={{ alignItems: "center" }}>
              <div className="grow">
                <strong>{m.name}</strong>
                <div className="meta">
                  <span>{m.email}</span>
                  {!m.hasPassword && <span className="badge warm">Uitnodiging nog niet geaccepteerd</span>}
                  {m.active === false && <span className="badge">Geblokkeerd</span>}
                </div>
              </div>
              {canEdit ? (
                <>
                  <select
                    className="input"
                    style={{ width: "auto" }}
                    aria-label={`Rol van ${m.name}`}
                    value={m.role}
                    onChange={async (e) => {
                      if (await run(() => api(`${base}/${m.id}`, { method: "PUT", body: { role: e.target.value } }), "Rol gewijzigd")) onChanged();
                    }}
                  >
                    <option value="deelnemer">Deelnemer</option>
                    <option value="secretaris">Secretaris</option>
                  </select>
                  <Button
                    variant="danger"
                    icon="trash"
                    aria-label={`${m.name} verwijderen uit dit overleg`}
                    onClick={async () => {
                      if (!window.confirm(`${m.name} uit dit overleg halen? Het account zelf blijft bestaan.`)) return;
                      if (await run(() => api(`${base}/${m.id}`, { method: "DELETE" }), "Deelnemer verwijderd")) onChanged();
                    }}
                  />
                </>
              ) : (
                <span className={`badge ${m.role === "secretaris" ? "accent" : ""}`}>{m.role === "secretaris" ? "Secretaris" : "Deelnemer"}</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="Nog geen deelnemers" />
      )}
      {canEdit && (
        <div className="card-body stack" style={{ borderTop: "1px solid var(--line)" }}>
          <form
            className="row"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!addId) return;
              if (await run(() => api(`${base}/${addId}`, { method: "PUT", body: { role: addRole } }), "Deelnemer toegevoegd")) {
                setAddId("");
                onChanged();
              }
            }}
          >
            <select className="input grow" style={{ minWidth: 200 }} aria-label="Persoon toevoegen" value={addId} onChange={(e) => setAddId(e.target.value)}>
              <option value="">Kies een persoon om toe te voegen…</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </select>
            <select className="input" style={{ width: "auto" }} aria-label="Rol" value={addRole} onChange={(e) => setAddRole(e.target.value as Role)}>
              <option value="deelnemer">Deelnemer</option>
              <option value="secretaris">Secretaris</option>
            </select>
            <Button type="submit" icon="plus" disabled={!addId}>
              Toevoegen
            </Button>
          </form>
          <p className="small muted">
            De secretaris beheert agenda, notulen, besluiten en deelnemers. Deelnemers lezen mee, leveren stukken aan en melden hun eigen acties af.{" "}
            {user.isAdmin ? (
              <>
                Staat iemand er niet tussen? Maak eerst een account aan onder <Link to="/beheer">Beheer</Link>.
              </>
            ) : (
              "Staat iemand er niet tussen? Vraag de beheerder om een account aan te maken."
            )}
          </p>
        </div>
      )}
    </section>
  );
}

export default function OverlegPage() {
  const { id } = useParams();
  const user = useUser();
  const [sp] = useSearchParams();
  const tab = TABS.some(([key]) => key === sp.get("tab")) ? sp.get("tab")! : "vergaderingen";
  const { data, loading, error, reload } = useLoad<OverlegDetail>(`/api/overleggen/${id}`);
  const decisions = useLoad<{ decisions: Decision[] }>(tab === "besluiten" ? `/api/decisions?overleg=${id}` : null);
  const [allActions, setAllActions] = useState(false);
  const actions = useLoad<{ actions: Action[] }>(tab === "acties" ? `/api/actions?overleg=${id}${allActions ? "&status=alle" : ""}` : null);
  const [modal, setModal] = useState<"meeting" | "edit" | null>(null);

  const canEdit = data?.role === "secretaris";
  const now = Date.now() - 3 * 3600_000;
  const upcoming = (data?.meetings ?? []).filter((m) => new Date(m.startsAt).getTime() >= now).reverse();
  const past = (data?.meetings ?? []).filter((m) => new Date(m.startsAt).getTime() < now);

  return (
    <div className="page">
      <Loader loading={loading} error={error}>
        {data && (
          <>
            <div className="page-head">
              <div>
                <div className="crumb">
                  <Link to="/overleggen">Overleggen</Link>
                </div>
                <h1>{data.overleg.name}</h1>
                {data.overleg.description && <p className="lead pre">{data.overleg.description}</p>}
                {data.overleg.archived && <span className="badge">Gearchiveerd</span>}
              </div>
              {canEdit && (
                <div className="actions">
                  <Button variant="secondary" icon="edit" onClick={() => setModal("edit")}>
                    Bewerken
                  </Button>
                  <Button icon="plus" onClick={() => setModal("meeting")}>
                    Nieuwe vergadering
                  </Button>
                </div>
              )}
            </div>

            <nav className="tabs" aria-label="Onderdelen van dit overleg">
              {TABS.map(([key, label]) => (
                <Link key={key} to={`?tab=${key}`} replace className={tab === key ? "active" : ""} aria-current={tab === key ? "page" : undefined}>
                  {label}
                </Link>
              ))}
            </nav>

            {tab === "vergaderingen" && (
              <>
                <section className="card">
                  <div className="card-head">
                    <h2 className="section-title">Gepland</h2>
                  </div>
                  {upcoming.length ? (
                    <ul className="list">
                      {upcoming.map((m) => (
                        <MeetingRow key={m.id} m={m} />
                      ))}
                    </ul>
                  ) : (
                    <Empty title="Geen vergadering gepland">{canEdit && "Plan de volgende met Nieuwe vergadering."}</Empty>
                  )}
                </section>
                {past.length > 0 && (
                  <section className="card">
                    <div className="card-head">
                      <h2 className="section-title">Geweest</h2>
                    </div>
                    <ul className="list">
                      {past.map((m) => (
                        <MeetingRow key={m.id} m={m} past />
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}

            {tab === "besluiten" && (
              <section className="card">
                <div className="card-head">
                  <h2 className="section-title">Besluitenlijst</h2>
                </div>
                <Loader loading={decisions.loading} error={decisions.error}>
                  <DecisionTable decisions={decisions.data?.decisions ?? []} />
                </Loader>
              </section>
            )}

            {tab === "acties" && (
              <section className="card">
                <div className="card-head">
                  <h2 className="section-title">Actielijst</h2>
                  <label className="check small">
                    <input type="checkbox" checked={allActions} onChange={(e) => setAllActions(e.target.checked)} />
                    Toon ook afgeronde acties
                  </label>
                </div>
                <Loader loading={actions.loading} error={actions.error}>
                  <ActionList actions={actions.data?.actions ?? []} userId={user.id} onChanged={actions.reload} emptyTitle="Geen openstaande acties" />
                </Loader>
              </section>
            )}

            {tab === "stukken" && (
              <section className="card">
                <div className="card-head">
                  <h2 className="section-title">Vaste stukken</h2>
                  {canEdit && <UploadButton target={{ overlegId: data.overleg.id }} onDone={reload} />}
                </div>
                {data.documents.length ? (
                  <div className="card-body">
                    <DocList docs={data.documents} canManage={() => canEdit} onChanged={reload} />
                  </div>
                ) : (
                  <Empty title="Nog geen vaste stukken">
                    Stukken die niet bij één vergadering horen: reglement, jaarplan, begroting, contracten.
                  </Empty>
                )}
              </section>
            )}

            {tab === "leden" && <Members data={data} canEdit={canEdit} onChanged={reload} />}

            {modal === "meeting" && <NewMeeting data={data} onClose={() => setModal(null)} />}
            {modal === "edit" && (
              <EditOverleg
                data={data}
                onClose={() => setModal(null)}
                onSaved={() => {
                  setModal(null);
                  void reload();
                }}
              />
            )}
          </>
        )}
      </Loader>
    </div>
  );
}
