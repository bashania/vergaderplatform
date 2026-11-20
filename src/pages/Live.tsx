import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useAuth, useUser } from "../auth";
import { DocList, UploadButton } from "../components/Docs";
import { ActionItem, ActionModal, DecisionModal } from "../components/Records";
import { agendaOrder, fmtClock, fmtTime, labelTone, type Action, type AgendaItem, type Decision, type Doc, type LiveState, type MeetingDetail } from "../lib";
import { Button, Icon, Loader, useLoad, useRun, useToast } from "../ui";

type ModalState = { type: "decision"; decision?: Decision } | { type: "action"; action?: Action } | null;

/** Notulen bij het actuele punt: slaat vanzelf op, ook als je snel naar het volgende punt gaat. */
function LiveNotes({ item, onSaved }: { item: AgendaItem; onSaved: () => void }) {
  const [draft, setDraft] = useState(item.notes);
  const [state, setState] = useState<"rust" | "bezig" | "opgeslagen" | "fout">("rust");
  const saved = useRef(item.notes);
  const latest = useRef(draft);
  latest.current = draft;

  // Wijziging van elders (een tweede notulist) overnemen zolang hier niets openstaat.
  useEffect(() => {
    if (latest.current === saved.current && item.notes !== saved.current) {
      saved.current = item.notes;
      setDraft(item.notes);
    }
  }, [item.notes]);

  useEffect(() => {
    if (draft === saved.current) return;
    const timer = window.setTimeout(async () => {
      setState("bezig");
      try {
        await api(`/api/items/${item.id}`, { method: "PATCH", body: { notes: draft } });
        saved.current = draft;
        setState("opgeslagen");
        onSaved();
      } catch {
        setState("fout");
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [draft, item.id, onSaved]);

  // Bij het verlaten van het punt: wat nog niet is opgeslagen alsnog wegschrijven.
  useEffect(
    () => () => {
      if (latest.current !== saved.current) {
        void api(`/api/items/${item.id}`, { method: "PATCH", body: { notes: latest.current } }).catch(() => {});
      }
    },
    [item.id],
  );

  return (
    <div className="sub">
      <div className="spread">
        <label className="sub-label" htmlFor="live-notulen">
          Notulen
        </label>
        <span className={`small ${state === "fout" ? "overdue" : "muted"}`} aria-live="polite">
          {state === "bezig" && "Opslaan…"}
          {state === "opgeslagen" && draft === saved.current && "Opgeslagen"}
          {state === "fout" && "Opslaan mislukt. Typ verder om het opnieuw te proberen."}
        </span>
      </div>
      <textarea
        id="live-notulen"
        className="input live-notes"
        rows={7}
        maxLength={50000}
        placeholder="Wat is besproken en afgesproken? Wordt vanzelf opgeslagen."
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
    </div>
  );
}

/** Vergadermodus: één scherm met het actuele agendapunt, de tijd, de stukken en de notulen. */
export default function LivePage() {
  const { id } = useParams();
  const user = useUser();
  const { ensureOrg } = useAuth();
  const navigate = useNavigate();
  const run = useRun();
  const toast = useToast();
  const { data, loading, error, reload } = useLoad<MeetingDetail>(`/api/meetings/${id}`);
  const [live, setLive] = useState<LiveState | null>(null);
  /** Verschil tussen de klok van de server en die van dit apparaat, in ms. */
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  /** Een deelnemer die zelf door de agenda bladert, kijkt naar dit punt in plaats van het actuele. */
  const [viewId, setViewId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const version = useRef<string | null>(null);

  const apply = useCallback(
    (s: LiveState) => {
      setLive(s);
      setOffset(Date.parse(s.now) - Date.now());
      if (version.current && version.current !== s.version) void reload();
      version.current = s.version;
    },
    [reload],
  );

  const organisationId = data?.meeting.organisationId;
  useEffect(() => {
    if (organisationId) ensureOrg(organisationId);
  }, [organisationId, ensureOrg]);

  // Stand ophalen zolang het scherm zichtbaar is: vaker tijdens de vergadering, rustiger ervoor.
  const isLive = !!live?.liveStartedAt;
  useEffect(() => {
    let gone = false;
    let timer = 0;
    const poll = async () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") {
        try {
          const s = await api<LiveState>(`/api/meetings/${id}/live`);
          if (!gone) apply(s);
        } catch {
          // Even geen verbinding: de volgende ronde probeert het opnieuw.
        }
      }
      if (!gone) timer = window.setTimeout(poll, isLive ? 4000 : 10000);
    };
    void poll();
    document.addEventListener("visibilitychange", poll);
    return () => {
      gone = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [id, apply, isLive]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Scherm aan houden tijdens de vergadering (tablet op tafel), waar de browser dat ondersteunt.
  useEffect(() => {
    if (!isLive) return;
    type Lock = { release: () => Promise<void> };
    const wakeLock = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<Lock> } }).wakeLock;
    let lock: Lock | null = null;
    wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => {});
    return () => void lock?.release().catch(() => {});
  }, [isLive]);

  const send = useCallback(
    async (action: "start" | "goto" | "stop", itemId?: string) => {
      const ok = await run(async () => apply(await api<LiveState>(`/api/meetings/${id}/live`, { method: "POST", body: { action, itemId } })));
      if (ok) setViewId(null);
      return ok;
    },
    [id, run, apply],
  );

  const isSec = data?.role === "secretaris";
  const order = data ? agendaOrder(data.items) : [];
  const liveIndex = order.findIndex((o) => o.item.id === live?.liveItemId);
  const canSteer = isSec && data?.meeting.status === "gepubliceerd";

  // Pijltjestoetsen voor de secretaris, behalve tijdens typen of in een venster.
  useEffect(() => {
    if (!canSteer || !isLive) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, dialog") || e.altKey || e.ctrlKey || e.metaKey) return;
      const step = e.key === "ArrowRight" || e.key === "PageDown" ? 1 : e.key === "ArrowLeft" || e.key === "PageUp" ? -1 : 0;
      const target = step ? order[liveIndex + step] : undefined;
      if (target) {
        e.preventDefault();
        void send("goto", target.item.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!data) {
    return (
      <div className="live">
        <div className="live-wait">
          <Loader loading={loading} error={error}>
            {null}
          </Loader>
          {error && (
            <Link className="btn secondary" to="/">
              Naar het overzicht
            </Link>
          )}
        </div>
      </div>
    );
  }

  const { meeting, documents, decisions, actions, members } = data;
  const status = live?.status ?? meeting.status;
  const locked = status === "afgerond";
  const serverNow = now + offset;
  const shownId = viewId ?? live?.liveItemId ?? null;
  const shown = order.find((o) => o.item.id === shownId) ?? null;
  const following = !viewId || viewId === live?.liveItemId;

  const spent = (it: AgendaItem) =>
    it.spentSec + (isLive && it.id === live?.liveItemId && live.liveItemStartedAt ? Math.max(0, (serverNow - Date.parse(live.liveItemStartedAt)) / 1000) : 0);
  const total = live?.liveStartedAt ? Math.max(0, (serverNow - Date.parse(live.liveStartedAt)) / 1000) : 0;

  const canManageDoc = (d: Doc) => !locked && (isSec || d.uploadedBy === user.id);
  const saved = () => {
    setModal(null);
    void reload();
  };

  async function stop() {
    if (!window.confirm("Vergadermodus beëindigen? De notulen blijven staan. Afronden en vergrendelen doe je daarna op de vergaderpagina.")) return;
    if (await send("stop")) {
      toast("Vergadermodus beëindigd");
      navigate(`/vergaderingen/${meeting.id}`);
    }
  }

  const pick = (itemId: string) => {
    if (canSteer) void send(isLive ? "goto" : "start", itemId);
    else setViewId(itemId);
  };

  const next = order[liveIndex + 1];
  const prev = liveIndex > 0 ? order[liveIndex - 1] : undefined;

  return (
    <div className="live">
      <header className="live-top">
        <div className="live-title">
          {isLive ? (
            <span className="live-badge">
              <span className="live-pulse" />
              Bezig
            </span>
          ) : (
            <span className="badge">{locked ? "Afgerond" : "Nog niet gestart"}</span>
          )}
          <strong>{meeting.title}</strong>
          <span className="muted hide-narrow">{meeting.overlegName}</span>
        </div>
        <div className="live-clock" aria-label="Tijd">
          <span className="num">{fmtTime(new Date(serverNow))}</span>
          {isLive && (
            <span className={`small ${total > meeting.durationMin * 60 ? "overdue" : "muted"}`}>
              {fmtClock(total)} van {meeting.durationMin} min
            </span>
          )}
        </div>
        <div className="row">
          {canSteer && isLive && (
            <Button variant="secondary" small icon="stop" onClick={() => void stop()}>
              Beëindigen
            </Button>
          )}
          <Link className="btn ghost small" to={`/vergaderingen/${meeting.id}`} aria-label="Vergadermodus sluiten">
            <Icon name="x" size={16} />
            <span className="hide-narrow">Sluiten</span>
          </Link>
        </div>
      </header>

      <div className="live-body">
        <nav className="live-rail" aria-label="Agenda">
          {order.map(({ item, number }, index) => {
            const current = item.id === live?.liveItemId;
            const done = !current && (item.spentSec > 0 || (liveIndex >= 0 && index < liveIndex));
            return (
              <button
                key={item.id}
                type="button"
                className={`live-step${current ? " current" : ""}${done ? " done" : ""}${item.parentId ? " child" : ""}${item.id === shownId && !current ? " viewed" : ""}`}
                aria-current={current ? "step" : undefined}
                onClick={() => pick(item.id)}
              >
                <span className="nr">{done ? <Icon name="check" size={14} /> : number}</span>
                <span className="grow">{item.title}</span>
                <span className="t num">{current || item.spentSec > 0 ? fmtClock(spent(item)) : item.durationMin ? `${item.durationMin} min` : ""}</span>
              </button>
            );
          })}
          {!order.length && <p className="muted small">Deze vergadering heeft nog geen agendapunten.</p>}
        </nav>

        <main className="live-main">
          {!isLive && !shown && (
            <div className="live-start">
              {locked ? (
                <>
                  <h1>Deze vergadering is afgerond</h1>
                  <p className="lead">Het verslag met besluiten en acties staat op de vergaderpagina.</p>
                </>
              ) : canSteer ? (
                <>
                  <h1>Klaar om te beginnen?</h1>
                  <p className="lead">
                    Start de vergadering en dit scherm toont steeds het actuele punt met de stukken, de tijd en de notulen. Deelnemers die dit scherm openen,
                    lopen vanzelf mee.
                  </p>
                  <div>
                    <Button icon="play" disabled={!order.length} onClick={() => void send("start")}>
                      Vergadering starten
                    </Button>
                  </div>
                </>
              ) : status === "concept" ? (
                <>
                  <h1>Nog niet gepubliceerd</h1>
                  <p className="lead">Publiceer de vergadering eerst. Daarna kun je de vergadermodus starten.</p>
                </>
              ) : (
                <>
                  <h1>De vergadering is nog niet gestart</h1>
                  <p className="lead">Zodra de secretaris start, springt dit scherm vanzelf naar het eerste punt. Je kunt intussen door de agenda bladeren.</p>
                </>
              )}
            </div>
          )}

          {isLive && !shown && (
            <div className="live-start">
              <h1>Geen actueel punt</h1>
              <p className="lead">{canSteer ? "Kies links het punt dat nu aan de orde is." : "De secretaris kiest zo het volgende punt."}</p>
            </div>
          )}

          {shown && (
            <article className="live-item" key={shown.item.id}>
              {!following && isLive && (
                <div className="notice accent spread">
                  <span>Je bladert door de agenda. De vergadering is bij een ander punt.</span>
                  <Button small variant="secondary" icon="eye" onClick={() => setViewId(null)}>
                    Terug naar het actuele punt
                  </Button>
                </div>
              )}
              <div className="live-head">
                <span className="live-nr">{shown.number}</span>
                <div className="grow">
                  <h1>{shown.item.title}</h1>
                  <div className="meta">
                    {shown.item.kind && <span className={`badge ${labelTone(shown.item.kind)}`}>{shown.item.kind}</span>}
                    {shown.item.presenter && <span>Inbrenger: {shown.item.presenter}</span>}
                  </div>
                </div>
                <LiveTimer seconds={spent(shown.item)} plannedMin={shown.item.durationMin} running={isLive && shown.item.id === live?.liveItemId} />
              </div>

              {shown.item.description && <div className="pre">{shown.item.description}</div>}

              {(documents.some((d) => d.agendaItemId === shown.item.id) || !locked) && (
                <div className="sub">
                  <span className="sub-label">Stukken</span>
                  <DocList docs={documents.filter((d) => d.agendaItemId === shown.item.id)} canManage={canManageDoc} onChanged={reload} />
                  {!locked && (
                    <div>
                      <UploadButton variant="ghost" target={{ meetingId: meeting.id, agendaItemId: shown.item.id }} onDone={reload} />
                    </div>
                  )}
                </div>
              )}

              {isSec && !locked ? (
                <LiveNotes item={shown.item} onSaved={reload} />
              ) : (
                shown.item.notes && (
                  <div className="sub">
                    <span className="sub-label">Notulen</span>
                    <div className="note pre">{shown.item.notes}</div>
                  </div>
                )
              )}

              {decisions.some((d) => d.agendaItemId === shown.item.id) && (
                <div className="sub">
                  <span className="sub-label">Besluiten</span>
                  {decisions
                    .filter((d) => d.agendaItemId === shown.item.id)
                    .map((d) => (
                      <div className="decision" key={d.id}>
                        <span className="nr">{d.number}</span>
                        <div className={`grow pre ${d.status === "ingetrokken" ? "strike" : ""}`}>{d.text}</div>
                        {isSec && <Button variant="ghost" small icon="edit" aria-label={`Besluit ${d.number} bewerken`} onClick={() => setModal({ type: "decision", decision: d })} />}
                      </div>
                    ))}
                </div>
              )}

              {actions.some((a) => a.agendaItemId === shown.item.id) && (
                <div className="sub">
                  <span className="sub-label">Acties</span>
                  {actions
                    .filter((a) => a.agendaItemId === shown.item.id)
                    .map((a) => (
                      <ActionItem
                        key={a.id}
                        action={a}
                        canToggle={isSec || a.ownerId === user.id}
                        onChanged={reload}
                        onEdit={isSec ? () => setModal({ type: "action", action: a }) : undefined}
                      />
                    ))}
                </div>
              )}

              {isSec && !locked && (
                <div className="row">
                  <Button variant="secondary" icon="decision" onClick={() => setModal({ type: "decision" })}>
                    Besluit vastleggen
                  </Button>
                  <Button variant="secondary" icon="tasks" onClick={() => setModal({ type: "action" })}>
                    Actie vastleggen
                  </Button>
                </div>
              )}
            </article>
          )}
        </main>
      </div>

      {isLive && (
        <footer className="live-foot">
          {canSteer ? (
            <>
              <Button variant="secondary" icon="left" disabled={!prev} onClick={() => prev && void send("goto", prev.item.id)}>
                Vorige
              </Button>
              <span className="muted small hide-narrow">Pijltjestoetsen werken ook</span>
              {next ? (
                <Button onClick={() => void send("goto", next.item.id)}>
                  Volgende: {next.number} {next.item.title}
                  <Icon name="right" size={17} />
                </Button>
              ) : (
                <Button icon="stop" onClick={() => void stop()}>
                  Vergadering beëindigen
                </Button>
              )}
            </>
          ) : (
            <span className="muted small">
              <Icon name="eye" size={15} /> {following ? "Je loopt mee met de vergadering. Dit scherm wisselt vanzelf van punt." : "Je bladert zelf door de agenda."}
            </span>
          )}
        </footer>
      )}

      {modal?.type === "decision" && shown && (
        <DecisionModal meetingId={meeting.id} agendaItemId={shown.item.id} decision={modal.decision} onClose={() => setModal(null)} onSaved={saved} />
      )}
      {modal?.type === "action" && shown && (
        <ActionModal meetingId={meeting.id} agendaItemId={shown.item.id} action={modal.action} members={members} onClose={() => setModal(null)} onSaved={saved} />
      )}
    </div>
  );
}

/** Besteed versus gepland; kleurt mee als het punt uitloopt. */
function LiveTimer({ seconds, plannedMin, running }: { seconds: number; plannedMin: number | null; running: boolean }) {
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
