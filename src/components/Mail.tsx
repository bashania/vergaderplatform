import { useEffect, useState } from "react";
import { BRAND } from "../../shared/brand";
import { api, errorText } from "../api";
import { useUser } from "../auth";
import { fmtDateTime, type Meeting } from "../lib";
import { Button, Field, Form, Loader, Modal, useLoad, useRun, useToast } from "../ui";

type Settings = { host: string; port: number; security: "starttls" | "ssl" | "geen"; user: string; fromName: string; fromAddress: string; hasPassword: boolean };
type LogRow = { at: string; kind: string; toEmail: string; subject: string; status: "bezig" | "verzonden" | "mislukt"; error: string };

/** Platformbeheer: de mailserver waarmee het platform uitnodigingen, agenda's, verslagen en herinneringen verstuurt. */
/**
 * Veelgebruikte aanbieders: kiezen vult de server, de poort en de beveiliging in en zegt welke gegevens
 * waar horen. De adressen komen uit de documentatie van de aanbieders (nagekeken in november 2026).
 */
const PROVIDERS = [
  { key: "brevo", name: "Brevo (Europese verzenddienst)", host: "smtp-relay.brevo.com", user: "Het SMTP-login dat Brevo toont onder SMTP en API.", pass: "De SMTP-sleutel, niet de API-sleutel.", warn: "" },
  { key: "mailjet", name: "Mailjet (Europese verzenddienst)", host: "in-v3.mailjet.com", user: "De API-sleutel van Mailjet.", pass: "De geheime sleutel van Mailjet.", warn: "" },
  { key: "scaleway", name: "Scaleway Transactional Email (Europees)", host: "smtp.tem.scaleway.com", user: "Staat in de console van Scaleway bij Transactional Email.", pass: "De geheime sleutel uit dezelfde console.", warn: "" },
  {
    key: "m365",
    name: "Microsoft 365",
    host: "smtp.office365.com",
    user: "Het e-mailadres van het postvak waarmee je verstuurt.",
    pass: "Het wachtwoord of app-wachtwoord van dat postvak.",
    warn: "Microsoft zet aanmelden met gebruikersnaam en wachtwoord eind december 2026 standaard uit. Daarna verstuurt het platform niets meer, tenzij je beheerder het opnieuw aanzet. Kies liever een verzenddienst.",
  },
] as const;

export function MailSettingsCard() {
  const user = useUser();
  const run = useRun();
  const toast = useToast();
  const { data, loading, error, reload } = useLoad<{ available: boolean; settings: Settings | null; log: LogRow[] }>("/api/admin/mail");
  const [form, setForm] = useState({ host: "", port: 587, security: "starttls" as Settings["security"], user: "", pass: "", fromName: "", fromAddress: "" });
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState("");

  useEffect(() => {
    const s = data?.settings;
    if (s) setForm({ host: s.host, port: s.port, security: s.security, user: s.user, pass: "", fromName: s.fromName, fromAddress: s.fromAddress });
  }, [data?.settings]);

  const set = (change: Partial<typeof form>) => setForm((f) => ({ ...f, ...change }));
  const active = !!data?.settings;
  // De aanbieder volgt uit de ingevulde server: zo klopt de toelichting ook na opslaan en herladen.
  const provider = PROVIDERS.find((p) => p.host === form.host.trim().toLowerCase());

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">E-mail</h2>
        {active ? <span className="badge accent">Ingesteld</span> : <span className="badge">Niet ingesteld</span>}
      </div>
      <div className="card-body stack">
        <Loader loading={loading} error={error}>
          {data && !data.available ? (
            <p className="muted">E-mail kan pas worden ingesteld als de versleutelingssleutel (TOKEN_KEY) op dit platform aanwezig is.</p>
          ) : (
            <>
              <p>
                Met een mailserver verstuurt het platform zelf de uitnodigingen, de agenda, het verslag en herinneringen voor vergaderingen en acties. Zonder
                blijft alles werken zoals nu: links kopieer je en deelnemers mail je uit je eigen programma.
              </p>
              <p className="small muted">
                Kies een aanbieder of vul de gegevens van je eigen mailserver in. Het afzenderadres moet van een domein zijn dat je bij de aanbieder hebt
                bevestigd (SPF en DKIM), anders belandt de mail in de spam. Het wachtwoord wordt versleuteld opgeslagen.
              </p>
              <Form
                submitLabel="Opslaan"
                onSubmit={async () => {
                  await api("/api/admin/mail", { method: "PUT", body: form });
                  set({ pass: "" });
                  setTestError("");
                  await reload();
                  toast("Mailinstellingen opgeslagen");
                }}
              >
                <Field label="Aanbieder">
                  <select
                    className="input"
                    value={provider?.key ?? ""}
                    onChange={(e) => {
                      const chosen = PROVIDERS.find((p) => p.key === e.target.value);
                      if (chosen) set({ host: chosen.host, port: 587, security: "starttls" });
                      else set({ host: "" });
                    }}
                  >
                    <option value="">Andere of eigen mailserver</option>
                    {PROVIDERS.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {provider?.warn && (
                  <div className="notice warm small" role="note">
                    {provider.warn}
                  </div>
                )}
                <div className="form-row">
                  <Field label="Mailserver (SMTP)">
                    <input className="input" required maxLength={200} placeholder="smtp.voorbeeld.nl" value={form.host} onChange={(e) => set({ host: e.target.value })} />
                  </Field>
                  <Field label="Beveiliging en poort">
                    <select
                      className="input"
                      value={form.security}
                      onChange={(e) => {
                        const security = e.target.value as Settings["security"];
                        set({ security, port: security === "ssl" ? 465 : 587 });
                      }}
                    >
                      <option value="starttls">STARTTLS, poort 587</option>
                      <option value="ssl">SSL/TLS, poort 465</option>
                      {form.security === "geen" && <option value="geen">Geen (alleen lokaal testen)</option>}
                    </select>
                  </Field>
                </div>
                <div className="form-row">
                  <Field label="Gebruikersnaam" hint={provider?.user}>
                    <input className="input" maxLength={200} autoComplete="off" value={form.user} onChange={(e) => set({ user: e.target.value })} />
                  </Field>
                  <Field label="Wachtwoord" hint={[provider?.pass, data?.settings?.hasPassword ? "Laat leeg om het opgeslagen wachtwoord te houden." : ""].filter(Boolean).join(" ") || undefined}>
                    <input className="input" type="password" maxLength={500} autoComplete="new-password" value={form.pass} onChange={(e) => set({ pass: e.target.value })} />
                  </Field>
                </div>
                <div className="form-row">
                  <Field label="Naam afzender">
                    <input className="input" maxLength={100} placeholder={BRAND} value={form.fromName} onChange={(e) => set({ fromName: e.target.value })} />
                  </Field>
                  <Field label="Afzenderadres">
                    <input className="input" type="email" required maxLength={200} value={form.fromAddress} onChange={(e) => set({ fromAddress: e.target.value })} />
                  </Field>
                </div>
              </Form>
              {active && (
                <div className="row">
                  <Button
                    variant="secondary"
                    icon="mail"
                    busy={testing}
                    onClick={async () => {
                      setTesting(true);
                      setTestError("");
                      try {
                        await api("/api/admin/mail/test", { method: "POST", body: {} });
                        toast(`Testmail verstuurd naar ${user.email}`);
                      } catch (e) {
                        setTestError(errorText(e));
                      }
                      setTesting(false);
                      void reload();
                    }}
                  >
                    {testing ? "Versturen…" : "Stuur mij een testmail"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      if (!window.confirm("Mailinstellingen wissen? Het platform verstuurt dan geen e-mail meer.")) return;
                      if (await run(() => api("/api/admin/mail", { method: "DELETE" }), "Mailinstellingen gewist")) {
                        setForm({ host: "", port: 587, security: "starttls", user: "", pass: "", fromName: "", fromAddress: "" });
                        void reload();
                      }
                    }}
                  >
                    Wissen
                  </Button>
                </div>
              )}
              {testError && (
                <div className="form-error" role="alert" style={{ overflowWrap: "anywhere" }}>
                  {testError}
                </div>
              )}
              {data && data.log.length > 0 && (
                <details>
                  <summary className="small">Laatst verstuurde e-mails</summary>
                  <div className="table-wrap" style={{ marginTop: 8 }}>
                    <table className="table">
                      <tbody>
                        {data.log.map((l, i) => (
                          <tr key={i}>
                            <td className="small nowrap">{fmtDateTime(l.at)}</td>
                            <td className="small">
                              {l.subject}
                              <div className="muted">{l.toEmail}</div>
                              {l.error && <div className="overdue">{l.error}</div>}
                            </td>
                            <td>{l.status === "verzonden" ? <span className="badge accent">Verzonden</span> : <span className="badge warm">{l.status === "mislukt" ? "Mislukt" : "Bezig"}</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </>
          )}
        </Loader>
      </div>
    </section>
  );
}

/** Vergaderpagina: de agenda of het verslag naar alle deelnemers mailen, met een eigen regel erbij. */
export function MeetingMailModal({ meeting, kind, count, onClose }: { meeting: Meeting; kind: "agenda" | "verslag"; count: number; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [result, setResult] = useState<{ sent: number; failed: string[] } | null>(null);
  const title = kind === "agenda" ? "Agenda mailen naar de deelnemers" : "Verslag mailen naar de deelnemers";
  if (result) {
    return (
      <Modal title={title} onClose={onClose}>
        <div className="stack">
          <p>
            <strong>
              {result.sent} {result.sent === 1 ? "e-mail" : "e-mails"} verstuurd.
            </strong>
          </p>
          {result.failed.length > 0 && <div className="form-error">Niet gelukt bij: {result.failed.join(", ")}. De platformbeheerder ziet de reden in het logboek van de e-mail.</div>}
          <div className="form-foot">
            <Button onClick={onClose}>Klaar</Button>
          </div>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={title} onClose={onClose}>
      <Form
        submitLabel={`Versturen naar ${count} ${count === 1 ? "deelnemer" : "deelnemers"}`}
        onCancel={onClose}
        onSubmit={async () => setResult(await api<{ sent: number; failed: string[] }>(`/api/meetings/${meeting.id}/mail`, { method: "POST", body: { kind, note } }))}
      >
        <p>
          {kind === "agenda"
            ? "Elke deelnemer krijgt een e-mail met datum, tijd, plaats, de agendapunten, een link naar de stukken en een agendabestand om de vergadering in de eigen agenda te zetten."
            : "Elke deelnemer krijgt een e-mail met de besluiten, de acties met actiehouder en deadline, en een link naar het volledige verslag."}
        </p>
        <Field label="Eigen bericht (optioneel)" hint="Komt bovenaan de e-mail. Antwoorden op de mail komen bij jou.">
          <textarea className="input" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Form>
    </Modal>
  );
}

/** Mijn account: herinneringen per e-mail aan of uit. Alleen zichtbaar als het platform kan mailen. */
export function MailPreferenceCard() {
  const run = useRun();
  const { data, reload } = useLoad<{ enabled: boolean; reminders: boolean }>("/api/account/mail");
  if (!data?.enabled) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Herinneringen per e-mail</h2>
        {data.reminders ? <span className="badge accent">Aan</span> : <span className="badge">Uit</span>}
      </div>
      <div className="card-body stack">
        <p>Je krijgt de dag vóór een vergadering een herinnering met een link naar de stukken, en een bericht als een actie op jouw naam afloopt of over de datum is.</p>
        <div>
          <Button
            variant="secondary"
            onClick={async () => {
              if (await run(() => api("/api/account/mail", { method: "PATCH", body: { reminders: !data.reminders } }), data.reminders ? "Herinneringen staan uit" : "Herinneringen staan aan")) void reload();
            }}
          >
            {data.reminders ? "Herinneringen uitzetten" : "Herinneringen aanzetten"}
          </Button>
        </div>
      </div>
    </section>
  );
}
