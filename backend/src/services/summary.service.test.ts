import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, deduplicateBookLevelSummaries, initDatabase } from '../config/database';
import { summaryService } from './summary.service';

function createBook(name: string, totalPages: number): number {
  const result = db.prepare(`
    INSERT INTO books (filename, original_name, file_path, file_type, file_size, total_pages, user_id)
    VALUES (?, ?, ?, 'epub', 100, ?, 1)
  `).run(`${name}.epub`, name, `/tmp/${name}.epub`, totalPages);
  return Number(result.lastInsertRowid);
}

function countBookSummaries(bookId: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM book_summaries
    WHERE book_id = ? AND summary_type = 'book' AND chapter_id IS NULL
  `).get(bookId) as { count: number };
  return row.count;
}

describe('book-level summary rows', () => {
  beforeEach(() => {
    initDatabase();
    db.prepare('DELETE FROM book_summaries').run();
    db.prepare('DELETE FROM books').run();
  });

  it('keeps exactly one row no matter how often the summary is regenerated', () => {
    // SQLite treats NULLs as distinct inside a UNIQUE index, so
    // UNIQUE(book_id, summary_type, chapter_id) never constrains book-level
    // rows. Regenerating used to append a new row every time.
    const bookId = createBook('regenerated', 120);

    summaryService.beginBookSummary(bookId, 120);
    summaryService.beginBookSummary(bookId, 120);
    summaryService.beginBookSummary(bookId, 120);

    expect(countBookSummaries(bookId)).toBe(1);
  });

  it('scopes the constraint per book and leaves chapter summaries alone', () => {
    const firstBook = createBook('first', 50);
    const secondBook = createBook('second', 80);

    summaryService.beginBookSummary(firstBook, 50);
    summaryService.beginBookSummary(secondBook, 80);
    for (const chapterId of ['ch-1', 'ch-2']) {
      db.prepare(`
        INSERT INTO book_summaries (book_id, summary_type, chapter_id, status)
        VALUES (?, 'chapter', ?, 'completed')
      `).run(firstBook, chapterId);
    }

    expect(countBookSummaries(firstBook)).toBe(1);
    expect(countBookSummaries(secondBook)).toBe(1);
    const chapters = db.prepare(`
      SELECT COUNT(*) AS count FROM book_summaries
      WHERE book_id = ? AND summary_type = 'chapter'
    `).get(firstBook) as { count: number };
    expect(chapters.count).toBe(2);
  });

  it('resets an existing row to generating instead of inserting a second one', () => {
    const bookId = createBook('retried', 30);

    summaryService.beginBookSummary(bookId, 30);
    db.prepare(`
      UPDATE book_summaries SET status = 'failed', error_message = '上游超时'
      WHERE book_id = ? AND summary_type = 'book' AND chapter_id IS NULL
    `).run(bookId);

    summaryService.beginBookSummary(bookId, 30);

    const row = db.prepare(`
      SELECT status, error_message FROM book_summaries
      WHERE book_id = ? AND summary_type = 'book' AND chapter_id IS NULL
    `).get(bookId) as { status: string; error_message: string | null };
    expect(countBookSummaries(bookId)).toBe(1);
    expect(row.status).toBe('generating');
    expect(row.error_message).toBeNull();
  });
});

describe('book-level summary migration', () => {
  it('collapses duplicates written by earlier versions, preferring a completed row', () => {
    // A database created before the partial unique index existed.
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        total_pages INTEGER NOT NULL,
        user_id INTEGER DEFAULT 1
      );
      CREATE TABLE book_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        summary_type TEXT NOT NULL,
        chapter_id TEXT,
        summary_text TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(book_id, summary_type, chapter_id)
      );
      INSERT INTO book_summaries (book_id, summary_type, chapter_id, summary_text, status, updated_at)
      VALUES
        (1, 'book', NULL, '第一次', 'completed', '2026-01-01 00:00:00'),
        (1, 'book', NULL, NULL, 'failed', '2026-01-02 00:00:00'),
        (1, 'book', NULL, NULL, 'generating', '2026-01-03 00:00:00'),
        (2, 'book', NULL, '另一本', 'completed', '2026-01-01 00:00:00'),
        (1, 'chapter', 'ch-1', '章节', 'completed', '2026-01-01 00:00:00');
    `);

    deduplicateBookLevelSummaries(legacy);
    // Only possible once the duplicates are gone; this is what initDatabase does next.
    legacy.exec(`
      CREATE UNIQUE INDEX idx_book_summaries_one_book_summary
      ON book_summaries(book_id, summary_type)
      WHERE chapter_id IS NULL
    `);

    const survivors = legacy.prepare(`
      SELECT book_id, summary_text, status FROM book_summaries
      WHERE summary_type = 'book' ORDER BY book_id
    `).all() as Array<{ book_id: number; summary_text: string | null; status: string }>;
    expect(survivors).toEqual([
      { book_id: 1, summary_text: '第一次', status: 'completed' },
      { book_id: 2, summary_text: '另一本', status: 'completed' },
    ]);

    const chapters = legacy.prepare(
      "SELECT COUNT(*) AS count FROM book_summaries WHERE summary_type = 'chapter'"
    ).get() as { count: number };
    expect(chapters.count).toBe(1);

    legacy.close();
  });
});
