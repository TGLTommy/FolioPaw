import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { db, initDatabase } from '../config/database';
import { runtimeConfig } from '../config/env';
import { saveBook } from './book.service';

const UPLOAD_DIR = runtimeConfig.uploadDir;

function createEpub(chapterText: string): Buffer {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from(
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    + '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  ));
  zip.addFile('OEBPS/content.opf', Buffer.from(
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture</dc:title>'
    + '<dc:identifier id="id">fixture</dc:identifier></metadata>'
    + '<manifest><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest>'
    + '<spine><itemref idref="c1"/></spine></package>'
  ));
  zip.addFile('OEBPS/chapter1.xhtml', Buffer.from(
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>${chapterText}</p></body></html>`
  ));
  return zip.toBuffer();
}

/** Writes the buffer into the upload directory the way multer would. */
function stageUpload(originalName: string, buffer: Buffer): Express.Multer.File {
  const filename = `${originalName.replace(/\W+/g, '-')}-${buffer.length}-${Math.random().toString(36).slice(2)}.epub`;
  const filePath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  return {
    fieldname: 'file',
    originalname: originalName,
    encoding: '7bit',
    mimetype: 'application/epub+zip',
    size: buffer.length,
    destination: UPLOAD_DIR,
    filename,
    path: filePath,
  } as Express.Multer.File;
}

function ownerId(): number {
  return (db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number }).id;
}

describe('upload deduplication', () => {
  beforeEach(() => {
    initDatabase();
    db.prepare('DELETE FROM books').run();
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  });

  it('treats a byte-identical re-upload as a duplicate', async () => {
    const userId = ownerId();
    const content = createEpub('Identical content.');

    const first = await saveBook(stageUpload('same.epub', content), null, userId);
    const second = await saveBook(stageUpload('same.epub', content), null, userId);

    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    const books = db.prepare('SELECT COUNT(*) AS count FROM books').get() as { count: number };
    expect(books.count).toBe(1);
  });

  it('stores a different file that happens to share name and size', async () => {
    // Padded so both revisions are the same byte length: name + type + size all
    // match, and only the content hash tells them apart. The old fallback
    // matched on those three attributes alone and silently discarded the new
    // upload, leaving the reader on the stale revision.
    const userId = ownerId();
    const firstRevision = createEpub('Revision one AAAA');
    const secondRevision = createEpub('Revision two BBBB');
    expect(secondRevision.length).toBe(firstRevision.length);

    const first = await saveBook(stageUpload('book.epub', firstRevision), null, userId);
    const second = await saveBook(stageUpload('book.epub', secondRevision), null, userId);

    expect(second.duplicate).toBe(false);
    expect(second.id).not.toBe(first.id);
    const books = db.prepare('SELECT COUNT(*) AS count FROM books').get() as { count: number };
    expect(books.count).toBe(2);
    const hashes = db.prepare('SELECT DISTINCT file_hash FROM books').all();
    expect(hashes).toHaveLength(2);
  });

  it('still matches pre-hash records whose file is gone from disk', async () => {
    // Legacy rows have file_hash = NULL and cannot be re-hashed, so the
    // name/type/size fallback is the only way to recognise them.
    const userId = ownerId();
    const content = createEpub('Legacy content.');
    const legacyId = Number(db.prepare(`
      INSERT INTO books (filename, original_name, file_path, file_type, file_size, file_hash, total_pages, user_id)
      VALUES ('legacy.epub', 'legacy.epub', '/nonexistent/legacy.epub', 'epub', ?, NULL, 1, ?)
    `).run(content.length, userId).lastInsertRowid);

    const uploaded = await saveBook(stageUpload('legacy.epub', content), null, userId);

    expect(uploaded.duplicate).toBe(true);
    expect(uploaded.id).toBe(legacyId);
  });
});
