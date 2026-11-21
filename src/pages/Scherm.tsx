import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorText } from "../api";
import { JoinStrip, Screen, useNow, useWakeLock, type ScreenData } from "../components/Screen";
import { Button, Icon } from "../ui";

/**
 * Presentatiescherm voor de beamer of het grote scherm: de agenda, het actuele punt, de klok en het stuk
 * dat de secretaris toont. Zonder notulen en zonder knoppen om iets te wijzigen; het volgt de secretaris.
 */
export default function SchermPage() {
  const { id } = useParams();
  const [data, setData] = useState<ScreenData | null>(null);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const [full, setFull] = useState(() => !!document.fullscreenElement);
  const now = useNow();

  useEffect(() => {
    let gone = false;
    let timer = 0;
    const poll = async () => {
      window.clearTimeout(timer);
      try {
        const s = await api<ScreenData>(`/api/meetings/${id}/screen`);
        if (gone) return;
        setData(s);
        setOffset(Date.parse(s.now) - Date.now());
        setError("");
      } catch (e) {
        // Even geen verbinding: het laatste beeld blijft staan en de volgende ronde probeert het opnieuw.
        if (!gone) setError(errorText(e));
      }
      if (!gone) timer = window.setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [id]);

  useEffect(() => {
    const onChange = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useWakeLock(!!data?.live.startedAt);

  if (!data) {
    return (
      <div className="live">
        <div className="live-wait">
          {error ? <div className="form-error">{error}</div> : <p className="muted">Laden…</p>}
          {error && (
            <Link className="btn secondary" to="/">
              Naar het overzicht
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <Screen
      data={data}
      serverNow={now + offset}
      chunkUrl={(docId, n) => `/api/documents/${docId}/chunks/${n}`}
      actions={
        !full && (
          <>
            {document.documentElement.requestFullscreen && (
              <Button variant="secondary" small icon="eye" onClick={() => void document.documentElement.requestFullscreen().catch(() => {})}>
                <span className="hide-narrow">Volledig scherm</span>
              </Button>
            )}
            <Link className="btn ghost small" to={`/vergaderingen/${id}/live`} aria-label="Presentatiescherm sluiten">
              <Icon name="x" size={16} />
              <span className="hide-narrow">Sluiten</span>
            </Link>
          </>
        )
      }
      footer={data.watch && data.live.startedAt ? <JoinStrip watch={data.watch} /> : undefined}
    />
  );
}
