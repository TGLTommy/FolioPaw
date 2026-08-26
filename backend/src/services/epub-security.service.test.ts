import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it } from 'vitest';
import { extractEpubSafely, openValidatedEpub } from './epub-security.service';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('EPUB archive validation', () => {
  it('accepts and safely extracts a minimal EPUB', () => {
    const directory = makeTemporaryDirectory();
    const epubPath = path.join(directory, 'valid.epub');
    const zip = createBaseEpub();
    zip.addFile('OEBPS/chapter.xhtml', Buffer.from('<html><body>Hello</body></html>'));
    zip.writeZip(epubPath);

    const validated = openValidatedEpub(epubPath);
    const destination = path.join(directory, 'extracted');
    extractEpubSafely(validated, destination);

    expect(fs.readFileSync(path.join(destination, 'OEBPS/chapter.xhtml'), 'utf8')).toContain('Hello');
  });

  it('rejects files with a fake EPUB extension', () => {
    const directory = makeTemporaryDirectory();
    const epubPath = path.join(directory, 'fake.epub');
    fs.writeFileSync(epubPath, 'not a zip');
    expect(() => openValidatedEpub(epubPath)).toThrow(/ZIP 容器/);
  });

  it('rejects archive path traversal', () => {
    const directory = makeTemporaryDirectory();
    const epubPath = path.join(directory, 'traversal.epub');
    const zip = createBaseEpub();
    // AdmZip sanitizes traversal paths passed to addFile, so create a valid
    // same-length name first and then mutate both ZIP filename records.
    zip.addFile('aa/outside.txt', Buffer.from('blocked'));
    const archive = zip.toBuffer();
    replaceAllAscii(archive, 'aa/outside.txt', '../outside.txt');
    fs.writeFileSync(epubPath, archive);
    expect(() => openValidatedEpub(epubPath)).toThrow(/不安全的文件路径/);
  });

  it('rejects suspicious compression ratios', () => {
    const directory = makeTemporaryDirectory();
    const epubPath = path.join(directory, 'bomb.epub');
    const zip = createBaseEpub();
    zip.addFile('OEBPS/large.xhtml', Buffer.alloc(2 * 1024 * 1024, 65));
    zip.writeZip(epubPath);
    expect(() => openValidatedEpub(epubPath)).toThrow(/压缩比/);
  });
});

function createBaseEpub(): AdmZip {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from(
    '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
  ));
  zip.addFile('OEBPS/content.opf', Buffer.from('<package></package>'));
  return zip;
}

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foliopaw-epub-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function replaceAllAscii(buffer: Buffer, from: string, to: string): void {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) {
    throw new Error('ZIP filename replacement must preserve byte length');
  }

  const needle = Buffer.from(from);
  let replacements = 0;
  for (let offset = buffer.indexOf(needle); offset !== -1; offset = buffer.indexOf(needle, offset + needle.length)) {
    buffer.write(to, offset, 'ascii');
    replacements += 1;
  }
  if (replacements < 2) throw new Error('Expected ZIP local and central filename records');
}
