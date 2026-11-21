import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useUser } from "../auth";
import { fmtDate, fmtDay, type MeetingSummary } from "../lib";
import { Button, Empty, Field, Form, Loader, Modal, useLoad, useRun, useToast } from "../ui";

type Vote = "akkoord" | "niet_akkoord" | "onthouding";
type Ballot = {
  id: string;
  title: string;
  body: string;
  closesOn: string | null;
  status: "open" | "aangenomen" | "verworpen" | "ingetrokken";
  createdAt: string;
  closedAt: string | null;
  createdByName: string | null;
  decisionNumber: string | null;
  decisionMeetingId: string | null;
  votes: { userId: string; name: string; vote: Vote; comment: string }[];
};
type Data = { ballots: Ballot[]; voters: { id: string; name: string }[]; canVote: boolean };

const VOTE_LABEL: Record<Vote, string> = { akkoord: "Akkoord", niet_akkoord: "Niet akkoord", onthouding: "Onthouding" };
const STATUS_LABEL: Record<Ballot["status"], string> = { open: "Stemmen loopt", aangenomen: "Aangenomen", verworpen: "Verworpen", ingetrokken: "Ingetrokken" };

function NewBallot({ overlegId, onClose, onSaved }: { overlegId: string; onClose: () => void; onSaved: (mailed: number) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [closesOn, setClosesOn] = useState("");
  return (
    <Modal title="Nieuwe stemronde" onClose={onClose}>
      <Form
        submitLabel="Voorleggen"
        onCancel={onClose}
        onSubmit={async () => {
          const res = await api<{ mailed: number }>(`/api/overleggen/${overlegId}/ballots`, { method: "POST", body: { title, body, closesOn: closesOn || null } });
          onSaved(res.mailed);
        }}
      >
        <Field label="Voorstel" hint="Formuleer het als het besluit dat je wilt nemen, bijvoorbeeld: De offerte van hovenier X voor € 4.800 wordt geaccepteerd.">
          <textarea className="input" required autoFocus rows={2} maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Toelichting (optioneel)">
          <textarea className="input" rows={4} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Field label="Stemmen tot en met (optioneel)" hint="Wie dan nog niet heeft gestemd, krijgt de dag ervoor een herinnering als e-mail is ingesteld.">
          <input className="input" type="date" value={closesOn} onChange={(e) => setClosesOn(e.target.value)} />
        </Field>
        <p className="small muted">De deelnemers van dit overleg stemmen. Stemmen zijn open: iedereen in het overleg ziet wie wat stemt.</p>
      </Form>
    </Modal>
  );
}

/** Sluiten met de uitkomst; een aangenomen voorstel gaat direct de besluitenlijst in, of later alsnog. */
function CloseBallot({ ballot, meetings, registerOnly, onClose, onSaved }: { ballot: Ballot; meetings: MeetingSummary[]; registerOnly: boolean; onClose: () => void; onSaved: (message: string) => void }) {
  const tally = (v: Vote) => ballot.votes.filter((x) => x.vote === v).length;
  const [outcome, setOutcome] = useState<"aangenomen" | "verworpen" | "ingetrokken">(tally("akkoord") > tally("niet_akkoord") ? "aangenomen" : "verworpen");
  // Alleen vergaderingen waar nog een besluit bij kan: niet afgerond.
  const targets = meetings.filter((m) => m.status !== "afgerond");
  const [meetingId, setMeetingId] = useState(targets[targets.length - 1]?.id ?? "");
  const [text, setText] = useState(ballot.title);
  const accepted = registerOnly || outcome === "aangenomen";
  return (
    <Modal title={registerOnly ? "Vastleggen in de besluitenlijst" : "Stemronde sluiten"} onClose={onClose}>
      <Form
        submitLabel={registerOnly ? "Vastleggen" : "Sluiten"}
        onCancel={onClose}
        onSubmit={async () => {
          if (registerOnly) {
            const r = await api<{ decision: { number: string } }>(`/api/ballots/${ballot.id}/decision`, { method: "POST", body: { meetingId, decisionText: text } });
            onSaved(`Vastgelegd als besluit ${r.decision.number}`);
          } else {
            const r = await api<{ decision: { number: string } | null }>(`/api/ballots/${ballot.id}/close`, {
              method: "POST",
              body: { outcome, meetingId: accepted && meetingId ? meetingId : null, decisionText: text },
            });
            onSaved(r.decision ? `Gesloten en vastgelegd als besluit ${r.decision.number}` : "Stemronde gesloten");
          }
        }}
      >
        <p>
          <strong>{ballot.title}</strong>
          <br />
          <span className="muted">
            {tally("akkoord")} akkoord, {tally("niet_akkoord")} niet akkoord, {tally("onthouding")} onthouding
          </span>
        </p>
        {!registerOnly && (
          <Field label="Uitkomst" hint="Jij stelt de uitkomst vast volgens de regels van jullie overleg (gewone meerderheid, unanimiteit, quorum).">
            <select className="input" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
              <option value="aangenomen">Aangenomen</option>
              <option value="verworpen">Verworpen</option>
              <option value="ingetrokken">Ingetrokken</option>
            </select>
          </Field>
        )}
        {accepted && (
          <>
            <Field label="Vastleggen bij vergadering" hint="Het besluit krijgt een nummer en staat in de besluitenlijst, met de stemverhouding erbij.">
              <select className="input" required={registerOnly} value={meetingId} onChange={(e) => setMeetingId(e.target.value)}>
                {!registerOnly && <option value="">Nog niet vastleggen</option>}
                {targets.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title} ({new Date(m.startsAt).toLocaleDateString("nl-NL")})
                  </option>
                ))}
              </select>
            </Field>
            {meetingId && (
              <Field label="Tekst van het besluit">
                <textarea className="input" required rows={3} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
            )}
            {!targets.length && <p className="small muted">Er is geen vergadering waar het besluit nu bij kan. Plan er een en leg het besluit daarna vast.</p>}
          </>
        )}
      </Form>
    </Modal>
  );
}

function BallotRow({ ballot, data, canEdit, onChanged, onClose, onRegister }: { ballot: Ballot; data: Data; canEdit: boolean; onChanged: () => void; onClose: () => void; onRegister: () => void }) {
  const user = useUser();
  const run = useRun();
  const mine = ballot.votes.find((v) => v.userId === user.id);
  const open = ballot.status === "open";
  const waiting = data.voters.filter((p) => !ballot.votes.some((v) => v.userId === p.id));

  async function vote(v: Vote) {
    let comment = mine?.comment ?? "";
    if (v !== "akkoord") {
      const answer = window.prompt("Toelichting bij je stem (mag leeg blijven):", comment);
      if (answer === null) return;
      comment = answer;
    }
    if (await run(() => api(`/api/ballots/${ballot.id}/vote`, { method: "PUT", body: { vote: v, comment } }), "Je stem is vastgelegd")) onChanged();
  }

  return (
    <li style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div className="grow">
          <strong>{ballot.title}</strong>
          {ballot.body && <div className="pre small">{ballot.body}</div>}
          <div className="meta">
            <span className={`badge ${open ? "accent" : ballot.status === "aangenomen" ? "accent" : "warm"}`}>{STATUS_LABEL[ballot.status]}</span>
            <span>
              {ballot.createdByName ?? "Onbekend"} · {fmtDate(ballot.createdAt)}
            </span>
            {open && ballot.closesOn && <span>stemmen tot en met {fmtDay(ballot.closesOn)}</span>}
            {ballot.decisionNumber && ballot.decisionMeetingId && (
              <span>
                Besluit <Link to={`/vergaderingen/${ballot.decisionMeetingId}`}>{ballot.decisionNumber}</Link>
              </span>
            )}
          </div>
        </div>
        {canEdit && (
          <div className="row no-print" style={{ gap: 6 }}>
            {open && (
              <Button small variant="secondary" icon="lock" onClick={onClose}>
                Sluiten
              </Button>
            )}
            {ballot.status === "aangenomen" && !ballot.decisionNumber && (
              <Button small variant="secondary" icon="decision" onClick={onRegister}>
                In besluitenlijst
              </Button>
            )}
            <Button
              small
              variant="danger"
              icon="trash"
              aria-label="Stemronde verwijderen"
              onClick={async () => {
                if (!window.confirm(`Stemronde "${ballot.title}" met alle stemmen verwijderen? Een al vastgelegd besluit blijft staan.`)) return;
                if (await run(() => api(`/api/ballots/${ballot.id}`, { method: "DELETE" }), "Stemronde verwijderd")) onChanged();
              }}
            />
          </div>
        )}
      </div>
      {open && data.canVote && (
        <div className="row">
          <div className="rsvp" role="group" aria-label="Mijn stem">
            {(Object.keys(VOTE_LABEL) as Vote[]).map((v) => (
              <button key={v} type="button" className={v === "niet_akkoord" ? "no" : ""} aria-pressed={mine?.vote === v} onClick={() => void vote(v)}>
                {VOTE_LABEL[v]}
              </button>
            ))}
          </div>
          {!mine && <span className="badge warm">Je stem wordt gevraagd</span>}
        </div>
      )}
      <div className="small">
        {ballot.votes.map((v) => (
          <div key={v.userId}>
            {v.name}: <strong>{VOTE_LABEL[v.vote].toLowerCase()}</strong>
            {v.comment ? ` (${v.comment})` : ""}
          </div>
        ))}
        {open && waiting.length > 0 && <div className="muted">Nog niet gestemd: {waiting.map((p) => p.name).join(", ")}</div>}
        {!ballot.votes.length && !open && <div className="muted">Er is niet gestemd.</div>}
      </div>
    </li>
  );
}

/** Tabblad Stemrondes van een overleg: besluiten nemen buiten de vergadering om. */
export function BallotsTab({ overlegId, canEdit, meetings }: { overlegId: string; canEdit: boolean; meetings: MeetingSummary[] }) {
  const toast = useToast();
  const { data, loading, error, reload } = useLoad<Data>(`/api/overleggen/${overlegId}/ballots`);
  const [modal, setModal] = useState<{ type: "new" } | { type: "close" | "register"; ballot: Ballot } | null>(null);
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Stemrondes</h2>
        {canEdit && (
          <Button small icon="plus" onClick={() => setModal({ type: "new" })}>
            Nieuwe stemronde
          </Button>
        )}
      </div>
      <Loader loading={loading} error={error}>
        {data?.ballots.length ? (
          <ul className="list">
            {data.ballots.map((b) => (
              <BallotRow
                key={b.id}
                ballot={b}
                data={data}
                canEdit={canEdit}
                onChanged={reload}
                onClose={() => setModal({ type: "close", ballot: b })}
                onRegister={() => setModal({ type: "register", ballot: b })}
              />
            ))}
          </ul>
        ) : (
          <Empty title="Geen stemrondes">
            Kan een besluit niet wachten tot de volgende vergadering? {canEdit ? "Leg het voorstel voor met Nieuwe stemronde; de deelnemers stemmen hier." : "De secretaris legt het voorstel hier voor en je stemt met één klik."}
          </Empty>
        )}
      </Loader>
      {modal?.type === "new" && (
        <NewBallot
          overlegId={overlegId}
          onClose={() => setModal(null)}
          onSaved={(mailed) => {
            setModal(null);
            toast(mailed ? `Voorgelegd en gemaild naar ${mailed} ${mailed === 1 ? "deelnemer" : "deelnemers"}` : "Voorstel voorgelegd");
            void reload();
          }}
        />
      )}
      {(modal?.type === "close" || modal?.type === "register") && (
        <CloseBallot
          ballot={modal.ballot}
          meetings={meetings}
          registerOnly={modal.type === "register"}
          onClose={() => setModal(null)}
          onSaved={(message) => {
            setModal(null);
            toast(message);
            void reload();
          }}
        />
      )}
    </section>
  );
}
