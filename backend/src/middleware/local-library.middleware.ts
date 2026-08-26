import type { NextFunction, Request, Response } from 'express';
import { db } from '../config/database';

declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

/**
 * The storage layer still uses a numeric owner key so existing single-account
 * databases can be opened without rewriting every book record. It is an
 * internal compatibility detail: the HTTP application has no accounts,
 * sessions, login flow, or user-facing identity.
 */
export function localLibraryMiddleware(req: Request, _res: Response, next: NextFunction): void {
  try {
    const owner = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number } | undefined;
    if (!owner) throw new Error('本地书库存储尚未初始化');
    req.userId = owner.id;
    next();
  } catch (error) {
    next(error);
  }
}
