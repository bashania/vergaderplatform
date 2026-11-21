import { useState } from "react";
import { downloadCsv } from "../api";
import { useUser } from "../auth";
import { ActionList } from "../components/Records";
import { isOverdue, type Action, type Overleg } from "../lib";
import { Button, Loader, useLoad } from "../ui";

export default function ActiesPage() {
  const user = useUser();
  const [mine, setMine] = useState(true);
  const [all, setAll] = useState(false);
  const [overlegId, setOverlegId] = useState("");
  const overleggen = useLoad<{ overleggen: Overleg[] }>("/api/overleggen");
  const query = new URLSearchParams();
  if (mine) query.set("mine", "1");
  if (all) query.set("status", "alle");
  if (overlegId) query.set("overleg", overlegId);
  const { data, loading, error, reload } = useLoad<{ actions: Action[] }>(`/api/actions?${query}`);

  const actions = data?.actions ?? [];
  const late = actions.filter((a) => a.status === "open" && isOverdue(a.dueDate)).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Acties</h1>
          <p className="lead">Vink een actie af zodra die gereed is. De secretaris ziet dat direct terug in de actielijst.</p>
        </div>
      </div>
      <div className="row no-print">
        <div className="rsvp" role="group" aria-label="Welke acties">
          <button type="button" aria-pressed={mine} onClick={() => setMine(true)}>
            Mijn acties
          </button>
          <button type="button" aria-pressed={!mine} onClick={() => setMine(false)}>
            Iedereen
          </button>
        </div>
        <select className="input" style={{ width: "auto", maxWidth: "100%" }} aria-label="Overleg" value={overlegId} onChange={(e) => setOverlegId(e.target.value)}>
          <option value="">Alle overleggen</option>
          {overleggen.data?.overleggen.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <label className="check small">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          Toon ook afgeronde acties
        </label>
      </div>
      <section className="card">
        <div className="card-head">
          <h2 className="section-title">
            {actions.length} {actions.length === 1 ? "actie" : "acties"}
          </h2>
          <div className="row">
            {late > 0 && <span className="badge warm">{late} te laat</span>}
            {actions.length > 0 && (
              <Button
                small
                variant="ghost"
                icon="download"
                className="no-print"
                onClick={() =>
                  downloadCsv("actielijst.csv", [
                    ["Actie", "Actiehouder", "Deadline", "Status", "Overleg", "Vergadering"],
                    ...actions.map((a) => [a.text, a.ownerName, a.dueDate, a.status, a.overlegName, a.meetingTitle]),
                  ])
                }
              >
                Excel
              </Button>
            )}
          </div>
        </div>
        <Loader loading={loading} error={error}>
          <ActionList
            actions={actions}
            userId={user.id}
            onChanged={reload}
            emptyTitle={mine ? "Je hebt geen openstaande acties" : "Geen openstaande acties"}
          />
        </Loader>
      </section>
    </div>
  );
}
