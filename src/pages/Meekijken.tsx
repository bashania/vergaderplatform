import { useEffect, useState, type FormEvent } from "react";
import { api, errorText } from "../api";
import { Screen, useNow, useWakeLock, type ScreenData } from "../components/Screen";
import { Brand, Button } from "../ui";

/**
 * Meekijken zonder account, met de QR-code of de code die in de zaal op het scherm staat. Toont alleen
 * wat op dat scherm staat: de agenda, het actuele punt, de klok en het stuk dat wordt getoond.
 */
export default function MeekijkenPage() {
  const [token, setToken] = useState(() => window.location.hash.slice(1));
  const [data, setData] = useState<ScreenData | null>(null);
  const [ended, setEnded] = useState(false);
  const [offset, setOffset] = useState(0);
  const now = useNow();

  useEffect(() => {
    const onHash = () => setToken(window.location.hash.slice(1));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!token) return;
    let gone = false;
    let timer = 0;
    setData(null);
    setEnded(false);
    const poll = async () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch(`/api/meekijken/${encodeURIComponent(token)}`, { credentials: "omit" });
          if (gone) return;
          if (res.status === 404) {
            setEnded(true);
            setData(null);
            return;
          }
          if (res.ok) {
            const s = (await res.json()) as ScreenData;
            // Het antwoord kan een paar seconden oud zijn (het wordt gedeeld met alle meekijkers): de leeftijd telt mee voor de klok.
            const age = Number(res.headers.get("age")) || 0;
            setData(s);
            setOffset(Date.parse(s.now) + age * 1000 - Date.now());
          }
        } catch {
          // Even geen verbinding: het laatste beeld blijft staan.
        }
      }
      if (!gone) timer = window.setTimeout(poll, 2500);
    };
    void poll();
    document.addEventListener("visibilitychange", poll);
    return () => {
      gone = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [token]);

  useWakeLock(!!data?.live.startedAt);

  if (token && data) {
    return <Screen data={data} serverNow={now + offset} chunkUrl={(docId, n) => `/api/meekijken/${encodeURIComponent(token)}/doc/${docId}/${n}`} />;
  }
  return (
    <CodeForm
      waiting={!!token && !ended}
      ended={ended}
      onToken={(t) => {
        window.location.hash = t;
        setToken(t);
      }}
    />
  );
}

function CodeForm({ waiting, ended, onToken }: { waiting: boolean; ended: boolean; onToken: (token: string) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { token } = await api<{ token: string }>("/api/meekijken", { method: "POST", body: { code } });
      onToken(token);
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <span className="brand">
          <Brand />
        </span>
        <h1>Meekijken</h1>
        {waiting ? (
          <p className="muted">Verbinden met de vergadering…</p>
        ) : (
          <>
            {ended && <div className="notice warm">Het meekijken is gestopt, of de link klopt niet meer. Heb je een nieuwe code, vul die dan hieronder in.</div>}
            <p className="lead">Typ de code die op het scherm in de zaal staat. Je ziet de agenda, het punt dat aan de orde is en het stuk dat wordt getoond.</p>
            <form className="stack" onSubmit={submit}>
              <label className="field">
                <span>Code</span>
                <input
                  className="input join-input"
                  required
                  autoFocus
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  inputMode="text"
                  maxLength={12}
                  placeholder="ABCD 2345"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                />
              </label>
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
              <Button type="submit" busy={busy}>
                Meekijken
              </Button>
            </form>
            <p className="small muted">Een account is niet nodig. Het meekijken stopt vanzelf als de vergadering is afgelopen.</p>
          </>
        )}
      </div>
    </main>
  );
}
