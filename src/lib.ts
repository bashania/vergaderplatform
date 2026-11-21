export type User = {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  /** Deze sessie is met een passkey ingelogd (telt als tweestapsverificatie). */
  strong: boolean;
  hasPassword: boolean;
  /** Aantal passkeys van dit account. */
  passkeys: number;
};
export type Role = "secretaris" | "deelnemer";
/** Een organisatie is een eigen omgeving; "beheerder" beheert die hele omgeving. */
export type Organisation = {
  id: string;
  name: string;
  role: "beheerder" | "lid";
  /** Alleen toegankelijk als je met een passkey bent ingelogd. */
  requirePasskey: boolean;
  /** De beheerder heeft de AI-assistent voor deze organisatie aangezet. */
  aiEnabled: boolean;
};
export type MeetingStatus = "concept" | "gepubliceerd" | "afgerond";

export type Overleg = {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  /** Alleen de deelnemers zien dit overleg; beheerders van de organisatie niet. */
  besloten: boolean;
  /** Bij een besloten kring: het overleg waar hij bij hoort, als de gebruiker dat ook ziet. */
  parentName: string | null;
  role: Role;
  memberCount: number;
  openActions: number;
  nextMeeting: { id: string; title: string; startsAt: string; status: MeetingStatus } | null;
};

export type MeetingSummary = {
  id: string;
  title: string;
  startsAt: string;
  durationMin: number;
  location: string;
  status: MeetingStatus;
  itemCount: number;
  documentCount: number;
  decisionCount?: number;
  overlegId?: string;
  overlegName?: string;
  myAttendance?: "aanwezig" | "afwezig" | null;
  /** De vergadering is nu bezig (vergadermodus). */
  live?: boolean;
};

export type Member = {
  id: string;
  name: string;
  email: string;
  role: Role;
  active?: boolean;
  activated?: boolean;
  attendance?: "aanwezig" | "afwezig" | null;
};

export type Doc = {
  id: string;
  agendaItemId?: string | null;
  name: string;
  mime: string;
  size: number;
  uploadedAt: string;
  uploadedBy?: string | null;
  uploadedByName?: string | null;
  /** Er is al een samenvatting gemaakt. */
  hasSummary?: boolean;
  meetingId?: string | null;
  meetingTitle?: string | null;
  overlegId?: string;
  overlegName?: string;
};

export type AgendaItem = {
  id: string;
  /** Gevuld bij een subpunt (2.1, 2.2): het hoofdpunt waar het onder valt. */
  parentId: string | null;
  position: number;
  title: string;
  /** Vrij label, bijvoorbeeld "Ter informatie" of "Ter bespreking en voor afspraken". Mag leeg zijn. */
  kind: string;
  presenter: string;
  durationMin: number | null;
  description: string;
  notes: string;
  /** Werkelijk bestede tijd in de vergadermodus, in seconden. */
  spentSec: number;
};

export type Decision = {
  id: string;
  agendaItemId?: string | null;
  number: string;
  text: string;
  status: "genomen" | "ingetrokken";
  decidedOn: string;
  overlegId?: string;
  overlegName?: string;
  meetingId?: string;
  meetingTitle?: string;
};

export type Action = {
  id: string;
  agendaItemId?: string | null;
  text: string;
  ownerId: string | null;
  ownerName: string | null;
  dueDate: string | null;
  status: "open" | "gereed" | "vervallen";
  overlegId?: string;
  overlegName?: string;
  meetingId?: string;
  meetingTitle?: string;
  meetingStartsAt?: string;
  role?: Role;
};

export type Meeting = {
  id: string;
  overlegId: string;
  overlegName: string;
  organisationId: string;
  organisationName: string;
  /** Vergadering van een besloten overleg. */
  besloten?: boolean;
  title: string;
  startsAt: string;
  durationMin: number;
  location: string;
  onlineUrl: string;
  status: MeetingStatus;
  /** Toelichting bij de agenda als geheel. */
  description: string;
  notes: string;
  /** Gevuld zolang de vergadering bezig is (vergadermodus). */
  liveStartedAt: string | null;
  liveItemId: string | null;
  liveItemStartedAt: string | null;
};

/** Stand van de vergadermodus; `version` verandert zodra er iets aan de vergadering wijzigt. */
export type LiveState = {
  status: MeetingStatus;
  liveStartedAt: string | null;
  liveItemId: string | null;
  liveItemStartedAt: string | null;
  now: string;
  version: string;
};

export type MeetingDetail = {
  meeting: Meeting;
  role: Role;
  items: AgendaItem[];
  documents: Doc[];
  decisions: Decision[];
  actions: Action[];
  members: Member[];
  carriedActions: Action[];
};

// ---------- weergave ----------

const NL = "nl-NL";
const pad = (n: number) => String(n).padStart(2, "0");

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(NL, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
export const fmtDateLong = (iso: string) =>
  new Date(iso).toLocaleDateString(NL, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
export const fmtTime = (iso: string | Date) => new Date(iso).toLocaleTimeString(NL, { hour: "2-digit", minute: "2-digit" });
export const fmtDateTime = (iso: string) => `${fmtDate(iso)}, ${fmtTime(iso)}`;
/** Voor datums zonder tijd (YYYY-MM-DD), zoals deadlines. */
export const fmtDay = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString(NL, { day: "numeric", month: "short", year: "numeric" });
export const monthShort = (iso: string) => new Date(iso).toLocaleDateString(NL, { month: "short" }).replace(".", "");

export const addMinutes = (iso: string, min: number) => new Date(new Date(iso).getTime() + min * 60_000);
export const timeRange = (iso: string, durationMin: number) => `${fmtTime(iso)} – ${fmtTime(addMinutes(iso, durationMin))}`;

export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const isOverdue = (dateOnly: string | null) => !!dateOnly && dateOnly < todayStr();

export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (s: string) => new Date(s).toISOString();

export function daysUntil(iso: string): string {
  const start = new Date(iso);
  const a = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const n = new Date();
  const b = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const days = Math.round((a - b) / 86_400_000);
  if (days === 0) return "vandaag";
  if (days === 1) return "morgen";
  if (days > 1 && days <= 14) return `over ${days} dagen`;
  return "";
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toLocaleString(NL, { maximumFractionDigits: 1 })} MB`;
}

export function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  const ext = i > 0 ? name.slice(i + 1) : "";
  return ext && ext.length <= 5 ? ext : "doc";
}

/** Veelgebruikte labels als suggestie; een eigen label typen kan ook. */
export const LABELS = ["Ter informatie", "Ter bespreking", "Ter besluitvorming", "Ter vaststelling", "Ter bespreking en voor afspraken"];

/** Kleur van het label: besluitpunten vallen op, informatiepunten zijn rustig. */
export function labelTone(kind: string): "accent" | "info" | "" {
  const k = kind.toLowerCase();
  if (/besluit|vaststelling|goedkeuring|instemming/.test(k)) return "accent";
  if (/informatie|kennis/.test(k)) return "info";
  return "";
}

export const STATUS_LABEL: Record<MeetingStatus, string> = {
  concept: "Concept",
  gepubliceerd: "Gepubliceerd",
  afgerond: "Afgerond",
};

/** Agendapunten in de volgorde van de vergadering, met hun nummer (1, 2, 2.1, ...). */
export function agendaOrder(items: AgendaItem[]): { item: AgendaItem; number: string }[] {
  const out: { item: AgendaItem; number: string }[] = [];
  items
    .filter((i) => !i.parentId)
    .forEach((top, i) => {
      out.push({ item: top, number: `${i + 1}` });
      items.filter((c) => c.parentId === top.id).forEach((child, j) => out.push({ item: child, number: `${i + 1}.${j + 1}` }));
    });
  return out;
}

/** Duur als 7:05 of 1:02:09. */
export function fmtClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
