import { Link } from "react-router-dom";
import { useUser } from "../auth";
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

type Dashboard = { upcoming: MeetingSummary[]; myActions: Action[]; recentDecisions: Decision[]; recentDocuments: Doc[] };

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
          {m.status === "concept" && <span className="badge warm">Concept</span>}
          {m.status === "afgerond" && <span className="badge">Afgerond</span>}
          {soon && <span className="badge accent">{soon}</span>}
          {m.myAttendance === "afwezig" && <span className="badge warm">Afgemeld</span>}
        </div>
        <div className="meta">
          {m.overlegName && <span>{[m.organisation, m.overlegName].filter(Boolean).join(" · ")}</span>}
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
  const { data, loading, error, reload } = useLoad<Dashboard>("/api/dashboard");
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>
            {greeting()}, {firstName(user.name)}
          </h1>
          <p className="lead">Je komende vergaderingen, je openstaande acties en de laatste stukken.</p>
        </div>
      </div>

      <Loader loading={loading} error={error}>
        {data && (
          <>
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
                  {user.isAdmin ? (
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
                <ActionList actions={data.myActions} userId={user.id} onChanged={reload} emptyTitle="Je hebt geen openstaande acties" />
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
                          <strong className="num nowrap" style={{ color: "var(--ink)" }}>
                            {d.number}
                          </strong>
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
