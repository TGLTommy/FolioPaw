import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { db, initDatabase } from '../config/database';
import { runtimeConfig } from '../config/env';
import { bookAiContextService } from '../services/book-ai-context.service';

describe('account-free local library', () => {
  beforeAll(() => {
    fs.rmSync(runtimeConfig.uploadDir, { recursive: true, force: true });
    fs.mkdirSync(runtimeConfig.uploadDir, { recursive: true, mode: 0o700 });
    initDatabase();
  });

  afterEach(() => {
    db.prepare('DELETE FROM books').run();
    fs.rmSync(runtimeConfig.uploadDir, { recursive: true, force: true });
    fs.mkdirSync(runtimeConfig.uploadDir, { recursive: true, mode: 0o700 });
  });

  it('serves the library and uploaded assets without a login session', async () => {
    const app = createApp();

    await request(app).get('/api/auth/setup-status').expect(404);
    await request(app).post('/api/auth/login').send({}).expect(404);
    await request(app).post('/api/auth/logout').expect(404);

    const filesBeforeRejectedUpload = fs.readdirSync(runtimeConfig.uploadDir).sort();
    await request(app)
      .post('/api/upload')
      .attach('file', Buffer.from('not an epub'), {
        filename: 'fake.epub',
        contentType: 'application/epub+zip',
      })
      .expect(400);
    expect(fs.readdirSync(runtimeConfig.uploadDir).sort()).toEqual(filesBeforeRejectedUpload);

    const uploaded = await request(app)
      .post('/api/upload')
      .attach('file', createSyntheticEpub(), {
        filename: 'synthetic.epub',
        contentType: 'application/epub+zip',
      })
      .expect(200);
    const bookId = uploaded.body.data.id as number;

    const book = await request(app).get(`/api/books/${bookId}`).expect(200);
    await request(app).get(book.body.data.file_url).expect(200);

    await request(app).delete(`/api/books/${bookId}`).expect(200);
    expect(listFilesRecursively(runtimeConfig.uploadDir)).toEqual([]);
  });

  it('rejects removed local CLI model configurations', async () => {
    const app = createApp();
    await request(app).post('/api/model-services').send({
      name: 'Local CLI',
      providerType: 'codex-cli',
      model: 'local-model',
      cliPath: 'codex',
      timeoutMs: 10_000,
      maxConcurrency: 1,
    }).expect(400);
  });

  it('returns Chinese validation messages from public APIs', async () => {
    const app = createApp();

    const chat = await request(app).post('/api/ai/chat').send({}).expect(400);
    expect(chat.body.error).toBe('bookId 为必填项且必须是数字');

    const summary = await request(app).get('/api/summary/not-a-number').expect(400);
    expect(summary.body.error).toBe('bookId 无效');

    const dictionary = await request(app).get('/api/dictionary/lookup').expect(400);
    expect(dictionary.body.error).toBe('word 参数不能为空');
  });

  it('imports text PDFs by physical page, preserves outline navigation, and serves byte ranges', async () => {
    const app = createApp();
    const pdf = createSyntheticPdf([
      ['First physical page contains enough generated text for extraction.', 'First page second line.'],
      ['Second physical page stays separate from the first page content.', 'Second page second line.'],
    ], { outline: true });

    const uploaded = await request(app)
      .post('/api/upload')
      .attach('file', pdf, { filename: 'two-pages.pdf', contentType: 'application/pdf' })
      .expect(200);
    const bookId = uploaded.body.data.id as number;

    expect(uploaded.body.data.filename).toMatch(/\.pdf$/);
    expect(uploaded.body.data.totalPages).toBe(2);
    expect(uploaded.body.data.text_extraction_status).toBe('ready');
    expect(uploaded.body.data.text_page_count).toBe(2);

    const book = await request(app).get(`/api/books/${bookId}`).expect(200);
    expect(book.body.data.file_type).toBe('pdf');
    expect(book.body.data.text_extraction_status).toBe('ready');
    expect(book.body.data.text_page_count).toBe(2);
    expect(book.body.data.tableOfContents).toEqual([
      expect.objectContaining({ title: 'First section', pageNumber: 1 }),
    ]);
    const library = await request(app).get('/api/books').expect(200);
    expect(library.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: bookId,
        text_extraction_status: 'ready',
        text_page_count: 2,
      }),
    ]));

    const pages = await request(app).get(`/api/books/${bookId}/pages`).expect(200);
    expect(pages.body.data).toHaveLength(2);
    expect(pages.body.data[0].original_text).toContain('First physical page');
    expect(pages.body.data[0].original_text).toContain('extraction.\nFirst page second line.');
    expect(pages.body.data[0].original_text).not.toContain('Second physical page');
    expect(pages.body.data[1].original_text).toContain('Second physical page');
    expect(pages.body.data[1].original_text).not.toContain('First physical page');

    const rangedFile = await request(app)
      .get(book.body.data.file_url)
      .set('Range', 'bytes=0-4')
      .expect(206);
    expect(rangedFile.headers['content-type']).toContain('application/pdf');
    expect(Buffer.from(rangedFile.body).toString('latin1')).toBe('%PDF-');

    const duplicate = await request(app)
      .post('/api/upload')
      .attach('file', pdf, { filename: 'two-pages.pdf', contentType: 'application/pdf' })
      .expect(200);
    expect(duplicate.body.data.duplicate).toBe(true);
    expect(duplicate.body.data.id).toBe(bookId);

    await request(app).delete(`/api/books/${bookId}`).expect(200);
    expect(listFilesRecursively(runtimeConfig.uploadDir)).toEqual([]);
  });

  it('preserves UTF-8 characters in uploaded filenames', async () => {
    const app = createApp();
    const originalName = '2608.03573v2_中科院_论文分析.pdf';

    const uploaded = await request(app)
      .post('/api/upload')
      .attach('file', createSyntheticPdf([
        ['This PDF verifies that a Unicode upload filename remains intact.'],
      ]), {
        filename: originalName,
        contentType: 'application/pdf',
      })
      .expect(200);

    expect(uploaded.body.data.originalName).toBe(originalName);

    const book = await request(app)
      .get(`/api/books/${uploaded.body.data.id}`)
      .expect(200);
    expect(book.body.data.original_name).toBe(originalName);
  });

  it('keeps scanned PDFs readable while every text capability returns the stable 422 error', async () => {
    const app = createApp();
    const scannedPdf = createSyntheticPdf([[], []]);
    const uploaded = await request(app)
      .post('/api/upload')
      .attach('file', scannedPdf, {
        filename: 'scanned.pdf',
        contentType: 'application/pdf',
      })
      .expect(200);
    const bookId = uploaded.body.data.id as number;

    const book = await request(app).get(`/api/books/${bookId}`).expect(200);
    expect(book.body.data.text_extraction_status).toBe('unavailable');
    expect(book.body.data.text_page_count).toBe(0);
    await request(app).get(book.body.data.file_url).expect(200);
    const duplicate = await request(app)
      .post('/api/upload')
      .attach('file', scannedPdf, { filename: 'scanned.pdf', contentType: 'application/pdf' })
      .expect(200);
    expect(duplicate.body.data).toEqual(expect.objectContaining({
      id: bookId,
      duplicate: true,
      text_extraction_status: 'unavailable',
      text_page_count: 0,
    }));

    const requests = [
      request(app).post('/api/translate/page').send({ bookId, pageNumber: 1 }),
      request(app).post('/api/translate/batch').send({ bookId, startPage: 1, endPage: 2 }),
      request(app).post('/api/translate/batch-job/start').send({ bookId }),
      request(app).get(`/api/summary/${bookId}`),
      request(app).get(`/api/summary/${bookId}/book`),
      request(app).get(`/api/summary/${bookId}/chapter/full-book`),
      request(app).post(`/api/summary/${bookId}/generate`).send({ type: 'book' }),
      request(app).post(`/api/summary/${bookId}/generate/stream`).send({}),
      request(app).get(`/api/mindmap/${bookId}`),
      request(app).get(`/api/mindmap/${bookId}/chapter/full-book`),
      request(app).post(`/api/mindmap/${bookId}/generate`).send({ chapterId: 'full-book' }),
      request(app).post(`/api/mindmap/${bookId}/generate/stream`).send({}),
      request(app).get(`/api/reading-guide/${bookId}`),
      request(app).post(`/api/reading-guide/${bookId}/generate`).send({}),
      request(app).post('/api/ai/chat').send({ bookId, pageNumber: 1, question: 'What is this page?' }),
      request(app).post('/api/ai/chat/stream').send({ bookId, pageNumber: 1, question: 'What is this page?' }),
    ];

    for (const textRequest of requests) {
      const response = await textRequest.expect(422);
      expect(response.body.code).toBe('TEXT_EXTRACTION_UNAVAILABLE');
    }

    await request(app).delete(`/api/books/${bookId}`).expect(200);
    expect(listFilesRecursively(runtimeConfig.uploadDir)).toEqual([]);
  });

  it('marks mixed PDFs partial, excludes blank pages from FTS, and skips blank-page translation', async () => {
    const app = createApp();
    const uploaded = await request(app)
      .post('/api/upload')
      .attach('file', createSyntheticPdf([
        ['This mixed PDF page has enough searchable text for all text capabilities.'],
        [],
      ]), {
        filename: 'mixed.pdf',
        contentType: 'application/pdf',
      })
      .expect(200);
    const bookId = uploaded.body.data.id as number;

    const book = await request(app).get(`/api/books/${bookId}`).expect(200);
    expect(book.body.data.text_extraction_status).toBe('partial');
    expect(book.body.data.text_page_count).toBe(1);
    expect(book.body.data.tableOfContents).toEqual([]);

    const indexedPages = db.prepare(
      'SELECT COUNT(*) as count FROM ai_page_search WHERE book_id = ?'
    ).get(bookId) as { count: number };
    expect(indexedPages.count).toBe(1);
    const blankPageHash = db.prepare(
      'SELECT page_hash FROM pages WHERE book_id = ? AND page_number = 2'
    ).get(bookId) as { page_hash: string | null };
    expect(blankPageHash.page_hash).toBeNull();

    const aiContext = bookAiContextService.buildContext(
      bookId,
      1,
      'What text is searchable?',
      undefined,
      'qa',
    );
    expect(aiContext.contextText).toContain('格式：PDF');
    expect(aiContext.currentChapter?.id).toBe('full-book');
    expect(aiContext.sources.map((source) => source.pageNumber)).toContain(1);
    expect(aiContext.sources.map((source) => source.pageNumber)).not.toContain(2);

    const skipped = await request(app)
      .post('/api/translate/batch')
      .send({ bookId, startPage: 2, endPage: 2 })
      .expect(200);
    expect(skipped.body.data.summary).toEqual(expect.objectContaining({
      total: 1,
      skipped: 1,
      failed: 0,
      progress: '1/1',
    }));

    const blankPage = await request(app).get(`/api/books/${bookId}/pages?page=2`).expect(200);
    expect(blankPage.body.data.original_text).toBe('');
    expect(blankPage.body.data.translation_status).toBe('skipped');

    db.prepare(`
      UPDATE pages
      SET translation_status = 'completed', translated_text = '已翻译的测试页'
      WHERE book_id = ? AND page_number = 1
    `).run(bookId);
    await request(app)
      .post('/api/translate/batch-job/start')
      .send({ bookId })
      .expect(200);
    const completedJob = await waitForBatchJob(app, bookId);
    expect(completedJob.status).toBe('completed');
    expect(completedJob.processed_pages).toBe(2);

    await request(app).delete(`/api/books/${bookId}`).expect(200);
    expect(listFilesRecursively(runtimeConfig.uploadDir)).toEqual([]);
  });

  it('rejects invalid, corrupt, zero-page, password-protected, and oversized PDFs without residue', async () => {
    const app = createApp();
    const filesBefore = listFilesRecursively(runtimeConfig.uploadDir);
    const booksBefore = (db.prepare('SELECT COUNT(*) as count FROM books').get() as { count: number }).count;

    await request(app)
      .post('/api/upload')
      .attach('file', Buffer.from('not a pdf'), { filename: 'fake.pdf', contentType: 'application/pdf' })
      .expect(400);
    await request(app)
      .post('/api/upload')
      .attach('file', Buffer.from('%PDF-1.7\ncorrupt'), { filename: 'corrupt.pdf', contentType: 'application/pdf' })
      .expect(400);
    await request(app)
      .post('/api/upload')
      .attach('file', createSyntheticPdf([]), { filename: 'zero.pdf', contentType: 'application/pdf' })
      .expect(400);

    const passwordResponse = await request(app)
      .post('/api/upload')
      .attach('file', createSyntheticPdf([['Password protected content']], { encrypted: true }), {
        filename: 'protected.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
    expect(passwordResponse.body.code).toBe('PDF_PASSWORD_PROTECTED');

    const oversized = await request(app)
      .post('/api/upload')
      .attach('file', createSyntheticPdf(Array.from({ length: 2001 }, () => [])), {
        filename: 'too-many-pages.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
    expect(oversized.body.code).toBe('PDF_PAGE_LIMIT_EXCEEDED');

    await request(app)
      .post('/api/upload')
      .attach('file', createSyntheticPdf([['MIME mismatch content']]), {
        filename: 'wrong-mime.pdf',
        contentType: 'text/plain',
      })
      .expect(400);

    expect((db.prepare('SELECT COUNT(*) as count FROM books').get() as { count: number }).count).toBe(booksBefore);
    expect(listFilesRecursively(runtimeConfig.uploadDir)).toEqual(filesBefore);
  });
});

function createSyntheticEpub(): Buffer {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from(`<?xml version="1.0"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`));
  zip.addFile('OEBPS/content.opf', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="2.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:identifier id="book-id">urn:uuid:synthetic-test-book</dc:identifier>
        <dc:title>Synthetic Test Book</dc:title>
        <dc:language>en</dc:language>
      </metadata>
      <manifest>
        <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
      </manifest>
      <spine toc="ncx"><itemref idref="chapter"/></spine>
    </package>`));
  zip.addFile('OEBPS/toc.ncx', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
      <head><meta name="dtb:uid" content="urn:uuid:synthetic-test-book"/></head>
      <docTitle><text>Synthetic Test Book</text></docTitle>
      <navMap><navPoint id="chapter" playOrder="1"><navLabel><text>Chapter</text></navLabel><content src="chapter.xhtml"/></navPoint></navMap>
    </ncx>`));
  zip.addFile('OEBPS/chapter.xhtml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head>
      <body><h1>Chapter</h1><p>This synthetic text is generated only for automated tests.</p></body>
    </html>`));
  return zip.toBuffer();
}

interface SyntheticPdfOptions {
  encrypted?: boolean;
  outline?: boolean;
}

function createSyntheticPdf(pages: string[][], options: SyntheticPdfOptions = {}): Buffer {
  const objects = new Map<number, string>();
  const catalogId = 1;
  const pagesId = 2;
  const fontId = 3;
  const pageIds = pages.map((_page, index) => 4 + index * 2);
  const contentIds = pages.map((_page, index) => 5 + index * 2);
  let nextId = 4 + pages.length * 2;
  const outlinesId = options.outline && pages.length > 0 ? nextId++ : null;
  const outlineItemId = outlinesId ? nextId++ : null;
  const encryptId = options.encrypted ? nextId : null;

  objects.set(catalogId, [
    '<< /Type /Catalog',
    `/Pages ${pagesId} 0 R`,
    outlinesId ? `/Outlines ${outlinesId} 0 R /PageMode /UseOutlines` : '',
    '>>',
  ].filter(Boolean).join(' '));
  objects.set(pagesId, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  pages.forEach((lines, index) => {
    const pageId = pageIds[index];
    const contentId = contentIds[index];
    const content = lines.length > 0
      ? [
          'BT /F1 14 Tf 72 720 Td',
          ...lines.flatMap((line, lineIndex) => [
            lineIndex > 0 ? '0 -22 Td' : '',
            `(${escapePdfString(line)}) Tj`,
          ]).filter(Boolean),
          'ET',
        ].join('\n')
      : 'q 0.94 g 72 520 300 120 re f Q';

    objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  });

  if (outlinesId && outlineItemId) {
    objects.set(outlinesId, `<< /Type /Outlines /First ${outlineItemId} 0 R /Last ${outlineItemId} 0 R /Count 1 >>`);
    objects.set(outlineItemId, `<< /Title (First section) /Parent ${outlinesId} 0 R /Dest [${pageIds[0]} 0 R /Fit] >>`);
  }

  if (encryptId) {
    const owner = '00'.repeat(32);
    const user = '00'.repeat(32);
    objects.set(encryptId, `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner}> /U <${user}> /P -4 >>`);
  }

  const objectCount = Math.max(0, ...objects.keys());
  let document = '%PDF-1.4\n%Synthetic\n';
  const offsets: number[] = [0];
  for (let id = 1; id <= objectCount; id++) {
    const body = objects.get(id) || '<< >>';
    offsets[id] = Buffer.byteLength(document, 'latin1');
    document += `${id} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(document, 'latin1');
  document += `xref\n0 ${objectCount + 1}\n`;
  document += '0000000000 65535 f \n';
  for (let id = 1; id <= objectCount; id++) {
    document += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }

  const encryptEntry = encryptId ? `/Encrypt ${encryptId} 0 R /ID [<00112233445566778899AABBCCDDEEFF><00112233445566778899AABBCCDDEEFF>]` : '';
  document += `trailer\n<< /Size ${objectCount + 1} /Root ${catalogId} 0 R ${encryptEntry} >>\n`;
  document += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, 'latin1');
}

function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function listFilesRecursively(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(path.relative(directory, fullPath));
    }
  };
  visit(directory);
  return files.sort();
}

async function waitForBatchJob(app: ReturnType<typeof createApp>, bookId: number) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await request(app).get(`/api/translate/batch-job/${bookId}`).expect(200);
    if (response.body.data && !['pending', 'processing'].includes(response.body.data.status)) {
      return response.body.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('批量翻译任务未在测试时限内结束');
}
