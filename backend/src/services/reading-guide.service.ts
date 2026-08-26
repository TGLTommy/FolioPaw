import { db } from '../config/database';
import {
  isModelAbortError,
  modelGateway,
  type ModelExecutionContext,
} from './model-gateway.service';
import {
  assertBookTextAvailable,
  isMeaningfulExtractedText,
} from './book-text-capability.service';
import {
  estimateTokenCount,
  truncateTextToTokenBudget,
} from './model-context-budget.service';

interface BookRow {
  id: number;
  original_name: string;
  file_type: string;
  total_pages: number;
  table_of_contents: string | null;
}

interface PageRow {
  page_number: number;
  original_text: string;
}

export interface TocLine {
  title: string;
  pageNumber?: number;
  depth: number;
}

export interface ReadingGuideRecord {
  id: number;
  book_id: number;
  guide_text: string | null;
  status: 'pending' | 'generating' | 'completed' | 'failed' | 'cancelled';
  error_message: string | null;
  model_used: string | null;
  model_config_id: number | null;
  created_at: string;
  updated_at: string;
}

const READING_GUIDE_PROMPT = `你是一位严谨的中文书籍摘要专家。请基于用户提供的书籍元数据、目录和正文抽样，生成一份可帮助用户在正式阅读前快速掌握核心内容的简体中文“预读摘要”。

目标：
- 让用户不用先通读全书，也能理解这本书主要在讲什么、核心观点是什么、论证如何展开、哪些部分最值得优先读。
- 输出应像一份高质量读书笔记，而不是营销推荐、泛泛书评或目录复述。

结构要求：
1. 先输出「一句话总览」：用1句话概括本书最核心的主题或主张。
2. 输出「核心摘要」：用3-5段说明本书要解决的问题、主要论证路径、关键结论和整体价值。
3. 输出「核心观点」：列出5-8个要点。每个要点都要包含“观点 + 解释”，避免只写标题。
4. 输出「内容脉络」：按目录或正文线索梳理全书展开顺序，指出各部分之间的关系。
5. 输出「关键概念/方法」：提炼书中反复出现或理解全书必需的概念、框架、方法或案例。
6. 输出「精读建议」：指出最值得优先阅读的章节/部分，并说明原因。
7. 输出「适合与不适合」：简要说明适合哪些读者、不适合哪些读者。
8. 最后输出「可信度说明」：说明本摘要依据的是元数据、目录和正文抽样；如果样本不足或信息不完整，要明确提醒哪些判断可能不充分。

质量要求：
- 字数控制在3000-5000个汉字左右，信息密度优先，不要空话套话。
- 只能依据输入内容，不要编造作者背景、出版信息、外部评价、未出现的案例或章节。
- 如果原文是英文或其他语言，仍然用自然、准确的中文表达，不要机械翻译。
- 保持客观准确；可以指出局限，但不要为了推荐而推荐。
- 使用Markdown，结构清晰，但不要输出表格。`;

const DEFAULT_MAX_INPUT_CHARS = 120000;
const DEFAULT_TIMEOUT_MS = 300000;

class ReadingGuideService {
  private runningControllers = new Map<number, AbortController>();

  resumeInterruptedGuides(): void {
    const interruptedGuides = db.prepare(`
      SELECT book_id, model_config_id
      FROM book_reading_guides
      WHERE status IN ('pending', 'generating')
      ORDER BY updated_at ASC, id ASC
    `).all() as Array<{ book_id: number; model_config_id: number | null }>;

    for (const guide of interruptedGuides) {
      console.log(`[ReadingGuide] Resuming interrupted guide for book ${guide.book_id}`);
      try {
        this.startGeneration(guide.book_id, guide.model_config_id || undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        db.prepare(`
          UPDATE book_reading_guides
          SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
          WHERE book_id = ?
        `).run(message, guide.book_id);
      }
    }
  }

  getReadingGuide(bookId: number): ReadingGuideRecord | undefined {
    return db.prepare(
      'SELECT * FROM book_reading_guides WHERE book_id = ?'
    ).get(bookId) as ReadingGuideRecord | undefined;
  }

  ensureReadingGuide(bookId: number, force: boolean = false): ReadingGuideRecord {
    assertBookTextAvailable(bookId);
    const existing = this.getReadingGuide(bookId);

    if (existing && !force && existing.status === 'completed') {
      return existing;
    }

    if (existing && !force && (existing.status === 'pending' || existing.status === 'generating')) {
      this.startGeneration(bookId, existing.model_config_id || undefined);
      return existing;
    }

    const modelContext = modelGateway.createContext();

    db.prepare(`
      INSERT INTO book_reading_guides (
        book_id, status, error_message, guide_text, model_config_id, updated_at
      ) VALUES (?, 'generating', NULL, NULL, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(book_id) DO UPDATE SET
        status = 'generating',
        error_message = NULL,
        guide_text = CASE WHEN ? THEN NULL ELSE guide_text END,
        model_config_id = excluded.model_config_id,
        updated_at = CURRENT_TIMESTAMP
    `).run(bookId, modelContext.config.id, force ? 1 : 0);

    this.startGeneration(bookId, modelContext.config.id, modelContext);
    return this.getReadingGuide(bookId)!;
  }

  deleteReadingGuide(bookId: number): void {
    this.runningControllers.get(bookId)?.abort();
    db.prepare('DELETE FROM book_reading_guides WHERE book_id = ?').run(bookId);
  }

  cancelReadingGuide(bookId: number): ReadingGuideRecord | undefined {
    this.runningControllers.get(bookId)?.abort();
    this.markGuideCancelled(bookId);
    return this.getReadingGuide(bookId);
  }

  private startGeneration(
    bookId: number,
    modelConfigId?: number,
    existingContext?: ModelExecutionContext,
  ): void {
    if (this.runningControllers.has(bookId)) return;

    assertBookTextAvailable(bookId);
    const modelContext = existingContext || modelGateway.createContext(modelConfigId);
    const controller = new AbortController();
    this.runningControllers.set(bookId, controller);
    setImmediate(() => {
      void this.generateReadingGuide(bookId, controller, modelContext);
    });
  }

  private async generateReadingGuide(
    bookId: number,
    controller: AbortController,
    modelContext: ModelExecutionContext,
  ): Promise<void> {
    try {
      if (controller.signal.aborted) {
        this.markGuideCancelled(bookId);
        return;
      }

      db.prepare(`
        UPDATE book_reading_guides
        SET status = 'generating', error_message = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE book_id = ? AND status != 'cancelled'
      `).run(bookId);

      const inputBudget = modelGateway.getInputTokenBudget({
        systemPrompt: READING_GUIDE_PROMPT,
        userMessage: '',
        task: '生成简体中文预读摘要，帮助用户在阅读前快速理解全书核心观点。',
        maxTokens: 8000,
      }, modelContext);
      const input = this.buildGuideInput(bookId, inputBudget ?? undefined);
      if (!input.trim()) {
        throw new Error('书籍正文为空，无法生成解读');
      }

      console.log(`[ReadingGuide] Generating guide for book ${bookId}`);
      const response = await modelGateway.call({
        systemPrompt: READING_GUIDE_PROMPT,
        userMessage: input,
        task: '生成简体中文预读摘要，帮助用户在阅读前快速理解全书核心观点。',
        maxTokens: 8000,
        timeoutMs: this.getTimeoutMs(),
        signal: controller.signal,
      }, modelContext);

      if (controller.signal.aborted) {
        this.markGuideCancelled(bookId);
        return;
      }

      db.prepare(`
        UPDATE book_reading_guides
        SET guide_text = ?,
            status = 'completed',
            model_used = ?,
            error_message = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE book_id = ? AND status != 'cancelled'
      `).run(response.text, response.model, bookId);
      console.log(`[ReadingGuide] Guide completed for book ${bookId}`);
    } catch (error: unknown) {
      if (controller.signal.aborted || isModelAbortError(error)) {
        this.markGuideCancelled(bookId);
        console.log(`[ReadingGuide] Guide cancelled for book ${bookId}`);
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ReadingGuide] Guide failed for book ${bookId}:`, message);
      db.prepare(`
        UPDATE book_reading_guides
        SET status = 'failed',
            error_message = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE book_id = ?
      `).run(message, bookId);
    } finally {
      if (this.runningControllers.get(bookId) === controller) {
        this.runningControllers.delete(bookId);
      }
    }
  }

  private markGuideCancelled(bookId: number): void {
    db.prepare(`
      UPDATE book_reading_guides
      SET status = 'cancelled',
          error_message = '用户取消了 AI摘要',
          updated_at = CURRENT_TIMESTAMP
      WHERE book_id = ? AND status IN ('pending', 'generating')
    `).run(bookId);
  }

  private buildGuideInput(bookId: number, tokenBudget?: number): string {
    const capability = assertBookTextAvailable(bookId);
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId) as BookRow | undefined;
    if (!book) {
      throw new Error('书籍不存在');
    }

    const pages = db.prepare(`
      SELECT page_number, original_text
      FROM pages
      WHERE book_id = ?
      ORDER BY page_number
    `).all(bookId) as PageRow[];

    const maxInputChars = this.getMaxInputChars();
    const tocLines = this.getTocLines(book.table_of_contents);
    const selectedPageNumbers = selectReadingGuidePages(book.total_pages, tocLines);
    const pageMap = new Map(pages.map((page) => [page.page_number, page.original_text]));

    if (tokenBudget !== undefined) {
      const metadata = [
        `书名：${book.original_name}`,
        `格式：${book.file_type.toUpperCase()}`,
        `总页数：${book.total_pages}`,
      ].join('\n\n');
      const metadataTokens = estimateTokenCount(metadata);
      const tocBudget = Math.max(
        0,
        Math.min(Math.floor(tokenBudget * 0.2), tokenBudget - metadataTokens - 128),
      );
      const toc = tocLines.length > 0
        ? `目录：\n${truncateTextToTokenBudget(formatTocLines(tocLines), tocBudget, '\n[目录已截断]')}`
        : '目录：未提取到目录';
      const prefix = [
        metadata,
        toc,
      ].join('\n\n');
      const bodyBudget = Math.max(0, tokenBudget - estimateTokenCount(prefix) - 64);
      const candidates = selectedPageNumbers
        .map((pageNumber) => ({ pageNumber, text: pageMap.get(pageNumber) || '' }))
        .filter(({ text }) => capability.fileType !== 'pdf' || isMeaningfulExtractedText(text))
        .map(({ pageNumber, text }) => ({ pageNumber, text: cleanText(text) }))
        .filter(({ text }) => Boolean(text));
      const sourcePages = candidates.length > 0
        ? candidates
        : pages
          .filter((page) => capability.fileType !== 'pdf' || isMeaningfulExtractedText(page.original_text))
          .map((page) => ({ pageNumber: page.page_number, text: cleanText(page.original_text) }))
          .filter(({ text }) => Boolean(text));
      const perPageBudget = Math.max(1, Math.floor(bodyBudget / Math.max(1, sourcePages.length)));
      const bodyParts: string[] = [];
      let usedTokens = 0;
      for (const page of sourcePages) {
        const header = `[第 ${page.pageNumber} 页]\n`;
        const section = `${header}${truncateTextToTokenBudget(page.text, Math.max(1, perPageBudget - estimateTokenCount(header)), '')}`;
        const sectionTokens = estimateTokenCount(section);
        if (usedTokens + sectionTokens > bodyBudget) continue;
        bodyParts.push(section);
        usedTokens += sectionTokens;
      }
      return `${prefix}\n\n正文抽样：\n\n${bodyParts.join('\n\n')}`;
    }

    const bodyParts: string[] = [];
    let usedChars = 0;

    for (const pageNumber of selectedPageNumbers) {
      const rawText = pageMap.get(pageNumber);
      if (!rawText) continue;
      if (capability.fileType === 'pdf' && !isMeaningfulExtractedText(rawText)) continue;

      const cleaned = cleanText(rawText);
      if (!cleaned) continue;

      const section = `\n\n[第 ${pageNumber} 页]\n${cleaned}`;
      if (usedChars + section.length > maxInputChars) break;
      bodyParts.push(section);
      usedChars += section.length;
    }

    if (bodyParts.length === 0) {
      for (const page of pages) {
        if (capability.fileType === 'pdf' && !isMeaningfulExtractedText(page.original_text)) continue;
        const cleaned = cleanText(page.original_text);
        if (!cleaned) continue;

        const section = `\n\n[第 ${page.page_number} 页]\n${cleaned}`;
        if (usedChars + section.length > maxInputChars) break;
        bodyParts.push(section);
        usedChars += section.length;
      }
    }

    return [
      `书名：${book.original_name}`,
      `格式：${book.file_type.toUpperCase()}`,
      `总页数：${book.total_pages}`,
      tocLines.length > 0 ? `目录：\n${formatTocLines(tocLines)}` : '目录：未提取到目录',
      `正文抽样：${bodyParts.join('')}`,
    ].join('\n\n');
  }

  private getTocLines(rawToc: string | null): TocLine[] {
    if (!rawToc) return [];

    try {
      const parsed = JSON.parse(rawToc) as unknown;
      return flattenToc(parsed).slice(0, 80);
    } catch {
      return [];
    }
  }

  private getMaxInputChars(): number {
    const parsed = Number.parseInt(process.env.READING_GUIDE_MAX_INPUT_CHARS || '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_INPUT_CHARS;
    return Math.max(20000, Math.min(parsed, 300000));
  }

  private getTimeoutMs(): number {
    const parsed = Number.parseInt(
      process.env.READING_GUIDE_TIMEOUT_MS || process.env.SUMMARY_TIMEOUT_MS || '',
      10
    );
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
    return parsed;
  }
}

function cleanText(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function selectReadingGuidePages(totalPages: number, tocLines: TocLine[]): number[] {
  const selected = new Set<number>();
  const addPage = (page: number) => {
    if (Number.isFinite(page) && page >= 1 && page <= totalPages) selected.add(Math.round(page));
  };
  const addRange = (start: number, end: number) => {
    for (let page = Math.max(1, start); page <= Math.min(totalPages, end); page += 1) {
      selected.add(page);
    }
  };

  if (totalPages <= 80) {
    addRange(1, totalPages);
    return [...selected];
  }

  // Preserve a small amount of front/back matter, then spread samples across
  // chapter starts and the full page range instead of consuming a fixed prefix.
  addRange(1, 5);
  addRange(totalPages - 4, totalPages);

  const chapterStarts = [...new Set(
    tocLines
      .map((line) => line.pageNumber)
      .filter((pageNumber): pageNumber is number =>
        typeof pageNumber === 'number'
        && Number.isFinite(pageNumber)
        && pageNumber >= 1
        && pageNumber <= totalPages
      )
      .map((pageNumber) => Math.round(pageNumber)),
  )].sort((left, right) => left - right);
  for (const pageNumber of sampleEvenly(chapterStarts, 24)) {
    addPage(pageNumber);
    addPage(pageNumber + 1);
  }

  const globalSampleCount = 12;
  for (let index = 0; index < globalSampleCount; index += 1) {
    addPage(1 + (index * (totalPages - 1)) / (globalSampleCount - 1));
  }

  return [...selected].sort((left, right) => left - right);
}

function sampleEvenly(values: number[], maximum: number): number[] {
  if (values.length <= maximum) return values;
  const sampled = new Set<number>();
  for (let index = 0; index < maximum; index += 1) {
    sampled.add(values[Math.round((index * (values.length - 1)) / (maximum - 1))]);
  }
  return [...sampled];
}

function flattenToc(value: unknown, depth: number = 0): TocLine[] {
  if (!Array.isArray(value)) return [];

  const lines: TocLine[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;

    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const pageNumber = typeof item.pageNumber === 'number' ? item.pageNumber : undefined;

    if (title) {
      lines.push({ title, pageNumber, depth });
    }

    if (Array.isArray(item.children)) {
      lines.push(...flattenToc(item.children, depth + 1));
    }
  }

  return lines;
}

function formatTocLines(lines: TocLine[]): string {
  return lines
    .map((line) => {
      const indent = '  '.repeat(Math.min(line.depth, 3));
      const page = line.pageNumber ? ` (p.${line.pageNumber})` : '';
      return `${indent}- ${line.title}${page}`;
    })
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export const readingGuideService = new ReadingGuideService();
