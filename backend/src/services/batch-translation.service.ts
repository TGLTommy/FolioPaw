import { db } from '../config/database';
import { getActiveTranslationConfig, getTranslationBatchSize, translatePages, TranslatePageOptions } from './translation.service';
import { assertBookAccess } from './book.service';
import {
    assertBookTextAvailable,
    isMeaningfulExtractedText,
} from './book-text-capability.service';

export interface BatchJob {
    id: number;
    book_id: number;
    user_id: number;
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'stopped';
    start_page: number;
    end_page: number;
    total_pages: number;
    current_page: number;
    processed_pages: number;
    config_id?: number;
    model_config_id?: number;
    error_message?: string;
    created_at: string;
    updated_at: string;
    completed_at?: string;
}

interface TranslationJobStats {
    completedPages: number;
    failedPages: number;
    remainingPages: number[];
    currentPage: number;
}

class BatchTranslationService {
    private runningJobIds = new Set<number>();

    // Create a new batch job
    async createJob(bookId: number, userId: number, startPage?: number, endPage?: number): Promise<BatchJob> {
        assertBookAccess(userId, bookId);
        const capability = assertBookTextAvailable(bookId);

        const book = db.prepare('SELECT total_pages FROM books WHERE id = ?').get(bookId) as { total_pages: number };
        if (!book) {
            throw new Error('书籍不存在');
        }

        const start = startPage || 1;
        const end = endPage || book.total_pages;
        const total = end - start + 1;

        if (capability.fileType === 'pdf') {
            const candidatePages = db.prepare(`
                SELECT id, original_text
                FROM pages
                WHERE book_id = ? AND page_number BETWEEN ? AND ?
            `).all(bookId, start, end) as Array<{ id: number; original_text: string }>;
            const markSkipped = db.prepare(`
                UPDATE pages
                SET translation_status = 'skipped', translated_text = NULL, page_hash = NULL,
                    is_cached = 0, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `);
            db.transaction(() => {
                for (const page of candidatePages) {
                    if (!isMeaningfulExtractedText(page.original_text)) markSkipped.run(page.id);
                }
            })();
        }

        // Check if there is already an active job for this book
        const existingJob = db.prepare(`
      SELECT * FROM translation_jobs 
      WHERE book_id = ? AND user_id = ? AND status IN ('pending', 'processing')
        `).get(bookId, userId) as BatchJob;

        if (existingJob) {
            const refreshedJob = this.refreshJobProgress(existingJob);
            this.startJob(refreshedJob.id);
            return refreshedJob;
        }

        const stats = this.getTranslationJobStats(bookId, start, end);
        const config = stats.remainingPages.length > 0
            ? await getActiveTranslationConfig()
            : null;

        const result = db.prepare(`
      INSERT INTO translation_jobs (
        book_id, user_id, status, start_page, end_page, total_pages,
        current_page, processed_pages, model_config_id
      ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(bookId, userId, start, end, total, stats.currentPage, stats.completedPages, config?.id);

        const job = db.prepare('SELECT * FROM translation_jobs WHERE id = ?').get(result.lastInsertRowid) as BatchJob;

        // Start processing in background (don't await)
        this.startJob(job.id);

        return job;
    }

    resumeInterruptedJobs(): void {
        const parsedMaxAgeHours = parseInt(process.env.BATCH_RESUME_ACTIVE_HOURS || '24', 10);
        const maxAgeHours = Number.isFinite(parsedMaxAgeHours) && parsedMaxAgeHours > 0 ? parsedMaxAgeHours : 24;

        this.markStaleActiveJobs(maxAgeHours);

        const jobs = db.prepare(`
            SELECT id, book_id, status, updated_at
            FROM translation_jobs
            WHERE status IN ('pending', 'processing')
              AND updated_at >= datetime('now', ?)
            ORDER BY created_at ASC, id ASC
        `).all(`-${maxAgeHours} hours`) as Array<Pick<BatchJob, 'id' | 'book_id' | 'status' | 'updated_at'>>;

        if (jobs.length === 0) {
            console.log(`[Batch] No interrupted jobs to resume from the last ${maxAgeHours} hours`);
            return;
        }

        console.log(`[Batch] Resuming ${jobs.length} interrupted job(s) from the last ${maxAgeHours} hours`);
        for (const job of jobs) {
            console.log(`[Batch] Resuming job ${job.id} for book ${job.book_id} (${job.status}, updated ${job.updated_at})`);
            this.startJob(job.id);
        }
    }

    async getJobStatus(bookId: number, userId: number): Promise<BatchJob | null> {
        const job = db.prepare(`
      SELECT * FROM translation_jobs 
      WHERE book_id = ? AND user_id = ?
      ORDER BY created_at DESC 
      LIMIT 1
    `).get(bookId, userId) as BatchJob | null;

        if (!job) return null;

        if (this.isActiveStatus(job.status)) {
            if (!this.runningJobIds.has(job.id) && this.isStaleActiveJob(job)) {
                this.markJobFailed(
                    job,
                    '翻译任务长时间没有进度，已自动标记为失败。可以再次点击“一键全本翻译”继续处理剩余页面。'
                );
            } else {
                this.refreshJobProgress(job);
            }

            return db.prepare('SELECT * FROM translation_jobs WHERE id = ?').get(job.id) as BatchJob | null;
        }

        return job;
    }

    async stopJob(bookId: number, userId: number): Promise<void> {
        db.prepare(`
      UPDATE translation_jobs 
      SET status = 'stopped' 
      WHERE book_id = ? AND user_id = ? AND status IN ('pending', 'processing')
    `).run(bookId, userId);

        db.prepare(`
      UPDATE pages
      SET translation_status = 'pending', updated_at = CURRENT_TIMESTAMP
      WHERE book_id = ? AND translation_status = 'translating'
    `).run(bookId);

        this.refreshBookTranslationStatus(bookId);
    }

    private startJob(jobId: number): void {
        if (this.runningJobIds.has(jobId)) {
            return;
        }

        this.processJob(jobId).catch(err => console.error(`Failed to process job ${jobId}:`, err));
    }

    private async processJob(jobId: number) {
        if (this.runningJobIds.has(jobId)) {
            return;
        }

        this.runningJobIds.add(jobId);
        console.log(`[Batch] Starting job ${jobId}`);

        try {
            // Update status to processing
            db.prepare("UPDATE translation_jobs SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(jobId);

            const job = db.prepare('SELECT * FROM translation_jobs WHERE id = ?').get(jobId) as BatchJob;
            assertBookTextAvailable(job.book_id);
            db.prepare(`
                UPDATE books
                SET translation_status = 'translating'
                WHERE id = ?
            `).run(job.book_id);

            db.prepare(`
                UPDATE pages
                SET translation_status = 'pending', updated_at = CURRENT_TIMESTAMP
                WHERE book_id = ?
                  AND page_number BETWEEN ? AND ?
                  AND translation_status = 'translating'
            `).run(job.book_id, job.start_page, job.end_page);

            const parsedConcurrency = parseInt(process.env.BATCH_CONCURRENCY || '1', 10);
            const concurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : 1;
            const translationBatchSize = getTranslationBatchSize();
            const initialStats = this.getTranslationJobStats(job.book_id, job.start_page, job.end_page);
            const remainingPages = initialStats.remainingPages;

            db.prepare(`
                UPDATE translation_jobs
                SET processed_pages = ?,
                    current_page = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(initialStats.completedPages, initialStats.currentPage, jobId);

            if (remainingPages.length === 0) {
                db.prepare(`
                    UPDATE translation_jobs
                    SET status = 'completed',
                        processed_pages = ?,
                        current_page = ?,
                        completed_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP,
                        error_message = NULL
                    WHERE id = ?
                `).run(job.total_pages, job.end_page, jobId);
                this.refreshBookTranslationStatus(job.book_id);
                console.log(`[Batch] Job ${jobId} completed; no remaining pages`);
                return;
            }

            const queue: number[][] = [];
            let currentChunk: number[] = [];
            for (const pageNumber of remainingPages) {
                currentChunk.push(pageNumber);
                if (currentChunk.length >= translationBatchSize) {
                    queue.push(currentChunk);
                    currentChunk = [];
                }
            }
            if (currentChunk.length > 0) {
                queue.push(currentChunk);
            }

            let processedCount = initialStats.completedPages;
            const failedPages = new Set<number>();
            const executing = new Set<Promise<void>>();

            // Use a loop to manage concurrency
            while (queue.length > 0 || executing.size > 0) {
                // Check if job was stopped
                const currentJobStatus = db.prepare('SELECT status FROM translation_jobs WHERE id = ?').get(jobId) as { status: string };
                if (currentJobStatus.status === 'stopped') {
                    console.log(`[Batch] Job ${jobId} was stopped`);
                    this.refreshBookTranslationStatus(job.book_id);
                    return;
                }

                // Fill active promises up to concurrency limit
                while (queue.length > 0 && executing.size < concurrency) {
                    const pageChunk = queue.shift()!;

                    const p = (async () => {
                        try {
                            const options: TranslatePageOptions = {
                                forceRetranslate: false,
                                skipIfTranslated: true,
                                modelConfigId: job.model_config_id,
                                userId: job.user_id,
                            };
                            const results = await translatePages(job.book_id, pageChunk, options);
                            const failed = results.filter((result) => result.status === 'failed');
                            for (const failedPage of failed) {
                                failedPages.add(failedPage.page);
                                console.error(`[Batch] Error translating page ${failedPage.page}:`, failedPage.error);
                            }
                        } catch (err: any) {
                            console.error(`[Batch] Error translating pages ${pageChunk.join('-')}:`, err.message);
                            for (const pageNumber of pageChunk) {
                                failedPages.add(pageNumber);
                            }
                            db.prepare(`
                                UPDATE pages
                                SET translation_status = 'failed', updated_at = CURRENT_TIMESTAMP
                                WHERE book_id = ? AND page_number IN (${pageChunk.map(() => '?').join(',')})
                            `).run(job.book_id, ...pageChunk);
                        } finally {
                            processedCount += pageChunk.length;
                            db.prepare(`
                                UPDATE translation_jobs 
                                SET current_page = ?, processed_pages = ?, updated_at = CURRENT_TIMESTAMP 
                                WHERE id = ?
                            `).run(pageChunk[pageChunk.length - 1], processedCount, jobId);
                        }
                    })();

                    // Wrap promise to remove itself from set upon completion
                    const promiseWithCleanup = p.then(() => {
                        executing.delete(promiseWithCleanup);
                    });

                    executing.add(promiseWithCleanup);
                }

                // Wait for at least one to finish
                if (executing.size > 0) {
                    await Promise.race(executing);
                }
            }

            const finalStats = this.getTranslationJobStats(job.book_id, job.start_page, job.end_page);
            const finalProcessedPages = Math.max(
                processedCount,
                finalStats.completedPages + finalStats.failedPages
            );

            if (finalStats.completedPages >= job.total_pages) {
                db.prepare(`
                    UPDATE translation_jobs
                    SET status = 'completed',
                        processed_pages = ?,
                        current_page = ?,
                        completed_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP,
                        error_message = NULL
                    WHERE id = ?
                `).run(job.total_pages, job.end_page, jobId);
                this.refreshBookTranslationStatus(job.book_id);
                console.log(`[Batch] Job ${jobId} completed`);
                return;
            }

            const failedCount = finalStats.failedPages || failedPages.size;
            const errorMessage = failedCount > 0
                ? `有 ${failedCount} 页翻译失败，已保留成功页面。再次启动翻译会继续处理剩余页面。`
                : '翻译任务结束后仍有未完成页面。再次启动翻译会继续处理剩余页面。';

            db.prepare(`
                UPDATE translation_jobs
                SET status = 'failed',
                    processed_pages = ?,
                    current_page = ?,
                    error_message = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(finalProcessedPages, finalStats.currentPage, errorMessage, jobId);
            this.refreshBookTranslationStatus(job.book_id);

            console.warn(`[Batch] Job ${jobId} failed with incomplete pages: ${errorMessage}`);

        } catch (error: any) {
            console.error(`[Batch] Job ${jobId} failed:`, error);
            db.prepare(`
        UPDATE translation_jobs 
        SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `).run(error.message, jobId);
            const failedJob = db.prepare('SELECT book_id FROM translation_jobs WHERE id = ?').get(jobId) as { book_id: number } | undefined;
            if (failedJob) {
                this.refreshBookTranslationStatus(failedJob.book_id);
            }
        } finally {
            this.runningJobIds.delete(jobId);
        }
    }

    private refreshJobProgress(job: BatchJob, touchUpdatedAt: boolean = false): BatchJob {
        const stats = this.getTranslationJobStats(job.book_id, job.start_page, job.end_page);
        const processedPages = Math.max(job.processed_pages || 0, stats.completedPages);

        db.prepare(`
            UPDATE translation_jobs
            SET processed_pages = ?,
                current_page = ?
                ${touchUpdatedAt ? ', updated_at = CURRENT_TIMESTAMP' : ''}
            WHERE id = ?
        `).run(processedPages, stats.currentPage, job.id);

        return db.prepare('SELECT * FROM translation_jobs WHERE id = ?').get(job.id) as BatchJob;
    }

    private getTranslationJobStats(bookId: number, startPage: number, endPage: number): TranslationJobStats {
        const rows = db.prepare(`
            SELECT page_number, translation_status, translated_text
            FROM pages
            WHERE book_id = ? AND page_number BETWEEN ? AND ?
            ORDER BY page_number
        `).all(bookId, startPage, endPage) as Array<{
            page_number: number;
            translation_status: string | null;
            translated_text: string | null;
        }>;

        const remainingPages: number[] = [];
        let completedPages = 0;
        let failedPages = 0;

        for (const row of rows) {
            if (row.translation_status === 'skipped' || (row.translation_status === 'completed' && row.translated_text)) {
                completedPages++;
            } else {
                remainingPages.push(row.page_number);
                if (row.translation_status === 'failed') {
                    failedPages++;
                }
            }
        }

        return {
            completedPages,
            failedPages,
            remainingPages,
            currentPage: remainingPages[0] ?? endPage,
        };
    }

    private refreshBookTranslationStatus(bookId: number): void {
        const stats = db.prepare(`
            SELECT
              COUNT(*) as total_pages,
              SUM(CASE WHEN translation_status = 'skipped' OR (translation_status = 'completed' AND translated_text IS NOT NULL) THEN 1 ELSE 0 END) as completed_pages,
              SUM(CASE WHEN translation_status = 'failed' THEN 1 ELSE 0 END) as failed_pages,
              SUM(CASE WHEN translation_status = 'translating' THEN 1 ELSE 0 END) as translating_pages
            FROM pages
            WHERE book_id = ?
        `).get(bookId) as {
            total_pages: number;
            completed_pages: number | null;
            failed_pages: number | null;
            translating_pages: number | null;
        };

        const completedPages = stats.completed_pages || 0;
        const failedPages = stats.failed_pages || 0;
        const translatingPages = stats.translating_pages || 0;
        const nextStatus = completedPages >= stats.total_pages
            ? 'completed'
            : translatingPages > 0
                ? 'translating'
                : failedPages > 0
                    ? 'failed'
                    : 'pending';

        db.prepare(`
            UPDATE books
            SET translation_status = ?
            WHERE id = ?
        `).run(nextStatus, bookId);
    }

    private markStaleActiveJobs(maxAgeHours: number): void {
        const staleJobs = db.prepare(`
            SELECT *
            FROM translation_jobs
            WHERE status IN ('pending', 'processing')
              AND updated_at < datetime('now', ?)
            ORDER BY updated_at ASC
        `).all(`-${maxAgeHours} hours`) as BatchJob[];

        for (const job of staleJobs) {
            this.markJobFailed(
                job,
                '翻译任务因服务重启或长时间无进度而中断。可以再次启动翻译继续处理剩余页面。'
            );
        }
    }

    private markJobFailed(job: BatchJob, message: string): void {
        db.prepare(`
            UPDATE pages
            SET translation_status = 'pending', updated_at = CURRENT_TIMESTAMP
            WHERE book_id = ?
              AND page_number BETWEEN ? AND ?
              AND translation_status = 'translating'
        `).run(job.book_id, job.start_page, job.end_page);

        const stats = this.getTranslationJobStats(job.book_id, job.start_page, job.end_page);
        db.prepare(`
            UPDATE translation_jobs
            SET status = 'failed',
                processed_pages = ?,
                current_page = ?,
                error_message = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(Math.max(job.processed_pages || 0, stats.completedPages), stats.currentPage, message, job.id);

        this.refreshBookTranslationStatus(job.book_id);
    }

    private isActiveStatus(status: BatchJob['status']): boolean {
        return status === 'pending' || status === 'processing';
    }

    private isStaleActiveJob(job: BatchJob): boolean {
        const updatedAt = Date.parse(`${job.updated_at.replace(' ', 'T')}Z`);
        if (!Number.isFinite(updatedAt)) return false;

        const parsedTimeoutMs = Number.parseInt(process.env.TRANSLATION_TIMEOUT_MS || '', 10);
        const timeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0 ? parsedTimeoutMs : 180000;
        const staleAfterMs = Math.max(timeoutMs * 3, 30 * 60 * 1000);

        return Date.now() - updatedAt > staleAfterMs;
    }
}

export const batchTranslationService = new BatchTranslationService();
