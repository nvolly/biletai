import * as fs from 'fs';
import { User, SqliteUserStore } from './accounts';

/**
 * One-time migration from data/users.json to data/users.db.
 * Copies every user from the JSON file into the SQLite store (replacing whatever is
 * already there) and returns how many users were copied. Runs idempotently.
 */
export function migrateUsers(jsonFile: string, dbFile: string): number {
  const users: User[] = fs.existsSync(jsonFile) ? JSON.parse(fs.readFileSync(jsonFile, 'utf8')) : [];
  const db = new SqliteUserStore(dbFile);
  db.save(users);
  return users.length;
}
