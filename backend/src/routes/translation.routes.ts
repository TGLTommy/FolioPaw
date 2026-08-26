import { Router } from 'express';
import { getTranslationBatchSize, translatePage, translatePages, TranslatePageOptions } from '../services/translation.service';
import { batchTranslationService } from '../services/batch-translation.service';

const router = Router();

// Helper function to rate-limit parallel requests
async function executeWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));

  async function worker() {
    while (nextIndex < tasks.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await tasks[currentIndex]();
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// Translate a specific page
router.post('/page', async (req, res, next) => {
  try {
    const { bookId, pageNumber, forceRetranslate } = req.body;

    if (!bookId || !pageNumber) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    const options: TranslatePageOptions = {
      forceRetranslate: forceRetranslate || false,
      skipIfTranslated: true,
      userId: req.userId!,
    };

    const result = await translatePage(bookId, pageNumber, options);

    res.json({
      success: true,
      message: `第 ${pageNumber} 页翻译完成`,
      data: {
        page: pageNumber,
        translatedText: result.translatedText,
        cacheSource: result.cacheSource,
        configId: result.configId,
        processingTimeMs: result.processingTimeMs,
        cachedAt: result.cachedAt,
      },
    });
  } catch (error: unknown) {
    next(error);
  }
});

// Translate multiple pages with optimization and parallel processing
router.post('/batch', async (req, res, next) => {
  try {
    const { bookId, startPage, endPage, forceRetranslate = false } = req.body;

    if (!bookId || !startPage || !endPage) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    const parsedConcurrency = parseInt(process.env.BATCH_CONCURRENCY || '1', 10);
    const concurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : 1;
    const shouldSkipTranslated = process.env.BATCH_SKIP_TRANSLATED !== 'false';
    const pageCount = endPage - startPage + 1;
    const translationBatchSize = getTranslationBatchSize();

    const pageChunks: number[][] = [];
    let currentChunk: number[] = [];

    for (let page = startPage; page <= endPage; page++) {
      currentChunk.push(page);
      if (currentChunk.length >= translationBatchSize) {
        pageChunks.push(currentChunk);
        currentChunk = [];
      }
    }
    if (currentChunk.length > 0) {
      pageChunks.push(currentChunk);
    }

    const options: TranslatePageOptions = {
      forceRetranslate,
      skipIfTranslated: shouldSkipTranslated,
      userId: req.userId!,
    };

    const tasks = pageChunks.map((chunk) => async () => translatePages(bookId, chunk, options));
    const batchResults = (await executeWithConcurrency(tasks, concurrency))
      .flat()
      .sort((a, b) => a.page - b.page);

    // Categorize results
    const translated = batchResults.filter((r) => r.status === 'translated').length;
    const cached = batchResults.filter((r) => r.status === 'memory' || r.status === 'database').length;
    const skipped = batchResults.filter((r) => r.status === 'skipped').length;
    const failed = batchResults.filter((r) => r.status === 'failed').length;

    res.json({
      success: true,
      message: '批量翻译完成',
      data: {
        summary: {
          total: pageCount,
          translated,
          cached,
          skipped,
          failed,
          progress: `${translated + cached + skipped}/${pageCount}`,
        },
        results: batchResults,
      },
    });
  } catch (error: unknown) {
    next(error);
  }
});

// Get batch translation status/progress
router.get('/batch-status/:batchId', async (req, res, next) => {
  try {
    // Note: Full implementation would require storing batch metadata in DB
    // For now, return placeholder
    res.json({
      batchId: req.params.batchId,
      status: 'completed',
      message: '批量翻译状态跟踪功能暂未开放',
    });
  } catch (error) {
    next(error);
  }
});
// Start a background batch translation job
router.post('/batch-job/start', async (req, res, next) => {
  try {
    const { bookId, startPage, endPage } = req.body;
    if (!bookId) {
      return res.status(400).json({ error: 'bookId 不能为空' });
    }

    const job = await batchTranslationService.createJob(bookId, req.userId!, startPage, endPage);
    res.json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
});

// Get batch job status by Book ID
router.get('/batch-job/:bookId', async (req, res, next) => {
  try {
    const job = await batchTranslationService.getJobStatus(parseInt(req.params.bookId), req.userId!);
    res.json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
});

// Stop a batch job
router.post('/batch-job/stop/:bookId', async (req, res, next) => {
  try {
    await batchTranslationService.stopJob(parseInt(req.params.bookId), req.userId!);
    res.json({ success: true, message: '翻译任务已停止' });
  } catch (error) {
    next(error);
  }
});

export default router;
