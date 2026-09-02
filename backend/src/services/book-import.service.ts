import { db } from '../config/database';
import { processBookImport } from './book.service';

class BookImportService {
  private readonly queue: number[] = [];
  private readonly queuedBookIds = new Set<number>();
  private activeBookId: number | null = null;
  private draining = false;
  private drainScheduled = false;
  private idleResolvers: Array<() => void> = [];

  enqueue(bookId: number): void {
    if (this.queuedBookIds.has(bookId)) return;

    const book = db.prepare('SELECT import_status FROM books WHERE id = ?').get(bookId) as
      | { import_status: string }
      | undefined;
    if (!book || book.import_status === 'ready') return;

    this.queue.push(bookId);
    this.queuedBookIds.add(bookId);
    this.scheduleDrain();
  }

  resumeInterruptedImports(): void {
    db.prepare(`
      UPDATE books
      SET import_status = 'pending', import_stage = 'queued',
          import_error = NULL, import_started_at = NULL, import_completed_at = NULL
      WHERE import_status = 'processing'
    `).run();

    const pendingBooks = db.prepare(`
      SELECT id FROM books
      WHERE import_status = 'pending'
      ORDER BY upload_time ASC, id ASC
    `).all() as Array<{ id: number }>;
    for (const book of pendingBooks) this.enqueue(book.id);
  }

  waitForIdle(): Promise<void> {
    if (!this.draining && !this.drainScheduled && this.activeBookId === null && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private scheduleDrain(): void {
    if (this.draining || this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      while (this.queue.length > 0) {
        const bookId = this.queue.shift()!;
        this.queuedBookIds.delete(bookId);
        this.activeBookId = bookId;

        try {
          await processBookImport(bookId);
        } catch (error) {
          console.error(
            `Book import failed for ${bookId}:`,
            error instanceof Error ? error.message : error,
          );
        } finally {
          this.activeBookId = null;
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length > 0) {
        this.scheduleDrain();
      } else {
        const resolvers = this.idleResolvers;
        this.idleResolvers = [];
        for (const resolve of resolvers) resolve();
      }
    }
  }
}

export const bookImportService = new BookImportService();
