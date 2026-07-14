// Run: pnpm run db:migrate  (respects DB_PATH env, defaults to data/delivery.db)
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db } from './repo.js';

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export function runMigrations() {
  migrate(db, { migrationsFolder });
}

// Run directly (not just imported)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations();
  console.log('Migrations applied.');
}
