import { describe, it, expect, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { backupData } from './backup';

describe('data backup', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'biletai-backup-'));
  const dataDir = path.join(tmp, 'data');
  const backupsDir = path.join(tmp, 'backups');
  const run = (at: string, maxBackups?: number) =>
    backupData({ dataDir, backupsDir, maxBackups, now: new Date(`${at}T00:00:00Z`) });

  it('copies data/ into backups/<YYYY-MM-DD>/', () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'users.json'), '{"a":1}');

    const r = run('2026-10-10');
    expect(r.at).toBe('2026-10-10');
    expect(fs.readFileSync(path.join(backupsDir, '2026-10-10', 'users.json'), 'utf-8')).toBe('{"a":1}');
  });

  it('refreshes the same day, and removes the oldest day beyond 14', () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'biletai-backup-'));
    const data2 = path.join(tmp2, 'data');
    const backups2 = path.join(tmp2, 'backups');
    const run2 = (at: string) => backupData({ dataDir: data2, backupsDir: backups2, maxBackups: 14, now: new Date(`${at}T00:00:00Z`) });

    fs.mkdirSync(data2, { recursive: true });
    fs.writeFileSync(path.join(data2, 'users.json'), '{"a":1}');
    const days = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 8, 2 + i)).toISOString().slice(0, 10));
    for (const d of days) run2(d); // 14 days: 2026-09-02 … 2026-09-15

    const r = run2('2026-10-15'); // 15th day: 2026-09-02 is pruned, today re-copied
    expect(r.at).toBe('2026-10-15');
    expect(fs.existsSync(path.join(backups2, '2026-09-02'))).toBe(false);
    expect(fs.readdirSync(backups2).sort()).toEqual([...days].slice(1).concat(['2026-10-15']).sort());

    fs.writeFileSync(path.join(data2, 'users.json'), '{"a":2}');
    run2('2026-10-15'); // same day: the folder is refreshed, not a new one
    expect(fs.readdirSync(backups2).filter((d) => d === '2026-10-15').length).toBe(1);
    expect(fs.readFileSync(path.join(backups2, '2026-10-15', 'users.json'), 'utf-8')).toBe('{"a":2}');
  });

  it('ignores unrelated files in backups/', () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'x.json'), '{}');
    fs.writeFileSync(path.join(backupsDir, 'notes.txt'), 'not a backup');
    fs.mkdirSync(path.join(backupsDir, 'not-a-date'), { recursive: true });

    run('2026-10-20', 14);
    expect(fs.existsSync(path.join(backupsDir, 'notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(backupsDir, 'not-a-date'))).toBe(true);
    expect(fs.existsSync(path.join(backupsDir, '2026-10-20', 'x.json'))).toBe(true);
  });

  it('refuses to back up a missing data folder', () => {
    expect(() => backupData({ dataDir: path.join(tmp, 'missing'), backupsDir, now: new Date('2026-10-10T00:00:00Z') }))
      .toThrow(/no such folder/);
  });
});
