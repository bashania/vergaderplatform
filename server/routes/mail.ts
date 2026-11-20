import { loadMeeting } from "../access";
import { q, q1 } from "../db";
import { currentDeployContext } from "../files";
import { bad, forbidden, HttpError, oneOf, optStr, uuid } from "../http";
import { clearSmtp, mailEnabled, mailer, nlDate, nlDay, nlTime, saveSmtp, sendTest, smtpSettings, type Mailer } from "../mail";
import { route, type Ctx } from "../router";
import { hasSecretKey, taskKey } from "../secret";
import { eventIcs } from "./calendar";

// ---------- instellen (platformbeheerder) ----------

route.get(
  "/api/admin/mail",
  async () => {
    const [smtp, log] = await Promise.all([
      smtpSettings(),
      q(`SELECT at, kind, to_email, subject, status, error FROM mail_log ORDER BY id DESC LIMIT 15`),
    ]);
    return {
      available: hasSecretKey(),
      // Het wachtwoord gaat nooit terug naar het scherm.
      settings: smtp ? { host: smtp.host, port: smtp.port, security: smtp.security, user: smtp.user, fromName: smtp.fromName, fromAddress: smtp.fromAddress, hasPassword: !!smtp.pass } : null,
      log,
    };
  },
  { admin: true },
);

route.put(
  "/api/admin/mail",
  async (c) => {
    await saveSmtp(await c.body());
    return { ok: true };
  },
  { admin: true },
);

route.delete(
  "/api/admin/mail",
  async () => {
    await clearSmtp();
    return { ok: true };
  },
  { admin: true },
);

route.post(
  "/api/admin/mail/test",
  async (c) => {
    await sendTest({ email: c.user.email, name: c.user.name });
    return { ok: true, to: c.user.email };
  },
  { admin: true },
);

// ---------- eigen voorkeur ----------

route.get("/api/account/mail", async (c) => {
  const row = await q1<{ mailReminders: boolean }>(`SELECT mail_reminders FROM users WHERE id = $1`, [c.user.id]);
  return { enabled: await mailEnabled(), reminders: row?.mailReminders ?? true };
});

route.patch("/api/account/mail", async (c) => {
  await q(`UPDATE users SET mail_reminders = $2 WHERE id = $1`, [c.user.id, (await c.body()).reminders === true]);
  return { ok: true };
});

// ---------- uitnodigings- en resetlinks ----------

/**
 * Mailt een zojuist gemaakte link naar de persoon zelf. Geeft terug of dat gelukt is; de link
 * blijft daarnaast zichtbaar voor wie hem maakte, voor het geval de mail niet aankomt.
 */
export async function mailLink(origin: string, senderName: string, userId: string, link: { token?: string; purpose?: string; validDays?: number }): Promise<boolean> {
  if (!link.token) return false;
  const m = await mailer();
  if (!m) return false;
  try {
    const to = await q1<{ email: string; name: string }>(`SELECT email, name FROM users WHERE id = $1 AND active`, [userId]);
    if (!to) return false;
    const invite = link.purpose !== "reset";
    return await m.send({
      kind: "uitnodiging",
      to,
      subject: invite ? "Uitnodiging voor het vergaderplatform" : "Opnieuw toegang tot het vergaderplatform",
      intro: invite
        ? [
            `${senderName} heeft je toegang gegeven tot het vergaderplatform. Daar staan de agenda's, stukken, besluiten en acties van de overleggen waaraan je deelneemt.`,
            `Met de knop hieronder activeer je je account. De link is ${link.validDays ?? 14} dagen geldig en werkt één keer.`,
          ]
        : [`${senderName} heeft een link voor je gemaakt om opnieuw toegang te krijgen. De link is ${link.validDays ?? 2} dagen geldig en werkt één keer.`],
      button: { label: invite ? "Account activeren" : "Toegang herstellen", url: `${origin}/welkom#${link.token}` },
      footer: "Verwachtte je deze e-mail niet? Dan kun je hem negeren; zonder de link gebeurt er niets.",
    });
  } finally {
    m.close();
  }
}

/** Voegt aan het antwoord toe of de link ook naar de persoon zelf is gemaild. */
export async function withMail<T extends { token?: string; purpose?: string; validDays?: number }>(c: Ctx, userId: string, link: T): Promise<T & { mailed: boolean }> {
  return { ...link, mailed: await mailLink(c.url.origin, c.user.name, userId, link) };
}

// ---------- agenda en verslag naar de deelnemers ----------

route.post("/api/meetings/:id/mail", async (c) => {
  const meetingId = uuid(c.params.id, "Vergadering");
  const b = await c.body();
  const kind = oneOf(b.kind, "Soort", ["agenda", "verslag"] as const);
  const note = optStr(b.note, "Bericht", 2000);
  const { meeting, role } = await loadMeeting(c.user, meetingId);
  if (role !== "secretaris") throw forbidden("Alleen de secretaris of beheerder kan de deelnemers mailen.");
  if (meeting.status === "concept") throw new HttpError(409, "Publiceer de vergadering eerst; deelnemers kunnen een concept niet openen.");
  const m = await mailer();
  if (!m) throw new HttpError(409, "Er is geen mailserver ingesteld. De platformbeheerder doet dat onder Platformbeheer, Instellingen.");
  try {
    const [members, items, decisions, actions] = await Promise.all([
      q<{ email: string; name: string }>(
        `SELECT u.email, u.name FROM memberships mb JOIN users u ON u.id = mb.user_id WHERE mb.overleg_id = $1 AND u.active ORDER BY lower(u.name)`,
        [meeting.overlegId],
      ),
      q<{ id: string; parentId: string | null; title: string; kind: string }>(
        `SELECT id, parent_id, title, kind FROM agenda_items WHERE meeting_id = $1 ORDER BY position, title`,
        [meetingId],
      ),
      q<{ number: string; text: string }>(`SELECT number, text FROM decisions WHERE meeting_id = $1 AND status = 'genomen' ORDER BY number`, [meetingId]),
      q<{ text: string; ownerName: string | null; dueDate: string | null }>(
        `SELECT a.text, u.name AS owner_name, a.due_date::text AS due_date FROM actions a LEFT JOIN users u ON u.id = a.owner_id
          WHERE a.meeting_id = $1 AND a.status <> 'vervallen' ORDER BY a.created_at`,
        [meetingId],
      ),
    ]);
    if (!members.length) throw bad("Dit overleg heeft nog geen deelnemers om te mailen.");
    if (members.length > 80) throw new HttpError(413, "Dit overleg heeft te veel deelnemers om in één keer te mailen.");

    const agenda: string[] = [];
    items
      .filter((i) => !i.parentId)
      .forEach((top, n) => {
        agenda.push(`${n + 1}. ${top.title}${top.kind ? ` (${top.kind})` : ""}`);
        items.filter((x) => x.parentId === top.id).forEach((child, k) => agenda.push(`${n + 1}.${k + 1} ${child.title}`));
      });
    const when = `${nlDate(meeting.startsAt)}, ${nlTime(meeting.startsAt)} tot ${nlTime(new Date(new Date(meeting.startsAt).getTime() + meeting.durationMin * 60_000))} uur`;
    const link = `${c.url.origin}/vergaderingen/${meeting.id}`;
    const practical = { title: "Wanneer en waar", lines: [when, ...(meeting.location ? [meeting.location] : []), ...(meeting.onlineUrl ? [`Online: ${meeting.onlineUrl}`] : [])] };
    const footer = `Je krijgt deze e-mail omdat je deelneemt aan ${meeting.overlegName} (${meeting.organisationName}). Verstuurd door ${c.user.name}.`;

    let sent = 0;
    const failed: string[] = [];
    for (const to of members) {
      const ok = await m.send(
        kind === "agenda"
          ? {
              kind,
              to,
              subject: `Agenda: ${meeting.title}, ${nlDate(meeting.startsAt)}`,
              intro: [`De agenda en de stukken voor ${meeting.title} staan klaar.`, ...(note ? [note] : [])],
              sections: [practical, ...(agenda.length ? [{ title: "Agenda", lines: agenda }] : [])],
              button: { label: "Agenda en stukken openen", url: link },
              footer,
              replyTo: { email: c.user.email, name: c.user.name },
              ics: { filename: "vergadering.ics", content: eventIcs(meeting, c.url.origin, c.url.host) },
            }
          : {
              kind,
              to,
              subject: `Verslag: ${meeting.title}, ${nlDate(meeting.startsAt)}`,
              intro: [`Het verslag van ${meeting.title} staat klaar.`, ...(note ? [note] : [])],
              sections: [
                ...(decisions.length ? [{ title: "Besluiten", lines: decisions.map((d) => `${d.number}: ${d.text}`) }] : []),
                ...(actions.length
                  ? [{ title: "Acties", lines: actions.map((a) => `${a.text} (${a.ownerName ?? "nog niet toegewezen"}${a.dueDate ? `, vóór ${nlDay(a.dueDate)}` : ""})`) }]
                  : []),
              ],
              button: { label: "Verslag openen", url: link },
              footer,
              replyTo: { email: c.user.email, name: c.user.name },
            },
      );
      if (ok) sent++;
      else failed.push(to.name);
    }
    return { sent, failed };
  } finally {
    m.close();
  }
});

// ---------- dagelijkse herinneringen ----------

type Reminder = { meetingId: string; title: string; startsAt: string; durationMin: number; location: string; onlineUrl: string; overlegName: string; organisationName: string; documentCount: number; userId: string; email: string; name: string };
type DueAction = { id: string; text: string; dueDate: string; late: boolean; overlegName: string; userId: string; email: string; name: string };

/** Vergaderingen van morgen en acties die aflopen. Elke herinnering gaat één keer de deur uit. */
async function daily(m: Mailer, origin: string, today: string): Promise<{ meetings: number; actions: number }> {
  const reminders = await q<Reminder>(
    `SELECT mt.id AS meeting_id, mt.title, mt.starts_at, mt.duration_min, mt.location, mt.online_url, o.name AS overleg_name, org.name AS organisation_name,
            (SELECT count(*)::int FROM documents d WHERE d.meeting_id = mt.id AND d.status = 'ready') AS document_count,
            u.id AS user_id, u.email, u.name
       FROM meetings mt
       JOIN overleggen o ON o.id = mt.overleg_id
       JOIN organisations org ON org.id = o.organisation_id
       JOIN memberships mb ON mb.overleg_id = o.id
       JOIN users u ON u.id = mb.user_id
       LEFT JOIN attendance a ON a.meeting_id = mt.id AND a.user_id = u.id
      WHERE mt.status = 'gepubliceerd' AND NOT o.archived AND NOT org.archived
        AND (mt.starts_at AT TIME ZONE 'Europe/Amsterdam')::date = $1::date + 1
        AND u.active AND u.mail_reminders AND COALESCE(a.status, '') <> 'afwezig'
      ORDER BY mt.starts_at`,
    [today],
  );
  let meetings = 0;
  for (const r of reminders) {
    const sent = await m.send({
      kind: "herinnering",
      to: r,
      subject: `Morgen: ${r.title}, ${nlTime(r.startsAt)} uur`,
      intro: [`Morgen is ${r.title}.${r.documentCount ? ` Er ${r.documentCount === 1 ? "staat 1 stuk" : `staan ${r.documentCount} stukken`} klaar om te lezen.` : ""}`],
      sections: [{ title: "Wanneer en waar", lines: [`${nlDate(r.startsAt)}, ${nlTime(r.startsAt)} uur`, ...(r.location ? [r.location] : []), ...(r.onlineUrl ? [`Online: ${r.onlineUrl}`] : [])] }],
      button: { label: "Agenda en stukken openen", url: `${origin}/vergaderingen/${r.meetingId}` },
      footer: `Je krijgt deze herinnering omdat je deelneemt aan ${r.overlegName} (${r.organisationName}). Uitzetten kan onder Mijn account.`,
      dedupeKey: `herinnering:${r.meetingId}:${r.userId}`,
    });
    if (sent) meetings++;
  }

  const due = await q<DueAction>(
    `SELECT a.id, a.text, a.due_date::text AS due_date, (a.due_date < $1::date) AS late, o.name AS overleg_name, u.id AS user_id, u.email, u.name
       FROM actions a
       JOIN users u ON u.id = a.owner_id
       JOIN overleggen o ON o.id = a.overleg_id
       JOIN organisations org ON org.id = o.organisation_id
       JOIN meetings mt ON mt.id = a.meeting_id
      WHERE a.status = 'open' AND a.due_date IS NOT NULL AND a.due_date <= $1::date + 1
        AND mt.status <> 'concept' AND NOT o.archived AND NOT org.archived AND u.active AND u.mail_reminders
      ORDER BY a.due_date`,
    [today],
  );
  const monday = new Date(`${today}T12:00:00Z`).getUTCDay() === 1;
  const perUser = new Map<string, DueAction[]>();
  for (const a of due) perUser.set(a.userId, [...(perUser.get(a.userId) ?? []), a]);
  let actions = 0;
  for (const list of perUser.values()) {
    const soon = list.filter((a) => !a.late);
    const late = list.filter((a) => a.late);
    // Loopt er vandaag of morgen iets af: nu melden. Alleen achterstand: één keer per week, op maandag.
    if (!soon.length && !(monday && late.length)) continue;
    const line = (a: DueAction) => `${a.text} (${a.overlegName}, ${a.dueDate === today ? "vandaag" : a.late ? `was ${nlDay(a.dueDate)}` : "morgen"})`;
    const sent = await m.send({
      kind: "acties",
      to: list[0],
      subject: soon.length ? `Je acties: ${soon.length === 1 ? "1 loopt" : `${soon.length} lopen`} af` : `Je acties: ${late.length} over de datum`,
      intro: ["Een overzicht van je acties die aandacht vragen. Is iets klaar, meld het dan af; dan staat het goed in de actielijst van de volgende vergadering."],
      sections: [...(soon.length ? [{ title: "Vandaag of morgen", lines: soon.map(line) }] : []), ...(late.length ? [{ title: "Over de datum", lines: late.map(line) }] : [])],
      button: { label: "Mijn acties openen", url: `${origin}/acties` },
      footer: "Je krijgt deze herinnering omdat deze acties op jouw naam staan. Uitzetten kan onder Mijn account.",
      dedupeKey: `acties:${list[0].userId}:${today}`,
    });
    if (sent) actions++;
  }
  // Het logboek hoeft niet eeuwig mee: na een halfjaar zegt een regel niets meer.
  await q(`DELETE FROM mail_log WHERE at < now() - interval '180 days'`);
  return { meetings, actions };
}

/**
 * Aangeroepen door de dagelijkse taak (netlify/functions/dagelijks.mts), in de achtergrondfunctie.
 * Geen sessie: de aanroeper bewijst zich met een sleutel die van TOKEN_KEY is afgeleid.
 */
route.post(
  "/api/background/daily",
  async (c) => {
    if (!hasSecretKey() || c.req.headers.get("x-task-key") !== taskKey("daily")) throw forbidden("Geen toegang.");
    const m = await mailer();
    if (!m) return { skipped: "geen mailserver" };
    try {
      // Lokaal kan de test een datum meegeven; daarbuiten is het altijd vandaag, Nederlandse tijd.
      const asked = currentDeployContext() === "dev" ? (await c.body().catch(() => ({}) as Record<string, unknown>)).today : undefined;
      const today = typeof asked === "string" && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });
      return await daily(m, c.url.origin, today);
    } finally {
      m.close();
    }
  },
  { public: true, audit: false },
);
