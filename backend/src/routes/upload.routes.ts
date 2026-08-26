import { Router } from 'express';
import { upload } from '../middleware/upload.middleware';
import { saveBook } from '../services/book.service';

const router = Router();

router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '未上传文件' });
    }

    const folderId = req.body.folderId ? parseInt(req.body.folderId) : null;
    const book = await saveBook(req.file, folderId, req.userId!);

    res.json({
      success: true,
      message: '文件上传成功',
      data: book
    });
  } catch (error) {
    next(error);
  }
});

export default router;
