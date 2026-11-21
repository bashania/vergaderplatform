import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, canOpenDirect, errorText, fileUrl } from "../api";
import { Thinking, useAi } from "../components/Ai";
import { fmtDay } from "../lib";
import { fmtDate } from "../lib";
import { Button, Empty, Icon, Loader, useLoad } from "../ui";

type Answer = { answer: string; sources: { type: "besluit" | "actie" | "notulen"; label: string; at: string; meetingId: string | null; excerpt: string }[] };

/** Vraag in gewone taal aan het archief van besluiten, acties en notulen; het antwoord noemt zijn bronnen. */
function AskArchive({ initial }: { initial: string }) {
  const [question, setQuestion] = useState(initial.includes(" ") ? initial : "");
  const [state, setState] = useState<{ busy: boolean; data?: Answer; error?: string }>({ busy: false });

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    setState({ busy: true });
    try {
      setState({ busy: false, data: await api<Answer>("/api/ai/ask", { method: "POST", body: { question } }) });
    } catch (err) {
      setState({ busy: false, error: errorText(err) });
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Vraag het archief</h2>
        <span className="muted small">
          <Icon name="spark" size={14} /> AI-assistent
        </span>
      </div>
      <div className="card-body stack">
        <form className="row" onSubmit={ask}>
          <input
            className="input grow"
            required
            minLength={8}
            maxLength={500}
            placeholder="Bijvoorbeeld: wat hebben we besloten over de leaseauto's?"
            aria-label="Vraag aan het archief"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <Button type="submit" icon="spark" busy={state.busy}>
            Vraag
          </Button>
        </form>
        {state.busy && <Thinking>Besluiten, acties en notulen worden doorzocht. Dit duurt meestal 10 tot 30 seconden.</Thinking>}
        {state.error && (
          <div className="form-error" role="alert">
            {state.error}
          </div>
        )}
        {state.data && (
          <>
            <div className="note pre">{state.data.answer}</div>
            {state.data.sources.length > 0 && (
              <div className="sub">
                <span className="sub-label">Bronnen</span>
                <ul className="list" style={{ margin: 0 }}>
                  {state.data.sources.map((s, i) => (
                    <li key={i} style={{ paddingLeft: 0, paddingRight: 0 }}>
                      <span className={`badge ${s.type === "besluit" ? "accent" : ""}`} style={{ marginTop: 3 }}>
                        {s.type === "besluit" ? "Besluit" : s.type === "actie" ? "Actie" : "Notulen"}
                      </span>
                      <div className="grow">
                        {s.meetingId ? (
                          <Link className="title" to={`/vergaderingen/${s.meetingId}`}>
                            {s.label}
                          </Link>
                        ) : (
                          <strong>{s.label}</strong>
                        )}
                        <div className="small muted">
                          {fmtDay(s.at)} · {s.excerpt}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="small muted">Antwoord van de AI-assistent op basis van wat is vastgelegd. Controleer bij twijfel de bron.</p>
          </>
        )}
      </div>
    </section>
  );
}

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
  const ai = useAi();

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
              ai ? "Zoek op een woord via het zoekveld in het menu, of stel hieronder een vraag in gewone taal." : "Typ minimaal twee tekens in het zoekveld in het menu."
            )}
          </p>
        </div>
      </div>
      {ai && <AskArchive key={term} initial={term} />}
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
