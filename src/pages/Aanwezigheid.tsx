import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { fmtDateLong, fmtTime } from "../lib";
import { Brand, Button } from "../ui";

type Info = { meetingId: string; title: string; startsAt: string; location: string; name: string; attendance: "aanwezig" | "afwezig" | null; closed: boolean };

/**
 * Landingspagina van de knoppen "Ik ben erbij" en "Ik ben verhinderd" in een e-mail: /aanwezigheid#<sleutel>~ja.
 * Werkt zonder inloggen. De keuze uit de mail staat klaar; één klik bevestigt haar.
 */
export default function AanwezigheidPage() {
  const [token, choice] = window.location.hash.slice(1).split("~");
  const wanted = choice === "nee" ? "afwezig" : "aanwezig";
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<"aanwezig" | "afwezig" | null>(null);
  const path = `/api/rsvp/${encodeURIComponent(token ?? "")}`;

  useEffect(() => {
    if (!token) {
      setError("Deze link is onvolledig. Open de vergadering in het platform om je aan of af te melden.");
      return;
    }
    api<Info>(path)
      .then(setInfo)
      .catch((e) => setError(errorText(e)));
  }, [token, path]);

  async function save(status: "aanwezig" | "afwezig") {
    setBusy(true);
    setError("");
    try {
      await api(path, { method: "POST", body: { status } });
      setSaved(status);
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <span className="brand">
          <Brand />
        </span>
        {!info && !error && <p className="muted">Laden…</p>}
        {info && (
          <>
            <div className="stack" style={{ gap: 6 }}>
              <h1>{info.title}</h1>
              <p className="lead">
                {fmtDateLong(info.startsAt)}, {fmtTime(info.startsAt)} uur{info.location ? `, ${info.location}` : ""}
              </p>
            </div>
            {saved ? (
              <div className="notice accent">
                <strong>{saved === "aanwezig" ? "Je bent aangemeld." : "Je bent afgemeld."}</strong> Dank je, {info.name.split(" ")[0]}. De secretaris ziet dit op de
                presentielijst.
              </div>
            ) : info.closed ? (
              <div className="notice">Deze vergadering is al afgerond.</div>
            ) : (
              <>
                <p>
                  {info.name}, bevestig hieronder of je erbij bent.
                  {info.attendance ? ` Je staat nu als ${info.attendance === "aanwezig" ? "aanwezig" : "verhinderd"} genoteerd.` : ""}
                </p>
                <Button variant={wanted === "aanwezig" ? "primary" : "secondary"} busy={busy} onClick={() => void save("aanwezig")}>
                  Ik ben erbij
                </Button>
                <Button variant={wanted === "afwezig" ? "primary" : "secondary"} busy={busy} onClick={() => void save("afwezig")}>
                  Ik ben verhinderd
                </Button>
              </>
            )}
            <a className="btn ghost" href={`/vergaderingen/${info.meetingId}`}>
              Agenda en stukken openen
            </a>
          </>
        )}
        {error && (
          <>
            <div className="form-error" role="alert">
              {error}
            </div>
            <a className="btn secondary" href="/">
              Naar het platform
            </a>
          </>
        )}
      </div>
    </main>
  );
}
