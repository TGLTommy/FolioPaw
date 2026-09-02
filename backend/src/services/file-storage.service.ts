import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { db } from '../config/database';
import { runtimeConfig } from '../config/env';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

interface FileStorageConfig {
  useBlob: boolean;
  compress: boolean;
  compressionLevel: number;
  uploadDir: string;
}

class FileStorageService {
  private config: FileStorageConfig;

  constructor() {
    this.config = {
      useBlob: process.env.USE_BLOB_STORAGE === 'true',
      compress: process.env.COMPRESS_BLOBS === 'true',
      compressionLevel: parseInt(process.env.BLOB_COMPRESSION_LEVEL || '6'),
      uploadDir: runtimeConfig.uploadDir,
    };

    // Ensure upload directory exists
    if (!fs.existsSync(this.config.uploadDir)) {
      fs.mkdirSync(this.config.uploadDir, { recursive: true, mode: 0o700 });
    }
    fs.chmodSync(this.config.uploadDir, 0o700);
  }

  /**
   * Register a multer upload that is already on disk. The common disk-storage
   * path deliberately avoids materialising the whole book as a second Buffer.
   */
  async persistUploadedFile(
    bookId: number,
    filePath: string,
    useBlob: boolean = this.config.useBlob
  ): Promise<{ success: boolean; error?: string; blobSize?: number }> {
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: '上传文件不存在' };
      }

      const fileName = path.basename(filePath);
      const fullPath = path.join(this.config.uploadDir, fileName);
      if (path.resolve(filePath) !== path.resolve(fullPath)) {
        fs.copyFileSync(filePath, fullPath);
        fs.chmodSync(fullPath, 0o600);
        db.prepare('UPDATE books SET file_path = ? WHERE id = ?').run(fullPath, bookId);
      }

      const fileSize = fs.statSync(fullPath).size;
      if (!useBlob) {
        console.log(`File registered on disk for book ${bookId} (${fileSize} bytes)`);
        return { success: true };
      }

      const fileBuffer = fs.readFileSync(fullPath);
      let blobData = fileBuffer;
      if (this.config.compress) {
        blobData = await gzip(fileBuffer, { level: this.config.compressionLevel });
      }

      db.prepare(`
        UPDATE books
        SET file_blob = ?, use_blob_storage = 1, blob_size = ?
        WHERE id = ?
      `).run(blobData, blobData.length, bookId);

      console.log(`File saved to BLOB for book ${bookId} (original: ${fileSize} bytes, stored: ${blobData.length} bytes)`);
      return { success: true, blobSize: blobData.length };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      console.error(`Error registering file for book ${bookId}:`, errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Save file to disk and optionally to database BLOB
   */
  async saveFile(
    bookId: number,
    filePath: string,
    fileBuffer: Buffer,
    useBlob: boolean = this.config.useBlob
  ): Promise<{ success: boolean; error?: string; blobSize?: number }> {
    try {
      // Save to disk
      const uploadDir = this.config.uploadDir;
      const fileName = path.basename(filePath);
      const fullPath = path.join(uploadDir, fileName);

      if (path.resolve(filePath) !== path.resolve(fullPath)) {
        fs.writeFileSync(fullPath, fileBuffer, { mode: 0o600 });
      }

      // Save to database BLOB if enabled
      if (useBlob) {
        let blobData: Buffer = fileBuffer;
        const blobSize = fileBuffer.length;

        if (this.config.compress) {
          blobData = await gzip(fileBuffer, { level: this.config.compressionLevel });
        }

        db.prepare(`
          UPDATE books
          SET file_blob = ?, use_blob_storage = 1, blob_size = ?
          WHERE id = ?
        `).run(blobData, blobData.length, bookId);

        console.log(`File saved to BLOB for book ${bookId} (original: ${blobSize} bytes, stored: ${blobData.length} bytes)`);
        return { success: true, blobSize: blobData.length };
      }

      console.log(`File saved to disk for book ${bookId} (${fileBuffer.length} bytes)`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      console.error(`Error saving file for book ${bookId}:`, errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Get file content from disk or BLOB
   */
  async getFileContent(bookId: number): Promise<{ buffer: Buffer; source: 'disk' | 'blob'; error?: string } | null> {
    try {
      // Try to get from database BLOB first if available
      const book = db.prepare('SELECT file_blob, use_blob_storage, file_path FROM books WHERE id = ?').get(bookId) as any;

      if (!book) {
        return null;
      }

      if (book.use_blob_storage && book.file_blob) {
        try {
          let buffer = Buffer.from(book.file_blob);

          if (this.config.compress) {
            // Try to decompress
            try {
              buffer = await gunzip(buffer);
            } catch {
              // If decompression fails, assume it's not compressed
              console.warn(`File for book ${bookId} is marked as BLOB but decompression failed, using raw data`);
            }
          }

          console.log(`Retrieved file from BLOB for book ${bookId} (${buffer.length} bytes)`);
          return { buffer, source: 'blob' };
        } catch {
          console.error(`Error reading BLOB for book ${bookId}, falling back to disk`);
        }
      }

      // Fall back to disk storage
      if (book.file_path) {
        const fullPath = path.join(this.config.uploadDir, path.basename(book.file_path));

        if (fs.existsSync(fullPath)) {
          const buffer = fs.readFileSync(fullPath);
          console.log(`Retrieved file from disk for book ${bookId} (${buffer.length} bytes)`);
          return { buffer, source: 'disk' };
        }
      }

      return null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      console.error(`Error getting file content for book ${bookId}:`, errorMessage);
      return null;
    }
  }

  /**
   * Migrate file from disk to BLOB
   */
  async migrateToBlob(bookId: number): Promise<{ success: boolean; error?: string; blobSize?: number }> {
    try {
      const book = db.prepare('SELECT file_path, file_size FROM books WHERE id = ?').get(bookId) as any;

      if (!book || !book.file_path) {
        return { success: false, error: '书籍不存在或缺少文件路径' };
      }

      const fullPath = path.join(this.config.uploadDir, path.basename(book.file_path));

      if (!fs.existsSync(fullPath)) {
        return { success: false, error: '磁盘中未找到书籍文件' };
      }

      const fileBuffer = fs.readFileSync(fullPath);
      let blobData: Buffer = fileBuffer;

      if (this.config.compress) {
        blobData = await gzip(fileBuffer, { level: this.config.compressionLevel });
      }

      db.prepare(`
        UPDATE books
        SET file_blob = ?, use_blob_storage = 1, blob_size = ?
        WHERE id = ?
      `).run(blobData, blobData.length, bookId);

      console.log(
        `Migrated book ${bookId} to BLOB (original: ${fileBuffer.length} bytes, stored: ${blobData.length} bytes)`
      );

      return { success: true, blobSize: blobData.length };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      console.error(`Error migrating book ${bookId} to BLOB:`, errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Migrate file from BLOB back to disk
   */
  async migrateToDisk(bookId: number): Promise<{ success: boolean; error?: string }> {
    try {
      const book = db.prepare('SELECT file_blob, file_path, use_blob_storage FROM books WHERE id = ?').get(bookId) as any;

      if (!book || !book.file_blob) {
        return { success: false, error: '书籍不存在或缺少 BLOB 数据' };
      }

      let fileBuffer = Buffer.from(book.file_blob);

      if (book.use_blob_storage && this.config.compress) {
        try {
          fileBuffer = await gunzip(fileBuffer);
        } catch {
          console.warn(`Decompression failed for book ${bookId}, using raw data`);
        }
      }

      const fullPath = path.join(this.config.uploadDir, path.basename(book.file_path));
      fs.writeFileSync(fullPath, fileBuffer);

      db.prepare(`
        UPDATE books
        SET use_blob_storage = 0
        WHERE id = ?
      `).run(bookId);

      console.log(`Migrated book ${bookId} to disk (${fileBuffer.length} bytes)`);

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      console.error(`Error migrating book ${bookId} to disk:`, errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Delete file from both disk and BLOB
   */
  async deleteFile(bookId: number): Promise<{ success: boolean; error?: string }> {
    try {
      const book = db.prepare('SELECT file_path FROM books WHERE id = ?').get(bookId) as any;

      if (!book) {
        return { success: false, error: '书籍不存在' };
      }

      // Delete from disk
      if (book.file_path) {
        const fullPath = path.join(this.config.uploadDir, path.basename(book.file_path));
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          console.log(`Deleted file from disk for book ${bookId}`);
        }
      }

      // Clear BLOB from database
      db.prepare(`
        UPDATE books
        SET file_blob = NULL, use_blob_storage = 0, blob_size = NULL
        WHERE id = ?
      `).run(bookId);

      console.log(`Deleted file references for book ${bookId}`);

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      console.error(`Error deleting file for book ${bookId}:`, errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Get storage statistics
   */
  getStorageStats(): {
    diskUsage: number;
    blobUsage: number;
    totalUsage: number;
    fileCount: number;
    compressionRatio: number;
  } {
    try {
      let diskUsage = 0;
      const uploadDir = this.config.uploadDir;

      if (fs.existsSync(uploadDir)) {
        for (const entry of fs.readdirSync(uploadDir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          diskUsage += fs.statSync(path.join(uploadDir, entry.name)).size;
        }
      }

      // Get BLOB usage from database
      const blobStats = db.prepare(`
        SELECT
          COUNT(*) as blob_count,
          SUM(COALESCE(blob_size, 0)) as total_blob_size,
          SUM(file_size) as total_file_size
        FROM books
        WHERE use_blob_storage = 1
      `).get() as any;

      const blobUsage = blobStats.total_blob_size || 0;
      const originalSize = blobStats.total_file_size || 0;
      const compressionRatio = originalSize > 0 ? ((originalSize - blobUsage) / originalSize) * 100 : 0;

      return {
        diskUsage,
        blobUsage,
        totalUsage: diskUsage + blobUsage,
        fileCount: blobStats.blob_count || 0,
        compressionRatio: parseFloat(compressionRatio.toFixed(2)),
      };
    } catch (error) {
      console.error('Error getting storage stats:', error);
      return {
        diskUsage: 0,
        blobUsage: 0,
        totalUsage: 0,
        fileCount: 0,
        compressionRatio: 0,
      };
    }
  }

  /**
   * Cleanup unused files
   */
  async cleanupUnusedFiles(): Promise<{ deleted: number; error?: string }> {
    try {
      const uploadDir = this.config.uploadDir;
      let deletedCount = 0;

      if (!fs.existsSync(uploadDir)) {
        return { deleted: 0 };
      }

      // Only plain files are book uploads. Generated assets live in
      // subdirectories (epub-resources/, pdf-resources/) and are removed with
      // their book, so unlinking a directory here would abort the whole sweep.
      const entries = fs.readdirSync(uploadDir, { withFileTypes: true });
      const dbFiles = db.prepare('SELECT file_path FROM books').all() as Array<{ file_path: string }>;
      const dbFileSet = new Set(dbFiles.map((row) => path.basename(row.file_path)));

      for (const entry of entries) {
        if (!entry.isFile() || dbFileSet.has(entry.name)) continue;

        const fullPath = path.join(uploadDir, entry.name);
        try {
          fs.unlinkSync(fullPath);
          deletedCount++;
          console.log(`Deleted unused file: ${entry.name}`);
        } catch (error) {
          // Keep sweeping the rest of the directory instead of losing the batch.
          console.warn(`Failed to delete unused file ${entry.name}:`, error instanceof Error ? error.message : error);
        }
      }

      return { deleted: deletedCount };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      console.error('Error cleaning up unused files:', errorMessage);
      return { deleted: 0, error: errorMessage };
    }
  }
}

// Singleton instance
export const fileStorageService = new FileStorageService();
