import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

export const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

const envFile = process.env.ENV_FILE
  ? path.resolve(process.env.ENV_FILE)
  : path.join(BACKEND_ROOT, '.env');

dotenv.config({ path: envFile, quiet: true });

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const trueBooleanString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const corsOrigins = z.string()
  .default('http://localhost:17890,http://127.0.0.1:17890')
  .superRefine((value, context) => {
    for (const item of value.split(',').map((origin) => origin.trim()).filter(Boolean)) {
      try {
        const url = new URL(item);
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== item || item === '*') {
          context.addIssue({ code: 'custom', message: `CORS 来源必须是完整的 HTTP(S) 源地址：${item}` });
        }
      } catch {
        context.addIssue({ code: 'custom', message: `无效的 CORS 来源：${item}` });
      }
    }
  });

const optionalUrl = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().url().optional(),
);

const httpUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'URL 必须使用 http 或 https 协议');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(17891),
  DB_PATH: z.string().trim().min(1).default('./data/database.sqlite'),
  UPLOAD_DIR: z.string().trim().min(1).default('./uploads'),
  MAX_FILE_SIZE: z.coerce.number().int().positive().default(209_715_200),
  MAX_PDF_PAGES: z.coerce.number().int().min(1).max(100_000).default(2_000),
  MAX_EPUB_ENTRIES: z.coerce.number().int().min(1).max(100_000).default(10_000),
  MAX_EPUB_UNCOMPRESSED_SIZE: z.coerce.number().int().positive().default(1_073_741_824),
  MAX_EPUB_ENTRY_SIZE: z.coerce.number().int().positive().default(104_857_600),
  MAX_EPUB_COMPRESSION_RATIO: z.coerce.number().positive().default(100),
  CORS_ORIGINS: corsOrigins,
  TRUST_PROXY: booleanString,
  TRANSLATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(180_000),
  AI_CHAT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(180_000),
  SUMMARY_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(180_000),
  READING_GUIDE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(300_000),
  TRANSLATION_MAX_TOKENS: z.coerce.number().int().min(256).default(12_000),
  TRANSLATION_SOURCE_LANG: z.string().trim().min(1).default('en'),
  TRANSLATION_TARGET_LANG: z.string().trim().min(1).default('zh'),
  TRANSLATION_MODE: z.enum(['normal', 'literary', 'technical']).default('normal'),
  TRANSLATION_PROMPT_VERSION: z.string().trim().min(1).default('v2'),
  TRANSLATION_BATCH_SIZE: z.coerce.number().int().min(1).max(20).default(1),
  TRANSLATION_RETRY_COUNT: z.coerce.number().int().min(0).max(3).default(2),
  READING_GUIDE_MAX_INPUT_CHARS: z.coerce.number().int().min(1_000).default(120_000),
  BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  BATCH_RESUME_ACTIVE_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  BATCH_SKIP_TRANSLATED: trueBooleanString,
  CACHE_TTL: z.coerce.number().int().min(1).default(3_600),
  CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).default(1_000),
  CACHE_CLEANUP_ENABLED: trueBooleanString,
  CACHE_CLEANUP_HOUR: z.coerce.number().int().min(0).max(23).default(2),
  CACHE_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  USE_BLOB_STORAGE: booleanString,
  COMPRESS_BLOBS: booleanString,
  BLOB_COMPRESSION_LEVEL: z.coerce.number().int().min(0).max(9).default(6),
  DICTIONARY_API_URL: optionalUrl,
  OLLAMA_BOOTSTRAP_ENABLED: booleanString,
  OLLAMA_BASE_URL: httpUrl.default('http://ollama:11434'),
  OLLAMA_BOOTSTRAP_URL: httpUrl.default('http://model-bootstrap:8080'),
  OLLAMA_MODEL: z.string().trim().min(1).default('qwen3.5:4b'),
  OLLAMA_CONTEXT_WINDOW: z.coerce.number().int().min(4096).max(262144).default(32768),
  OLLAMA_MANAGED_NAME: z.string().trim().min(1).max(80).default('本地 Ollama（Docker 托管）'),
  OLLAMA_MANAGED_TIMEOUT_MS: z.coerce.number().int().min(1000).max(1800000).default(1800000),
});

const result = envSchema.safeParse(process.env);
if (!result.success) {
  const details = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('; ');
  throw new Error(`环境变量配置无效：${details}`);
}

function resolveBackendPath(value: string): string {
  if (value === ':memory:' || path.isAbsolute(value)) return value;
  return path.resolve(BACKEND_ROOT, value);
}

const values = result.data;

export const runtimeConfig = {
  nodeEnv: values.NODE_ENV,
  host: values.HOST,
  port: values.PORT,
  dbPath: resolveBackendPath(values.DB_PATH),
  uploadDir: resolveBackendPath(values.UPLOAD_DIR),
  maxFileSize: values.MAX_FILE_SIZE,
  maxPdfPages: values.MAX_PDF_PAGES,
  epubLimits: {
    maxEntries: values.MAX_EPUB_ENTRIES,
    maxUncompressedSize: values.MAX_EPUB_UNCOMPRESSED_SIZE,
    maxEntrySize: values.MAX_EPUB_ENTRY_SIZE,
    maxCompressionRatio: values.MAX_EPUB_COMPRESSION_RATIO,
  },
  allowedOrigins: values.CORS_ORIGINS
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  trustProxy: values.TRUST_PROXY,
  dictionaryApiUrl: values.DICTIONARY_API_URL,
  ollamaBootstrap: {
    enabled: values.OLLAMA_BOOTSTRAP_ENABLED,
    ollamaBaseUrl: values.OLLAMA_BASE_URL,
    serviceUrl: values.OLLAMA_BOOTSTRAP_URL,
    model: values.OLLAMA_MODEL,
    contextWindow: values.OLLAMA_CONTEXT_WINDOW,
    managedName: values.OLLAMA_MANAGED_NAME,
    timeoutMs: values.OLLAMA_MANAGED_TIMEOUT_MS,
  },
  envFile,
} as const;
