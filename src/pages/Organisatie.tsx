import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { LinkModal, type LinkInfo } from "../components/LinkModal";
import type { Role } from "../lib";
import { Button, Empty, Field, Form, Loader, useLoad, useRun, useToast } from "../ui";

type Person = {
  id: string;
  name: string;
  email: string;
  active: boolean;
  hasPassword: boolean;
  isAdmin: boolean;
  overleggen: { id: string; name: string; role: Role }[];
};

type Added = { name: string; email: string; created: boolean } & Partial<LinkInfo>;

/** Beheer van één organisatie: wie mag erin, en wie beheert haar. Alleen voor beheerders van die organisatie. */
export default function OrganisatiePage() {
  const { org, refresh } = useAuth();
  const run = useRun();
  const toast = useToast();
  const base = `/api/organisations/${org?.id}`;
  const { data, loading, error, reload } = useLoad<{ people: Person[] }>(org?.role === "beheerder" ? `${base}/people` : null);
  const [name, setName] = useState(org?.name ?? "");
  const [email, setEmail] = useState("");
  const [personName, setPersonName] = useState("");
  const [link, setLink] = useState<LinkInfo | null>(null);

  if (!org || org.role !== "beheerder") return <Navigate to="/" replace />;

  const people = data?.people ?? [];
  const admins = people.filter((p) => p.isAdmin);

  async function invite(p: Person) {
    await run(async () => setLink(await api<LinkInfo>(`${base}/people/${p.id}/invite`, { method: "POST" })));
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Toegang en beheer</h1>
          <p className="lead">
            Wie bij <strong>{org.name}</strong> kan, en wie deze organisatie beheert. Mensen uit andere organisaties zien hier niets van.
          </p>
        </div>
      </div>

      <Loader loading={loading} error={error}>
        <section className="card">
          <div className="card-head">
            <h2 className="section-title">Beheerders</h2>
            <span className="muted small">Zien en beheren alle overleggen van deze organisatie</span>
          </div>
          <ul className="list">
            {admins.map((p) => (
              <li key={p.id} style={{ alignItems: "center" }}>
                <div className="grow">
                  <strong>{p.name}</strong>
                  <div className="meta">
                    <span>{p.email}</span>
                    {!p.hasPassword && <span className="badge warm">Uitnodiging nog niet geaccepteerd</span>}
                  </div>
                </div>
                <Button
                  variant="danger"
                  small
                  disabled={admins.length === 1}
                  title={admins.length === 1 ? "Voeg eerst een andere beheerder toe" : undefined}
                  onClick={async () => {
                    if (!window.confirm(`${p.name} is daarna geen beheerder meer van ${org.name}. Deelname aan overleggen blijft staan.`)) return;
                    if (await run(() => api(`${base}/admins/${p.id}`, { method: "DELETE" }), "Beheerder verwijderd")) {
                      await refresh();
                      void reload();
                    }
                  }}
                >
                  Beheer intrekken
                </Button>
              </li>
            ))}
          </ul>
          <div className="card-body stack" style={{ borderTop: "1px solid var(--line)" }}>
            <h3>Beheerder toevoegen</h3>
            <Form
              submitLabel="Toevoegen"
              onSubmit={async () => {
                const res = await api<Added>(`${base}/admins`, { method: "POST", body: { email, name: personName } });
                setEmail("");
                setPersonName("");
                void reload();
                if (res.created && res.token) setLink(res as LinkInfo);
                else toast(`${res.name} is nu beheerder`);
              }}
            >
              <div className="form-row">
                <Field label="E-mailadres">
                  <input className="input" type="email" required maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Field label="Naam" hint="Alleen nodig als deze persoon nog geen account heeft.">
                  <input className="input" maxLength={120} value={personName} onChange={(e) => setPersonName(e.target.value)} />
                </Field>
              </div>
            </Form>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2 className="section-title">Iedereen met toegang</h2>
            <span className="muted small">
              {people.length} {people.length === 1 ? "persoon" : "personen"}
            </span>
          </div>
          {people.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Naam</th>
                    <th>Neemt deel aan</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.name}</strong>
                        <div className="small muted">{p.email}</div>
                        <div className="row" style={{ gap: 4, marginTop: 4 }}>
                          {p.isAdmin && <span className="badge accent">Beheerder</span>}
                          {!p.hasPassword && <span className="badge warm">Nog niet geactiveerd</span>}
                          {!p.active && <span className="badge">Geblokkeerd</span>}
                        </div>
                      </td>
                      <td className="small">
                        {p.overleggen.length
                          ? p.overleggen.map((o) => (
                              <div key={o.id}>
                                <Link to={`/overleggen/${o.id}?tab=leden`}>{o.name}</Link>
                                {o.role === "secretaris" ? " (secretaris)" : ""}
                              </div>
                            ))
                          : "Geen overleg"}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 2, justifyContent: "flex-end" }}>
                          {!p.hasPassword && p.active && (
                            <Button small variant="ghost" icon="mail" onClick={() => invite(p)}>
                              Uitnodigingslink
                            </Button>
                          )}
                          <Button
                            small
                            variant="danger"
                            onClick={async () => {
                              if (!window.confirm(`${p.name} verliest alle toegang tot ${org.name}: uit elk overleg en uit het beheer. Het account zelf blijft bestaan.`)) return;
                              if (await run(() => api(`${base}/people/${p.id}`, { method: "DELETE" }), "Toegang ingetrokken")) {
                                await refresh();
                                void reload();
                              }
                            }}
                          >
                            Toegang intrekken
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="Nog niemand" />
          )}
          <div className="card-body" style={{ borderTop: "1px solid var(--line)" }}>
            <p className="small muted">
              Deelnemers voeg je toe bij het overleg zelf, op het tabblad Deelnemers. Wachtwoord vergeten? Dat regelt de platformbeheerder met een resetlink.
            </p>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2 className="section-title">Naam van de organisatie</h2>
          </div>
          <div className="card-body">
            <Form
              onSubmit={async () => {
                await api(base, { method: "PATCH", body: { name } });
                await refresh();
                toast("Naam opgeslagen");
              }}
            >
              <Field label="Naam" hint="Staat in het menu en op afgedrukte agenda's en verslagen.">
                <input className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
            </Form>
          </div>
        </section>
      </Loader>
      {link && <LinkModal link={link} onClose={() => setLink(null)} />}
    </div>
  );
}
