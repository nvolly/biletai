import * as path from 'path';
import { paths } from '../config/config';
import { USERS_DB_FILE } from './accounts';
import { migrateUsers } from './migrate';

/**
 * One-time migration of accounts from the JSON file to the SQLite database:
 *   npm run users:migrate
 * Copies data/users.json into data/users.db and prints how many users were copied.
 * Safe to run again: it replaces the database contents with the JSON every time.
 * (Switch `store` in accounts.ts to SqliteUserStore once you stop using the JSON file.)
 */
const jsonFile = path.join(paths.data, 'users.json');
const n = migrateUsers(jsonFile, USERS_DB_FILE);
console.log(`  users migrated: ${n}`);
console.log(`  ${jsonFile}  ->  ${USERS_DB_FILE}`);
