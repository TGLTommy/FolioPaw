import fs from 'node:fs';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import type Database from 'better-sqlite3';
import { runtimeConfig } from './env';

export const CURRENT_SCHEMA_VERSION = 5;

const LATIN1_DECODED_UTF8_SEQUENCE = /[\u00c2-\u00f4][\u0080-\u00bf]/u;

export function prepareSchemaMigration(database: Database.Database): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const row = database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number };
  const currentVersion = row.version;

  if (currentVersion < CURRENT_SCHEMA_VERSION && hasApplicationTables(database)) {
    createDatabaseBackup(database, currentVersion);
  }

  return currentVersion;
}

export function completeSchemaMigration(database: Database.Database, previousVersion: number): void {
  if (previousVersion >= CURRENT_SCHEMA_VERSION) return;
  database.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)')
    .run(CURRENT_SCHEMA_VERSION);
}

/**
 * Repairs filenames whose UTF-8 bytes were decoded as latin1 by the multipart
 * parser used before schema v4. Strict validation keeps ordinary latin1 names
 * (for example, "Résumé.pdf") and already-correct Unicode names unchanged.
 */
export function migrateBookNamesToUtf8(
  database: Database.Database,
  previousVersion: number,
): number {
  if (previousVersion >= 4 || !hasTable(database, 'books')) return 0;

  const rows = database.prepare('SELECT id, original_name FROM books').all() as Array<{
    id: number;
    original_name: string;
  }>;
  const update = database.prepare('UPDATE books SET original_name = ? WHERE id = ?');
  let repairedCount = 0;

  for (const row of rows) {
    const repairedName = repairLatin1DecodedUtf8(row.original_name);
    if (repairedName === row.original_name) continue;
    update.run(repairedName, row.id);
    repairedCount += 1;
  }

  return repairedCount;
}

export function repairLatin1DecodedUtf8(value: string): string {
  if (!LATIN1_DECODED_UTF8_SEQUENCE.test(value)) return value;

  // A string produced by latin1 decoding can contain only byte-sized code
  // points. Refuse mixed/already-correct Unicode strings rather than risk loss.
  if (Array.from(value).some((character) => character.codePointAt(0)! > 0xff)) {
    return value;
  }

  const bytes = Buffer.from(value, 'latin1');
  return isUtf8(bytes) ? bytes.toString('utf8') : value;
}

function hasApplicationTables(database: Database.Database): boolean {
  const row = database.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'table' AND name NOT IN ('schema_migrations', 'sqlite_sequence')
  `).get() as { count: number };
  return row.count > 0;
}

function hasTable(database: Database.Database, tableName: string): boolean {
  return Boolean(database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(tableName));
}

function createDatabaseBackup(database: Database.Database, version: number): void {
  if (runtimeConfig.dbPath === ':memory:' || !fs.existsSync(runtimeConfig.dbPath)) return;

  const backupDir = path.join(path.dirname(runtimeConfig.dbPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `database-v${version}-${timestamp}.sqlite`);
  const escapedPath = backupPath.replace(/'/g, "''");
  database.exec(`VACUUM INTO '${escapedPath}'`);
  fs.chmodSync(backupPath, 0o600);
  pruneBackups(backupDir);
  console.log(`Database backup created before schema migration: ${backupPath}`);
}

function pruneBackups(backupDir: string): void {
  const backups = fs.readdirSync(backupDir)
    .filter((name) => /^database-v\d+-.+\.sqlite$/.test(name))
    .map((name) => ({ name, mtime: fs.statSync(path.join(backupDir, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);

  for (const backup of backups.slice(5)) {
    fs.unlinkSync(path.join(backupDir, backup.name));
  }
}
