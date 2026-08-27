import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { runtimeConfig } from './env';
import {
  completeSchemaMigration,
  migrateBookNamesToUtf8,
  prepareSchemaMigration,
} from './migration-manager';

const DB_PATH = runtimeConfig.dbPath;
process.umask(0o077);

// Ensure data directory exists
const dbDir = path.dirname(DB_PATH);
if (DB_PATH !== ':memory:') {
  fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dbDir, 0o700);
}

export const db = new Database(DB_PATH);
if (DB_PATH !== ':memory:') fs.chmodSync(DB_PATH, 0o600);
db.pragma('foreign_keys = ON');

export function initDatabase() {
  const previousSchemaVersion = prepareSchemaMigration(db);
  db.exec('BEGIN IMMEDIATE');
  try {
  // Books table
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      file_hash TEXT,
      total_pages INTEGER NOT NULL,
      user_id INTEGER DEFAULT 1,
      upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_read_page INTEGER DEFAULT 1,
      translation_status TEXT DEFAULT 'pending',
      file_blob BLOB,
      use_blob_storage INTEGER DEFAULT 0,
      blob_size INTEGER,
      table_of_contents TEXT,
      folder_id INTEGER,
      cover_image_path TEXT
    )
  `);

  // Pages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      page_number INTEGER NOT NULL,
      original_text TEXT NOT NULL,
      translated_text TEXT,
      translation_status TEXT DEFAULT 'pending',
      page_hash VARCHAR(64),
      is_cached INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
      UNIQUE(book_id, page_number)
    )
  `);

  // Page cache table - stores unique translations by content hash
  db.exec(`
    CREATE TABLE IF NOT EXISTS page_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_hash VARCHAR(64) NOT NULL,
      source_lang TEXT NOT NULL,
      target_lang TEXT NOT NULL,
      translation_fingerprint TEXT NOT NULL DEFAULT 'legacy',
      translated_text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(page_hash, source_lang, target_lang, translation_fingerprint)
    )
  `);

  // Sentence alignment tables used by the existing alignment indices.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sentence_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL,
      book_id INTEGER NOT NULL,
      page_number INTEGER NOT NULL,
      sentence_index INTEGER NOT NULL,
      original_start_index INTEGER,
      original_end_index INTEGER,
      translated_start_index INTEGER,
      translated_end_index INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
      UNIQUE(page_id, sentence_index)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS alignment_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL UNIQUE,
      config_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    )
  `);

  // Cache metadata table - track cache statistics
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      total_cached_pages INTEGER DEFAULT 0,
      cache_hits INTEGER DEFAULT 0,
      cache_misses INTEGER DEFAULT 0,
      hit_rate REAL DEFAULT 0.0,
      last_cleaned_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // User configs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Shared model service configurations. API keys are intentionally stored as
  // plain text in the local SQLite database; never expose them through APIs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_service_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      provider_type TEXT NOT NULL
        CHECK(provider_type IN ('openai-compatible', 'anthropic-compatible', 'ollama')),
      model TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      context_window INTEGER CHECK(context_window IS NULL OR context_window BETWEEN 4096 AND 262144),
      managed_by TEXT CHECK(managed_by IS NULL OR managed_by = 'docker-bootstrap'),
      timeout_ms INTEGER NOT NULL DEFAULT 180000,
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 1,
      test_status TEXT NOT NULL DEFAULT 'untested'
        CHECK(test_status IN ('untested', 'success', 'failed')),
      tested_revision INTEGER,
      last_test_message TEXT,
      last_test_status_code INTEGER,
      last_test_response_ms INTEGER,
      last_tested_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  migrateModelServiceConfigsToV3();

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_model_service_configs_one_active
    ON model_service_configs(is_active)
    WHERE is_active = 1
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_model_service_configs_managed_by
    ON model_service_configs(managed_by)
    WHERE managed_by IS NOT NULL
  `);

  // Translation jobs table - track background translation progress
  db.exec(`
    CREATE TABLE IF NOT EXISTS translation_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      user_id INTEGER DEFAULT 1,
      status TEXT CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'stopped')) DEFAULT 'pending',
      start_page INTEGER NOT NULL,
      end_page INTEGER NOT NULL,
      total_pages INTEGER NOT NULL,
      current_page INTEGER NOT NULL,
      processed_pages INTEGER DEFAULT 0,
      config_id INTEGER,
      model_config_id INTEGER,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    )
  `);

  // Folders table - for organizing books into folders
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#3B82F6',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Book summaries table - AI-generated chapter and book summaries
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      summary_type TEXT NOT NULL CHECK(summary_type IN ('chapter', 'book')),
      chapter_id TEXT,
      chapter_title TEXT,
      page_start INTEGER,
      page_end INTEGER,
      summary_text TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'generating', 'completed', 'failed')),
      error_message TEXT,
      model_used TEXT,
      model_config_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
      UNIQUE(book_id, summary_type, chapter_id)
    )
  `);

  // CRITICAL MIGRATION: book-level summaries store chapter_id as NULL, and
  // SQLite treats NULLs as distinct inside a UNIQUE index. UNIQUE(book_id,
  // summary_type, chapter_id) therefore never fires for them, so every
  // regeneration inserted another row. Collapse the duplicates and back the
  // upsert with a partial index that does constrain NULL chapter ids.
  deduplicateBookLevelSummaries();
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_book_summaries_one_book_summary
    ON book_summaries(book_id, summary_type)
    WHERE chapter_id IS NULL
  `);

  // Book reading guides table - AI-generated pre-translation reading decisions
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_reading_guides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL UNIQUE,
      guide_text TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'generating', 'completed', 'failed', 'cancelled')),
      error_message TEXT,
      model_used TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    )
  `);

  // Book mindmaps table - AI-generated chapter mindmap SVGs
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_mindmaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      chapter_id TEXT NOT NULL,
      chapter_title TEXT,
      page_start INTEGER,
      page_end INTEGER,
      svg_content TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'generating', 'completed', 'failed')),
      error_message TEXT,
      model_used TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
      UNIQUE(book_id, chapter_id)
    )
  `);

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ai_page_search USING fts5(
        book_id UNINDEXED,
        page_number UNINDEXED,
        original_text,
        translated_text,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS ai_page_search_meta (
        book_id INTEGER PRIMARY KEY,
        page_count INTEGER NOT NULL,
        content_fingerprint TEXT NOT NULL,
        indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      );
    `);
  } catch (error) {
    console.warn('AI search index initialization warning:', error instanceof Error ? error.message : 'Unknown error');
  }

  // Migration: Add missing columns to existing tables
  try {
    // Check if columns exist and add them if they don't
    const booksTableInfo = db.pragma('table_info(books)') as any[];
    const hasFileBlob = booksTableInfo.some((col) => col.name === 'file_blob');
    const hasUseBlobStorage = booksTableInfo.some((col) => col.name === 'use_blob_storage');
    const hasBlobSize = booksTableInfo.some((col) => col.name === 'blob_size');
    const hasTOC = booksTableInfo.some((col) => col.name === 'table_of_contents');
    const hasFolderId = booksTableInfo.some((col) => col.name === 'folder_id');
    const hasCoverImagePath = booksTableInfo.some((col) => col.name === 'cover_image_path');
    const hasUserId = booksTableInfo.some((col) => col.name === 'user_id');
    const hasFileHash = booksTableInfo.some((col) => col.name === 'file_hash');

    if (!hasFileBlob) {
      db.exec('ALTER TABLE books ADD COLUMN file_blob BLOB');
      console.log('Added file_blob column to books table');
    }
    if (!hasUseBlobStorage) {
      db.exec('ALTER TABLE books ADD COLUMN use_blob_storage INTEGER DEFAULT 0');
      console.log('Added use_blob_storage column to books table');
    }
    if (!hasBlobSize) {
      db.exec('ALTER TABLE books ADD COLUMN blob_size INTEGER');
      console.log('Added blob_size column to books table');
    }
    if (!hasFileHash) {
      db.exec('ALTER TABLE books ADD COLUMN file_hash TEXT');
      console.log('Added file_hash column to books table');
    }
    if (!hasTOC) {
      db.exec('ALTER TABLE books ADD COLUMN table_of_contents TEXT');
      console.log('Added table_of_contents column to books table');
    }
    if (!hasUserId) {
      db.exec('ALTER TABLE books ADD COLUMN user_id INTEGER DEFAULT 1');
      console.log('Added user_id column to books table');
    }
    if (!hasFolderId) {
      db.exec('ALTER TABLE books ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL');
      console.log('Added folder_id column to books table');
    }
    if (!hasCoverImagePath) {
      db.exec('ALTER TABLE books ADD COLUMN cover_image_path TEXT');
      console.log('Added cover_image_path column to books table');
    }

    const pagesTableInfo = db.pragma('table_info(pages)') as any[];
    const hasPageHash = pagesTableInfo.some((col) => col.name === 'page_hash');
    const hasIsCached = pagesTableInfo.some((col) => col.name === 'is_cached');

    if (!hasPageHash) {
      db.exec('ALTER TABLE pages ADD COLUMN page_hash VARCHAR(64)');
      console.log('Added page_hash column to pages table');
    }
    if (!hasIsCached) {
      db.exec('ALTER TABLE pages ADD COLUMN is_cached INTEGER DEFAULT 0');
      console.log('Added is_cached column to pages table');
    }

    const pageIndexes = db.pragma('index_list(pages)') as any[];
    const uniquePageHashIndex = pageIndexes.find((idx: any) => {
      if (!idx.unique) return false;
      const cols = db.pragma(`index_info(${idx.name})`) as any[];
      return cols.length === 1 && cols[0]?.name === 'page_hash';
    });

    if (uniquePageHashIndex) {
      console.log('🔄 Rebuilding pages table to remove UNIQUE(page_hash)...');
      db.exec(`
        CREATE TABLE pages_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          book_id INTEGER NOT NULL,
          page_number INTEGER NOT NULL,
          original_text TEXT NOT NULL,
          translated_text TEXT,
          translation_status TEXT DEFAULT 'pending',
          page_hash VARCHAR(64),
          is_cached INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
          UNIQUE(book_id, page_number)
        );
        INSERT INTO pages_new (
          id, book_id, page_number, original_text, translated_text,
          translation_status, page_hash, is_cached, created_at, updated_at
        )
        SELECT
          id, book_id, page_number, original_text, translated_text,
          translation_status, page_hash, COALESCE(is_cached, 0), created_at, updated_at
        FROM pages;
        DROP TABLE pages;
        ALTER TABLE pages_new RENAME TO pages;
      `);
      console.log('✅ pages table rebuilt without UNIQUE(page_hash)');
    }

  } catch (error) {
    console.warn('Migration warning:', error instanceof Error ? error.message : 'Unknown error');
  }

  try {
    const guideSchema = db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'book_reading_guides'
    `).get() as { sql?: string } | undefined;

    if (guideSchema?.sql && !guideSchema.sql.includes("'cancelled'")) {
      console.log('🔄 Migrating book_reading_guides table to allow cancelled status...');
      const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
      db.pragma('foreign_keys = OFF');

      try {
        db.exec(`
          DROP TABLE IF EXISTS book_reading_guides_new;
          CREATE TABLE book_reading_guides_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL UNIQUE,
            guide_text TEXT,
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending', 'generating', 'completed', 'failed', 'cancelled')),
            error_message TEXT,
            model_used TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
          );
          INSERT INTO book_reading_guides_new (
            id, book_id, guide_text, status, error_message, model_used, created_at, updated_at
          )
          SELECT
            id, book_id, guide_text, status, error_message, model_used, created_at, updated_at
          FROM book_reading_guides;
          DROP TABLE book_reading_guides;
          ALTER TABLE book_reading_guides_new RENAME TO book_reading_guides;
        `);
      } finally {
        if (foreignKeysEnabled) {
          db.pragma('foreign_keys = ON');
        }
      }

      console.log('✅ book_reading_guides status migration completed');
    }
  } catch (error) {
    console.warn('book_reading_guides migration warning:', error instanceof Error ? error.message : 'Unknown error');
  }

  try {
    const jobsTableInfo = db.pragma('table_info(translation_jobs)') as any[];
    const hasJobUserId = jobsTableInfo.some((col: any) => col.name === 'user_id');
    if (!hasJobUserId) {
      db.exec('ALTER TABLE translation_jobs ADD COLUMN user_id INTEGER DEFAULT 1');
      console.log('Added user_id column to translation_jobs table');
    }
  } catch (error) {
    console.warn('translation_jobs migration warning:', error instanceof Error ? error.message : 'Unknown error');
  }

  // CRITICAL MIGRATION: Remove translation_config_id from page_cache table
  try {
    const pageCacheInfo = db.pragma('table_info(page_cache)') as any[];
    const hasTranslationConfigId = pageCacheInfo.some((col: any) => col.name === 'translation_config_id');

    if (hasTranslationConfigId) {
      console.log('🔄 Migrating page_cache table to remove translation_config_id...');

      // Step 1: Create new table without translation_config_id
      db.exec(`
        CREATE TABLE IF NOT EXISTS page_cache_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          page_hash VARCHAR(64) NOT NULL,
          source_lang TEXT NOT NULL,
          target_lang TEXT NOT NULL,
          translation_fingerprint TEXT NOT NULL DEFAULT 'legacy',
          translated_text TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(page_hash, source_lang, target_lang, translation_fingerprint)
        )
      `);

      // Step 2: Migrate data (remove duplicates by keeping the first one)
      db.exec(`
        INSERT INTO page_cache_new (
          page_hash, source_lang, target_lang, translation_fingerprint,
          translated_text, created_at, updated_at
        )
        SELECT page_hash, source_lang, target_lang, 'legacy', translated_text, created_at, updated_at
        FROM page_cache
        GROUP BY page_hash, source_lang, target_lang
      `);

      // Step 3: Drop old table
      db.exec('DROP TABLE page_cache');

      // Step 4: Rename new table
      db.exec('ALTER TABLE page_cache_new RENAME TO page_cache');

      console.log('✅ page_cache table migration completed');
    }
  } catch (error) {
    console.error('❌ page_cache migration failed:', error);
    throw error; // Critical error, should not continue
  }

  try {
    const pageCacheInfo = db.pragma('table_info(page_cache)') as any[];
    const hasTranslationFingerprint = pageCacheInfo.some((col: any) => col.name === 'translation_fingerprint');
    const pageCacheIndexes = db.pragma('index_list(page_cache)') as any[];
    const hasFingerprintUniqueIndex = pageCacheIndexes.some((idx: any) => {
      if (!idx.unique) return false;
      const cols = db.pragma(`index_info(${idx.name})`) as any[];
      const names = cols.map((col: any) => col.name);
      return names.length === 4
        && names.includes('page_hash')
        && names.includes('source_lang')
        && names.includes('target_lang')
        && names.includes('translation_fingerprint');
    });

    if (!hasTranslationFingerprint || !hasFingerprintUniqueIndex) {
      console.log('🔄 Migrating page_cache table to include translation_fingerprint...');
      const fingerprintSelect = hasTranslationFingerprint
        ? "COALESCE(translation_fingerprint, 'legacy')"
        : "'legacy'";

      db.exec(`
        DROP TABLE IF EXISTS page_cache_new;
        CREATE TABLE page_cache_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          page_hash VARCHAR(64) NOT NULL,
          source_lang TEXT NOT NULL,
          target_lang TEXT NOT NULL,
          translation_fingerprint TEXT NOT NULL DEFAULT 'legacy',
          translated_text TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(page_hash, source_lang, target_lang, translation_fingerprint)
        );
        INSERT INTO page_cache_new (
          page_hash, source_lang, target_lang, translation_fingerprint,
          translated_text, created_at, updated_at
        )
        SELECT
          page_hash,
          source_lang,
          target_lang,
          ${fingerprintSelect},
          translated_text,
          MIN(created_at),
          MAX(updated_at)
        FROM page_cache
        GROUP BY page_hash, source_lang, target_lang, ${fingerprintSelect};
        DROP TABLE page_cache;
        ALTER TABLE page_cache_new RENAME TO page_cache;
      `);
      console.log('✅ page_cache translation_fingerprint migration completed');
    }
  } catch (error) {
    console.error('❌ page_cache translation_fingerprint migration failed:', error);
    throw error;
  }

  // Create indices for performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pages_book_id ON pages(book_id);
    CREATE INDEX IF NOT EXISTS idx_pages_page_hash ON pages(page_hash);
    CREATE INDEX IF NOT EXISTS idx_page_cache_page_hash ON page_cache(page_hash);
    CREATE INDEX IF NOT EXISTS idx_page_cache_fingerprint ON page_cache(translation_fingerprint);
    CREATE INDEX IF NOT EXISTS idx_books_translation_status ON books(translation_status);
    CREATE INDEX IF NOT EXISTS idx_books_folder_id ON books(folder_id);
    CREATE INDEX IF NOT EXISTS idx_books_user_file_hash ON books(user_id, file_hash);
    CREATE INDEX IF NOT EXISTS idx_books_user_upload_dedupe ON books(user_id, original_name, file_type, file_size);

    -- Book summaries indices
    CREATE INDEX IF NOT EXISTS idx_book_summaries_book_id ON book_summaries(book_id);
    CREATE INDEX IF NOT EXISTS idx_book_summaries_type ON book_summaries(book_id, summary_type);

    -- Book reading guide indices
    CREATE INDEX IF NOT EXISTS idx_book_reading_guides_book_id ON book_reading_guides(book_id);

    -- Book mindmaps indices
    CREATE INDEX IF NOT EXISTS idx_book_mindmaps_book_id ON book_mindmaps(book_id);

    -- Sentence mapping indices
    CREATE INDEX IF NOT EXISTS idx_sentence_mappings_page_sentence ON sentence_mappings(page_id, sentence_index);
    CREATE INDEX IF NOT EXISTS idx_sentence_mappings_book_page ON sentence_mappings(book_id, page_number);
    CREATE INDEX IF NOT EXISTS idx_sentence_mappings_original_position ON sentence_mappings(page_id, original_start_index, original_end_index);

    -- Alignment config indices
    CREATE INDEX IF NOT EXISTS idx_alignment_configs_page_id ON alignment_configs(page_id);
  `);

  // Initialize cache metadata if not exists
  const existingMetadata = db.prepare('SELECT * FROM cache_metadata LIMIT 1').get();
  if (!existingMetadata) {
    db.prepare(`
      INSERT INTO cache_metadata (total_cached_pages, cache_hits, cache_misses, hit_rate, updated_at)
      VALUES (0, 0, 0, 0.0, CURRENT_TIMESTAMP)
    `).run();
  }

  // ============================================================
  // Multi-user migration: users, books.user_id, user progress/folders
  // ============================================================
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        avatar_color TEXT DEFAULT '#3B82F6',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const localOwnerCount = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    if (localOwnerCount.count > 1) {
      throw new Error('当前本地书库版本最多只能迁移一个旧版用户的数据');
    }
    if (localOwnerCount.count === 0) {
      db.prepare(`
        INSERT INTO users (username, display_name, password_hash, avatar_color)
        VALUES ('__local_library__', 'Local Library', '!login-disabled!', '#3B82F6')
      `).run();
    } else {
      db.prepare(`
        UPDATE users
        SET username = '__local_library__',
            display_name = 'Local Library',
            password_hash = '!login-disabled!',
            avatar_color = '#3B82F6',
            updated_at = CURRENT_TIMESTAMP
      `).run();
    }

    db.exec(`
      UPDATE books SET user_id = 1 WHERE user_id IS NULL;

      CREATE TABLE IF NOT EXISTS user_book_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        book_id INTEGER NOT NULL,
        last_read_page INTEGER DEFAULT 1,
        reading_status TEXT DEFAULT 'unread'
          CHECK(reading_status IN ('unread', 'reading', 'paused', 'finished', 'abandoned')),
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
        UNIQUE(user_id, book_id)
      );

      CREATE TABLE IF NOT EXISTS user_book_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        book_id INTEGER NOT NULL,
        folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
        UNIQUE(user_id, book_id)
      );
    `);

    const foldersInfo = db.pragma('table_info(folders)') as any[];
    const foldersHasUserId = foldersInfo.some((col: any) => col.name === 'user_id');
    if (!foldersHasUserId) {
      db.exec(`
        CREATE TABLE folders_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL DEFAULT 1,
          name TEXT NOT NULL,
          color TEXT DEFAULT '#3B82F6',
          sort_order INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, name),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        INSERT INTO folders_new (id, user_id, name, color, sort_order, created_at, updated_at)
        SELECT id, 1, name, color, sort_order, created_at, updated_at FROM folders;
        DROP TABLE folders;
        ALTER TABLE folders_new RENAME TO folders;
      `);
      console.log('  ✅ Rebuilt folders table with user_id column');
    }

    db.exec(`
      INSERT OR IGNORE INTO user_book_progress (user_id, book_id, last_read_page)
      SELECT COALESCE(user_id, 1), id, last_read_page
      FROM books
      WHERE last_read_page > 1;

      INSERT OR IGNORE INTO user_book_folders (user_id, book_id, folder_id)
      SELECT COALESCE(user_id, 1), id, folder_id
      FROM books
      WHERE folder_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_books_user_id ON books(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_book_progress_user_id ON user_book_progress(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_book_progress_book_id ON user_book_progress(book_id);
      CREATE INDEX IF NOT EXISTS idx_user_book_folders_user_id ON user_book_folders(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_book_folders_book_id ON user_book_folders(book_id);
      CREATE INDEX IF NOT EXISTS idx_folders_user_id ON folders(user_id);
    `);

    console.log('✅ Local-library compatibility tables verified');
  } catch (error) {
    console.error('❌ Local-library compatibility migration failed:', error);
    throw error;
  }

  // Migration: Add user-scoped progress metadata columns to user_book_progress
  try {
    const ubpInfo = db.pragma('table_info(user_book_progress)') as any[];
    const hasIsPinned = ubpInfo.some((col: any) => col.name === 'is_pinned');
    const hasReadingStatus = ubpInfo.some((col: any) => col.name === 'reading_status');
    if (!hasIsPinned) {
      db.exec('ALTER TABLE user_book_progress ADD COLUMN is_pinned INTEGER DEFAULT 0');
      console.log('Added is_pinned column to user_book_progress table');
    }
    if (!hasReadingStatus) {
      db.exec(`
        ALTER TABLE user_book_progress ADD COLUMN reading_status TEXT DEFAULT 'unread'
          CHECK(reading_status IN ('unread', 'reading', 'paused', 'finished', 'abandoned'));

        UPDATE user_book_progress
        SET reading_status = CASE
          WHEN last_read_page >= COALESCE((SELECT total_pages FROM books WHERE books.id = user_book_progress.book_id), 1)
            THEN 'finished'
          WHEN last_read_page > 1 THEN 'reading'
          ELSE 'unread'
        END
        WHERE reading_status IS NULL OR reading_status = 'unread';
      `);
      console.log('Added reading_status column to user_book_progress table');
    }
  } catch (error) {
    console.warn('user_book_progress metadata migration warning:', error instanceof Error ? error.message : 'Unknown error');
  }

  initializeModelServiceConfigs();

  cleanupOrphanedBookData();

  const repairedBookNames = migrateBookNamesToUtf8(db, previousSchemaVersion);
  if (repairedBookNames > 0) {
    console.log(`✅ Repaired ${repairedBookNames} UTF-8 book filename(s)`);
  }

  completeSchemaMigration(db, previousSchemaVersion);

  db.exec('COMMIT');
  console.log('Database initialized successfully');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export function cleanupOrphanedBookData(): void {
  const cleanup = db.transaction(() => {
    const results: Array<{ label: string; changes: number }> = [];
    const run = (label: string, sql: string) => {
      const result = db.prepare(sql).run();
      results.push({ label, changes: result.changes });
    };
    const runIfTableExists = (tableName: string, label: string, sql: string) => {
      if (!tableExists(tableName)) return;
      run(label, sql);
    };

    run('alignment_configs_without_page', `
      DELETE FROM alignment_configs
      WHERE page_id NOT IN (SELECT id FROM pages)
    `);

    run('sentence_mappings_without_book_or_page', `
      DELETE FROM sentence_mappings
      WHERE book_id NOT IN (SELECT id FROM books)
         OR page_id NOT IN (SELECT id FROM pages)
    `);

    run('pages_without_book', `
      DELETE FROM pages
      WHERE book_id NOT IN (SELECT id FROM books)
    `);

    run('translation_jobs_without_book', `
      DELETE FROM translation_jobs
      WHERE book_id NOT IN (SELECT id FROM books)
    `);

    run('book_summaries_without_book', `
      DELETE FROM book_summaries
      WHERE book_id NOT IN (SELECT id FROM books)
    `);

    run('book_mindmaps_without_book', `
      DELETE FROM book_mindmaps
      WHERE book_id NOT IN (SELECT id FROM books)
    `);

    run('book_reading_guides_without_book', `
      DELETE FROM book_reading_guides
      WHERE book_id NOT IN (SELECT id FROM books)
    `);

    runIfTableExists('ai_page_search_meta', 'ai_page_search_meta_without_book', `
      DELETE FROM ai_page_search_meta
      WHERE book_id NOT IN (SELECT id FROM books)
    `);

    runIfTableExists('ai_page_search', 'ai_page_search_without_book', `
      DELETE FROM ai_page_search
      WHERE book_id NOT IN (SELECT id FROM books)
    `);

    runIfTableExists('selection_history', 'selection_history_without_book', `
      DELETE FROM selection_history
      WHERE book_id NOT IN (SELECT id FROM books)
    `);

    runIfTableExists('vocabulary_records', 'vocabulary_records_without_book', `
      DELETE FROM vocabulary_records
      WHERE book_id NOT IN (SELECT id FROM books)
    `);

    run('user_book_progress_without_book_or_user', `
      DELETE FROM user_book_progress
      WHERE book_id NOT IN (SELECT id FROM books)
         OR user_id NOT IN (SELECT id FROM users)
    `);

    run('user_book_folders_without_book_user_or_folder', `
      DELETE FROM user_book_folders
      WHERE book_id NOT IN (SELECT id FROM books)
         OR user_id NOT IN (SELECT id FROM users)
         OR (folder_id IS NOT NULL AND folder_id NOT IN (SELECT id FROM folders))
    `);

    run('unused_page_cache_entries', `
      DELETE FROM page_cache
      WHERE page_hash NOT IN (
        SELECT DISTINCT page_hash FROM pages WHERE page_hash IS NOT NULL
      )
    `);

    db.prepare(`
      UPDATE cache_metadata
      SET total_cached_pages = (SELECT COUNT(*) FROM page_cache),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run();

    return results;
  });

  try {
    const results = cleanup();
    const totalChanges = results.reduce((sum, item) => sum + item.changes, 0);
    if (totalChanges > 0) {
      const details = results
        .filter((item) => item.changes > 0)
        .map((item) => `${item.label}=${item.changes}`)
        .join(', ');
      console.log(`Cleaned up ${totalChanges} orphaned database record(s): ${details}`);
    }
  } catch (error) {
    console.warn('Orphaned book data cleanup warning:', error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Keeps one book-level summary per book, preferring a completed row over a
 * failed or in-flight one, so the partial unique index can be created on
 * databases written by earlier versions.
 */
export function deduplicateBookLevelSummaries(database: Database.Database = db): void {
  const result = database.prepare(`
    DELETE FROM book_summaries
    WHERE summary_type = 'book'
      AND chapter_id IS NULL
      AND id NOT IN (
        SELECT id FROM (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY book_id
              ORDER BY (status = 'completed') DESC, updated_at DESC, id DESC
            ) AS row_rank
          FROM book_summaries
          WHERE summary_type = 'book' AND chapter_id IS NULL
        )
        WHERE row_rank = 1
      )
  `).run();

  if (result.changes > 0) {
    console.log(`Removed ${result.changes} duplicate book-level summary row(s)`);
  }
}

function tableExists(tableName: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName)
  );
}

export function migrateModelServiceConfigsToV3(database: Database.Database = db): void {
  const schema = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'model_service_configs'
  `).get() as { sql?: string } | undefined;
  const columns = database.pragma('table_info(model_service_configs)') as Array<{ name: string }>;
  const hasRemovedColumns = columns.some((column) =>
    column.name === 'cli_path' || column.name === 'reasoning_effort'
  );
  const allowsRemovedProvider = schema?.sql?.includes('codex-cli') ?? false;
  const allowsOllamaProvider = schema?.sql?.includes("'ollama'") ?? false;
  const hasContextWindow = columns.some((column) => column.name === 'context_window');
  const hasManagedBy = columns.some((column) => column.name === 'managed_by');

  if (
    !hasRemovedColumns
    && !allowsRemovedProvider
    && allowsOllamaProvider
    && hasContextWindow
    && hasManagedBy
  ) return;

  const contextWindowSelect = hasContextWindow ? 'context_window' : 'NULL';
  const managedBySelect = hasManagedBy ? 'managed_by' : 'NULL';

  database.exec(`
    DROP TABLE IF EXISTS model_service_configs_v3;
    CREATE TABLE model_service_configs_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      provider_type TEXT NOT NULL
        CHECK(provider_type IN ('openai-compatible', 'anthropic-compatible', 'ollama')),
      model TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      context_window INTEGER CHECK(context_window IS NULL OR context_window BETWEEN 4096 AND 262144),
      managed_by TEXT CHECK(managed_by IS NULL OR managed_by = 'docker-bootstrap'),
      timeout_ms INTEGER NOT NULL DEFAULT 180000,
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 1,
      test_status TEXT NOT NULL DEFAULT 'untested'
        CHECK(test_status IN ('untested', 'success', 'failed')),
      tested_revision INTEGER,
      last_test_message TEXT,
      last_test_status_code INTEGER,
      last_test_response_ms INTEGER,
      last_tested_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO model_service_configs_v3 (
      id, name, provider_type, model, base_url, api_key, context_window, managed_by,
      timeout_ms, max_concurrency, is_active, revision, test_status,
      tested_revision, last_test_message, last_test_status_code,
      last_test_response_ms, last_tested_at, created_at, updated_at
    )
    SELECT
      id, name, provider_type, model, base_url, COALESCE(api_key, ''),
      ${contextWindowSelect}, ${managedBySelect},
      timeout_ms, max_concurrency, is_active, revision, test_status,
      tested_revision, last_test_message, last_test_status_code,
      last_test_response_ms, last_tested_at, created_at, updated_at
    FROM model_service_configs
    WHERE provider_type IN ('openai-compatible', 'anthropic-compatible', 'ollama')
      AND base_url IS NOT NULL
      AND TRIM(base_url) != '';
    DROP TABLE model_service_configs;
    ALTER TABLE model_service_configs_v3 RENAME TO model_service_configs;
  `);
  console.log('✅ Model service configurations migrated to schema v3');
}

function initializeModelServiceConfigs(): void {
  try {
    const jobsInfo = db.pragma('table_info(translation_jobs)') as Array<{ name: string }>;
    if (!jobsInfo.some((column) => column.name === 'model_config_id')) {
      db.exec('ALTER TABLE translation_jobs ADD COLUMN model_config_id INTEGER');
    }

    const guidesInfo = db.pragma('table_info(book_reading_guides)') as Array<{ name: string }>;
    if (!guidesInfo.some((column) => column.name === 'model_config_id')) {
      db.exec('ALTER TABLE book_reading_guides ADD COLUMN model_config_id INTEGER');
    }

    if (tableExists('translation_configs')) {
      const legacyConfigs = db.prepare(`
        SELECT name, api_url, api_key, model
        FROM translation_configs
        WHERE name != '__env_config__'
        ORDER BY id ASC
      `).all() as Array<{ name: string; api_url: string; api_key: string; model: string }>;

      const insertLegacy = db.prepare(`
        INSERT OR IGNORE INTO model_service_configs (
          name, provider_type, model, base_url, api_key,
          timeout_ms, max_concurrency, is_active, test_status
        ) VALUES (?, ?, ?, ?, ?, 180000, 1, 0, 'untested')
      `);

      for (const legacy of legacyConfigs) {
        if (!legacy.name?.trim() || !legacy.api_url?.trim() || !legacy.model?.trim()) continue;
        const providerType = /anthropic|claude|\/messages(?:$|\?)/i.test(legacy.api_url)
          ? 'anthropic-compatible'
          : 'openai-compatible';
        insertLegacy.run(
          legacy.name.trim(),
          providerType,
          legacy.model.trim(),
          legacy.api_url.trim(),
          legacy.api_key || '',
        );
      }
    }

    const activeConfig = db.prepare(
      'SELECT id FROM model_service_configs WHERE is_active = 1 LIMIT 1'
    ).get() as { id: number } | undefined;

    if (activeConfig) {
      db.prepare(`
        UPDATE translation_jobs
        SET model_config_id = ?
        WHERE model_config_id IS NULL AND status IN ('pending', 'processing')
      `).run(activeConfig.id);
      db.prepare(`
        UPDATE book_reading_guides
        SET model_config_id = ?
        WHERE model_config_id IS NULL AND status IN ('pending', 'generating')
      `).run(activeConfig.id);
    }

    db.prepare(`
      UPDATE translation_jobs
      SET status = 'failed',
          error_message = '任务引用的模型配置已不可用，请配置并启用第三方模型 API',
          updated_at = CURRENT_TIMESTAMP,
          completed_at = CURRENT_TIMESTAMP
      WHERE status IN ('pending', 'processing')
        AND (model_config_id IS NULL OR model_config_id NOT IN (SELECT id FROM model_service_configs))
    `).run();
    db.prepare(`
      UPDATE book_reading_guides
      SET status = 'failed',
          error_message = '任务引用的模型配置已不可用，请配置并启用第三方模型 API',
          updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('pending', 'generating')
        AND (model_config_id IS NULL OR model_config_id NOT IN (SELECT id FROM model_service_configs))
    `).run();

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_translation_jobs_model_config
      ON translation_jobs(model_config_id);
      CREATE INDEX IF NOT EXISTS idx_reading_guides_model_config
      ON book_reading_guides(model_config_id);
    `);
    console.log('✅ Model service configurations verified');
  } catch (error) {
    console.error('❌ Model service configuration migration failed:', error);
    throw error;
  }
}
