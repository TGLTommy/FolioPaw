import fs from 'node:fs';
import type { TOCEntry } from './epub.service';
import { runtimeConfig } from '../config/env';

export interface PDFPage {
  pageNumber: number;
  text: string;
}

export interface ParsedPdf {
  pages: PDFPage[];
  totalPages: number;
  toc: TOCEntry[];
  coverImagePath: null;
  createdResourcePaths: string[];
}

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfDocument = Awaited<ReturnType<PdfJsModule['getDocument']>['promise']>;
type PdfOutlineNode = Awaited<ReturnType<PdfDocument['getOutline']>>[number];

// TypeScript compiles ordinary dynamic imports to require() in this CommonJS backend.
// Vitest, however, needs to see the regular import expression so it can provide its
// VM loader. Try that form first, then fall back to Node's native import after build.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<PdfJsModule>;

async function loadPdfJs(): Promise<PdfJsModule> {
  try {
    return await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (error: unknown) {
    if ((error as { code?: string } | null)?.code !== 'ERR_REQUIRE_ESM') throw error;
    return nativeDynamicImport('pdfjs-dist/legacy/build/pdf.mjs');
  }
}

export class PdfValidationError extends Error {
  readonly status = 400;
  readonly expose = true;
  readonly code: string;

  constructor(message: string, code = 'INVALID_PDF') {
    super(message);
    this.name = 'PdfValidationError';
    this.code = code;
  }
}

function assertPdfHeader(buffer: Buffer): void {
  const header = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('latin1');
  if (!header.includes('%PDF-')) {
    throw new PdfValidationError('文件头无效，不是有效的 PDF 文件');
  }
}

function isTextItem(item: unknown): item is {
  str: string;
  hasEOL: boolean;
  transform: number[];
  width: number;
  height: number;
} {
  return Boolean(
    item
    && typeof item === 'object'
    && 'str' in item
    && typeof (item as { str?: unknown }).str === 'string'
  );
}

function extractPageText(items: unknown[]): string {
  let output = '';
  let previousY: number | null = null;
  let previousEndX: number | null = null;
  let previousHeight = 0;
  let forceNewLine = false;

  for (const item of items) {
    if (!isTextItem(item) || !item.str) continue;

    const x = Number(item.transform?.[4] || 0);
    const y = Number(item.transform?.[5] || 0);
    const height = Math.abs(Number(item.height || item.transform?.[3] || 0));
    const lineThreshold = Math.max(2, Math.max(height, previousHeight) * 0.6);
    const movedToNewLine = previousY !== null && Math.abs(y - previousY) > lineThreshold;
    const movedBackwards = previousEndX !== null && x + Math.max(1, height * 0.2) < previousEndX;

    if (output && (forceNewLine || movedToNewLine || movedBackwards)) {
      output = output.replace(/[ \t]+$/g, '');
      if (!output.endsWith('\n')) output += '\n';
    } else if (output && !/\s$/.test(output) && previousEndX !== null) {
      const gap = x - previousEndX;
      if (gap > Math.max(0.5, height * 0.08)) output += ' ';
    }

    output += item.str;
    previousY = y;
    previousEndX = x + Math.abs(Number(item.width || 0));
    previousHeight = height;
    forceNewLine = Boolean(item.hasEOL);
  }

  return output
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function resolveOutlinePageNumber(
  document: PdfDocument,
  destination: PdfOutlineNode['dest']
): Promise<number | undefined> {
  if (!destination) return undefined;

  const explicitDestination = typeof destination === 'string'
    ? await document.getDestination(destination)
    : destination;
  if (!Array.isArray(explicitDestination) || explicitDestination.length === 0) return undefined;

  const target = explicitDestination[0];
  if (Number.isInteger(target) && target >= 0) return target + 1;
  if (!target || typeof target !== 'object') return undefined;

  try {
    return (await document.getPageIndex(target)) + 1;
  } catch {
    return undefined;
  }
}

async function convertOutline(
  document: PdfDocument,
  nodes: PdfOutlineNode[],
  level = 0,
  outlinePath: number[] = []
): Promise<TOCEntry[]> {
  const entries: TOCEntry[] = [];

  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const nodePath = [...outlinePath, index];
    const pageNumber = await resolveOutlinePageNumber(document, node.dest);
    const children = await convertOutline(document, node.items || [], level + 1, nodePath);
    const title = node.title?.trim();

    if (!title || (pageNumber === undefined && children.length === 0)) continue;
    entries.push({
      id: `pdf-outline-${nodePath.join('-')}`,
      title,
      href: pageNumber ? `#page=${pageNumber}` : '',
      level,
      pageNumber,
      ...(children.length > 0 ? { children } : {}),
    });
  }

  return entries;
}

function isPasswordError(error: unknown, passwordResponses: PdfJsModule['PasswordResponses']): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string; code?: number };
  return candidate.name === 'PasswordException'
    || candidate.code === passwordResponses.NEED_PASSWORD
    || candidate.code === passwordResponses.INCORRECT_PASSWORD;
}

export async function parsePDF(filePath: string): Promise<ParsedPdf> {
  const buffer = fs.readFileSync(filePath);
  assertPdfHeader(buffer);

  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  });
  let document: PdfDocument | null = null;

  try {
    document = await loadingTask.promise;
    const totalPages = document.numPages;
    if (!Number.isInteger(totalPages) || totalPages <= 0) {
      throw new PdfValidationError('PDF 没有可读取的页面');
    }
    if (totalPages > runtimeConfig.maxPdfPages) {
      throw new PdfValidationError(
        `PDF 页数超过限制（最多 ${runtimeConfig.maxPdfPages} 页）`,
        'PDF_PAGE_LIMIT_EXCEEDED'
      );
    }

    const pages: PDFPage[] = [];
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      pages.push({
        pageNumber,
        text: extractPageText(textContent.items),
      });
      page.cleanup();
    }

    const outline = await document.getOutline();
    const toc = outline ? await convertOutline(document, outline) : [];

    return {
      pages,
      totalPages,
      toc,
      coverImagePath: null,
      createdResourcePaths: [],
    };
  } catch (error: unknown) {
    if (error instanceof PdfValidationError) throw error;
    if (isPasswordError(error, pdfjs.PasswordResponses)) {
      throw new PdfValidationError(
        '暂不支持加密或密码保护的 PDF',
        'PDF_PASSWORD_PROTECTED'
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new PdfValidationError(`PDF 已损坏或无法完整解析：${message}`);
  } finally {
    if (document) {
      await document.destroy().catch(() => undefined);
    } else {
      await loadingTask.destroy().catch(() => undefined);
    }
  }
}
