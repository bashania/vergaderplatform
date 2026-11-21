import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { api } from "../api";
import { useAuth, useUser } from "../auth";
import { LinkModal, type LinkInfo } from "../components/LinkModal";
import type { Role } from "../lib";
import { BeslotenBadge, Button, Empty, Field, Form, Loader, useLoad, useRun, useToast } from "../ui";

type Person = {
  id: string;
  name: string;
  email: string;
  active: boolean;
  activated: boolean;
  isAdmin: boolean;
  hasPasskey: boolean;
  overleggen: { id: string; name: string; role: Role; besloten: boolean; open: boolean }[];
};

type Besloten = { id: string; name: string; archived: boolean; parentName: string | null; memberCount: number; secretarissen: string[]; mine: boolean };

type AiInfo = { enabled: boolean; available: boolean; month: { calls: number; inputTokens: number; outputTokens: number } };
type Added = { name: string; email: string; created: boolean } & Partial<LinkInfo>;

/** Beheer van één organisatie: wie mag erin, en wie beheert haar. Alleen voor beheerders van die organisatie. */
export default function OrganisatiePage() {
  const { org, refresh } = useAuth();
  const user = useUser();
  const run = useRun();
  const toast = useToast();
  const base = `/api/organisations/${org?.id}`;
  const { data, loading, error, reload } = useLoad<{ people: Person[] }>(org?.role === "beheerder" ? `${base}/people` : null);
  const [name, setName] = useState(org?.name ?? "");
  const [email, setEmail] = useState("");
  const [personName, setPersonName] = useState("");
  const [link, setLink] = useState<LinkInfo | null>(null);
  const ai = useLoad<AiInfo>(org?.role === "beheerder" ? `${base}/ai` : null);

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
                    {!p.activated && <span className="badge warm">Uitnodiging nog niet geaccepteerd</span>}
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
                          {!p.activated && <span className="badge warm">Nog niet geactiveerd</span>}
                          {p.activated && (p.hasPasskey ? <span className="badge accent">Passkey</span> : <span className="badge">Geen passkey</span>)}
                          {!p.active && <span className="badge">Geblokkeerd</span>}
                        </div>
                      </td>
                      <td className="small">
                        {p.overleggen.length
                          ? p.overleggen.map((o) => (
                              <div key={o.id}>
                                {o.open ? <Link to={`/overleggen/${o.id}?tab=leden`}>{o.name}</Link> : o.name}
                                {o.role === "secretaris" ? " (secretaris)" : ""}
                                {o.besloten ? " · besloten" : ""}
                              </div>
                            ))
                          : "Geen overleg"}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 2, justifyContent: "flex-end" }}>
                          {!p.activated && p.active && (
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

        <BeslotenCard base={base} people={people} />

        <section className="card">
          <div className="card-head">
            <h2 className="section-title">Tweestapsverificatie</h2>
            {org.requirePasskey ? <span className="badge accent">Passkey verplicht</span> : <span className="badge">Niet verplicht</span>}
          </div>
          <div className="card-body stack">
            <p>
              Stel je een passkey verplicht, dan komt alleen wie met een passkey is ingelogd nog bij <strong>{org.name}</strong>. Een wachtwoord alleen is dan niet
              genoeg. Geschikt voor overleggen met vertrouwelijke stukken, zoals cijfers of personeelszaken.
            </p>
            <p className="small muted">
              {people.filter((p) => p.hasPasskey).length} van de {people.length} personen hebben al een passkey. Wie er nog geen heeft, krijgt bij het openen van
              deze organisatie de vraag er een aan te maken.
            </p>
            {user.strong ? (
              <div>
                <Button
                  variant={org.requirePasskey ? "secondary" : "primary"}
                  icon="lock"
                  onClick={async () => {
                    const next = !org.requirePasskey;
                    if (next && !window.confirm(`Passkey verplicht stellen voor ${org.name}? Deelnemers zonder passkey moeten er eerst een aanmaken.`)) return;
                    if (await run(() => api(base, { method: "PATCH", body: { requirePasskey: next } }), next ? "Passkey is nu verplicht" : "Passkey is niet meer verplicht")) {
                      await refresh();
                    }
                  }}
                >
                  {org.requirePasskey ? "Passkey niet meer verplichten" : "Passkey verplicht stellen"}
                </Button>
              </div>
            ) : (
              <div className="notice">
                Log zelf eerst in met een passkey om dit te wijzigen. Zo sluit je jezelf niet buiten. Een passkey maak je aan onder <Link to="/account">Mijn account</Link>.
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2 className="section-title">AI-assistent</h2>
            {org.aiEnabled ? <span className="badge accent">Aan</span> : <span className="badge">Uit</span>}
          </div>
          <div className="card-body stack">
            <p>
              De assistent vat stukken samen ter voorbereiding, maakt concept-notulen uit het transcript van een opname en stelt besluiten en acties voor uit
              de notulen. Hij legt zelf niets vast: de secretaris beoordeelt elk voorstel en neemt het over of niet.
            </p>
            <div className="notice">
              <strong>Wat je hiermee toestaat.</strong> Notulen, stukken en transcripten waarop iemand de assistent gebruikt, gaan voor verwerking naar een taalmodel
              (Claude van Anthropic, via Netlify). Dat gebeurt buiten dit platform en mogelijk buiten de EU. Netlify geeft aan de inhoud niet te bewaren. Zet de assistent
              niet aan als jullie stukken dat niet toelaten, bijvoorbeeld bij personeelsdossiers of medische gegevens.
            </div>
            {ai.data && !ai.data.available ? (
              <p className="small muted">Op dit platform is geen taalmodel beschikbaar. De platformbeheerder kan dat controleren onder Platformbeheer, Instellingen.</p>
            ) : (
              <>
                {ai.data && org.aiEnabled && (
                  <p className="small muted">
                    Deze maand: {ai.data.month.calls} {ai.data.month.calls === 1 ? "verzoek" : "verzoeken"} aan de assistent. Per persoon geldt een limiet
                    van 30 per uur, per organisatie 300 per dag.
                  </p>
                )}
                <div>
                  <Button
                    variant={org.aiEnabled ? "secondary" : "primary"}
                    icon="spark"
                    onClick={async () => {
                      const next = !org.aiEnabled;
                      if (next && !window.confirm(`AI-assistent aanzetten voor ${org.name}? Notulen en stukken waarop hij wordt gebruikt, gaan dan naar een taalmodel buiten dit platform.`)) return;
                      if (await run(() => api(base, { method: "PATCH", body: { aiEnabled: next } }), next ? "AI-assistent staat aan" : "AI-assistent staat uit")) {
                        await refresh();
                        void ai.reload();
                      }
                    }}
                  >
                    {org.aiEnabled ? "AI-assistent uitzetten" : "AI-assistent aanzetten"}
                  </Button>
                </div>
              </>
            )}
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

/** Besloten overleggen: de beheerder ziet dat ze bestaan en wie de secretaris is, niet de inhoud. */
function BeslotenCard({ base, people }: { base: string; people: Person[] }) {
  const run = useRun();
  const { data, reload } = useLoad<{ overleggen: Besloten[] }>(`${base}/besloten`);
  const [pick, setPick] = useState<Record<string, string>>({});
  const list = data?.overleggen ?? [];
  if (!list.length) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Besloten overleggen</h2>
        <BeslotenBadge />
      </div>
      <ul className="list">
        {list.map((o) => (
          <li key={o.id} style={{ alignItems: "center", flexWrap: "wrap" }}>
            <div className="grow" style={{ minWidth: 200 }}>
              <strong>{o.mine ? <Link to={`/overleggen/${o.id}`}>{o.name}</Link> : o.name}</strong>
              <div className="meta">
                {o.parentName && <span>Kring van {o.parentName}</span>}
                <span>
                  {o.memberCount} {o.memberCount === 1 ? "deelnemer" : "deelnemers"}
                </span>
                {o.secretarissen.length ? <span>Secretaris: {o.secretarissen.join(", ")}</span> : <span className="badge warm">Geen secretaris</span>}
                {o.archived && <span className="badge">Gearchiveerd</span>}
              </div>
            </div>
            {o.secretarissen.length === 0 && (
              <div className="row" style={{ gap: 4 }}>
                <select
                  className="input"
                  style={{ width: "auto" }}
                  aria-label={`Nieuwe secretaris voor ${o.name}`}
                  value={pick[o.id] ?? ""}
                  onChange={(e) => setPick({ ...pick, [o.id]: e.target.value })}
                >
                  <option value="">Kies een persoon</option>
                  {people
                    .filter((p) => p.active)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
                <Button
                  small
                  disabled={!pick[o.id]}
                  onClick={async () => {
                    if (await run(() => api(`${base}/besloten/${o.id}/secretaris`, { method: "POST", body: { userId: pick[o.id] } }), "Secretaris aangewezen")) reload();
                  }}
                >
                  Aanwijzen
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="card-body" style={{ borderTop: "1px solid var(--line)" }}>
        <p className="small muted">
          Een besloten overleg is er alleen voor de deelnemers. Als beheerder zie je dat het bestaat en wie eraan deelneemt, niet de agenda, stukken, notulen,
          besluiten of acties. Heeft een besloten overleg geen secretaris meer, dan wijs je hier een nieuwe aan; dat staat in het logboek van het platform.
        </p>
      </div>
    </section>
  );
}
