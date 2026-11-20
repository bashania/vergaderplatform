/**
 * Maakt van geplakte tekst (uit Word, pdf of e-mail) een agenda met hoofd- en subpunten.
 *
 * Herkent:
 * - nummering "1", "2.1", "3." of "4)" aan het begin van een regel;
 * - een label aan het eind ("Ter informatie", "Ter bespreking en voor afspraken"),
 *   ook als dat door het kopiëren op een eigen regel is beland;
 * - vervolgregels van een lang onderwerp, en een nummer dat op een eigen regel is beland;
 * - tekst ná een compleet punt als toelichting bij dat punt.
 * Zonder nummering wordt elke regel een agendapunt.
 */
export type ParsedItem = { title: string; kind: string; description: string; children: ParsedItem[] };

const NUMBERED = /^(\d{1,2})(?:\.(\d{1,2}))?(?:\.\d{1,2})*[.)]?\s+(\S.*)$/;
const LABEL = /^Ter [\p{L} ,/-]{3,70}$/u;
const MAX_TITLE = 200;

function splitLabel(text: string): { title: string; kind: string } {
  const t = text.trim();
  // "(ter informatie)" aan het eind.
  const paren = /^(.*\S)\s*\((ter [^()]{3,70})\)$/i.exec(t);
  if (paren) return { title: paren[1], kind: paren[2].charAt(0).toUpperCase() + paren[2].slice(1) };
  const at = t.lastIndexOf(" Ter ");
  if (at > 0) {
    const kind = t.slice(at + 1);
    if (LABEL.test(kind)) return { title: t.slice(0, at).trim(), kind };
  }
  return { title: t, kind: "" };
}

type Draft = { sub: boolean; title: string; kind: string; extra: string[] };

function finish(d: Draft): ParsedItem {
  let title = d.title;
  const extra = [...d.extra];
  if (title.length > MAX_TITLE) {
    const cut = title.lastIndexOf(" ", MAX_TITLE);
    extra.unshift(title.slice(cut > 0 ? cut + 1 : MAX_TITLE));
    title = title.slice(0, cut > 0 ? cut : MAX_TITLE);
  }
  return { title, kind: d.kind, description: extra.join("\n"), children: [] };
}

export function parseAgenda(input: string): ParsedItem[] {
  const raw = input
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // Sommige pdf-viewers zetten het nummer op een eigen regel: voeg het samen met de regel erna.
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (/^\d{1,2}(\.\d{1,2})*[.)]?$/.test(raw[i]) && i + 1 < raw.length) lines.push(`${raw[i]} ${raw[++i]}`);
    else lines.push(raw[i]);
  }
  const numbered = lines.map((l) => NUMBERED.exec(l));

  // Begin bij punt 1 (of 0) als dat er is: wat ervoor staat is de kop van het document.
  let start = numbered.findIndex((m) => m && !m[2] && (m[1] === "1" || m[1] === "0"));
  if (start < 0) start = numbered.findIndex(Boolean);

  const drafts: Draft[] = [];
  if (start < 0) {
    for (const line of lines) drafts.push({ sub: false, ...splitLabel(line), extra: [] });
  } else {
    let lastMajor = -1;
    for (let i = start; i < lines.length; i++) {
      const m = numbered[i];
      const major = m ? Number(m[1]) : NaN;
      // Alleen een opvolgend nummer telt als nieuw punt; zo wordt "20 november" geen agendapunt.
      const top = !!m && !m[2] && (lastMajor < 0 || major === lastMajor + 1);
      const sub = !!m && !!m[2] && major === lastMajor;
      if (m && (top || sub)) {
        drafts.push({ sub, ...splitLabel(m[3]), extra: [] });
        if (top) lastMajor = major;
        continue;
      }
      const current = drafts[drafts.length - 1];
      if (current.kind) {
        // Het punt was al compleet: dit is toelichting.
        current.extra.push(lines[i]);
      } else {
        Object.assign(current, splitLabel(`${current.title} ${lines[i]}`));
      }
    }
  }

  const result: ParsedItem[] = [];
  for (const d of drafts) {
    if (!d.title) continue;
    const item = finish(d);
    const parent = result[result.length - 1];
    if (d.sub && parent) parent.children.push(item);
    else result.push(item);
  }
  return result;
}

export const countItems = (items: ParsedItem[]) => items.reduce((n, i) => n + 1 + i.children.length, 0);
