import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useUser } from "../auth";
import { fmtDateTime, type Overleg } from "../lib";
import { Button, Empty, Field, Form, Loader, Modal, useLoad } from "../ui";

/** Organisatie kiezen uit de bestaande namen of een nieuwe typen: voorkomt varianten van dezelfde naam. */
export function OrganisationField({ value, onChange, known }: { value: string; onChange: (v: string) => void; known: string[] }) {
  return (
    <Field label="Organisatie" hint="Bij welk bedrijf, welke opleiding of welke commissie hoort dit overleg? Staat op afgedrukte agenda's.">
      <input className="input" list="organisaties" maxLength={120} value={value} onChange={(e) => onChange(e.target.value)} />
      <datalist id="organisaties">
        {known.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </Field>
  );
}

export const organisationsOf = (overleggen: Overleg[]) =>
  [...new Set(overleggen.map((o) => o.organisation).filter(Boolean))].sort((a, b) => a.localeCompare(b, "nl"));

function NewOverleg({ known, onClose }: { known: string[]; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [organisation, setOrganisation] = useState("");
  const [description, setDescription] = useState("");
  return (
    <Modal title="Nieuw overleg" onClose={onClose}>
      <Form
        submitLabel="Aanmaken"
        onCancel={onClose}
        onSubmit={async () => {
          const { id } = await api<{ id: string }>("/api/overleggen", { method: "POST", body: { name, organisation, description } });
          navigate(`/overleggen/${id}?tab=leden`);
        }}
      >
        <Field label="Naam" hint="Bijvoorbeeld: MT-overleg, bestuursvergadering, projectoverleg.">
          <input className="input" required autoFocus maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <OrganisationField value={organisation} onChange={setOrganisation} known={known} />
        <Field label="Omschrijving (optioneel)" hint="Doel, frequentie of vaste afspraken van dit overleg.">
          <textarea className="input" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <p className="small muted">Je wordt zelf secretaris van dit overleg. Daarna voeg je de deelnemers toe.</p>
      </Form>
    </Modal>
  );
}

export default function OverleggenPage() {
  const user = useUser();
  const { data, loading, error } = useLoad<{ overleggen: Overleg[] }>("/api/overleggen");
  const [creating, setCreating] = useState(false);
  const all = data?.overleggen ?? [];
  const active = all.filter((o) => !o.archived);
  const archived = all.filter((o) => o.archived);

  // Groeperen per organisatie; overleggen zonder organisatie komen onderaan.
  const groups = [...organisationsOf(active), ""]
    .map((org) => ({ org, items: active.filter((o) => o.organisation === org) }))
    .filter((g) => g.items.length > 0);
  const showHeadings = groups.some((g) => g.org);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Overleggen</h1>
          <p className="lead">Elk overleg heeft zijn eigen deelnemers, vergaderingen, besluitenlijst en actielijst.</p>
        </div>
        {user.isAdmin && (
          <Button icon="plus" onClick={() => setCreating(true)}>
            Nieuw overleg
          </Button>
        )}
      </div>

      <Loader loading={loading} error={error}>
        {active.length === 0 && (
          <div className="card">
            <Empty title="Je neemt nog aan geen overleg deel">
              {user.isAdmin ? "Maak het eerste overleg aan met de knop rechtsboven." : "Vraag de secretaris van je overleg om je toe te voegen."}
            </Empty>
          </div>
        )}
        {groups.map((g) => (
          <section className="stack" key={g.org || "zonder"}>
            {showHeadings && <h2 className="section-title">{g.org || "Zonder organisatie"}</h2>}
            <div className="grid-2">
              {g.items.map((o) => (
                <OverlegCard key={o.id} o={o} />
              ))}
            </div>
          </section>
        ))}
        {archived.length > 0 && (
          <section className="stack">
            <h2 className="section-title">Gearchiveerd</h2>
            <div className="grid-2">
              {archived.map((o) => (
                <OverlegCard key={o.id} o={o} showOrganisation />
              ))}
            </div>
          </section>
        )}
      </Loader>
      {creating && <NewOverleg known={organisationsOf(all)} onClose={() => setCreating(false)} />}
    </div>
  );
}

function OverlegCard({ o, showOrganisation }: { o: Overleg; showOrganisation?: boolean }) {
  return (
    <article className="card">
      <div className="card-body stack" style={{ gap: 10 }}>
        <div className="spread">
          <h2>
            <Link to={`/overleggen/${o.id}`} style={{ color: "var(--ink)", textDecoration: "none" }}>
              {o.name}
            </Link>
          </h2>
          {o.role === "secretaris" && <span className="badge accent">Secretaris</span>}
        </div>
        {showOrganisation && o.organisation && <span className="sub-label">{o.organisation}</span>}
        {o.description && <p className="muted small pre">{o.description}</p>}
        <div className="meta">
          <span>
            {o.memberCount} {o.memberCount === 1 ? "deelnemer" : "deelnemers"}
          </span>
          <span>
            {o.openActions} open {o.openActions === 1 ? "actie" : "acties"}
          </span>
        </div>
        <div>
          {o.nextMeeting ? (
            <>
              <span className="sub-label">Eerstvolgende vergadering</span>
              <div>
                <Link to={`/vergaderingen/${o.nextMeeting.id}`}>{o.nextMeeting.title}</Link>
                <span className="muted"> · {fmtDateTime(o.nextMeeting.startsAt)}</span>
              </div>
            </>
          ) : (
            <span className="muted small">Geen vergadering gepland</span>
          )}
        </div>
      </div>
    </article>
  );
}
