import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth, useUser } from "../auth";
import { LinkModal, type LinkInfo } from "../components/LinkModal";
import { fmtDateTime } from "../lib";
import { Button, Empty, Field, Form, Loader, Modal, useLoad, useRun, useToast } from "../ui";

type AdminUser = {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  activated: boolean;
  /** Aantal passkeys van dit account. */
  passkeys: number;
  organisations: string[];
};

type AdminOrganisation = {
  id: string;
  name: string;
  archived: boolean;
  overlegCount: number;
  admins: { id: string; name: string; email: string }[];
};

type Added = { name: string; email: string; created: boolean } & Partial<LinkInfo>;

const TABS = [
  ["organisaties", "Organisaties"],
  ["gebruikers", "Accounts"],
  ["instellingen", "Instellingen"],
  ["logboek", "Logboek"],
] as const;

// ---------- organisaties ----------

function NewOrganisation({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  return (
    <Modal title="Nieuwe organisatie" onClose={onClose}>
      <Form
        submitLabel="Aanmaken"
        onCancel={onClose}
        onSubmit={async () => {
          const { id } = await api<{ id: string }>("/api/organisations", { method: "POST", body: { name } });
          onCreated(id);
        }}
      >
        <Field label="Naam" hint="Bijvoorbeeld de commissie, de school of het bedrijf. Elke organisatie is een eigen omgeving: deelnemers zien alleen hun eigen organisatie.">
          <input className="input" required autoFocus maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <p className="small muted">
          Je wordt zelf beheerder van de nieuwe organisatie, zodat je haar kunt inrichten. Overdragen kan daarna: voeg een andere beheerder toe en haal jezelf weg.
        </p>
      </Form>
    </Modal>
  );
}

function ManageOrganisation({ org, onClose, onChanged }: { org: AdminOrganisation; onClose: () => void; onChanged: () => void }) {
  const run = useRun();
  const toast = useToast();
  const { refresh } = useAuth();
  const base = `/api/organisations/${org.id}`;
  const [name, setName] = useState(org.name);
  const [archived, setArchived] = useState(org.archived);
  const [email, setEmail] = useState("");
  const [personName, setPersonName] = useState("");
  const [link, setLink] = useState<LinkInfo | null>(null);

  const changed = async () => {
    await refresh();
    onChanged();
  };

  if (link) return <LinkModal link={link} onClose={() => setLink(null)} />;
  return (
    <Modal title={org.name} onClose={onClose}>
      <div className="stack" style={{ gap: 24 }}>
        <Form
          onSubmit={async () => {
            await api(base, { method: "PATCH", body: { name, archived } });
            await changed();
            toast("Organisatie opgeslagen");
          }}
        >
          <Field label="Naam">
            <input className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
            Gearchiveerd (verdwijnt uit de organisatiekiezer, gegevens blijven bewaard)
          </label>
        </Form>

        <div className="stack">
          <h3>Beheerders</h3>
          {org.admins.map((a) => (
            <div className="spread" key={a.id}>
              <span>
                {a.name} <span className="muted small">({a.email})</span>
              </span>
              <Button
                small
                variant="danger"
                disabled={org.admins.length === 1}
                title={org.admins.length === 1 ? "Voeg eerst een andere beheerder toe" : undefined}
                onClick={async () => {
                  if (!window.confirm(`${a.name} is daarna geen beheerder meer van ${org.name}.`)) return;
                  if (await run(() => api(`${base}/admins/${a.id}`, { method: "DELETE" }), "Beheerder verwijderd")) await changed();
                }}
              >
                Verwijderen
              </Button>
            </div>
          ))}
          <Form
            submitLabel="Beheerder toevoegen"
            onSubmit={async () => {
              const res = await api<Added>(`${base}/admins`, { method: "POST", body: { email, name: personName } });
              setEmail("");
              setPersonName("");
              await changed();
              if (res.created && res.token) setLink(res as LinkInfo);
              else toast(`${res.name} is nu beheerder van ${org.name}`);
            }}
          >
            <div className="form-row">
              <Field label="E-mailadres">
                <input className="input" type="email" required maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Naam" hint="Alleen bij een nieuw account.">
                <input className="input" maxLength={120} value={personName} onChange={(e) => setPersonName(e.target.value)} />
              </Field>
            </div>
          </Form>
        </div>
      </div>
    </Modal>
  );
}

function Organisations() {
  const { refresh, selectOrg } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useLoad<{ organisations: AdminOrganisation[] }>("/api/organisations");
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  const list = data?.organisations ?? [];
  const managed = list.find((o) => o.id === managing);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Organisaties</h2>
        <Button icon="plus" onClick={() => setCreating(true)}>
          Nieuwe organisatie
        </Button>
      </div>
      <Loader loading={loading} error={error}>
        {list.length ? (
          <ul className="list">
            {list.map((o) => (
              <li key={o.id} style={{ alignItems: "center" }}>
                <div className="grow">
                  <div className="row">
                    <strong>{o.name}</strong>
                    {o.archived && <span className="badge">Gearchiveerd</span>}
                  </div>
                  <div className="meta">
                    <span>
                      {o.overlegCount} {o.overlegCount === 1 ? "overleg" : "overleggen"}
                    </span>
                    <span>Beheer: {o.admins.map((a) => a.name).join(", ") || "niemand"}</span>
                  </div>
                </div>
                <Button variant="secondary" small icon="edit" onClick={() => setManaging(o.id)}>
                  Beheren
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="Nog geen organisaties">Maak de eerste aan. Elke organisatie krijgt eigen overleggen, deelnemers en beheerders.</Empty>
        )}
        <div className="card-body" style={{ borderTop: "1px solid var(--line)" }}>
          <p className="small muted">
            Als platformbeheerder maak je organisaties aan en wijs je beheerders aan. De overleggen en stukken van een organisatie zie je alleen als je er zelf beheerder
            of deelnemer van bent.
          </p>
        </div>
      </Loader>
      {creating && (
        <NewOrganisation
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await refresh();
            selectOrg(id);
            void reload();
            toast("Organisatie aangemaakt. Je werkt nu in deze organisatie.");
          }}
        />
      )}
      {managed && <ManageOrganisation key={managed.id + managed.admins.length} org={managed} onClose={() => setManaging(null)} onChanged={reload} />}
    </section>
  );
}

// ---------- accounts ----------

function NewAdmin({ onClose, onCreated }: { onClose: () => void; onCreated: (link: LinkInfo) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  return (
    <Modal title="Platformbeheerder toevoegen" onClose={onClose}>
      <Form
        submitLabel="Aanmaken en link tonen"
        onCancel={onClose}
        onSubmit={async () => {
          const res = await api<Omit<LinkInfo, "name" | "email">>("/api/users", { method: "POST", body: { name, email, isAdmin: true } });
          onCreated({ ...res, name, email });
        }}
      >
        <div className="form-row">
          <Field label="Naam">
            <input className="input" required autoFocus maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="E-mailadres">
            <input className="input" type="email" required maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
        <p className="small muted">
          Een platformbeheerder maakt organisaties aan, blokkeert accounts en maakt resetlinks. Deelnemers voeg je niet hier toe, maar bij het overleg zelf.
        </p>
      </Form>
    </Modal>
  );
}

function EditUser({ target, onClose, onSaved }: { target: AdminUser; onClose: () => void; onSaved: () => void }) {
  const me = useUser();
  const self = target.id === me.id;
  const [name, setName] = useState(target.name);
  const [email, setEmail] = useState(target.email);
  const [isAdmin, setIsAdmin] = useState(target.isAdmin);
  const [active, setActive] = useState(target.active);
  const run = useRun();
  return (
    <Modal title={`${target.name} bewerken`} onClose={onClose}>
      <Form
        onCancel={onClose}
        onSubmit={async () => {
          const body: Record<string, unknown> = { name, email };
          if (!self) Object.assign(body, { isAdmin, active });
          await api(`/api/users/${target.id}`, { method: "PATCH", body });
          onSaved();
        }}
        extra={
          // Herstel bij een verloren apparaat: passkeys wissen, daarna een resetlink sturen.
          target.passkeys > 0 &&
          !self && (
            <Button
              variant="danger"
              onClick={async () => {
                if (!window.confirm(`Alle passkeys van ${target.name} wissen? Doe dit alleen als diegene zijn apparaat kwijt is. Stuur daarna een resetlink.`)) return;
                if (await run(() => api(`/api/users/${target.id}/passkeys`, { method: "DELETE" }), "Passkeys gewist")) onSaved();
              }}
            >
              Passkeys wissen
            </Button>
          )
        }
      >
        <div className="form-row">
          <Field label="Naam">
            <input className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="E-mailadres">
            <input className="input" type="email" required maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
        {self ? (
          <p className="small muted">Je eigen beheerdersrol en status kun je niet zelf wijzigen; dat voorkomt dat je jezelf buitensluit.</p>
        ) : (
          <>
            <label className="check">
              <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
              Platformbeheerder
            </label>
            <label className="check">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              Account actief (uitvinken blokkeert de toegang tot alle organisaties direct)
            </label>
          </>
        )}
      </Form>
    </Modal>
  );
}

function Users() {
  const run = useRun();
  const { data, loading, error, reload } = useLoad<{ users: AdminUser[] }>("/api/users");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [link, setLink] = useState<LinkInfo | null>(null);

  async function newLink(u: AdminUser) {
    await run(async () => {
      const res = await api<Omit<LinkInfo, "name" | "email">>(`/api/users/${u.id}/token`, { method: "POST" });
      setLink({ ...res, name: u.name, email: u.email });
    });
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Accounts</h2>
        <Button variant="secondary" icon="plus" onClick={() => setCreating(true)}>
          Platformbeheerder toevoegen
        </Button>
      </div>
      <Loader loading={loading} error={error}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Naam</th>
                <th>Status</th>
                <th>Organisaties</th>
                <th>Laatst ingelogd</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.name}</strong>
                    <div className="small muted">{u.email}</div>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {!u.active ? (
                        <span className="badge">Geblokkeerd</span>
                      ) : u.activated ? (
                        <span className="badge accent">Actief</span>
                      ) : (
                        <span className="badge warm">Uitgenodigd</span>
                      )}
                      {u.isAdmin && <span className="badge info">Platformbeheerder</span>}
                      {u.passkeys > 0 && <span className="badge accent">Passkey</span>}
                    </div>
                  </td>
                  <td className="small">{u.organisations.length ? u.organisations.map((o) => <div key={o}>{o}</div>) : "Geen"}</td>
                  <td className="small nowrap">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "Nog nooit"}</td>
                  <td>
                    <div className="row" style={{ gap: 2, flexWrap: "nowrap", justifyContent: "flex-end" }}>
                      {u.active && (
                        <Button small variant="ghost" icon="mail" onClick={() => newLink(u)}>
                          {u.activated ? "Resetlink" : "Uitnodigingslink"}
                        </Button>
                      )}
                      <Button small variant="ghost" icon="edit" aria-label={`${u.name} bewerken`} onClick={() => setEditing(u)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Loader>
      {creating && (
        <NewAdmin
          onClose={() => setCreating(false)}
          onCreated={(l) => {
            setCreating(false);
            setLink(l);
            void reload();
          }}
        />
      )}
      {editing && (
        <EditUser
          target={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
      {link && <LinkModal link={link} onClose={() => setLink(null)} />}
    </section>
  );
}

// ---------- instellingen en logboek ----------

import { MailSettingsCard } from "../components/Mail";

type AiTest = { ok: boolean; model: string; ms?: number; reply?: string; error?: string };
type Diagnostics = { functionRegion: string; dbHost: string; dbRoundTripMs: number; dbVersion: string; blobRegion: string };

function Settings() {
  const { orgName, refresh } = useAuth();
  const run = useRun();
  const toast = useToast();
  const [name, setName] = useState(orgName);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [aiTest, setAiTest] = useState<AiTest | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2 className="section-title">Weergave</h2>
        </div>
        <div className="card-body">
          <Form
            onSubmit={async () => {
              await api("/api/settings", { method: "PUT", body: { orgName: name } });
              await refresh();
              toast("Opgeslagen");
            }}
          >
            <Field label="Naam onder de titel (optioneel)" hint="Staat in het menu en op het inlogscherm, voor iedereen. Laat leeg als het platform voor meerdere organisaties is.">
              <input className="input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </Form>
        </div>
      </section>
      <MailSettingsCard />

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">Techniek</h2>
          <Button variant="secondary" small onClick={() => run(async () => setDiag(await api<Diagnostics>("/api/admin/diagnostics")))}>
            Controleer
          </Button>
        </div>
        <div className="card-body">
          {diag ? (
            <table className="table">
              <tbody>
                <tr>
                  <td>Regio van de server</td>
                  <td className="num">{diag.functionRegion}</td>
                </tr>
                <tr>
                  <td>Database</td>
                  <td className="num" style={{ overflowWrap: "anywhere" }}>
                    {diag.dbHost}
                  </td>
                </tr>
                <tr>
                  <td>Reactietijd database</td>
                  <td className="num">{diag.dbRoundTripMs} ms</td>
                </tr>
                <tr>
                  <td>Regio van de stukken</td>
                  <td className="num">{diag.blobRegion}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="muted">Laat zien in welke regio de server draait en waar de gegevens en stukken staan.</p>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">AI-assistent</h2>
          <Button
            variant="secondary"
            small
            busy={aiBusy}
            onClick={async () => {
              setAiBusy(true);
              await run(async () => setAiTest(await api<AiTest>("/api/admin/ai/test", { method: "POST", body: {} })));
              setAiBusy(false);
            }}
          >
            {aiBusy ? "Testen…" : "Test de koppeling"}
          </Button>
        </div>
        <div className="card-body stack">
          <p>
            De assistent vat stukken samen en stelt besluiten en acties voor uit de notulen. Hij staat per organisatie uit, tot een beheerder van die
            organisatie hem aanzet onder Toegang en beheer. De test hieronder stuurt één kort verzoek naar het taalmodel en kost een fractie van een cent.
          </p>
          {aiTest &&
            (aiTest.ok ? (
              <div className="notice accent">
                <strong>De koppeling werkt.</strong> Model {aiTest.model}, antwoord in {aiTest.ms} ms.
              </div>
            ) : (
              <div className="form-error" role="alert" style={{ overflowWrap: "anywhere" }}>
                <strong>De koppeling werkt niet.</strong> {aiTest.error} (model: {aiTest.model})
              </div>
            ))}
        </div>
      </section>
    </>
  );
}

const ACTION_LABEL: Record<string, string> = {
  "POST /api/users": "Account aangemaakt",
  "PATCH /api/users/:id": "Account gewijzigd",
  "POST /api/users/:id/token": "Uitnodigings- of resetlink gemaakt",
  "PUT /api/settings": "Instellingen gewijzigd",
  "POST /api/organisations": "Organisatie aangemaakt",
  "PATCH /api/organisations/:id": "Organisatie gewijzigd",
  "POST /api/organisations/:id/admins": "Beheerder van organisatie toegevoegd",
  "DELETE /api/organisations/:id/admins/:userId": "Beheerder van organisatie verwijderd",
  "DELETE /api/organisations/:id/people/:userId": "Toegang tot organisatie ingetrokken",
  "POST /api/organisations/:id/people/:userId/invite": "Uitnodigingslink gemaakt",
  "POST /api/overleggen": "Overleg aangemaakt",
  "PATCH /api/overleggen/:id": "Overleg gewijzigd",
  "POST /api/overleggen/:id/members": "Deelnemer toegevoegd",
  "POST /api/overleggen/:id/members/:userId/invite": "Uitnodigingslink gemaakt",
  "PUT /api/overleggen/:id/members/:userId": "Rol van deelnemer gewijzigd",
  "DELETE /api/overleggen/:id/members/:userId": "Deelnemer verwijderd",
  "POST /api/overleggen/:id/meetings": "Vergadering aangemaakt",
  "PATCH /api/meetings/:id": "Vergadering gewijzigd",
  "DELETE /api/meetings/:id": "Vergadering verwijderd",
  "POST /api/meetings/:id/items": "Agendapunt toegevoegd",
  "POST /api/meetings/:id/items/bulk": "Agenda geplakt",
  "PATCH /api/items/:id": "Agendapunt of notulen gewijzigd",
  "DELETE /api/items/:id": "Agendapunt verwijderd",
  "PUT /api/meetings/:id/order": "Volgorde agenda gewijzigd",
  "PUT /api/meetings/:id/attendance": "Aanwezigheid gewijzigd",
  "POST /api/meetings/:id/decisions": "Besluit vastgelegd",
  "PATCH /api/decisions/:id": "Besluit gewijzigd",
  "DELETE /api/decisions/:id": "Besluit verwijderd",
  "POST /api/meetings/:id/actions": "Actie vastgelegd",
  "PATCH /api/actions/:id": "Actie gewijzigd",
  "DELETE /api/actions/:id": "Actie verwijderd",
  "POST /api/documents": "Upload gestart",
  "POST /api/documents/:id/complete": "Stuk toegevoegd",
  "PATCH /api/documents/:id": "Stuk gewijzigd",
  "DELETE /api/documents/:id": "Stuk verwijderd",
  "POST /api/account/password": "Eigen wachtwoord gewijzigd",
  "PATCH /api/account": "Eigen naam gewijzigd",
};

function AuditLog() {
  const { data, loading, error } = useLoad<{ entries: { id: number; at: string; userName: string; action: string }[] }>("/api/audit");
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Logboek</h2>
        <span className="muted small">Laatste 200 wijzigingen, zonder inhoud</span>
      </div>
      <Loader loading={loading} error={error}>
        {data?.entries.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Wanneer</th>
                  <th>Wie</th>
                  <th>Wat</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap small">{fmtDateTime(e.at)}</td>
                    <td>{e.userName}</td>
                    <td>{ACTION_LABEL[e.action] ?? e.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="Nog geen wijzigingen vastgelegd" />
        )}
      </Loader>
    </section>
  );
}

export default function BeheerPage() {
  const [sp] = useSearchParams();
  const tab = TABS.some(([key]) => key === sp.get("tab")) ? sp.get("tab")! : "organisaties";
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Platformbeheer</h1>
          <p className="lead">Organisaties aanmaken, accounts blokkeren of herstellen, en nagaan wie wat heeft gewijzigd.</p>
        </div>
      </div>
      <nav className="tabs" aria-label="Onderdelen van platformbeheer">
        {TABS.map(([key, label]) => (
          <Link key={key} to={`?tab=${key}`} replace className={tab === key ? "active" : ""} aria-current={tab === key ? "page" : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      {tab === "organisaties" && <Organisations />}
      {tab === "gebruikers" && <Users />}
      {tab === "instellingen" && <Settings />}
      {tab === "logboek" && <AuditLog />}
    </div>
  );
}
