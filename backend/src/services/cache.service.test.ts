import { beforeEach, describe, expect, it } from 'vitest';
import { db, initDatabase } from '../config/database';
import { CacheService } from './cache.service';

describe('translation memory cache', () => {
  beforeEach(() => {
    initDatabase();
    db.prepare('DELETE FROM page_cache').run();
  });

  it('keeps accepting translations after the memory cache reaches maxEntries', async () => {
    // node-cache throws ECACHEFULL once maxKeys is reached, even when the key
    // already exists. Before the eviction fallback that exception escaped
    // setTranslation and surfaced to the user as a failed translation, after
    // the model had already produced a correct result.
    const cache = new CacheService({ maxEntries: 3, ttlSeconds: 3600 });

    for (let index = 0; index < 10; index += 1) {
      await expect(
        cache.setTranslation(`hash-${index}`, 'en', 'zh', `译文 ${index}`, 'fingerprint-v1')
      ).resolves.toBeUndefined();
    }

    expect(cache.getStats().cacheSize).toBeLessThanOrEqual(3);

    // Every translation still reached the durable database cache.
    const stored = db.prepare('SELECT COUNT(*) AS count FROM page_cache').get() as { count: number };
    expect(stored.count).toBe(10);
  });

  it('overwriting an existing key does not fail once the cache is full', async () => {
    const cache = new CacheService({ maxEntries: 2, ttlSeconds: 3600 });

    await cache.setTranslation('hash-a', 'en', 'zh', '第一版', 'fingerprint-v1');
    await cache.setTranslation('hash-b', 'en', 'zh', '第一版', 'fingerprint-v1');
    await expect(
      cache.setTranslation('hash-a', 'en', 'zh', '第二版', 'fingerprint-v1')
    ).resolves.toBeUndefined();

    const entry = await cache.getTranslation('hash-a', 'en', 'zh', 'fingerprint-v1');
    expect(entry?.translatedText).toBe('第二版');
  });

  it('populating memory from a database hit never throws when the cache is full', async () => {
    const cache = new CacheService({ maxEntries: 1, ttlSeconds: 3600 });

    db.prepare(`
      INSERT INTO page_cache (page_hash, source_lang, target_lang, translation_fingerprint, translated_text)
      VALUES ('db-only', 'en', 'zh', 'fingerprint-v1', '来自数据库')
    `).run();
    await cache.setTranslation('filler', 'en', 'zh', '占位', 'fingerprint-v1');

    const entry = await cache.getTranslation('db-only', 'en', 'zh', 'fingerprint-v1');
    expect(entry?.translatedText).toBe('来自数据库');
  });
});
