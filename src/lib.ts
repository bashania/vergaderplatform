export type User = { id: string; email: string; name: string; isAdmin: boolean };
export type Role = "secretaris" | "deelnemer";
export type MeetingStatus = "concept" | "gepubliceerd" | "afgerond";
export type Kind = "informatie" | "bespreking" | "besluit";

export type Overleg = {
  id: string;
  name: string;
  organisation: string;
  description: string;
  archived: boolean;
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
  organisation?: string;
  myAttendance?: "aanwezig" | "afwezig" | null;
};

export type Member = {
  id: string;
  name: string;
  email: string;
  role: Role;
  active?: boolean;
  hasPassword?: boolean;
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
  meetingId?: string | null;
  meetingTitle?: string | null;
  overlegId?: string;
  overlegName?: string;
};

export type AgendaItem = {
  id: string;
  position: number;
  title: string;
  kind: Kind;
  presenter: string;
  durationMin: number | null;
  description: string;
  notes: string;
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
  organisation: string;
  title: string;
  startsAt: string;
  durationMin: number;
  location: string;
  onlineUrl: string;
  status: MeetingStatus;
  notes: string;
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

export const KIND_LABEL: Record<Kind, string> = {
  informatie: "Ter informatie",
  bespreking: "Ter bespreking",
  besluit: "Ter besluitvorming",
};

export const STATUS_LABEL: Record<MeetingStatus, string> = {
  concept: "Concept",
  gepubliceerd: "Gepubliceerd",
  afgerond: "Afgerond",
};

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
