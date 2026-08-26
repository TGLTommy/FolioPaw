import crypto from 'crypto';
import { db } from '../config/database';

interface DeduplicationResult {
  found: boolean;
  translatedText?: string;
  sourceLang?: string;
  targetLang?: string;
  cachedAt?: Date;
  duplicateCount?: number; // How many times this content appears
}

interface PageDuplicates {
  pageHash: string;
  originalText: string;
  count: number; // How many books have this exact page
  translations: Array<{
    sourceLang: string;
    targetLang: string;
    translatedText: string;
  }>;
}

class DeduplicationService {
  /**
   * Calculate SHA-256 hash of page content
   */
  calculatePageHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Find existing translation for page content
   */
  async findExistingTranslation(
    originalText: string,
    sourceLang: string,
    targetLang: string,
    translationFingerprint: string = 'legacy'
  ): Promise<DeduplicationResult> {
    try {
      const pageHash = this.calculatePageHash(originalText);

      // Check if translation exists in page_cache
      const cacheEntry = db.prepare(`
        SELECT translated_text, source_lang, target_lang, created_at
        FROM page_cache
        WHERE page_hash = ? AND source_lang = ? AND target_lang = ? AND translation_fingerprint = ?
        LIMIT 1
      `).get(pageHash, sourceLang, targetLang, translationFingerprint) as any;

      if (cacheEntry) {
        // Count how many books have this exact page
        const duplicateCount = db.prepare(`
          SELECT COUNT(*) as count FROM pages WHERE page_hash = ? AND page_hash IS NOT NULL
        `).get(pageHash) as any;

        return {
          found: true,
          translatedText: cacheEntry.translated_text,
          sourceLang,
          targetLang,
          cachedAt: new Date(cacheEntry.created_at),
          duplicateCount: duplicateCount.count,
        };
      }

      return { found: false };
    } catch (error) {
      console.error('Error finding existing translation:', error);
      return { found: false };
    }
  }

  /**
   * Check if page is already translated for given language pair
   */
  async isPageTranslated(
    pageHash: string,
    sourceLang: string,
    targetLang: string,
    translationFingerprint: string = 'legacy'
  ): Promise<boolean> {
    try {
      const result = db.prepare(`
        SELECT COUNT(*) as count
        FROM page_cache
        WHERE page_hash = ? AND source_lang = ? AND target_lang = ? AND translation_fingerprint = ?
      `).get(pageHash, sourceLang, targetLang, translationFingerprint) as any;

      return result.count > 0;
    } catch (error) {
      console.error('Error checking if page is translated:', error);
      return false;
    }
  }

  /**
   * Find all pages with the same content hash
   */
  async findDuplicatePages(pageHash: string, userId: number): Promise<Array<{ bookId: number; pageNumber: number }>> {
    try {
      const duplicates = db.prepare(`
        SELECT DISTINCT book_id, page_number
        FROM pages p
        INNER JOIN books b ON b.id = p.book_id
        WHERE p.page_hash = ? AND p.page_hash IS NOT NULL AND b.user_id = ?
        ORDER BY p.book_id, p.page_number
      `).all(pageHash, userId) as Array<{ book_id: number; page_number: number }>;

      return duplicates.map((d) => ({
        bookId: d.book_id,
        pageNumber: d.page_number,
      }));
    } catch (error) {
      console.error('Error finding duplicate pages:', error);
      return [];
    }
  }

  /**
   * Find all available translations for a page hash
   */
  async findTranslationsForHash(pageHash: string, userId: number): Promise<PageDuplicates | null> {
    try {
      // Get page content and count of duplicates
      const pageInfo = db.prepare(`
        SELECT original_text, COUNT(*) as count
        FROM pages p
        INNER JOIN books b ON b.id = p.book_id
        WHERE p.page_hash = ? AND p.page_hash IS NOT NULL AND b.user_id = ?
        GROUP BY p.page_hash
      `).get(pageHash, userId) as any;

      if (!pageInfo) {
        return null;
      }

      // Get all translations for this hash
      const translations = db.prepare(`
        SELECT DISTINCT pc.source_lang, pc.target_lang, pc.translated_text
        FROM page_cache pc
        WHERE pc.page_hash = ?
      `).all(pageHash) as any[];

      return {
        pageHash,
        originalText: pageInfo.original_text,
        count: pageInfo.count,
        translations: translations.map((t) => ({
          sourceLang: t.source_lang,
          targetLang: t.target_lang,
          translatedText: t.translated_text,
        })),
      };
    } catch (error) {
      console.error('Error finding translations for hash:', error);
      return null;
    }
  }

  /**
   * Get deduplication statistics
   */
  async getDeduplicationStats(userId: number): Promise<{
    totalPages: number;
    uniquePages: number;
    duplicateGroups: number;
    averageDuplicatesPerPage: number;
    potentialSavings: number;
  }> {
    try {
      const totalPages = db.prepare(`
        SELECT COUNT(*) as count FROM pages p
        INNER JOIN books b ON b.id = p.book_id
        WHERE p.page_hash IS NOT NULL AND b.user_id = ?
      `).get(userId) as any;

      const uniquePages = db.prepare(`
        SELECT COUNT(DISTINCT p.page_hash) as count FROM pages p
        INNER JOIN books b ON b.id = p.book_id
        WHERE p.page_hash IS NOT NULL AND b.user_id = ?
      `).get(userId) as any;

      const duplicateGroups = db.prepare(`
        SELECT COUNT(*) as count FROM (
          SELECT p.page_hash, COUNT(*) as cnt FROM pages p
          INNER JOIN books b ON b.id = p.book_id
          WHERE p.page_hash IS NOT NULL AND b.user_id = ?
          GROUP BY p.page_hash
          HAVING cnt > 1
        )
      `).get(userId) as any;

      // Potential translations saved (duplicates - unique)
      const potentialSavings = totalPages.count - uniquePages.count;

      const averageDuplicates = uniquePages.count > 0 ? totalPages.count / uniquePages.count : 1;

      return {
        totalPages: totalPages.count,
        uniquePages: uniquePages.count,
        duplicateGroups: duplicateGroups.count,
        averageDuplicatesPerPage: parseFloat(averageDuplicates.toFixed(2)),
        potentialSavings,
      };
    } catch (error) {
      console.error('Error getting deduplication stats:', error);
      return {
        totalPages: 0,
        uniquePages: 0,
        duplicateGroups: 0,
        averageDuplicatesPerPage: 0,
        potentialSavings: 0,
      };
    }
  }

  /**
   * Mark page as translated by updating page_hash and caching status
   */
  async markPageAsTranslated(
    pageId: number,
    originalText: string,
    translatedText: string,
    sourceLang: string,
    targetLang: string,
    translationFingerprint: string = 'legacy'
  ): Promise<{ success: boolean; pageHash: string; error?: string }> {
    try {
      const pageHash = this.calculatePageHash(originalText);

      // Update page with hash
      db.prepare(`
        UPDATE pages
        SET page_hash = ?, is_cached = 1
        WHERE id = ?
      `).run(pageHash, pageId);

      // Insert or update in page_cache
      db.prepare(`
        INSERT INTO page_cache (page_hash, source_lang, target_lang, translation_fingerprint, translated_text, created_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(page_hash, source_lang, target_lang, translation_fingerprint)
        DO UPDATE SET translated_text = ?, updated_at = CURRENT_TIMESTAMP
      `).run(pageHash, sourceLang, targetLang, translationFingerprint, translatedText, translatedText);

      return { success: true, pageHash };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      console.error('Error marking page as translated:', errorMessage);
      return { success: false, pageHash: '', error: errorMessage };
    }
  }

  /**
   * Apply cached translation to all duplicate pages
   */
  async applyTranslationToDuplicates(pageHash: string, userId: number): Promise<{ updated: number; error?: string }> {
    try {
      const duplicates = await this.findDuplicatePages(pageHash, userId);

      // Get the translation (first available one)
      const translation = db.prepare(`
        SELECT translated_text FROM page_cache
        WHERE page_hash = ?
        LIMIT 1
      `).get(pageHash) as any;

      if (!translation) {
        return { updated: 0, error: '没有找到与该页面哈希匹配的译文' };
      }

      // Update all duplicate pages
      let updateCount = 0;
      duplicates.forEach((dup) => {
        try {
          db.prepare(`
            UPDATE pages
            SET translated_text = ?, translation_status = 'completed', is_cached = 1
            WHERE id IN (
              SELECT p.id FROM pages p
              INNER JOIN books b ON b.id = p.book_id
              WHERE p.page_hash = ? AND p.book_id = ? AND p.page_number = ? AND b.user_id = ?
            )
          `).run(translation.translated_text, pageHash, dup.bookId, dup.pageNumber, userId);

          updateCount++;
        } catch (error) {
          console.error(`Error updating page ${dup.bookId}:${dup.pageNumber}:`, error);
        }
      });

      console.log(`Applied translation to ${updateCount} duplicate pages`);
      return { updated: updateCount };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      console.error('Error applying translation to duplicates:', errorMessage);
      return { updated: 0, error: errorMessage };
    }
  }

  /**
   * Get pages that could benefit from deduplication
   */
  async findOptimizationOpportunities(minDuplicates: number = 2, userId: number): Promise<Array<PageDuplicates>> {
    try {
      const opportunities = db.prepare(`
        SELECT p.page_hash, COUNT(*) as cnt
        FROM pages p
        INNER JOIN books b ON b.id = p.book_id
        WHERE p.page_hash IS NOT NULL AND b.user_id = ?
        GROUP BY p.page_hash
        HAVING cnt >= ?
        ORDER BY cnt DESC
        LIMIT 50
      `).all(userId, minDuplicates) as any[];

      const results: PageDuplicates[] = [];

      for (const opp of opportunities) {
        const dupInfo = await this.findTranslationsForHash(opp.page_hash, userId);
        if (dupInfo) {
          results.push(dupInfo);
        }
      }

      return results;
    } catch (error) {
      console.error('Error finding optimization opportunities:', error);
      return [];
    }
  }

  /**
   * Bulk hash all pages that don't have hashes yet
   */
  async hashUnhashedPages(userId: number): Promise<{ hashed: number; error?: string }> {
    try {
      const unhashed = db.prepare(`
        SELECT p.id, p.original_text FROM pages p
        INNER JOIN books b ON b.id = p.book_id
        WHERE p.page_hash IS NULL AND b.user_id = ?
      `).all(userId) as Array<{ id: number; original_text: string }>;

      let hashCount = 0;

      unhashed.forEach((page) => {
        try {
          const pageHash = this.calculatePageHash(page.original_text);
          db.prepare(`UPDATE pages SET page_hash = ? WHERE id = ?`).run(pageHash, page.id);
          hashCount++;
        } catch (error) {
          console.error(`Error hashing page ${page.id}:`, error);
        }
      });

      console.log(`Hashed ${hashCount} pages`);
      return { hashed: hashCount };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      console.error('Error hashing unhashed pages:', errorMessage);
      return { hashed: 0, error: errorMessage };
    }
  }

  /**
   * Find pages with same content but different hashes (shouldn't happen, but for validation)
   */
  async findHashConflicts(userId: number): Promise<Array<{ content: string; hashes: string[] }>> {
    try {
      const conflicts = db.prepare(`
        SELECT original_text, COUNT(DISTINCT page_hash) as hash_count
        FROM pages p
        INNER JOIN books b ON b.id = p.book_id
        WHERE p.page_hash IS NOT NULL AND b.user_id = ?
        GROUP BY p.original_text
        HAVING hash_count > 1
      `).all(userId) as any[];

      const results = [];

      for (const conflict of conflicts) {
        const hashes = db.prepare(`
          SELECT DISTINCT p.page_hash FROM pages p
          INNER JOIN books b ON b.id = p.book_id
          WHERE p.original_text = ? AND b.user_id = ?
        `).all(conflict.original_text, userId) as any[];

        results.push({
          content: conflict.original_text.substring(0, 100) + '...',
          hashes: hashes.map((h: any) => h.page_hash),
        });
      }

      return results;
    } catch (error) {
      console.error('Error finding hash conflicts:', error);
      return [];
    }
  }
}

// Singleton instance
export const deduplicationService = new DeduplicationService();
