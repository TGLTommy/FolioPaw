import { Request, Response, NextFunction } from 'express';
import { runtimeConfig } from '../config/env';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const error = err as {
    code?: string;
    expose?: boolean;
    message?: string;
    status?: number;
    stack?: string;
  };
  const status = error.status || 500;
  if (status >= 500) console.error('Request failed:', error.message || 'Unknown error');

  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      error: '文件大小超出限制',
      message: `文件不能超过 ${Math.round(runtimeConfig.maxFileSize / 1024 / 1024)}MB`
    });
  }

  if (error.message?.includes('只支持')) {
    return res.status(400).json({
      error: '文件格式错误',
      message: error.message
    });
  }

  // In production, don't expose internal error details
  const isDev = runtimeConfig.nodeEnv !== 'production';
  const publicMessage = error.expose ? (error.message || '模型服务调用失败') : '服务器内部错误';
  res.status(status).json({
    error: isDev ? (error.message || '服务器内部错误') : publicMessage,
    ...(error.code && { code: error.code }),
    ...(isDev && { stack: error.stack })
  });
}
