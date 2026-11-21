import { api } from "../api";
import { Button, Modal, useLoad, useRun, useToast } from "../ui";
import { fmtCode, Qr, watchUrl } from "./Qr";

/**
 * Meekijken zonder account, per vergadering aan te zetten door de secretaris. Wie de QR-code scant of
 * de code intypt, ziet alleen wat op het scherm staat; zie server/routes/screen.ts.
 */
export function WatchModal({ meetingId, besloten, onClose, onChanged }: { meetingId: string; besloten: boolean; onClose: () => void; onChanged: () => void }) {
  const run = useRun();
  const toast = useToast();
  const { data, loading, reload } = useLoad<{ watch: { token: string; code: string } | null }>(`/api/meetings/${meetingId}/watch`);
  const watch = data?.watch ?? null;

  const set = (on: boolean) =>
    run(
      async () => {
        await api(`/api/meetings/${meetingId}/watch`, { method: "POST", body: { on } });
        await reload();
        onChanged();
      },
      on ? "Meekijken staat aan" : "Meekijken is gestopt",
    );

  return (
    <Modal title="Meekijken op het eigen scherm" onClose={onClose}>
      <div className="stack">
        {besloten ? (
          <p>Dit is een besloten overleg. Meekijken zonder account kan hier niet: deelnemers lopen mee door in te loggen en de vergadermodus te openen.</p>
        ) : loading && !data ? (
          <p className="muted">Laden…</p>
        ) : watch ? (
          <>
            <div className="watch-qr">
              <Qr text={watchUrl(watch.token)} size={220} label="QR-code om mee te kijken" />
              <div className="join-code big">{fmtCode(watch.code)}</div>
              <div className="small muted">
                Scannen, of naar <strong>{window.location.host}/meekijken</strong> en de code typen
              </div>
            </div>
            <p className="small muted">
              Meekijkers zien de agenda, het punt dat aan de orde is, de klok en het stuk dat je op het scherm zet. Geen notulen, besluiten, acties of andere
              stukken. De code staat ook op het presentatiescherm en vervalt als je de vergadermodus beëindigt.
            </p>
            <div className="form-foot">
              <Button
                variant="ghost"
                icon="copy"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(watchUrl(watch.token));
                    toast("Link gekopieerd");
                  } catch {
                    toast("Kopiëren lukt niet in deze browser", "error");
                  }
                }}
              >
                Link kopiëren
              </Button>
              <Button variant="secondary" icon="stop" onClick={() => void set(false)}>
                Meekijken stoppen
              </Button>
            </div>
          </>
        ) : (
          <>
            <p>
              Laat aanwezigen en gasten meekijken op hun eigen telefoon of laptop, zonder account. Ze scannen een QR-code of typen een korte code die je op
              het scherm zet.
            </p>
            <ul className="plain-list">
              <li>Ze zien de agenda, het punt dat aan de orde is, de klok en het stuk dat jij op het scherm zet.</li>
              <li>Ze zien geen notulen, besluiten, acties of andere stukken, en kunnen niets wijzigen.</li>
              <li>Het stopt vanzelf als je de vergadermodus beëindigt. Wie de link heeft, kan tot dat moment meekijken.</li>
            </ul>
            <div className="form-foot">
              <Button variant="ghost" onClick={onClose}>
                Annuleren
              </Button>
              <Button icon="users" onClick={() => void set(true)}>
                Meekijken aanzetten
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
