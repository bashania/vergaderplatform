import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth, useUser } from "../auth";
import { fmtDateTime, type Overleg, type Role } from "../lib";
import { Button, CopyBox, Empty, Field, Form, Icon, Loader, Modal, useLoad, useRun } from "../ui";

type AdminUser = {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  hasPassword: boolean;
  memberships: { overlegId: string; overlegName: string; role: Role }[];
};

type LinkInfo = { name: string; email: string; token: string; purpose: "invite" | "reset"; validDays: number };

const TABS = [
  ["gebruikers", "Gebruikers"],
  ["instellingen", "Instellingen"],
  ["logboek", "Logboek"],
] as const;

/** Toont de eenmalige link. Er wordt niets automatisch gemaild: de beheerder verstuurt de link zelf. */
function LinkModal({ link, onClose }: { link: LinkInfo; onClose: () => void }) {
  const user = useUser();
  const url = `${window.location.origin}/welkom#${link.token}`;
  const invite = link.purpose === "invite";
  const subject = invite ? "Uitnodiging voor het vergaderplatform" : "Nieuw wachtwoord voor het vergaderplatform";
  const body = invite
    ? `Beste ${link.name},\n\nJe hebt toegang gekregen tot het vergaderplatform, met de agenda's, stukken, besluiten en acties van onze overleggen.\n\nKies via deze link je wachtwoord:\n${url}\n\nDe link is ${link.validDays} dagen geldig en werkt één keer.\n\nMet vriendelijke groet,\n${user.name}`
    : `Beste ${link.name},\n\nVia deze link kies je een nieuw wachtwoord voor het vergaderplatform:\n${url}\n\nDe link is ${link.validDays} dagen geldig en werkt één keer.\n\nMet vriendelijke groet,\n${user.name}`;
  return (
    <Modal title={invite ? "Uitnodigingslink" : "Link voor nieuw wachtwoord"} onClose={onClose}>
      <div className="stack">
        <p>
          Stuur deze link naar <strong>{link.name}</strong> ({link.email}). De link is {link.validDays} dagen geldig en werkt één keer.
        </p>
        <CopyBox value={url} />
        <div className="notice">Het platform verstuurt zelf geen e-mail. Deze link is alleen nu zichtbaar; maak een nieuwe als je hem kwijt bent.</div>
        <div className="form-foot">
          <a className="btn secondary" href={`mailto:${link.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}>
            <Icon name="mail" size={17} />
            Open in mijn mailprogramma
          </a>
          <Button onClick={onClose}>Klaar</Button>
        </div>
      </div>
    </Modal>
  );
}

function NewUser({ overleggen, onClose, onCreated }: { overleggen: Overleg[]; onClose: () => void; onCreated: (link: LinkInfo) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [roles, setRoles] = useState<Record<string, Role | "">>({});
  return (
    <Modal title="Nieuwe gebruiker" onClose={onClose}>
      <Form
        submitLabel="Aanmaken en link tonen"
        onCancel={onClose}
        onSubmit={async () => {
          const memberships = Object.entries(roles)
            .filter(([, role]) => role)
            .map(([overlegId, role]) => ({ overlegId, role }));
          const res = await api<Omit<LinkInfo, "name" | "email">>("/api/users", { method: "POST", body: { name, email, isAdmin, memberships } });
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
        {overleggen.length > 0 && (
          <div className="field">
            <span>Neemt deel aan</span>
            {overleggen.map((o) => (
              <div className="spread" key={o.id}>
                <span>{o.name}</span>
                <select
                  className="input"
                  style={{ width: "auto" }}
                  aria-label={`Rol in ${o.name}`}
                  value={roles[o.id] ?? ""}
                  onChange={(e) => setRoles({ ...roles, [o.id]: e.target.value as Role | "" })}
                >
                  <option value="">Geen deelnemer</option>
                  <option value="deelnemer">Deelnemer</option>
                  <option value="secretaris">Secretaris</option>
                </select>
              </div>
            ))}
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          Beheerder (ziet alle overleggen en beheert gebruikers)
        </label>
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
              Beheerder
            </label>
            <label className="check">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              Account actief (uitvinken blokkeert de toegang direct)
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
  const overleggen = useLoad<{ overleggen: Overleg[] }>("/api/overleggen");
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
        <h2 className="section-title">Gebruikers</h2>
        <Button icon="plus" onClick={() => setCreating(true)}>
          Nieuwe gebruiker
        </Button>
      </div>
      <Loader loading={loading} error={error}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Naam</th>
                <th>Status</th>
                <th>Overleggen</th>
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
                      ) : u.hasPassword ? (
                        <span className="badge accent">Actief</span>
                      ) : (
                        <span className="badge warm">Uitgenodigd</span>
                      )}
                      {u.isAdmin && <span className="badge info">Beheerder</span>}
                    </div>
                  </td>
                  <td className="small">
                    {u.memberships.length
                      ? u.memberships.map((m) => (
                          <div key={m.overlegId}>
                            <Link to={`/overleggen/${m.overlegId}?tab=leden`}>{m.overlegName}</Link>
                            {m.role === "secretaris" ? " (secretaris)" : ""}
                          </div>
                        ))
                      : "Geen"}
                  </td>
                  <td className="small nowrap">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "Nog nooit"}</td>
                  <td>
                    <div className="row" style={{ gap: 2, flexWrap: "nowrap", justifyContent: "flex-end" }}>
                      {u.active && (
                        <Button small variant="ghost" icon="mail" onClick={() => newLink(u)}>
                          {u.hasPassword ? "Resetlink" : "Uitnodigingslink"}
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
        <NewUser
          overleggen={(overleggen.data?.overleggen ?? []).filter((o) => !o.archived)}
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

type Diagnostics = { functionRegion: string; dbHost: string; dbRoundTripMs: number; dbVersion: string; blobRegion: string };

function Settings() {
  const { orgName, refresh } = useAuth();
  const run = useRun();
  const [name, setName] = useState(orgName);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2 className="section-title">Organisatie</h2>
        </div>
        <div className="card-body">
          <Form
            onSubmit={async () => {
              await api("/api/settings", { method: "PUT", body: { orgName: name } });
              await refresh();
            }}
          >
            <Field label="Naam organisatie" hint="Staat in het menu, op het inlogscherm en op afgedrukte agenda's.">
              <input className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </Form>
        </div>
      </section>
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
    </>
  );
}

const ACTION_LABEL: Record<string, string> = {
  "POST /api/users": "Gebruiker aangemaakt",
  "PATCH /api/users/:id": "Gebruiker gewijzigd",
  "POST /api/users/:id/token": "Uitnodigings- of resetlink gemaakt",
  "PUT /api/settings": "Instellingen gewijzigd",
  "POST /api/overleggen": "Overleg aangemaakt",
  "PATCH /api/overleggen/:id": "Overleg gewijzigd",
  "PUT /api/overleggen/:id/members/:userId": "Deelnemer toegevoegd of rol gewijzigd",
  "DELETE /api/overleggen/:id/members/:userId": "Deelnemer verwijderd",
  "POST /api/overleggen/:id/meetings": "Vergadering aangemaakt",
  "PATCH /api/meetings/:id": "Vergadering gewijzigd",
  "DELETE /api/meetings/:id": "Vergadering verwijderd",
  "POST /api/meetings/:id/items": "Agendapunt toegevoegd",
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
        <span className="muted small">Laatste 200 wijzigingen</span>
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
  const tab = TABS.some(([key]) => key === sp.get("tab")) ? sp.get("tab")! : "gebruikers";
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Beheer</h1>
          <p className="lead">Accounts aanmaken, toegang intrekken en nagaan wie wat heeft gewijzigd.</p>
        </div>
      </div>
      <nav className="tabs" aria-label="Onderdelen van beheer">
        {TABS.map(([key, label]) => (
          <Link key={key} to={`?tab=${key}`} replace className={tab === key ? "active" : ""} aria-current={tab === key ? "page" : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      {tab === "gebruikers" && <Users />}
      {tab === "instellingen" && <Settings />}
      {tab === "logboek" && <AuditLog />}
    </div>
  );
}
