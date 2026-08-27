import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { BACKEND_ROOT, runtimeConfig } from './config/env';
import { localLibraryMiddleware } from './middleware/local-library.middleware';
import { errorHandler } from './middleware/error.middleware';
import uploadRoutes from './routes/upload.routes';
import bookRoutes from './routes/book.routes';
import translationRoutes from './routes/translation.routes';
import cacheRoutes from './routes/cache.routes';
import aiChatRoutes from './routes/ai-chat.routes';
import dictionaryRoutes from './routes/dictionary.routes';
import folderRoutes from './routes/folder.routes';
import summaryRoutes from './routes/summary.routes';
import mindmapRoutes from './routes/mindmap.routes';
import readingGuideRoutes from './routes/reading-guide.routes';
import modelServiceRoutes from './routes/model-service.routes';
import ttsRoutes from './routes/tts.routes';

export function createApp() {
  const app = express();

  if (runtimeConfig.trustProxy) app.set('trust proxy', 1);

  app.disable('x-powered-by');
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'same-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", ...runtimeConfig.allowedOrigins],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }));

  app.use((req, res, next) => {
    const sameOrigin = `${req.protocol}://${req.get('host')}`;
    return cors({
      origin(origin, callback) {
        if (!origin || origin === sameOrigin || runtimeConfig.allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error('请求来源不在 CORS 允许列表中'));
      },
    })(req, res, next);
  });
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use((req, res, next) => {
    req.setTimeout(600_000);
    res.setTimeout(600_000);
    next();
  });

  app.use('/uploads', express.static(runtimeConfig.uploadDir, {
    dotfiles: 'deny',
    fallthrough: false,
    index: false,
    maxAge: runtimeConfig.nodeEnv === 'production' ? '1h' : 0,
  }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api', localLibraryMiddleware);
  app.use('/api/upload', uploadRoutes);
  app.use('/api/books', bookRoutes);
  app.use('/api/translate', translationRoutes);
  app.use('/api/cache', cacheRoutes);
  app.use('/api/ai', aiChatRoutes);
  app.use('/api/dictionary', dictionaryRoutes);
  app.use('/api/folders', folderRoutes);
  app.use('/api/summary', summaryRoutes);
  app.use('/api/mindmap', mindmapRoutes);
  app.use('/api/reading-guide', readingGuideRoutes);
  app.use('/api/model-services', modelServiceRoutes);
  app.use('/api/tts', ttsRoutes);

  app.use('/api', (_req, res) => {
    res.status(404).json({ success: false, error: '接口不存在' });
  });

  const frontendDist = path.resolve(BACKEND_ROOT, '..', 'frontend', 'dist');
  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || !req.accepts('html')) return next();
      return res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ success: false, error: '资源不存在' });
  });
  app.use(errorHandler);

  return app;
}
