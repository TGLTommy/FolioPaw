import { Router } from 'express';
import { assertBookAccess } from '../services/book.service';
import { readingGuideService } from '../services/reading-guide.service';
import { assertBookTextAvailable } from '../services/book-text-capability.service';

const router = Router();

router.get('/:bookId', (req, res, next) => {
  try {
    const bookId = parseInt(req.params.bookId);
    if (isNaN(bookId)) {
      return res.status(400).json({ success: false, error: '无效的书籍ID' });
    }

    assertBookAccess(req.userId!, bookId);
    assertBookTextAvailable(bookId);
    const guide = readingGuideService.getReadingGuide(bookId);
    res.json({ success: true, data: guide || null });
  } catch (error) {
    next(error);
  }
});

router.post('/:bookId/generate', (req, res, next) => {
  try {
    const bookId = parseInt(req.params.bookId);
    if (isNaN(bookId)) {
      return res.status(400).json({ success: false, error: '无效的书籍ID' });
    }

    assertBookAccess(req.userId!, bookId);
    assertBookTextAvailable(bookId);
    const guide = readingGuideService.ensureReadingGuide(bookId, Boolean(req.body?.force));
    res.json({ success: true, data: guide });
  } catch (error) {
    next(error);
  }
});

router.post('/:bookId/cancel', (req, res, next) => {
  try {
    const bookId = parseInt(req.params.bookId);
    if (isNaN(bookId)) {
      return res.status(400).json({ success: false, error: '无效的书籍ID' });
    }

    assertBookAccess(req.userId!, bookId);
    const guide = readingGuideService.cancelReadingGuide(bookId);
    res.json({ success: true, data: guide || null });
  } catch (error) {
    next(error);
  }
});

export default router;
