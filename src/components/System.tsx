import { useState } from "react";
import { api, errorText } from "../api";
import { fmtDateTime } from "../lib";
import { Button, useRun } from "../ui";

type Check = { key: string; label: string; status: "ok" | "fout" | "uit"; detail: string };

/** Platformbeheer: één knop die elk onderdeel echt aanspreekt en zegt of het werkt. */
export function SystemCheckCard() {
  const run = useRun();
  const [state, setState] = useState<{ busy: boolean; checks?: Check[]; at?: string; error?: string }>({ busy: false });

  async function check() {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    try {
      const r = await api<{ checks: Check[]; at: string }>("/api/admin/system/check", { method: "POST", body: {} });
      setState({ busy: false, checks: r.checks, at: r.at });
    } catch (e) {
      setState((s) => ({ ...s, busy: false, error: errorText(e) }));
    }
  }

  const wrong = state.checks?.filter((c) => c.status === "fout").length ?? 0;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Systeemcontrole</h2>
        <Button small busy={state.busy} onClick={() => void check()}>
          {state.busy ? "Controleren…" : "Controleer alles"}
        </Button>
      </div>
      <div className="card-body stack">
        {!state.checks && !state.error && (
          <p>
            Spreekt elk onderdeel echt aan: de database, de opslag van stukken, de AI-assistent (één klein verzoek aan het taalmodel), de mailserver, Plaud en
            de dagelijkse herinneringen. Duurt hooguit een halve minuut.
          </p>
        )}
        {state.error && (
          <div className="form-error" role="alert">
            {state.error}
          </div>
        )}
        {state.checks && (
          <>
            <div className={`notice ${wrong ? "warm" : "accent"}`}>
              <strong>{wrong ? `${wrong} ${wrong === 1 ? "onderdeel werkt" : "onderdelen werken"} niet.` : "Alles wat is ingericht, werkt."}</strong>
              {state.at ? ` Gecontroleerd op ${fmtDateTime(state.at)}.` : ""}
            </div>
            <ul className="list" style={{ margin: 0 }}>
              {state.checks.map((c) => (
                <li key={c.key} style={{ paddingLeft: 0, paddingRight: 0, alignItems: "flex-start" }}>
                  <span className={`badge ${c.status === "ok" ? "accent" : c.status === "fout" ? "warm" : ""}`} style={{ marginTop: 3, minWidth: 92, justifyContent: "center" }}>
                    {c.status === "ok" ? "Werkt" : c.status === "fout" ? "Werkt niet" : "Niet actief"}
                  </span>
                  <div className="grow">
                    <strong>{c.label}</strong>
                    <div className="small muted" style={{ overflowWrap: "anywhere" }}>
                      {c.detail}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div>
              <Button
                variant="ghost"
                small
                icon="mail"
                onClick={() =>
                  run(async () => {
                    await api("/api/background/daily", { method: "POST", body: {} });
                  }, "Herinneringen gestart. Controleer over een minuut opnieuw voor de uitkomst.")
                }
              >
                Dagelijkse herinneringen nu versturen
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
