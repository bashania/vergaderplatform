import { env } from "./http";

/**
 * Antwoorden voor de lokale testmodus (AI_FAKE=1, alleen onder `netlify dev`).
 * Geen taalmodel: eenvoudige regels die genoeg opleveren om de schermen en de tests te laten werken.
 */

type Item = { key: string; notes: string };
type Member = { key: string; name: string };

const sentences = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

const MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

/** "15 januari" of "15 januari 2027" naar JJJJ-MM-DD; het jaar is anders het eerstvolgende waarin de datum na de vergadering valt. */
function dueDate(sentence: string, meetingDate: string): string {
  const m = new RegExp(`(\\d{1,2}) (${MONTHS.join("|")})(?: (\\d{4}))?`, "i").exec(sentence);
  if (!m) return "";
  const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
  const stamp = (year: number) => `${year}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  if (m[3]) return stamp(Number(m[3]));
  const year = Number(meetingDate.slice(0, 4));
  return stamp(year) >= meetingDate ? stamp(year) : stamp(year + 1);
}

export function fakeProposals(items: Item[], members: Member[], meetingDate: string): string {
  const decisions: { item: string; text: string }[] = [];
  const actions: { item: string; text: string; owner: string; due: string }[] = [];
  for (const it of items) {
    for (const s of sentences(it.notes)) {
      if (/\b(besluit|besloten|akkoord|stelt vast|vastgesteld|goedgekeurd|stemt in)\b/i.test(s)) {
        decisions.push({ item: it.key, text: s });
      } else if (/\b(zorgt|stuurt|maakt|levert|regelt|vraagt|neemt contact|werkt .* uit|actie)\b/i.test(s)) {
        const owner = members.find((m) => new RegExp(`\\b${m.name.split(/\s+/)[0]}\\b`, "i").test(s));
        actions.push({ item: it.key, text: s, owner: owner?.key ?? "", due: dueDate(s, meetingDate) });
      }
    }
  }
  return JSON.stringify({ decisions, actions });
}

/** Concept-notulen: per agendapunt de regels uit het transcript waarin het onderwerp wordt genoemd. */
export function fakeNotes(items: { key: string; title: string }[], transcript: string): string {
  const preset = env("AI_FAKE_NOTES");
  if (preset) return preset;
  const lines = transcript.split("\n").map((l) => l.replace(/^\[[^\]]*\]\s*/, "").trim());
  const out: { item: string; notes: string }[] = [];
  for (const it of items) {
    const word = it.title.split(/\s+/).find((w) => w.length > 4)?.toLowerCase();
    const hits = word ? lines.filter((l) => l.toLowerCase().includes(word)).slice(0, 3) : [];
    if (hits.length) out.push({ item: it.key, notes: `Besproken: ${hits.join(" ")}` });
  }
  return JSON.stringify({ items: out, general: "" });
}

/** Vraag het archief: het eerste besluit of de eerste notitie waarin een trefwoord uit de vraag voorkomt. */
export function fakeAnswer(sources: { key: string; text: string }[], words: string[]): string {
  const hit = sources.find((s) => words.some((w) => s.text.toLowerCase().includes(w)));
  // Voor de instructiefilm kan het antwoord vooraf zijn ingesteld (zoals AI_FAKE_SUMMARY).
  const answer = env("AI_FAKE_ANSWER")?.replace(/\\n/g, "\n") ?? `Gevonden in het archief: ${hit?.text}`;
  return JSON.stringify(hit ? { answer, sources: [hit.key, "ONBEKEND"] } : { answer: "Daarover is niets vastgelegd.", sources: [] });
}

export function fakeSummary(name: string): string {
  return (
    env("AI_FAKE_SUMMARY")?.replace(/\\n/g, "\n") ??
    `Waar het over gaat\nTestsamenvatting van ${name}.\n\nKernpunten\n- Eerste kernpunt uit het stuk.\n- Tweede kernpunt uit het stuk.`
  );
}
