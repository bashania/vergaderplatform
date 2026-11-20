import { useState } from "react";
import { api } from "../api";
import { fmtDateTime } from "../lib";
import { Button, CopyBox, Loader, useLoad, useRun } from "../ui";

/** Mijn account: vergaderingen laten verschijnen in Outlook, Google Agenda of de agenda van je telefoon. */
export function CalendarCard() {
  const run = useRun();
  const { data, loading, error, reload } = useLoad<{ active: boolean; since: string | null }>("/api/account/calendar");
  const [url, setUrl] = useState("");

  const create = () =>
    run(async () => {
      setUrl((await api<{ url: string }>("/api/account/calendar", { method: "POST", body: {} })).url);
      await reload();
    });

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Vergaderingen in je eigen agenda</h2>
        {data?.active ? <span className="badge accent">Actief</span> : <span className="badge">Niet ingesteld</span>}
      </div>
      <div className="card-body stack">
        <Loader loading={loading} error={error}>
          <p>
            Met een agenda-abonnement staan al je vergaderingen vanzelf in Outlook, Google Agenda of de agenda van je telefoon, met de agendapunten en een
            link naar de stukken. Wijzigt een datum of tijd, dan verandert je agenda mee.
          </p>
          {url ? (
            <>
              <CopyBox value={url} />
              <div className="notice">
                <strong>Deze link zie je alleen nu.</strong> Voeg hem toe als internetagenda: in Outlook via Agenda toevoegen, Abonneren via internet; in Google
                Agenda via Andere agenda's, Via URL. Of open hem direct in je agenda-app:{" "}
                <a href={url.replace(/^https?:/, "webcal:")}>abonneren</a>. Deel de link niet: wie hem heeft, ziet je vergaderingen.
              </div>
            </>
          ) : (
            data?.active && data.since && <p className="small muted">Link gemaakt op {fmtDateTime(data.since)}. Kwijt, of gedeeld met de verkeerde? Maak een nieuwe; de oude werkt dan niet meer.</p>
          )}
          <div className="row">
            <Button
              variant={data?.active ? "secondary" : "primary"}
              icon="calendar"
              onClick={() => {
                if (data?.active && !window.confirm("Nieuwe link maken? De oude link werkt daarna niet meer; je voegt de nieuwe opnieuw toe in je agenda.")) return;
                void create();
              }}
            >
              {data?.active ? "Nieuwe link maken" : "Agendalink maken"}
            </Button>
            {data?.active && (
              <Button
                variant="ghost"
                onClick={async () => {
                  if (!window.confirm("Agenda-abonnement stoppen? Je agenda-app krijgt dan geen vergaderingen meer.")) return;
                  if (await run(() => api("/api/account/calendar", { method: "DELETE" }), "Agenda-abonnement gestopt")) {
                    setUrl("");
                    void reload();
                  }
                }}
              >
                Stoppen
              </Button>
            )}
          </div>
        </Loader>
      </div>
    </section>
  );
}
