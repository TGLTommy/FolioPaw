import { Router } from 'express';
import { summaryService } from '../services/summary.service';
import { assertBookAccess } from '../services/book.service';
import { modelGateway } from '../services/model-gateway.service';
import { getErrorMessage } from '../utils/errors';
import { assertBookTextAvailable } from '../services/book-text-capability.service';

const router = Router();

/**
 * GET /api/summary/:bookId
 * Get all summaries for a book
 */
router.get('/:bookId', async (req, res, next) => {
  try {
    const bookId = parseInt(req.params.bookId);
    if (isNaN(bookId)) return res.status(400).json({ error: 'bookId 无效' });
    assertBookAccess(req.userId!, bookId);
    assertBookTextAvailable(bookId);

    const summaries = summaryService.getSummaries(bookId);
    const chapters = summaryService.calculateChapterRanges(bookId);

    res.json({ success: true, data: { summaries, chapters } });
  } catch (error: unknown) {
    next(error);
  }
});

/**
 * GET /api/summary/:bookId/book
 * Get book-level summary
 */
router.get('/:bookId/book', async (req, res, next) => {
  try {
    const bookId = parseInt(req.params.bookId);
    if (isNaN(bookId)) return res.status(400).json({ error: 'bookId 无效' });
    assertBookAccess(req.userId!, bookId);
    assertBookTextAvailable(bookId);

    const summary = summaryService.getBookSummary(bookId);
    res.json({ success: true, data: summary || null });
  } catch (error: unknown) {
    next(error);
  }
});

/**
 * GET /api/summary/:bookId/chapter/:chapterId
 * Get a specific chapter summary
 */
router.get('/:bookId/chapter/:chapterId', async (req, res, next) => {
  try {
    const bookId = parseInt(req.params.bookId);
    if (isNaN(bookId)) return res.status(400).json({ error: 'bookId 无效' });
    assertBookAccess(req.userId!, bookId);
    assertBookTextAvailable(bookId);

    const summary = summaryService.getChapterSummary(bookId, req.params.chapterId);
    res.json({ success: true, data: summary || null });
  } catch (error: unknown) {
    next(error);
  }
});

/**
 * POST /api/summary/:bookId/generate
 * Generate summary: { type: 'chapter' | 'book', chapterId? }
 */
router.post('/:bookId/generate', async (req, res, next) => {
  try {
    const bookId = parseInt(req.params.bookId);
    if (isNaN(bookId)) return res.status(400).json({ error: 'bookId 无效' });
    assertBookAccess(req.userId!, bookId);
    assertBookTextAvailable(bookId);

    const { type, chapterId } = req.body;

    if (type === 'chapter') {
      if (!chapterId) return res.status(400).json({ error: '生成章节摘要时 chapterId 不能为空' });
      const summary = await summaryService.generateChapterSummary(bookId, chapterId);
      res.json({ success: true, data: summary });
    } else if (type === 'book') {
      const summary = await summaryService.generateBookSummary(bookId);
      res.json({ success: true, data: summary });
    } else {
      return res.status(400).json({ error: 'type 必须是 chapter 或 book' });
    }
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    if (message.includes('不存在') || message.includes('未找到')) {
      return res.status(404).json({ error: message });
    }
    if (message.includes('尚未配置')) {
      return res.status(503).json({ error: message });
    }
    next(error);
  }
});

/**
 * POST /api/summary/:bookId/generate/stream
 * SSE stream: generate all chapter summaries + book summary
 */
router.post('/:bookId/generate/stream', async (req, res, next) => {
  try {
    const bookId = parseInt(req.params.bookId);
    if (isNaN(bookId)) return res.status(400).json({ error: 'bookId 无效' });
    assertBookAccess(req.userId!, bookId);
    assertBookTextAvailable(bookId);
    const modelContext = modelGateway.createContext();

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const chapters = summaryService.calculateChapterRanges(bookId);
    const contentChapters = chapters.filter(c => c.isContent);

    // Send chapter list with content chapter count
    res.write(`data: ${JSON.stringify({ type: 'init', totalChapters: contentChapters.length, contentChapters: contentChapters.length })}\n\n`);

    // Generate each content chapter summary (skip non-content)
    for (let i = 0; i < contentChapters.length; i++) {
      const chapter = contentChapters[i];

      // Skip already completed chapters
      const existing = summaryService.getChapterSummary(bookId, chapter.id);
      if (existing && existing.status === 'completed') {
        res.write(`data: ${JSON.stringify({
          type: 'chapter_complete',
          chapterId: chapter.id,
          title: chapter.title,
          summary: existing.summary_text,
          index: i,
          cached: true,
        })}\n\n`);
        continue;
      }

      res.write(`data: ${JSON.stringify({
        type: 'chapter_start',
        chapterId: chapter.id,
        title: chapter.title,
        index: i,
      })}\n\n`);

      try {
        const result = await summaryService.generateChapterSummary(bookId, chapter.id, modelContext);
        res.write(`data: ${JSON.stringify({
          type: 'chapter_complete',
          chapterId: chapter.id,
          title: chapter.title,
          summary: result.summary_text,
          index: i,
        })}\n\n`);
      } catch (error: unknown) {
        res.write(`data: ${JSON.stringify({
          type: 'chapter_error',
          chapterId: chapter.id,
          title: chapter.title,
          error: getErrorMessage(error),
          index: i,
        })}\n\n`);
      }
    }

    // Generate book summary from chapter summaries
    res.write(`data: ${JSON.stringify({ type: 'book_start' })}\n\n`);

    try {
      const bookSummary = await summaryService.generateBookSummary(bookId, modelContext);
      res.write(`data: ${JSON.stringify({
        type: 'book_complete',
        summary: bookSummary.summary_text,
      })}\n\n`);
    } catch (error: unknown) {
      res.write(`data: ${JSON.stringify({
        type: 'book_error',
        error: getErrorMessage(error),
      })}\n\n`);
    }

    res.write(`data: [DONE]\n\n`);
    res.end();
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
      return;
    }
    next(error);
  }
});

/**
 * DELETE /api/summary/:bookId
 * Delete all summaries for a book
 */
router.delete('/:bookId', async (req, res, next) => {
  try {
    const bookId = parseInt(req.params.bookId);
    if (isNaN(bookId)) return res.status(400).json({ error: 'bookId 无效' });
    assertBookAccess(req.userId!, bookId);

    summaryService.deleteSummaries(bookId);
    res.json({ success: true });
  } catch (error: unknown) {
    next(error);
  }
});

export default router;
