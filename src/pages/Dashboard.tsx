import { Link } from "react-router-dom";
import { useAuth, useUser } from "../auth";
import { StartCard } from "../components/StartCard";
import { ActionList } from "../components/Records";
import { DocList } from "../components/Docs";
import {
  daysUntil,
  firstName,
  fmtDate,
  fmtDay,
  monthShort,
  timeRange,
  type Action,
  type Decision,
  type Doc,
  type MeetingSummary,
} from "../lib";
import { Empty, Icon, Loader, useLoad } from "../ui";

type OpenBallot = { id: string; title: string; closesOn: string | null; overlegId: string; overlegName: string };
type Dashboard = { upcoming: MeetingSummary[]; myActions: Action[]; recentDecisions: Decision[]; recentDocuments: Doc[]; openBallots: OpenBallot[] };

export function MeetingRow({ m, past }: { m: MeetingSummary; past?: boolean }) {
  const soon = past ? "" : daysUntil(m.startsAt);
  return (
    <li>
      <div className={`dateblock ${past ? "past" : ""}`} aria-hidden="true">
        <b>{new Date(m.startsAt).getDate()}</b>
        <span>{monthShort(m.startsAt)}</span>
      </div>
      <div className="grow">
        <div className="row">
          <Link className="title" to={`/vergaderingen/${m.id}`}>
            {m.title}
          </Link>
          {m.live && (
            <Link className="live-badge" to={`/vergaderingen/${m.id}/live`}>
              <span className="live-pulse" />
              Nu bezig: meelopen
            </Link>
          )}
          {m.status === "concept" && <span className="badge warm">Concept</span>}
          {m.status === "afgerond" && <span className="badge">Afgerond</span>}
          {soon && !m.live && <span className="badge accent">{soon}</span>}
          {m.myAttendance === "afwezig" && <span className="badge warm">Afgemeld</span>}
        </div>
        <div className="meta">
          {m.overlegName && <span>{m.overlegName}</span>}
          <span>
            <Icon name="clock" size={14} />
            {fmtDate(m.startsAt)}, {timeRange(m.startsAt, m.durationMin)}
          </span>
          {m.location && (
            <span>
              <Icon name="pin" size={14} />
              {m.location}
            </span>
          )}
          <span>
            {m.itemCount} {m.itemCount === 1 ? "agendapunt" : "agendapunten"} · {m.documentCount} {m.documentCount === 1 ? "stuk" : "stukken"}
          </span>
        </div>
      </div>
    </li>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Goedemorgen" : h < 18 ? "Goedemiddag" : "Goedenavond";
}

export default function DashboardPage() {
  const user = useUser();
  const { org, systemIssues } = useAuth();
  const { data, loading, error, reload } = useLoad<Dashboard>("/api/dashboard");
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>
            {greeting()}, {firstName(user.name)}
          </h1>
          <p className="lead">
            Je komende vergaderingen, openstaande acties en de laatste stukken van <strong>{org?.name}</strong>.
          </p>
        </div>
      </div>

      {user.isAdmin && !!systemIssues?.length && (
        <div className="notice warm" role="status">
          <strong>Werkt niet volgens de laatste systeemcontrole:</strong> {systemIssues.join(", ")}.{" "}
          <Link to="/beheer?tab=instellingen">Bekijk wat er aan de hand is</Link>.
        </div>
      )}

      <StartCard key={org?.id} />

      <Loader loading={loading} error={error}>
        {data && (
          <>
            {data.openBallots.length > 0 && (
              <section className="card">
                <div className="card-head">
                  <h2 className="section-title">Je stem wordt gevraagd</h2>
                  <span className="badge warm">
                    {data.openBallots.length} {data.openBallots.length === 1 ? "stemronde" : "stemrondes"}
                  </span>
                </div>
                <ul className="list">
                  {data.openBallots.map((b) => (
                    <li key={b.id}>
                      <div className="grow">
                        <Link className="title" to={`/overleggen/${b.overlegId}?tab=stemrondes`}>
                          {b.title}
                        </Link>
                        <div className="meta">
                          <span>{b.overlegName}</span>
                          {b.closesOn && <span>stemmen tot en met {fmtDay(b.closesOn)}</span>}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="card">
              <div className="card-head">
                <h2 className="section-title">Komende vergaderingen</h2>
                <Link to="/overleggen">Alle overleggen</Link>
              </div>
              {data.upcoming.length ? (
                <ul className="list">
                  {data.upcoming.map((m) => (
                    <MeetingRow key={m.id} m={m} />
                  ))}
                </ul>
              ) : (
                <Empty title="Geen vergaderingen gepland">
                  {org?.role === "beheerder" ? (
                    <>
                      Maak een <Link to="/overleggen">overleg</Link> aan en plan daar de eerste vergadering.
                    </>
                  ) : (
                    "Zodra de secretaris een agenda publiceert, staat die hier."
                  )}
                </Empty>
              )}
            </section>

            <div className="grid-2">
              <section className="card">
                <div className="card-head">
                  <h2 className="section-title">Mijn openstaande acties</h2>
                  <Link to="/acties">Alle acties</Link>
                </div>
                <ActionList actions={data.myActions} userId={user.id} onChanged={reload} emptyTitle="Kortweg: niets meer te doen." />
              </section>

              <div className="stack" style={{ gap: 24 }}>
                <section className="card">
                  <div className="card-head">
                    <h2 className="section-title">Laatste stukken</h2>
                  </div>
                  {data.recentDocuments.length ? (
                    <div className="card-body">
                      <DocList docs={data.recentDocuments} canManage={() => false} onChanged={reload} />
                    </div>
                  ) : (
                    <Empty title="Nog geen stukken" />
                  )}
                </section>

                <section className="card">
                  <div className="card-head">
                    <h2 className="section-title">Recente besluiten</h2>
                    <Link to="/besluiten">Besluitenlijst</Link>
                  </div>
                  {data.recentDecisions.length ? (
                    <ul className="list">
                      {data.recentDecisions.map((d) => (
                        <li key={d.id}>
                          <strong className="nr-pill">{d.number}</strong>
                          <div className="grow">
                            <Link className="title" to={`/vergaderingen/${d.meetingId}`}>
                              <span className={d.status === "ingetrokken" ? "strike" : ""}>{d.text}</span>
                            </Link>
                            <div className="meta">
                              <span>{d.overlegName}</span>
                              <span>{fmtDay(d.decidedOn)}</span>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Empty title="Nog geen besluiten" />
                  )}
                </section>
              </div>
            </div>
          </>
        )}
      </Loader>
    </div>
  );
}
