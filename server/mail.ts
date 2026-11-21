import { q, q1 } from "./db";
import { currentDeployContext } from "./files";
import { bad, email as emailAddress, HttpError, int, oneOf, optStr, str } from "./http";
import { hasSecretKey, open, seal } from "./secret";

/**
 * E-mail vanuit het platform, via de mailserver (SMTP) die de platformbeheerder instelt.
 * Zonder instellingen verandert er niets: links kopieer je dan zelf en deelnemers mail je uit je eigen programma.
 *
 * Het wachtwoord van de mailserver staat versleuteld in `settings`. Elke mail komt in `mail_log`,
 * ook om een herinnering nooit dubbel te sturen (dedupe_key).
 */

export type Smtp = { host: string; port: number; security: "starttls" | "ssl" | "geen"; user: string; pass: string; fromName: string; fromAddress: string };

export async function smtpSettings(): Promise<Smtp | null> {
  if (!hasSecretKey()) return null;
  const row = await q1<{ value: string }>(`SELECT value FROM settings WHERE key = 'smtp'`);
  if (!row) return null;
  try {
    return JSON.parse(open(row.value)) as Smtp;
  } catch {
    return null;
  }
}

export const mailEnabled = async () => !!(await smtpSettings());

/** Controleert en bewaart de instellingen. Een leeg wachtwoord laat het bestaande staan. */
export async function saveSmtp(b: Record<string, unknown>): Promise<void> {
  const previous = await smtpSettings();
  const security = oneOf(b.security ?? "starttls", "Beveiliging", ["starttls", "ssl", "geen"] as const);
  // Onversleuteld gaat het wachtwoord leesbaar over de lijn; dat is er alleen voor de lokale tests.
  if (security === "geen" && currentDeployContext() !== "dev") throw bad("Kies STARTTLS of SSL/TLS: zonder versleuteling gaat het wachtwoord leesbaar over het netwerk.");
  const settings: Smtp = {
    host: str(b.host, "Mailserver", { max: 200 }),
    port: int(b.port ?? 587, "Poort", 1, 65535),
    security,
    user: optStr(b.user, "Gebruikersnaam", 200),
    pass: typeof b.pass === "string" && b.pass ? b.pass.slice(0, 500) : (previous?.pass ?? ""),
    fromName: optStr(b.fromName, "Naam afzender", 100) || "Vergaderplatform",
    fromAddress: emailAddress(b.fromAddress),
  };
  await q(`INSERT INTO settings (key, value) VALUES ('smtp', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [seal(JSON.stringify(settings))]);
}

export const clearSmtp = () => q(`DELETE FROM settings WHERE key = 'smtp'`);

// ---------- opmaak ----------

export type Recipient = { email: string; name: string };
export type Message = {
  kind: "uitnodiging" | "agenda" | "verslag" | "herinnering" | "acties" | "test";
  to: Recipient;
  subject: string;
  /** Alinea's boven de knop. */
  intro: string[];
  /** Blokken met een kopje en regels (agenda, besluiten, acties). */
  sections?: { title: string; lines: string[] }[];
  button?: { label: string; url: string };
  /** Kleine tekst onderaan: waarom je deze mail krijgt. */
  footer: string;
  replyTo?: Recipient;
  ics?: { filename: string; content: string };
  /** Dezelfde sleutel wordt maar één keer verstuurd. */
  dedupeKey?: string;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const br = (s: string) => esc(s).replace(/\n/g, "<br>");

function render(m: Message, brand: string): { text: string; html: string } {
  const text = [
    `Beste ${m.to.name},`,
    ...m.intro,
    ...(m.sections ?? []).map((s) => `${s.title}\n${s.lines.map((l) => `- ${l}`).join("\n")}`),
    ...(m.button ? [`${m.button.label}: ${m.button.url}`] : []),
    `--\n${m.footer}`,
  ].join("\n\n");
  const html = `<!doctype html><html lang="nl"><body style="margin:0;padding:24px 12px;background:#f5f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f1c2b;font-size:15px;line-height:1.6">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e1e7ec;border-radius:10px;overflow:hidden">
<div style="padding:14px 24px;background:#13283b;color:#ffffff;font-weight:700">${esc(brand)}</div>
<div style="padding:24px">
<p style="margin:0 0 14px">Beste ${esc(m.to.name)},</p>
${m.intro.map((p) => `<p style="margin:0 0 14px">${br(p)}</p>`).join("\n")}
${(m.sections ?? [])
  .map(
    (s) =>
      `<p style="margin:18px 0 6px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#5a6b7d">${esc(s.title)}</p><ul style="margin:0 0 14px;padding-left:20px">${s.lines
        .map((l) => `<li style="margin:3px 0">${br(l)}</li>`)
        .join("")}</ul>`,
  )
  .join("\n")}
${m.button ? `<p style="margin:22px 0 6px"><a href="${esc(m.button.url)}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:#0b6e78;color:#ffffff;font-weight:600;text-decoration:none">${esc(m.button.label)}</a></p>` : ""}
</div>
<div style="padding:14px 24px;border-top:1px solid #e1e7ec;color:#5a6b7d;font-size:12.5px">${br(m.footer)}</div>
</div></body></html>`;
  return { text, html };
}

// ---------- verzenden ----------

export type Mailer = { send: (m: Message) => Promise<boolean>; close: () => void };

/** Geeft null als er geen mailserver is ingesteld. Sluit de verbinding na gebruik met close(). */
export async function mailer(): Promise<Mailer | null> {
  const smtp = await smtpSettings();
  if (!smtp) return null;
  const brand = (await q1<{ value: string }>(`SELECT value FROM settings WHERE key = 'orgName'`))?.value || "Vergaderplatform";
  const nodemailer = (await import("nodemailer")).default;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === "ssl",
    requireTLS: smtp.security === "starttls",
    ignoreTLS: smtp.security === "geen",
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    pool: true,
    maxConnections: 1,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(m) {
      const log = await q1<{ id: number }>(
        `INSERT INTO mail_log (kind, to_email, subject, dedupe_key) VALUES ($1, $2, $3, $4) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
        [m.kind, m.to.email, m.subject.slice(0, 300), m.dedupeKey ?? null],
      );
      // Al eerder verstuurd (of nu onderweg in een andere aanroep): niet nog eens.
      if (!log) return false;
      try {
        const { text, html } = render(m, brand);
        await transport.sendMail({
          from: { name: smtp.fromName, address: smtp.fromAddress },
          to: { name: m.to.name, address: m.to.email },
          replyTo: m.replyTo ? { name: m.replyTo.name, address: m.replyTo.email } : undefined,
          subject: m.subject,
          text,
          html,
          attachments: m.ics ? [{ filename: m.ics.filename, content: m.ics.content, contentType: "text/calendar; charset=utf-8" }] : undefined,
        });
        await q(`UPDATE mail_log SET status = 'verzonden' WHERE id = $1`, [log.id]);
        return true;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error("mail", m.kind, error);
        // Een mislukte herinnering mag later opnieuw: de sleutel komt weer vrij.
        await q(`UPDATE mail_log SET status = 'mislukt', error = $2, dedupe_key = NULL WHERE id = $1`, [log.id, error.slice(0, 500)]);
        return false;
      }
    },
    close: () => transport.close(),
  };
}

/** Eén mail versturen; gooit een fout met de melding van de mailserver (voor de testknop). */
export async function sendTest(to: Recipient): Promise<void> {
  const m = await mailer();
  if (!m) throw new HttpError(409, "Er is nog geen mailserver ingesteld.");
  try {
    const ok = await m.send({
      kind: "test",
      to,
      subject: "Testmail van het vergaderplatform",
      intro: ["Dit is een testmail. Komt hij aan, dan kan het platform uitnodigingen, agenda's, verslagen en herinneringen versturen."],
      footer: "Verstuurd met de testknop onder Platformbeheer, Instellingen.",
    });
    if (!ok) {
      const last = await q1<{ error: string }>(`SELECT error FROM mail_log WHERE kind = 'test' ORDER BY id DESC LIMIT 1`);
      throw new HttpError(502, `De mailserver weigert het bericht: ${last?.error || "onbekende fout"}`);
    }
  } finally {
    m.close();
  }
}

// ---------- datums in de mail (altijd Nederlandse tijd) ----------

const TZ = "Europe/Amsterdam";
export const nlDate = (iso: string) => new Date(iso).toLocaleDateString("nl-NL", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });
export const nlTime = (iso: string | Date) => new Date(iso).toLocaleTimeString("nl-NL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
export const nlDay = (dateOnly: string) => new Date(`${dateOnly}T12:00:00Z`).toLocaleDateString("nl-NL", { timeZone: TZ, day: "numeric", month: "long" });
