import { useMemo, useState } from "react";
import { DecisionTable } from "../components/Records";
import type { Decision, Overleg } from "../lib";
import { Loader, useLoad } from "../ui";

export default function BesluitenPage() {
  const [overlegId, setOverlegId] = useState("");
  const [term, setTerm] = useState("");
  const [withdrawn, setWithdrawn] = useState(true);
  const overleggen = useLoad<{ overleggen: Overleg[] }>("/api/overleggen");
  const { data, loading, error } = useLoad<{ decisions: Decision[] }>(`/api/decisions${overlegId ? `?overleg=${overlegId}` : ""}`);

  const shown = useMemo(() => {
    const t = term.trim().toLowerCase();
    return (data?.decisions ?? []).filter(
      (d) => (withdrawn || d.status === "genomen") && (!t || d.text.toLowerCase().includes(t) || d.number.includes(t)),
    );
  }, [data, term, withdrawn]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Besluitenlijst</h1>
          <p className="lead">Alle besluiten uit je overleggen, doorlopend genummerd per overleg en per jaar.</p>
        </div>
      </div>
      <div className="row no-print">
        <select className="input" style={{ width: "auto", maxWidth: "100%" }} aria-label="Overleg" value={overlegId} onChange={(e) => setOverlegId(e.target.value)}>
          <option value="">Alle overleggen</option>
          {overleggen.data?.overleggen.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.archived ? " (gearchiveerd)" : ""}
            </option>
          ))}
        </select>
        <input
          className="input grow"
          style={{ minWidth: 180 }}
          type="search"
          placeholder="Filter op tekst of nummer"
          aria-label="Filter besluiten"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        <label className="check small">
          <input type="checkbox" checked={withdrawn} onChange={(e) => setWithdrawn(e.target.checked)} />
          Toon ingetrokken
        </label>
      </div>
      <section className="card">
        <Loader loading={loading} error={error}>
          <DecisionTable decisions={shown} showOverleg={!overlegId} />
        </Loader>
      </section>
    </div>
  );
}
