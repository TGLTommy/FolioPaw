import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, initDatabase } from '../config/database';
import { runtimeConfig } from '../config/env';
import { fileStorageService } from './file-storage.service';

const UPLOAD_DIR = runtimeConfig.uploadDir;

function resetUploadDir(): void {
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
}

function registerBook(filename: string): void {
  db.prepare(`
    INSERT INTO books (filename, original_name, file_path, file_type, file_size, total_pages, user_id)
    VALUES (?, ?, ?, 'epub', 10, 1, 1)
  `).run(filename, filename, path.join(UPLOAD_DIR, filename));
}

describe('unused upload cleanup', () => {
  beforeEach(() => {
    initDatabase();
    db.prepare('DELETE FROM books').run();
    resetUploadDir();
  });

  it('deletes orphaned uploads while leaving generated-asset directories alone', async () => {
    // readdirSync also returns directories. Unlinking one throws EPERM, which
    // previously aborted the whole sweep before a single orphan was removed.
    fs.mkdirSync(path.join(UPLOAD_DIR, 'epub-resources'), { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, 'epub-resources', 'cover.jpg'), 'cover');
    fs.mkdirSync(path.join(UPLOAD_DIR, 'pdf-resources'), { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, 'orphan-a.epub'), 'orphan');
    fs.writeFileSync(path.join(UPLOAD_DIR, 'orphan-b.pdf'), 'orphan');
    fs.writeFileSync(path.join(UPLOAD_DIR, 'keep.epub'), 'referenced');
    registerBook('keep.epub');

    const result = await fileStorageService.cleanupUnusedFiles();

    expect(result.error).toBeUndefined();
    expect(result.deleted).toBe(2);
    expect(fs.readdirSync(UPLOAD_DIR).sort()).toEqual([
      'epub-resources',
      'keep.epub',
      'pdf-resources',
    ]);
    // The nested asset survives; it is removed together with its book instead.
    expect(fs.existsSync(path.join(UPLOAD_DIR, 'epub-resources', 'cover.jpg'))).toBe(true);
  });

  it('reports disk usage without counting asset directories', () => {
    fs.mkdirSync(path.join(UPLOAD_DIR, 'epub-resources'), { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, 'book.epub'), 'x'.repeat(64));

    expect(fileStorageService.getStorageStats().diskUsage).toBe(64);
  });
});
