import * as path from 'path';
import { paths } from '../config/config';
import { backupData } from '../utils/backup';

/**
 * Daily backup of the server state (run on the server, e.g. from cron):
 *   npm run backup
 * Copies data/ into backups/<YYYY-MM-DD>/ and keeps only the newest 14 days.
 */
const { at, dir } = backupData({ dataDir: paths.data, backupsDir: path.resolve(paths.root, 'backups') });
console.log(`  backed up ${paths.data} to ${dir} (${at}), kept ${14} days max`);
