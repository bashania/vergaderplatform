import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth, useUser } from "../auth";
import { Icon, useLoad } from "../ui";

type Start = { overleggen: number; firstOverlegId: string | null; members: number; published: number; calendar: boolean; aiEnabled: boolean; aiAvailable: boolean; mailEnabled: boolean; mailPossible: boolean };

const key = (orgId: string) => `vp.start.${orgId}`;
function hidden(orgId: string): boolean {
  try {
    return window.localStorage.getItem(key(orgId)) === "1";
  } catch {
    return false;
  }
}

/** Overzicht, voor beheerders: wat er nog moet gebeuren om de organisatie in gebruik te nemen. Verdwijnt als alles gedaan is. */
export function StartCard() {
  const user = useUser();
  const { org } = useAuth();
  const [dismissed, setDismissed] = useState(() => (org ? hidden(org.id) : true));
  const { data } = useLoad<Start>(org?.role === "beheerder" && !dismissed ? `/api/organisations/${org.id}/start` : null);
  if (!org || !data || dismissed) return null;

  const overleg = data.firstOverlegId ? `/overleggen/${data.firstOverlegId}` : "/overleggen";
  const steps: { done: boolean; label: string; text: string; to: string; optional?: boolean }[] = [
    { done: data.overleggen > 0, label: "Maak een overleg aan", text: "Bijvoorbeeld het MT-overleg, het werkoverleg of een projectoverleg.", to: "/overleggen" },
    { done: data.members > 0, label: "Voeg de deelnemers toe", text: "Op het tabblad Deelnemers van het overleg, met hun e-mailadres.", to: `${overleg}?tab=leden` },
    { done: data.published > 0, label: "Plan een vergadering en publiceer de agenda", text: "Kies een standaardagenda of plak een bestaande agenda.", to: overleg },
    { done: data.calendar, label: "Zet je vergaderingen in je eigen agenda", text: "Eén link voor Outlook, Google Agenda of je telefoon.", to: "/account" },
    ...(data.mailPossible && user.isAdmin
      ? [{ done: data.mailEnabled, label: "Stel e-mail in", text: "Dan verstuurt het platform uitnodigingen, agenda's, verslagen en herinneringen.", to: "/beheer?tab=instellingen" }]
      : []),
    ...(data.aiAvailable
      ? [{ done: data.aiEnabled, label: "Beslis over de AI-assistent", text: "Samenvattingen, concept-notulen en voorstellen voor besluiten en acties.", to: "/organisatie", optional: true }]
      : []),
  ];
  if (steps.every((s) => s.done || s.optional)) return null;
  const done = steps.filter((s) => s.done).length;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Aan de slag met {org.name}</h2>
        <span className="muted small">
          {done} van {steps.length} gedaan
        </span>
      </div>
      <ul className="list">
        {steps.map((s) => (
          <li key={s.label} style={{ alignItems: "center" }}>
            <span className={`step-mark ${s.done ? "done" : ""}`} aria-hidden="true">
              {s.done && <Icon name="check" size={14} />}
            </span>
            <div className="grow">
              {s.done ? (
                <span className="muted">{s.label}</span>
              ) : (
                <Link className="title" to={s.to}>
                  {s.label}
                </Link>
              )}
              {!s.done && (
                <div className="small muted">
                  {s.text}
                  {s.optional ? " Naar keuze." : ""}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="card-body spread" style={{ borderTop: "1px solid var(--line)" }}>
        <span className="small muted">
          Meer weten? Lees de <Link to="/uitleg">uitleg</Link>.
        </span>
        <button
          type="button"
          className="btn ghost small"
          onClick={() => {
            try {
              window.localStorage.setItem(key(org.id), "1");
            } catch {
              // Zonder opslag blijft de lijst bij een volgend bezoek gewoon staan.
            }
            setDismissed(true);
          }}
        >
          Verbergen
        </button>
      </div>
    </section>
  );
}
