import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  migrateBookNamesToUtf8,
  repairLatin1DecodedUtf8,
} from './migration-manager';

describe('UTF-8 book filename migration', () => {
  it('repairs UTF-8 bytes that were decoded as latin1', () => {
    const correctName = '2608.03573v2_中科院_code_SFT.pdf';
    const mojibakeName = Buffer.from(correctName, 'utf8').toString('latin1');

    expect(repairLatin1DecodedUtf8(mojibakeName)).toBe(correctName);
  });

  it('does not alter valid latin1 or already-correct Unicode names', () => {
    expect(repairLatin1DecodedUtf8('Résumé.pdf')).toBe('Résumé.pdf');
    expect(repairLatin1DecodedUtf8('中科院.pdf')).toBe('中科院.pdf');
  });

  it('repairs only affected rows and runs once for schema v4', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE books (
        id INTEGER PRIMARY KEY,
        original_name TEXT NOT NULL
      )
    `);

    const correctName = '中科院_论文.pdf';
    const mojibakeName = Buffer.from(correctName, 'utf8').toString('latin1');
    database.prepare('INSERT INTO books (id, original_name) VALUES (?, ?), (?, ?)')
      .run(1, mojibakeName, 2, 'Résumé.pdf');

    expect(migrateBookNamesToUtf8(database, 3)).toBe(1);
    expect(database.prepare('SELECT original_name FROM books WHERE id = 1').pluck().get())
      .toBe(correctName);
    expect(database.prepare('SELECT original_name FROM books WHERE id = 2').pluck().get())
      .toBe('Résumé.pdf');
    expect(migrateBookNamesToUtf8(database, 4)).toBe(0);

    database.close();
  });
});
