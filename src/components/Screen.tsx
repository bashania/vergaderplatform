import { useEffect, useState, type ReactNode } from "react";
import { agendaOrder, fmtClock, fmtTime, labelTone, type AgendaItem, type MeetingStatus } from "../lib";
import { Icon } from "../ui";
import { DocStage, type StageDoc } from "./DocStage";
import { fmtCode, Qr, watchUrl } from "./Qr";

/**
 * Wat op het scherm in de zaal hoort: de agenda, het actuele punt, de klok en het getoonde stuk.
 * Dezelfde toestand voor het presentatiescherm (ingelogd) en voor meekijkers zonder account;
 * notulen, besluiten, acties en andere stukken zitten er niet in.
 */
export type ScreenData = {
  meeting: { title: string; overlegName: string; organisationName: string; startsAt: string; durationMin: number; status: MeetingStatus };
  items: Omit<AgendaItem, "notes">[];
  live: { startedAt: string | null; itemId: string | null; itemStartedAt: string | null; docPage: number | null };
  doc: (StageDoc & { chunkCount: number }) | null;
  now: string;
  /** Alleen voor wie is ingelogd: de code waarmee anderen kunnen meekijken, als dat aan staat. */
  watch?: { token: string; code: string } | null;
};

/** De tijd op dit apparaat, elke seconde bijgewerkt. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/** Scherm aan houden tijdens de vergadering (tablet op tafel, beamer), waar de browser dat ondersteunt. */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    type Lock = { release: () => Promise<void> };
    const wakeLock = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<Lock> } }).wakeLock;
    let lock: Lock | null = null;
    wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => {});
    return () => void lock?.release().catch(() => {});
  }, [active]);
}

/** Besteed versus gepland; kleurt mee als het punt uitloopt. */
export function LiveTimer({ seconds, plannedMin, running }: { seconds: number; plannedMin: number | null; running: boolean }) {
  if (!running && seconds === 0 && !plannedMin) return null;
  const planned = (plannedMin ?? 0) * 60;
  const ratio = planned ? seconds / planned : 0;
  const tone = planned && ratio > 1 ? "over" : planned && ratio > 0.8 ? "warn" : "";
  return (
    <div className={`live-timer ${tone}`} aria-label="Tijd voor dit punt">
      <span className="num">{running || seconds > 0 ? fmtClock(seconds) : `${plannedMin} min`}</span>
      {planned > 0 && (running || seconds > 0) && <span className="small">van {plannedMin} min</span>}
      {planned > 0 && (
        <div className="bar">
          <div style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * De uitnodiging om mee te kijken. Naast het agendapunt een grote QR-code, zodat hij vanuit de zaal te
 * scannen is. Staat er een stuk op het scherm, dan een smalle strook met alleen het adres en de code:
 * een kleine QR-code is van een afstand niet te lezen en zou alleen ruimte van het stuk afnemen.
 */
function Join({ watch, big }: { watch: { token: string; code: string }; big?: boolean }) {
  const typed = (
    <>
      ga naar <span className="join-url">{window.location.host}/meekijken</span> en typ <span className="join-code">{fmtCode(watch.code)}</span>
    </>
  );
  if (!big) {
    return (
      <div className="join">
        <span>
          <strong>Meekijken op je eigen scherm:</strong> {typed}
        </span>
      </div>
    );
  }
  return (
    <div className="join big">
      <Qr text={watchUrl(watch.token)} size={320} label="QR-code om mee te kijken" />
      <div>
        <strong>Meekijken op je eigen scherm</strong>
        <div>Scan de code, of {typed}</div>
      </div>
    </div>
  );
}

export function Screen({
  data,
  serverNow,
  chunkUrl,
  actions,
}: {
  data: ScreenData;
  /** De tijd volgens de server, in ms: zo loopt de klok op elk apparaat gelijk. */
  serverNow: number;
  chunkUrl: (docId: string, n: number) => string;
  /** Knoppen rechtsboven (volledig scherm, sluiten). */
  actions?: ReactNode;
}) {
  const [pages, setPages] = useState(0);
  const { meeting, live, doc } = data;
  const order = agendaOrder(data.items.map((i) => ({ ...i, notes: "" })));
  const isLive = !!live.startedAt;
  const liveIndex = order.findIndex((o) => o.item.id === live.itemId);
  const current = liveIndex >= 0 ? order[liveIndex] : null;
  const running = (it: { id: string }) => isLive && it.id === live.itemId && !!live.itemStartedAt;
  const spent = (it: { id: string; spentSec: number }) => it.spentSec + (running(it) ? Math.max(0, (serverNow - Date.parse(live.itemStartedAt!)) / 1000) : 0);
  const total = live.startedAt ? Math.max(0, (serverNow - Date.parse(live.startedAt)) / 1000) : 0;
  const page = live.docPage ?? 1;
  // De code om mee te kijken staat alleen op het presentatiescherm (ingelogd), nooit bij de meekijker zelf.
  const watch = isLive ? (data.watch ?? null) : null;

  return (
    <div className="live screen">
      <header className="live-top">
        <div className="live-title">
          {isLive ? (
            <span className="live-badge">
              <span className="live-pulse" />
              Bezig
            </span>
          ) : (
            <span className="badge">{meeting.status === "afgerond" ? "Afgerond" : "Nog niet gestart"}</span>
          )}
          <strong>{meeting.title}</strong>
          <span className="muted hide-narrow">{[meeting.organisationName, meeting.overlegName].filter(Boolean).join(" · ")}</span>
        </div>
        <div className="live-clock" aria-label="Tijd">
          <span className="num">{fmtTime(new Date(serverNow))}</span>
          {isLive && (
            <span className={`small ${total > meeting.durationMin * 60 ? "overdue" : "muted"}`}>
              {fmtClock(total)} van {meeting.durationMin} min
            </span>
          )}
        </div>
        <div className="row">{actions}</div>
      </header>

      <div className="live-body">
        {/* Hier valt niets aan te klikken; tabIndex maakt de lijst met het toetsenbord te schuiven. */}
        <nav className="live-rail" aria-label="Agenda" tabIndex={0}>
          {order.map(({ item, number }, index) => {
            const isCurrent = item.id === live.itemId;
            const done = !isCurrent && (item.spentSec > 0 || (liveIndex >= 0 && index < liveIndex));
            return (
              <div key={item.id} className={`live-step${isCurrent ? " current" : ""}${done ? " done" : ""}${item.parentId ? " child" : ""}`} aria-current={isCurrent ? "step" : undefined}>
                <span className="nr">{done ? <Icon name="check" size={14} /> : number}</span>
                <span className="grow">{item.title}</span>
                <span className="t num">{isCurrent || item.spentSec > 0 ? fmtClock(spent(item)) : item.durationMin ? `${item.durationMin} min` : ""}</span>
              </div>
            );
          })}
        </nav>

        <main className={`live-main${isLive && doc ? " staged" : ""}`}>
          {!isLive ? (
            <div className="live-start">
              <h1>{meeting.status === "afgerond" ? "Deze vergadering is afgerond" : "De vergadering is nog niet gestart"}</h1>
              <p className="lead">{meeting.status === "afgerond" ? "Bedankt voor het meekijken." : "Zodra de secretaris start, verschijnt hier het eerste agendapunt."}</p>
            </div>
          ) : doc ? (
            <div className="stage-wrap">
              <h1 className="sr-only">
                {current ? `${current.item.title}: ` : ""}
                {doc.name}
              </h1>
              <div className="stage-bar">
                {current && <span className="live-nr small">{current.number}</span>}
                {current && <strong>{current.item.title}</strong>}
                <span className="muted">
                  {doc.name}
                  {pages > 1 ? ` · pagina ${Math.min(page, pages)} van ${pages}` : ""}
                </span>
              </div>
              <DocStage key={doc.id} doc={doc} page={page} chunkUrl={(n) => chunkUrl(doc.id, n)} onPages={setPages} tall />
            </div>
          ) : current ? (
            <div className={watch ? "screen-split" : undefined}>
            <article className="live-item screen-item" key={current.item.id}>
              <div className="live-head">
                <span className="live-nr">{current.number}</span>
                <div className="grow">
                  <h1>{current.item.title}</h1>
                  <div className="meta">
                    {current.item.kind && <span className={`badge ${labelTone(current.item.kind)}`}>{current.item.kind}</span>}
                    {current.item.presenter && <span>Inbrenger: {current.item.presenter}</span>}
                  </div>
                </div>
                <LiveTimer seconds={spent(current.item)} plannedMin={current.item.durationMin} running={running(current.item)} />
              </div>
              {current.item.description && <div className="pre">{current.item.description}</div>}
              {order[liveIndex + 1] && (
                <p className="muted screen-next">
                  Hierna: {order[liveIndex + 1].number} {order[liveIndex + 1].item.title}
                </p>
              )}
            </article>
            {watch && <Join watch={watch} big />}
            </div>
          ) : (
            <div className="live-start">
              <h1>Even geduld</h1>
              <p className="lead">De secretaris kiest zo het volgende punt.</p>
            </div>
          )}
        </main>
      </div>

      {watch && doc && (
        <footer className="live-foot screen-foot">
          <Join watch={watch} />
        </footer>
      )}
    </div>
  );
}
