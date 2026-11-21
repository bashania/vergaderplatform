import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { fmtDateTime, type Overleg } from "../lib";
import { BeslotenBadge, Button, Empty, Field, Form, Loader, Modal, useLoad } from "../ui";

function NewOverleg({ organisation, onClose }: { organisation: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [besloten, setBesloten] = useState(false);
  return (
    <Modal title={`Nieuw overleg bij ${organisation}`} onClose={onClose}>
      <Form
        submitLabel="Aanmaken"
        onCancel={onClose}
        onSubmit={async () => {
          const { id } = await api<{ id: string }>("/api/overleggen", { method: "POST", body: { name, description, besloten } });
          navigate(`/overleggen/${id}?tab=leden`);
        }}
      >
        <Field label="Naam" hint="Bijvoorbeeld: bestuursvergadering, MT-overleg, projectoverleg.">
          <input className="input" required autoFocus maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Omschrijving (optioneel)" hint="Doel, frequentie of vaste afspraken van dit overleg.">
          <textarea className="input" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={besloten} onChange={(e) => setBesloten(e.target.checked)} />
          Besloten overleg
        </label>
        <p className="small muted">
          {besloten
            ? "Alleen de deelnemers zien dit overleg. Beheerders van de organisatie zien dat het bestaat en wie eraan deelneemt, niet de inhoud. Je wordt zelf secretaris; haal je jezelf er later uit, dan kun je er ook zelf niet meer bij."
            : "Je wordt zelf secretaris van dit overleg. Daarna voeg je de deelnemers toe."}
        </p>
      </Form>
    </Modal>
  );
}

export default function OverleggenPage() {
  const { org } = useAuth();
  const { data, loading, error } = useLoad<{ overleggen: Overleg[] }>("/api/overleggen");
  const [creating, setCreating] = useState(false);
  const canCreate = org?.role === "beheerder";
  const active = data?.overleggen.filter((o) => !o.archived) ?? [];
  const archived = data?.overleggen.filter((o) => o.archived) ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Overleggen</h1>
          <p className="lead">
            De overleggen van <strong>{org?.name}</strong> waar je aan deelneemt. Elk overleg heeft eigen deelnemers, vergaderingen, besluiten en acties.
          </p>
        </div>
        {canCreate && (
          <Button icon="plus" onClick={() => setCreating(true)}>
            Nieuw overleg
          </Button>
        )}
      </div>

      <Loader loading={loading} error={error}>
        {active.length ? (
          <div className="grid-2">
            {active.map((o) => (
              <OverlegCard key={o.id} o={o} />
            ))}
          </div>
        ) : (
          <div className="card">
            <Empty title="Nog geen overleg">
              {canCreate ? "Maak het eerste overleg aan met de knop rechtsboven." : "Vraag de secretaris van je overleg om je toe te voegen."}
            </Empty>
          </div>
        )}
        {archived.length > 0 && (
          <section className="stack">
            <h2 className="section-title">Gearchiveerd</h2>
            <div className="grid-2">
              {archived.map((o) => (
                <OverlegCard key={o.id} o={o} />
              ))}
            </div>
          </section>
        )}
      </Loader>
      {creating && org && <NewOverleg organisation={org.name} onClose={() => setCreating(false)} />}
    </div>
  );
}

function OverlegCard({ o }: { o: Overleg }) {
  return (
    <article className="card">
      <div className="card-body stack" style={{ gap: 10 }}>
        <div className="spread">
          <h2>
            <Link to={`/overleggen/${o.id}`} style={{ color: "var(--ink)", textDecoration: "none" }}>
              {o.name}
            </Link>
          </h2>
          <span className="row" style={{ gap: 4 }}>
            {o.besloten && <BeslotenBadge />}
            {o.role === "secretaris" && <span className="badge accent">Secretaris</span>}
          </span>
        </div>
        {o.parentName && <p className="muted small">Besloten kring van {o.parentName}</p>}
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
