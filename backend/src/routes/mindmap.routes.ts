import { Router } from 'express';
import { mindmapService } from '../services/mindmap.service';
import { summaryService } from '../services/summary.service';
import { assertBookAccess } from '../services/book.service';
import { modelGateway } from '../services/model-gateway.service';
import { getErrorMessage } from '../utils/errors';
import { assertBookTextAvailable } from '../services/book-text-capability.service';

const router = Router();

/**
 * GET /api/mindmap/:bookId
 * Get all mindmaps for a book + chapter list
 */
router.get('/:bookId', async (req, res, next) => {
  try {
    const bookId = parseInt(req.params.bookId);
    if (isNaN(bookId)) return res.status(400).json({ error: 'bookId 无效' });
    assertBookAccess(req.userId!, bookId);
    assertBookTextAvailable(bookId);

    const mindmaps = mindmapService.getMindmaps(bookId);
    const chapters = summaryService.calculateChapterRanges(bookId);

    res.json({ success: true, data: { mindmaps, chapters } });
  } catch (error: unknown) {
    next(error);
  }
});

/**
 * GET /api/mindmap/:bookId/chapter/:chapterId
 * Get a specific chapter mindmap
 */
router.get('/:bookId/chapter/:chapterId', async (req, res, next) => {
  try {
    const bookId = parseInt(req.params.bookId);
    if (isNaN(bookId)) return res.status(400).json({ error: 'bookId 无效' });
    assertBookAccess(req.userId!, bookId);
    assertBookTextAvailable(bookId);

    const mindmap = mindmapService.getMindmap(bookId, req.params.chapterId);
    res.json({ success: true, data: mindmap || null });
  } catch (error: unknown) {
    next(error);
  }
});

/**
 * POST /api/mindmap/:bookId/generate
 * Generate a single chapter mindmap: { chapterId }
 */
router.post('/:bookId/generate', async (req, res, next) => {
  try {
    const bookId = parseInt(req.params.bookId);
    if (isNaN(bookId)) return res.status(400).json({ error: 'bookId 无效' });
    assertBookAccess(req.userId!, bookId);
    assertBookTextAvailable(bookId);

    const { chapterId } = req.body;
    if (!chapterId) return res.status(400).json({ error: 'chapterId 不能为空' });

    const mindmap = await mindmapService.generateMindmap(bookId, chapterId);
    res.json({ success: true, data: mindmap });
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
 * POST /api/mindmap/:bookId/generate/stream
 * SSE stream: generate all chapter mindmaps
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

    res.write(`data: ${JSON.stringify({ type: 'init', totalChapters: contentChapters.length })}\n\n`);

    for (let i = 0; i < contentChapters.length; i++) {
      const chapter = contentChapters[i];

      // Skip already completed
      const existing = mindmapService.getMindmap(bookId, chapter.id);
      if (existing && existing.status === 'completed') {
        res.write(`data: ${JSON.stringify({
          type: 'chapter_complete',
          chapterId: chapter.id,
          title: chapter.title,
          svgContent: existing.svg_content,
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
        const result = await mindmapService.generateMindmap(bookId, chapter.id, modelContext);
        res.write(`data: ${JSON.stringify({
          type: 'chapter_complete',
          chapterId: chapter.id,
          title: chapter.title,
          svgContent: result.svg_content,
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
 * DELETE /api/mindmap/:bookId
 * Delete all mindmaps for a book
 */
router.delete('/:bookId', async (req, res, next) => {
  try {
    const bookId = parseInt(req.params.bookId);
    if (isNaN(bookId)) return res.status(400).json({ error: 'bookId 无效' });
    assertBookAccess(req.userId!, bookId);

    mindmapService.deleteMindmaps(bookId);
    res.json({ success: true });
  } catch (error: unknown) {
    next(error);
  }
});

export default router;
