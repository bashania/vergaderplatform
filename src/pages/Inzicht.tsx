import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { Button, Empty, Loader, useLoad, useRun } from "../ui";

type Row = {
  id: string;
  name: string;
  meetings: number;
  plannedMin: number;
  personMin: number;
  timedSpentSec: number;
  timedPlannedMin: number;
  timedMeetings: number;
  decisions: number;
  actionsCreated: number;
  actionsDone: number;
  doneWithDeadline: number;
  doneOnTime: number;
  actionsOpen: number;
  actionsLate: number;
};
type Data = { months: number; hourlyRate: number | null; overleggen: Row[]; people: { id: string; name: string; open: number; late: number }[] };

const nl = (n: number, digits = 0) => n.toLocaleString("nl-NL", { maximumFractionDigits: digits });
const hours = (min: number) => nl(min / 60, min < 600 ? 1 : 0);
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");

function Stat({ value, label, hint, tone }: { value: string; label: string; hint?: string; tone?: "warm" }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <b>{value}</b>
      <span>{label}</span>
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** Voor beheerders: hoeveel er wordt vergaderd, of het uitloopt en of afspraken worden nagekomen. */
export default function InzichtPage() {
  const { org } = useAuth();
  const run = useRun();
  const [months, setMonths] = useState(12);
  const base = `/api/organisations/${org?.id}`;
  const { data, loading, error, reload } = useLoad<Data>(org?.role === "beheerder" ? `${base}/insights?months=${months}` : null);
  const [rate, setRate] = useState<string | null>(null);

  if (!org || org.role !== "beheerder") return <Navigate to="/" replace />;

  const rows = data?.overleggen ?? [];
  const sum = (key: keyof Row) => rows.reduce((n, r) => n + (r[key] as number), 0);
  const overrun = sum("timedPlannedMin") ? (sum("timedSpentSec") / 60 - sum("timedPlannedMin")) / sum("timedPlannedMin") : null;
  const cost = data?.hourlyRate ? (sum("personMin") / 60) * data.hourlyRate : null;
  const rateValue = rate ?? (data?.hourlyRate ? String(data.hourlyRate) : "");

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Inzicht</h1>
          <p className="lead">
            Hoeveel er bij <strong>{org.name}</strong> wordt vergaderd, of vergaderingen uitlopen en of afspraken worden nagekomen.
          </p>
        </div>
        <div className="actions">
          <select className="input" style={{ width: "auto" }} aria-label="Periode" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            <option value={3}>Afgelopen 3 maanden</option>
            <option value={6}>Afgelopen 6 maanden</option>
            <option value={12}>Afgelopen 12 maanden</option>
            <option value={24}>Afgelopen 2 jaar</option>
          </select>
        </div>
      </div>

      <Loader loading={loading} error={error}>
        {data && (
          <>
            <div className="stats">
              <Stat value={nl(sum("meetings"))} label="vergaderingen" hint={`${hours(sum("plannedMin"))} uur gepland`} />
              <Stat
                value={sum("personMin") ? hours(sum("personMin")) : "–"}
                label="persoonsuren"
                hint={sum("personMin") ? (cost ? `ongeveer € ${nl(cost)} aan tijd` : "duur maal aanwezigen") : "Leg aanwezigheid vast om dit te zien"}
              />
              <Stat
                value={overrun === null ? "–" : `${overrun > 0 ? "+" : ""}${Math.round(overrun * 100)}%`}
                label={overrun !== null && overrun < 0 ? "korter dan gepland" : "uitloop"}
                hint={overrun === null ? "Gebruik de vergadermodus om dit te meten" : `gemeten in ${sum("timedMeetings")} ${sum("timedMeetings") === 1 ? "vergadering" : "vergaderingen"}`}
                tone={overrun !== null && overrun > 0.15 ? "warm" : undefined}
              />
              <Stat value={nl(sum("decisions"))} label="besluiten" />
              <Stat value={pct(sum("doneOnTime"), sum("doneWithDeadline"))} label="acties op tijd af" hint={`${sum("doneOnTime")} van ${sum("doneWithDeadline")} met een deadline`} />
              <Stat value={nl(sum("actionsOpen"))} label="acties open" hint={sum("actionsLate") ? `${sum("actionsLate")} over de datum` : "geen over de datum"} tone={sum("actionsLate") ? "warm" : undefined} />
            </div>

            <section className="card">
              <div className="card-head">
                <h2 className="section-title">Per overleg</h2>
              </div>
              {rows.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Overleg</th>
                        <th>Vergaderingen</th>
                        <th>Uren</th>
                        <th>Besluiten</th>
                        <th>Acties af</th>
                        <th>Op tijd</th>
                        <th>Open</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <Link to={`/overleggen/${r.id}`}>{r.name}</Link>
                          </td>
                          <td className="num">{r.meetings}</td>
                          <td className="num">{hours(r.plannedMin)}</td>
                          <td className="num">{r.decisions}</td>
                          <td className="num">
                            {r.actionsDone} van {r.actionsCreated}
                          </td>
                          <td className="num">{pct(r.doneOnTime, r.doneWithDeadline)}</td>
                          <td className="num">
                            {r.actionsOpen}
                            {r.actionsLate > 0 && <span className="overdue"> ({r.actionsLate} te laat)</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="Nog geen overleggen" />
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2 className="section-title">Openstaande acties per persoon</h2>
                <Link to="/acties">Alle acties</Link>
              </div>
              {data.people.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Naam</th>
                        <th>Open</th>
                        <th>Over de datum</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.people.map((p) => (
                        <tr key={p.id}>
                          <td>{p.name}</td>
                          <td className="num">{p.open}</td>
                          <td className="num">{p.late ? <span className="overdue">{p.late}</span> : "0"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="Geen openstaande acties" />
              )}
              <div className="card-body" style={{ borderTop: "1px solid var(--line)" }}>
                <p className="small muted">Bedoeld om te zien waar het vastloopt en wie hulp of minder werk nodig heeft. Alleen beheerders zien dit overzicht.</p>
              </div>
            </section>

            <section className="card">
              <div className="card-head">
                <h2 className="section-title">Wat kost vergaderen?</h2>
              </div>
              <div className="card-body stack">
                <p>
                  Vul een gemiddeld uurtarief in en de persoonsuren hierboven worden omgerekend naar een bedrag. Een schatting om het gesprek te voeren, geen
                  boekhouding: het telt de geplande duur maal het aantal mensen dat als aanwezig is vastgelegd.
                </p>
                <div className="row">
                  <input
                    className="input"
                    style={{ width: 140 }}
                    type="number"
                    min={1}
                    max={1000}
                    placeholder="Bijv. 65"
                    aria-label="Gemiddeld uurtarief in euro"
                    value={rateValue}
                    onChange={(e) => setRate(e.target.value)}
                  />
                  <span className="muted">euro per uur</span>
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      if (await run(() => api(base, { method: "PATCH", body: { hourlyRate: rateValue === "" ? null : Number(rateValue) } }), "Uurtarief opgeslagen")) {
                        setRate(null);
                        void reload();
                      }
                    }}
                  >
                    Opslaan
                  </Button>
                </div>
              </div>
            </section>
          </>
        )}
      </Loader>
    </div>
  );
}
