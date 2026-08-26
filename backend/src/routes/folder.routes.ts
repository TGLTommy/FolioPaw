import { Router, Request, Response, NextFunction } from 'express';
import {
  getAllFolders,
  getFolderById,
  createFolder,
  updateFolder,
  deleteFolder,
  getUncategorizedBookCount,
} from '../services/folder.service';
import { getErrorMessage } from '../utils/errors';

const router = Router();

// GET /api/folders - Get all folders with uncategorized count
router.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const folders = getAllFolders(userId);
    const uncategorizedCount = getUncategorizedBookCount(userId);

    res.json({
      success: true,
      data: {
        folders,
        uncategorizedCount,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/folders/:id - Get a single folder
router.get('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const folder = getFolderById(Number.parseInt(String(req.params.id), 10), req.userId!);
    if (!folder) {
      return res.status(404).json({ success: false, error: '文件夹不存在' });
    }
    res.json({ success: true, data: folder });
  } catch (error) {
    next(error);
  }
});

// POST /api/folders - Create a new folder
router.post('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, color } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: '文件夹名称不能为空' });
    }

    if (name.trim().length > 50) {
      return res.status(400).json({ success: false, error: '文件夹名称不能超过50个字符' });
    }

    const folder = createFolder(req.userId!, { name: name.trim(), color });
    res.status(201).json({ success: true, data: folder });
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    if (message === '文件夹名称已存在') {
      return res.status(409).json({ success: false, error: message });
    }
    next(error);
  }
});

// PUT /api/folders/:id - Update a folder
router.put('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, color, sort_order } = req.body;

    if (name !== undefined && (!name || !name.trim())) {
      return res.status(400).json({ success: false, error: '文件夹名称不能为空' });
    }

    if (name && name.trim().length > 50) {
      return res.status(400).json({ success: false, error: '文件夹名称不能超过50个字符' });
    }

    const folder = updateFolder(Number.parseInt(String(req.params.id), 10), req.userId!, { name, color, sort_order });
    res.json({ success: true, data: folder });
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    if (message === '文件夹不存在') {
      return res.status(404).json({ success: false, error: message });
    }
    if (message === '文件夹名称已存在') {
      return res.status(409).json({ success: false, error: message });
    }
    next(error);
  }
});

// DELETE /api/folders/:id - Delete a folder
router.delete('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    deleteFolder(Number.parseInt(String(req.params.id), 10), req.userId!);
    res.json({ success: true, message: '文件夹已删除，书籍已移至未分类' });
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    if (message === '文件夹不存在') {
      return res.status(404).json({ success: false, error: message });
    }
    next(error);
  }
});

export default router;
