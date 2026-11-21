import { newToken, sha256 } from "../auth";
import { q, q1 } from "../db";
import { route } from "../router";

/**
 * Agenda-abonnement: vergaderingen verschijnen vanzelf in de agenda-app van de gebruiker.
 * De link is een geheime sleutel (geen inlog mogelijk in een agenda-app) en geeft daarom
 * alleen leestoegang tot wat in een agenda thuishoort: titel, tijd, plaats en de agendapunten.
 */

const feedPath = (token: string) => `/api/agenda/${token}.ics`;

route.get("/api/account/calendar", async (c) => {
  const row = await q1<{ since: string | null }>(`SELECT calendar_token_at AS since FROM users WHERE id = $1`, [c.user.id]);
  return { active: !!row?.since, since: row?.since ?? null };
});

/** Maakt een nieuwe link; een eerdere link werkt daarna niet meer. */
route.post("/api/account/calendar", async (c) => {
  const token = newToken();
  await q(`UPDATE users SET calendar_token_hash = $2, calendar_token_at = now() WHERE id = $1`, [c.user.id, sha256(token)]);
  return { url: `${c.url.origin}${feedPath(token)}` };
});

route.delete("/api/account/calendar", async (c) => {
  await q(`UPDATE users SET calendar_token_hash = NULL, calendar_token_at = NULL WHERE id = $1`, [c.user.id]);
  return { ok: true };
});

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const text = (s: string) => s.replace(/\\/g, "\\\\").replace(/[,;]/g, "\\$&").replace(/\r?\n/g, "\\n");

/** Regels van meer dan 75 bytes horen in iCalendar te worden afgebroken met een spatie op de vervolgregel. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  let limit = 75;
  while (Buffer.byteLength(rest, "utf8") > limit) {
    let cut = Math.min(rest.length, limit);
    while (Buffer.byteLength(rest.slice(0, cut), "utf8") > limit) cut--;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    limit = 74;
  }
  parts.push(rest);
  return parts.join("\r\n ");
}

/** Eén vergadering als agendabestand, voor de bijlage bij de mail met de agenda. */
export function eventIcs(m: { id: string; title: string; startsAt: string; durationMin: number; location: string; onlineUrl: string }, origin: string, host: string): string {
  const start = new Date(m.startsAt);
  const link = `${origin}/vergaderingen/${m.id}`;
  return (
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Vergaderplatform//NL",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${m.id}@${host}`,
      `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(new Date(start.getTime() + m.durationMin * 60_000))}`,
      `SUMMARY:${text(m.title)}`,
      ...(m.location || m.onlineUrl ? [`LOCATION:${text(m.location || m.onlineUrl)}`] : []),
      `DESCRIPTION:${text(`Agenda en stukken: ${link}${m.onlineUrl ? `\nOnline deelnemen: ${m.onlineUrl}` : ""}`)}`,
      `URL:${link}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .map(fold)
      .join("\r\n") + "\r\n"
  );
}

type FeedRow = {
  id: string;
  title: string;
  startsAt: string;
  durationMin: number;
  location: string;
  onlineUrl: string;
  status: string;
  overlegName: string;
  organisationName: string;
  protected: boolean;
  items: { nr: string; title: string }[] | null;
};

route.get(
  "/api/agenda/:token",
  async (c) => {
    const token = c.params.token.replace(/\.ics$/i, "");
    const user = token.length >= 20 ? await q1<{ id: string }>(`SELECT id FROM users WHERE calendar_token_hash = $1 AND active`, [sha256(token)]) : null;
    if (!user) return new Response("Deze agendalink is niet (meer) geldig.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

    // Alle organisaties waar de gebruiker bij hoort. Concepten blijven buiten de agenda.
    // Van een organisatie die een passkey eist, komt alleen titel, tijd en plaats mee: de link is geen passkey.
    const rows = await q<FeedRow>(
      `SELECT mt.id, mt.title, mt.starts_at, mt.duration_min, mt.location, mt.online_url, mt.status,
              o.name AS overleg_name, org.name AS organisation_name, org.require_passkey AS protected,
              (SELECT json_agg(json_build_object(
                        'nr', CASE WHEN i.parent_id IS NULL THEN i.position::text
                                   ELSE (SELECT p.position FROM agenda_items p WHERE p.id = i.parent_id)::text || '.' || i.position::text END,
                        'title', i.title)
                      ORDER BY COALESCE((SELECT p.position FROM agenda_items p WHERE p.id = i.parent_id), i.position),
                               (i.parent_id IS NOT NULL), i.position)
                 FROM agenda_items i WHERE i.meeting_id = mt.id) AS items
         FROM meetings mt
         JOIN overleggen o ON o.id = mt.overleg_id
         JOIN organisations org ON org.id = o.organisation_id
        WHERE mt.status <> 'concept' AND NOT o.archived AND NOT org.archived
          AND mt.starts_at > now() - interval '60 days'
          AND (EXISTS (SELECT 1 FROM memberships m WHERE m.overleg_id = o.id AND m.user_id = $1)
               OR (NOT o.besloten AND EXISTS (SELECT 1 FROM organisation_admins a WHERE a.organisation_id = org.id AND a.user_id = $1)))
        ORDER BY mt.starts_at LIMIT 400`,
      [user.id],
    );

    const now = stamp(new Date());
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Vergaderplatform//NL", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Vergaderingen", "X-PUBLISHED-TTL:PT1H"];
    for (const m of rows) {
      const start = new Date(m.startsAt);
      const link = `${c.url.origin}/vergaderingen/${m.id}`;
      const agenda = !m.protected && m.items?.length ? `Agenda:\n${m.items.map((i) => `${i.nr} ${i.title}`).join("\n")}\n\n` : "";
      lines.push(
        "BEGIN:VEVENT",
        `UID:${m.id}@${c.url.host}`,
        `DTSTAMP:${now}`,
        `DTSTART:${stamp(start)}`,
        `DTEND:${stamp(new Date(start.getTime() + m.durationMin * 60_000))}`,
        `SUMMARY:${text(m.title)}`,
        ...(m.location || m.onlineUrl ? [`LOCATION:${text(m.location || m.onlineUrl)}`] : []),
        `DESCRIPTION:${text(`${m.overlegName} (${m.organisationName})\n\n${agenda}Agenda en stukken: ${link}${m.onlineUrl ? `\nOnline deelnemen: ${m.onlineUrl}` : ""}`)}`,
        `URL:${link}`,
        "END:VEVENT",
      );
    }
    lines.push("END:VCALENDAR");
    return new Response(lines.map(fold).join("\r\n") + "\r\n", {
      headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, no-store", "x-robots-tag": "noindex" },
    });
  },
  { public: true },
);
