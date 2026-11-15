// Builds a fresh, empty database for a test, using the real migration files.
//
// Why Node's built-in SQLite instead of D1? It starts in milliseconds and needs
// no extra package, so tests stay fast. Both are SQLite, so the schema behaves
// the same. `npm run db:migrate:local` is the separate check against real D1.

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');

// Migration files are named 0001_..., 0002_..., so sorting by name gives the
// order they must run in, which is the same order Wrangler uses.
export function listMigrationFiles(): string[] {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'));
  return files.sort();
}

export function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');

  // D1 always enforces foreign keys. Plain SQLite doesn't unless asked.
  db.exec('PRAGMA foreign_keys = ON;');

  for (const file of listMigrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    db.exec(sql);
  }
  return db;
}
