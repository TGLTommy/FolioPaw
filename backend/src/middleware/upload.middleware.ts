import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'node:crypto';
import { runtimeConfig } from '../config/env';

const UPLOAD_DIR = runtimeConfig.uploadDir;
const ALLOWED_EPUB_MIME_TYPES = new Set([
  'application/epub+zip',
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
]);
const ALLOWED_PDF_MIME_TYPES = new Set([
  'application/pdf',
  'application/octet-stream',
]);

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
}
fs.chmodSync(UPLOAD_DIR, 0o700);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${extension}`);
  }
});

const fileFilter = (_req: Express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const ext = path.extname(file.originalname).toLowerCase();

  const mimeType = file.mimetype.toLowerCase();
  const validEpub = ext === '.epub' && ALLOWED_EPUB_MIME_TYPES.has(mimeType);
  const validPdf = ext === '.pdf' && ALLOWED_PDF_MIME_TYPES.has(mimeType);

  if (validEpub || validPdf) {
    cb(null, true);
  } else {
    cb(new Error('只支持有效的 EPUB 或 PDF 文件'));
  }
};

export const upload = multer({
  storage,
  fileFilter,
  // Browsers encode multipart filenames as UTF-8. Multer otherwise defaults
  // non-extended filename parameters to latin1, which turns names such as
  // "中科院.pdf" into "ä¸­ç§\u0091é\u0099¢.pdf".
  defParamCharset: 'utf8',
  limits: {
    fileSize: runtimeConfig.maxFileSize,
    files: 1,
    fields: 5,
  }
});
