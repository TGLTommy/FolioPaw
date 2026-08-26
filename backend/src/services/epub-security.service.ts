import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { runtimeConfig } from '../config/env';

export class EpubSecurityError extends Error {
  readonly status = 400;
  readonly expose = true;

  constructor(message: string) {
    super(message);
    this.name = 'EpubSecurityError';
  }
}

export function openValidatedEpub(filePath: string): AdmZip {
  assertZipSignature(filePath);

  let zip: AdmZip;
  try {
    zip = new AdmZip(filePath);
  } catch {
    throw new EpubSecurityError('EPUB 压缩包无法读取');
  }

  const entries = zip.getEntries();
  if (entries.length === 0 || entries.length > runtimeConfig.epubLimits.maxEntries) {
    throw new EpubSecurityError('EPUB 文件条目数量超出安全限制');
  }

  const seenPaths = new Set<string>();
  let totalUncompressed = 0;

  for (const entry of entries) {
    const normalized = normalizeEntryPath(entry.entryName);
    const collisionKey = normalized.toLocaleLowerCase('en-US');
    if (seenPaths.has(collisionKey)) {
      throw new EpubSecurityError('EPUB 包含重复或大小写冲突的路径');
    }
    seenPaths.add(collisionKey);

    if (isSymlink(entry.attr)) {
      throw new EpubSecurityError('EPUB 不允许包含符号链接');
    }

    const uncompressedSize = entry.header.size;
    const compressedSize = entry.header.compressedSize;
    if (uncompressedSize < 0 || compressedSize < 0) {
      throw new EpubSecurityError('EPUB 包含无效的条目大小');
    }
    if (uncompressedSize > runtimeConfig.epubLimits.maxEntrySize) {
      throw new EpubSecurityError('EPUB 中的单个文件超出安全限制');
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > runtimeConfig.epubLimits.maxUncompressedSize) {
      throw new EpubSecurityError('EPUB 解压后的总体积超出安全限制');
    }

    if (
      uncompressedSize > 0 &&
      (compressedSize === 0 || uncompressedSize / compressedSize > runtimeConfig.epubLimits.maxCompressionRatio)
    ) {
      throw new EpubSecurityError('EPUB 的压缩比超出安全限制');
    }
  }

  const mimetype = zip.getEntry('mimetype');
  const container = zip.getEntry('META-INF/container.xml');
  if (!mimetype || mimetype.isDirectory || !container || container.isDirectory) {
    throw new EpubSecurityError('文件缺少 EPUB 必需的元数据');
  }
  if (mimetype.getData().toString('utf8').trim() !== 'application/epub+zip') {
    throw new EpubSecurityError('文件不是有效的 EPUB 格式');
  }

  return zip;
}

export function extractEpubSafely(zip: AdmZip, destination: string): void {
  const root = path.resolve(destination);
  fs.mkdirSync(root, { recursive: true });
  let extractedBytes = 0;

  for (const entry of zip.getEntries()) {
    const normalized = normalizeEntryPath(entry.entryName);
    const target = path.resolve(root, ...normalized.split('/'));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new EpubSecurityError('EPUB 包含目录穿越路径');
    }

    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    const data = entry.getData();
    extractedBytes += data.length;
    if (
      data.length > runtimeConfig.epubLimits.maxEntrySize ||
      extractedBytes > runtimeConfig.epubLimits.maxUncompressedSize
    ) {
      throw new EpubSecurityError('EPUB 解压后的内容超出安全限制');
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx', mode: 0o600 });
  }
}

function assertZipSignature(filePath: string): void {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const signature = Buffer.alloc(4);
    if (fs.readSync(descriptor, signature, 0, signature.length, 0) !== signature.length) {
      throw new EpubSecurityError('EPUB 文件内容为空或不完整');
    }
    const valid =
      signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
      signature.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])) ||
      signature.equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
    if (!valid) throw new EpubSecurityError('文件扩展名为 EPUB，但内容不是 ZIP 容器');
  } finally {
    fs.closeSync(descriptor);
  }
}

function normalizeEntryPath(entryName: string): string {
  const normalized = entryName.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    throw new EpubSecurityError('EPUB 包含不安全的文件路径');
  }
  return normalized;
}

function isSymlink(attributes: number): boolean {
  const fileType = (attributes >>> 16) & 0o170000;
  return fileType === 0o120000;
}
