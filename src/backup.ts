import { api, saveBlob } from "./api";

type Row = Record<string, unknown>;
export type Backup = { format: "vergaderplatform-backup"; version: 1; exportedAt: string; origin: string; tables: Record<string, Row[]> };

/** Haalt alle tabellen in delen op en bewaart ze als één bestand. */
export async function downloadBackup(onProgress: (done: number, total: number) => void): Promise<number> {
  const plan = await api<{ format: Backup["format"]; version: 1; tables: { name: string; rows: number }[] }>("/api/admin/backup");
  const total = plan.tables.reduce((n, t) => n + t.rows, 0);
  const backup: Backup = { format: plan.format, version: plan.version, exportedAt: new Date().toISOString(), origin: window.location.origin, tables: {} };
  let done = 0;
  for (const t of plan.tables) {
    const rows: Row[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const part: { rows: Row[]; next: number | null } = await api("/api/admin/backup", { method: "POST", body: { table: t.name, offset } });
      rows.push(...part.rows);
      done += part.rows.length;
      onProgress(done, total);
      offset = part.next;
    }
    backup.tables[t.name] = rows;
  }
  await api("/api/admin/backup/done", { method: "POST", body: {} });
  saveBlob(new Blob([JSON.stringify(backup)], { type: "application/json" }), `vergaderplatform-backup-${backup.exportedAt.slice(0, 10)}.json`);
  return done;
}

/** Zet een back-up terug op een leeg platform; stuurt de rijen in delen die binnen de limiet van één verzoek passen. */
export async function restoreBackup(file: File, code: string, onProgress: (done: number, total: number) => void): Promise<{ users: number; organisations: number; meetings: number }> {
  let backup: Backup;
  try {
    backup = JSON.parse(await file.text()) as Backup;
  } catch {
    throw new Error("Dit bestand is niet leesbaar. Kies het back-upbestand dat je in Platformbeheer hebt gedownload.");
  }
  if (!backup || typeof backup.tables !== "object") throw new Error("Dit bestand is geen back-up van het vergaderplatform.");
  const send = <T>(body: Record<string, unknown>) => api<T>("/api/setup/restore", { method: "POST", body: { code, ...body } });
  const { order } = await send<{ order: string[] }>({ step: "start", format: backup.format, version: backup.version });
  const total = order.reduce((n, name) => n + (backup.tables[name]?.length ?? 0), 0);
  let done = 0;
  for (const name of order) {
    const rows = backup.tables[name] ?? [];
    let batch: Row[] = [];
    let size = 0;
    const flush = async () => {
      if (!batch.length) return;
      await send({ step: "rows", table: name, rows: batch });
      done += batch.length;
      onProgress(done, total);
      batch = [];
      size = 0;
    };
    for (const row of rows) {
      const bytes = JSON.stringify(row).length;
      // Ruim onder de limiet van één verzoek blijven; een enkele grote rij (een transcript) gaat alleen.
      if (batch.length && (size + bytes > 1_500_000 || batch.length >= 400)) await flush();
      batch.push(row);
      size += bytes;
    }
    await flush();
  }
  return send({ step: "finish" });
}

/**
 * Controleert een back-upbestand tegen het draaiende platform zonder iets te wijzigen: elke regel wordt
 * gelezen zoals terugzetten dat zou doen, en geteld hoeveel er nu (nog) in de database staan.
 */
export async function verifyBackup(file: File, onProgress: (done: number, total: number) => void): Promise<{ rows: number; readable: number; present: number; exportedAt: string }> {
  let backup: Backup;
  try {
    backup = JSON.parse(await file.text()) as Backup;
  } catch {
    throw new Error("Dit bestand is niet leesbaar. Kies het back-upbestand dat je hier hebt gedownload.");
  }
  if (!backup || backup.format !== "vergaderplatform-backup" || typeof backup.tables !== "object") throw new Error("Dit bestand is geen back-up van het vergaderplatform.");
  const total = Object.values(backup.tables).reduce((n, r) => n + r.length, 0);
  let done = 0;
  let readable = 0;
  let present = 0;
  for (const [name, rows] of Object.entries(backup.tables)) {
    let batch: Row[] = [];
    let size = 0;
    const flush = async () => {
      if (!batch.length) return;
      const r = await api<{ readable: number; present: number }>("/api/admin/backup/verify", { method: "POST", body: { table: name, rows: batch } });
      readable += r.readable;
      present += r.present;
      done += batch.length;
      onProgress(done, total);
      batch = [];
      size = 0;
    };
    for (const row of rows) {
      const bytes = JSON.stringify(row).length;
      if (batch.length && (size + bytes > 1_500_000 || batch.length >= 400)) await flush();
      batch.push(row);
      size += bytes;
    }
    await flush();
  }
  return { rows: total, readable, present, exportedAt: backup.exportedAt };
}
