import { useRef, useState } from "react";
import { api, errorText } from "../api";
import { downloadBackup, verifyBackup } from "../backup";
import { fmtDateTime } from "../lib";
import { Button, useRun, useToast } from "../ui";

/** Platformbeheer: alle gegevens als één bestand downloaden, om te bewaren of om mee te verhuizen. */
export function BackupCard() {
  const toast = useToast();
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ rows: number; readable: number; present: number; exportedAt: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Back-up</h2>
        <Button
          small
          variant="secondary"
          icon="download"
          busy={progress !== null}
          onClick={async () => {
            setError("");
            setProgress("Voorbereiden…");
            try {
              const rows = await downloadBackup((done, total) => setProgress(`${done} van ${total}`));
              toast(`Back-up gedownload (${rows.toLocaleString("nl-NL")} regels)`);
            } catch (e) {
              setError(errorText(e));
            }
            setProgress(null);
          }}
        >
          {progress ?? "Back-up downloaden"}
        </Button>
      </div>
      <div className="card-body stack">
        <p>
          Eén bestand met alle gegevens: organisaties, overleggen, vergaderingen, notulen, besluiten, acties, stemrondes en accounts. Je zet het terug op een
          leeg platform, bijvoorbeeld bij een verhuizing naar een andere regio of na verlies van gegevens.
        </p>
        <p className="small muted">
          Bewaar het bestand op een veilige plek: het bevat alles wat in het platform staat, waaronder transcripten en de (versleutelde) inloggegevens van
          accounts. De bestanden van stukken zitten er niet in; die blijven in de opslag van het platform staan.
        </p>
        <div className="row">
          <Button small variant="secondary" icon="check" busy={checking !== null} onClick={() => fileInput.current?.click()}>
            {checking ?? "Een back-upbestand controleren"}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            aria-label="Back-upbestand om te controleren"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setError("");
              setChecked(null);
              setChecking("Controleren…");
              try {
                setChecked(await verifyBackup(file, (done, total) => setChecking(`${done} van ${total}`)));
              } catch (err) {
                setError(errorText(err));
              }
              setChecking(null);
            }}
          />
        </div>
        {checked && (
          <div className={`notice ${checked.readable === checked.rows ? "accent" : "warm"}`}>
            <strong>
              {checked.readable === checked.rows ? "Dit bestand is compleet leesbaar." : `Niet alles is leesbaar: ${checked.readable} van ${checked.rows} regels.`}
            </strong>{" "}
            Back-up van {fmtDateTime(checked.exportedAt)} met {checked.rows.toLocaleString("nl-NL")} regels; {checked.present.toLocaleString("nl-NL")} daarvan staan nu
            in het platform. Er is niets gewijzigd.
          </div>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </section>
  );
}

type Check = { key: string; label: string; status: "ok" | "fout" | "uit" | "let_op"; detail: string };

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
  const attention = state.checks?.filter((c) => c.status === "let_op").length ?? 0;
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
            <div className={`notice ${wrong || attention ? "warm" : "accent"}`}>
              <strong>
                {wrong ? `${wrong} ${wrong === 1 ? "onderdeel werkt" : "onderdelen werken"} niet.` : "Alles wat is ingericht, werkt."}
                {attention ? ` ${attention} ${attention === 1 ? "punt vraagt" : "punten vragen"} je aandacht.` : ""}
              </strong>
              {state.at ? ` Gecontroleerd op ${fmtDateTime(state.at)}.` : ""}
            </div>
            <ul className="list" style={{ margin: 0 }}>
              {state.checks.map((c) => (
                <li key={c.key} style={{ paddingLeft: 0, paddingRight: 0, alignItems: "flex-start" }}>
                  <span className={`badge ${c.status === "ok" ? "accent" : c.status === "uit" ? "" : "warm"}`} style={{ marginTop: 3, minWidth: 92, justifyContent: "center" }}>
                    {c.status === "ok" ? "In orde" : c.status === "fout" ? "Werkt niet" : c.status === "let_op" ? "Let op" : "Niet actief"}
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
