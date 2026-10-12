import * as fs from 'fs';
import * as path from 'path';

/**
 * Daily backup of the server's state (data/): copies it into <root>/backups/<YYYY-MM-DD>/
 * and keeps only the newest `maxBackups` days. A same-day run re-copies that day's folder.
 */

export interface BackupOptions {
  dataDir: string;
  backupsDir: string;
  maxBackups?: number;
  now?: Date;
}

export function backupData(opts: BackupOptions): { at: string; dir: string } {
  const maxBackups = opts.maxBackups ?? 14;
  const now = opts.now ?? new Date();
  const at = now.toISOString().slice(0, 10);
  const dir = path.join(opts.backupsDir, at);

  if (!fs.existsSync(opts.dataDir)) {
    throw new Error(`backup: no such folder: ${opts.dataDir}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(opts.dataDir, dir, { recursive: true, force: true });

  const days = fs
    .readdirSync(opts.backupsDir)
    .map((d) => path.join(opts.backupsDir, d))
    .filter((d) => fs.statSync(d).isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(path.basename(d)))
    .sort();
  for (const old of days.slice(0, Math.max(0, days.length - maxBackups))) {
    fs.rmSync(old, { recursive: true, force: true });
  }
  return { at, dir };
}
