import { Link, useSearchParams } from "react-router-dom";
import { canOpenDirect, fileUrl } from "../api";
import { fmtDate } from "../lib";
import { Empty, Loader, useLoad } from "../ui";

type Result = {
  type: "vergadering" | "agendapunt" | "besluit" | "actie" | "stuk";
  id: string;
  title: string;
  snippet: string;
  at: string;
  meetingId: string | null;
  overlegId: string;
  overlegName: string;
  size: number | null;
};

const TYPE_LABEL: Record<Result["type"], string> = {
  vergadering: "Vergadering",
  agendapunt: "Agendapunt",
  besluit: "Besluit",
  actie: "Actie",
  stuk: "Stuk",
};

export default function ZoekenPage() {
  const [sp] = useSearchParams();
  const term = (sp.get("q") ?? "").trim();
  const { data, loading, error } = useLoad<{ results: Result[] }>(term.length >= 2 ? `/api/search?q=${encodeURIComponent(term)}` : null);
  const results = data?.results ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Zoeken</h1>
          <p className="lead">
            {term.length >= 2 ? (
              <>
                Resultaten voor <strong>{term}</strong> in vergaderingen, agendapunten, notulen, besluiten, acties en bestandsnamen.
              </>
            ) : (
              "Typ minimaal twee tekens in het zoekveld in het menu."
            )}
          </p>
        </div>
      </div>
      {term.length >= 2 && (
        <section className="card">
          <Loader loading={loading} error={error}>
            {results.length ? (
              <ul className="list">
                {results.map((r) => {
                  // Stukken openen direct; al het andere gaat naar de vergadering.
                  const openFile = r.type === "stuk" && r.size !== null && canOpenDirect({ size: r.size });
                  const to = r.meetingId ? `/vergaderingen/${r.meetingId}` : `/overleggen/${r.overlegId}?tab=stukken`;
                  return (
                    <li key={`${r.type}-${r.id}`}>
                      <span className={`badge ${r.type === "besluit" ? "accent" : r.type === "stuk" ? "info" : ""}`} style={{ marginTop: 3 }}>
                        {TYPE_LABEL[r.type]}
                      </span>
                      <div className="grow">
                        {openFile ? (
                          <a className="title" href={fileUrl(r)} target="_blank" rel="noopener">
                            {r.title}
                          </a>
                        ) : (
                          <Link className="title" to={to}>
                            {r.title}
                          </Link>
                        )}
                        {r.snippet && <div className="pre small">{r.snippet}</div>}
                        <div className="meta">
                          <Link to={to}>{r.overlegName}</Link>
                          <span>{fmtDate(r.at)}</span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty title="Niets gevonden">Probeer een ander of korter zoekwoord. De inhoud van pdf's wordt niet doorzocht, wel de bestandsnaam.</Empty>
            )}
          </Loader>
        </section>
      )}
    </div>
  );
}
