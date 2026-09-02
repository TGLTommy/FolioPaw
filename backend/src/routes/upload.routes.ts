import { Router } from 'express';
import fs from 'node:fs/promises';
import { upload } from '../middleware/upload.middleware';
import {
  getBookById,
  prepareBookImportRetry,
  stageBookUpload,
} from '../services/book.service';
import { bookImportService } from '../services/book-import.service';

const router = Router();

router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '未上传文件' });
    }

    const folderId = req.body.folderId ? Number.parseInt(req.body.folderId, 10) : null;
    if (folderId !== null && !Number.isInteger(folderId)) {
      await fs.rm(req.file.path, { force: true });
      return res.status(400).json({ error: '文件夹ID无效' });
    }

    const staged = await stageBookUpload(req.file, folderId, req.userId!);
    if (staged.shouldEnqueue) bookImportService.enqueue(staged.book.id);

    res.status(staged.shouldEnqueue ? 202 : 200).json({
      success: true,
      message: staged.shouldEnqueue ? '文件上传成功，正在后台解析' : '书籍已存在',
      data: staged.book,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:bookId/status', (req, res, next) => {
  try {
    const bookId = Number.parseInt(req.params.bookId, 10);
    if (!Number.isInteger(bookId)) {
      return res.status(400).json({ error: '书籍ID无效' });
    }

    const book = getBookById(bookId, req.userId!);
    if (!book) return res.status(404).json({ error: '书籍不存在' });
    return res.json({ success: true, data: book });
  } catch (error) {
    next(error);
  }
});

router.post('/:bookId/retry', (req, res, next) => {
  try {
    const bookId = Number.parseInt(req.params.bookId, 10);
    if (!Number.isInteger(bookId)) {
      return res.status(400).json({ error: '书籍ID无效' });
    }

    const book = prepareBookImportRetry(bookId, req.userId!);
    bookImportService.enqueue(bookId);
    return res.status(202).json({
      success: true,
      message: '已重新排队解析',
      data: book,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
