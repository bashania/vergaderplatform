import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth, useUser } from "../auth";
import { parseAgenda } from "../agendaParse";
import { AgendaPaste } from "../components/AgendaPaste";
import { DocList, UploadButton } from "../components/Docs";
import { LinkModal, type LinkInfo } from "../components/LinkModal";
import { ActionList, DecisionTable } from "../components/Records";
import { SuggestionsCard } from "../components/Suggestions";
import { fromLocalInput, toLocalInput, type Action, type Decision, type Doc, type Member, type MeetingSummary, type Role } from "../lib";
import { Button, Empty, Field, Form, Loader, Modal, useLoad, useRun } from "../ui";
import { AGENDA_TEMPLATES } from "../templates";
import { MeetingRow } from "./Dashboard";

type OverlegDetail = {
  overleg: { id: string; name: string; description: string; archived: boolean; organisationId: string; organisationName: string };
  /** De gebruiker is beheerder van de organisatie van dit overleg. */
  orgAdmin: boolean;
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

/**
 * Datum voor de volgende vergadering na `from`: hetzelfde ritme als tussen de vorige twee
 * (anders vier weken), op dezelfde tijd, en altijd in de toekomst.
 */
function nextStart(from: MeetingSummary, meetings: MeetingSummary[]): string {
  const day = 86_400_000;
  const start = new Date(from.startsAt).getTime();
  const before = meetings.map((m) => new Date(m.startsAt).getTime()).filter((t) => t < start).sort((a, b) => b - a)[0];
  let interval = before ? Math.round((start - before) / day) : 28;
  if (interval < 1 || interval > 400) interval = 28;
  const next = new Date(start);
  do next.setDate(next.getDate() + interval);
  while (next.getTime() < Date.now());
  return toLocalInput(next.toISOString());
}

function NewMeeting({ data, from, onClose }: { data: OverlegDetail; from?: MeetingSummary; onClose: () => void }) {
  const navigate = useNavigate();
  const last = from ?? data.meetings[0];
  const [title, setTitle] = useState(from?.title ?? data.overleg.name);
  const [startsAt, setStartsAt] = useState(() => (from ? nextStart(from, data.meetings) : defaultStart()));
  const [durationMin, setDurationMin] = useState(last?.durationMin ?? 60);
  const [location, setLocation] = useState(last?.location ?? "");
  const [onlineUrl, setOnlineUrl] = useState("");
  // Waar de agenda vandaan komt: "" (leeg), "m:<id>" (vorige vergadering) of "t:<sleutel>" (standaardagenda).
  const [source, setSource] = useState(last ? `m:${last.id}` : "");
  const [agenda, setAgenda] = useState("");
  const pasted = parseAgenda(agenda);
  const template = AGENDA_TEMPLATES.find((t) => source === `t:${t.key}`);
  return (
    <Modal title={from ? "Volgende vergadering plannen" : "Nieuwe vergadering"} onClose={onClose}>
      <Form
        submitLabel="Aanmaken"
        onCancel={onClose}
        onSubmit={async () => {
          const { id } = await api<{ id: string }>(`/api/overleggen/${data.overleg.id}/meetings`, {
            method: "POST",
            body: {
              title,
              startsAt: fromLocalInput(startsAt),
              durationMin,
              location,
              onlineUrl,
              // Een geplakte agenda gaat voor op een standaardagenda of overnemen van een vorige vergadering.
              ...(pasted.length ? { items: pasted } : template ? { items: template.items } : { copyFromId: source.startsWith("m:") ? source.slice(2) : null }),
            },
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
        <AgendaPaste value={agenda} onChange={setAgenda} label="Bestaande agenda plakken (optioneel)" />
        {pasted.length === 0 && (
          <Field
            label="Agenda"
            hint={template ? `${template.items.length} agendapunten als startpunt; je past ze daarna aan.` : "Overnemen neemt de agendapunten over, zonder notulen, stukken en besluiten."}
          >
            <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Lege agenda</option>
              {data.meetings.length > 0 && (
                <optgroup label="Overnemen van">
                  {data.meetings.slice(0, 12).map((m) => (
                    <option key={m.id} value={`m:${m.id}`}>
                      {m.title} ({new Date(m.startsAt).toLocaleDateString("nl-NL")})
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Standaardagenda">
                {AGENDA_TEMPLATES.map((t) => (
                  <option key={t.key} value={`t:${t.key}`}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
        )}
        <p className="small muted">De vergadering start als concept. Deelnemers zien de agenda pas nadat je publiceert.</p>
      </Form>
    </Modal>
  );
}

function EditOverleg({ data, onClose, onSaved }: { data: OverlegDetail; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(data.overleg.name);
  const [description, setDescription] = useState(data.overleg.description);
  const [archived, setArchived] = useState(data.overleg.archived);
  return (
    <Modal title="Overleg bewerken" onClose={onClose}>
      <Form
        onCancel={onClose}
        onSubmit={async () => {
          const body: Record<string, unknown> = { name, description };
          if (data.orgAdmin) body.archived = archived;
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
        {data.orgAdmin && (
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
  const run = useRun();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("deelnemer");
  const [link, setLink] = useState<LinkInfo | null>(null);
  const base = `/api/overleggen/${data.overleg.id}/members`;

  type Added = { name: string; email: string; created: boolean; pending: boolean } & Partial<LinkInfo>;

  async function add() {
    const res = await api<Added>(base, { method: "POST", body: { email, name, role } });
    setEmail("");
    setName("");
    setRole("deelnemer");
    onChanged();
    // Nieuw account: direct de uitnodigingslink tonen om te versturen.
    if (res.created && res.token) setLink(res as LinkInfo);
  }

  async function invite(m: Member) {
    await run(async () => setLink(await api<LinkInfo>(`${base}/${m.id}/invite`, { method: "POST" })));
  }

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
            <li key={m.id} style={{ alignItems: "center", flexWrap: "wrap" }}>
              <div className="grow" style={{ minWidth: 180 }}>
                <strong>{m.name}</strong>
                <div className="meta">
                  <span>{m.email}</span>
                  {!m.activated && <span className="badge warm">Uitnodiging nog niet geaccepteerd</span>}
                  {m.active === false && <span className="badge">Geblokkeerd</span>}
                </div>
              </div>
              {canEdit ? (
                <div className="row" style={{ gap: 4 }}>
                  {!m.activated && m.active !== false && (
                    <Button small variant="ghost" icon="mail" onClick={() => invite(m)}>
                      Uitnodigingslink
                    </Button>
                  )}
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
                </div>
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
          <h3>Deelnemer toevoegen</h3>
          <Form submitLabel="Toevoegen" onSubmit={add}>
            <div className="form-row">
              <Field label="E-mailadres">
                <input className="input" type="email" required maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Naam" hint="Alleen nodig als deze persoon nog geen account heeft.">
                <input className="input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Rol">
                <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  <option value="deelnemer">Deelnemer</option>
                  <option value="secretaris">Secretaris</option>
                </select>
              </Field>
            </div>
          </Form>
          <p className="small muted">
            Heeft iemand al een account, dan wordt die direct gekoppeld. Anders krijg je een uitnodigingslink om te versturen. De secretaris beheert agenda,
            notulen, besluiten en deelnemers; deelnemers lezen mee, leveren stukken aan en melden hun eigen acties af.
          </p>
        </div>
      )}
      {link && <LinkModal link={link} onClose={() => setLink(null)} />}
    </section>
  );
}

export default function OverlegPage() {
  const { id } = useParams();
  const user = useUser();
  const [sp, setSp] = useSearchParams();
  const tab = TABS.some(([key]) => key === sp.get("tab")) ? sp.get("tab")! : "vergaderingen";
  const { data, loading, error, reload } = useLoad<OverlegDetail>(`/api/overleggen/${id}`);
  const decisions = useLoad<{ decisions: Decision[] }>(tab === "besluiten" ? `/api/decisions?overleg=${id}` : null);
  const [allActions, setAllActions] = useState(false);
  const actions = useLoad<{ actions: Action[] }>(tab === "acties" ? `/api/actions?overleg=${id}${allActions ? "&status=alle" : ""}` : null);
  const [modal, setModal] = useState<"meeting" | "edit" | null>(null);

  // Geopend via een directe link: werk dan verder in de organisatie van dit overleg.
  const { ensureOrg } = useAuth();
  const organisationId = data?.overleg.organisationId;
  useEffect(() => {
    if (organisationId) ensureOrg(organisationId);
  }, [organisationId, ensureOrg]);

  const canEdit = data?.role === "secretaris";
  // Vanaf een vergadering doorgeklikt op "Volgende vergadering plannen": het formulier opent vooringevuld.
  const planFrom = canEdit ? data?.meetings.find((m) => m.id === sp.get("nieuw")) : undefined;
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
                {!data.overleg.archived && <SuggestionsCard overlegId={data.overleg.id} isSec={canEdit} meetings={data.meetings} onPlaced={reload} />}
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
            {planFrom && !modal && <NewMeeting data={data} from={planFrom} onClose={() => setSp({}, { replace: true })} />}
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
