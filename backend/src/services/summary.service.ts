import { db } from '../config/database';
import {
  ModelGatewayError,
  modelGateway,
  type ModelExecutionContext,
} from './model-gateway.service';
import {
  splitTextByTokenBudget,
  textFitsTokenBudget,
} from './model-context-budget.service';
import {
  assertBookTextAvailable,
  isMeaningfulExtractedText,
} from './book-text-capability.service';

interface TOCEntry {
  id: string;
  title: string;
  level: number;
  pageNumber?: number;
  children?: TOCEntry[];
}

interface ChapterRange {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  isContent: boolean;
}

const NON_CONTENT_TITLES = [
  'cover', 'title page', 'copyright', 'dedication', 'contents',
  'table of contents', 'acknowledgments', 'acknowledgements',
  'about the author', 'also by', 'colophon', 'front matter',
  'half title', 'praise for', 'endorsements', 'epigraph',
  'frontispiece', 'list of figures', 'list of tables',
  'list of illustrations', 'half-title', 'books by',
  'notes', 'bibliography', 'glossary', 'index', 'appendix',
  'afterword', 'postscript', 'further reading', 'references',
];

interface SummaryRecord {
  id: number;
  book_id: number;
  summary_type: 'chapter' | 'book';
  chapter_id: string | null;
  chapter_title: string | null;
  page_start: number | null;
  page_end: number | null;
  summary_text: string | null;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  error_message: string | null;
  model_used: string | null;
  created_at: string;
  updated_at: string;
}

// Prompts
const CHAPTER_SUMMARY_PROMPT = `你是一位专业的书籍内容分析师。请为以下章节内容生成一份结构化的简体中文摘要。

要求：
1. 300-800字
2. 结构：核心主题 → 关键内容(3-5点) → 重要概念 → 章节价值
3. 保持客观准确
4. 使用Markdown格式`;

const BOOK_SUMMARY_FROM_CHAPTERS_PROMPT = `请基于以下各章节摘要，用简体中文生成一份全书综述。

结构要求：
1. 全书概览（1-2段）
2. 主要脉络
3. 核心观点（3-5个要点）
4. 适读人群
5. 推荐精读章节

字数要求：500-1500字
使用Markdown格式`;

const BOOK_SUMMARY_DIRECT_PROMPT = `你是一位专业的书籍内容分析师。请为以下书籍内容生成一份结构化的简体中文全书摘要。

结构要求：
1. 全书概览（1-2段）
2. 主要脉络
3. 核心观点（3-5个要点）
4. 适读人群

字数要求：500-1500字
使用Markdown格式`;

const CHUNK_SUMMARY_PROMPT = `你是一位专业的内容分析师。请提取以下文本的关键要点，200-400字，使用简体中文。保持客观准确。`;

const MERGE_CHUNK_SUMMARIES_PROMPT = `你是一位专业的书籍内容分析师。以下是同一章节不同部分的要点提取，请用简体中文将它们合并为一份完整的章节摘要。

要求：
1. 300-800字
2. 结构：核心主题 → 关键内容(3-5点) → 重要概念 → 章节价值
3. 去除重复内容，保持连贯
4. 使用Markdown格式`;

const MAX_CHUNK_SIZE = 300000; // MiniMax-M2.5 supports 204,800 tokens context window

export class SummaryService {

  /**
   * Flatten TOC entries to get all entries with page numbers
   */
  private flattenTOC(entries: TOCEntry[]): TOCEntry[] {
    const result: TOCEntry[] = [];
    for (const entry of entries) {
      if (entry.pageNumber !== undefined) {
        result.push(entry);
      }
      if (entry.children) {
        result.push(...this.flattenTOC(entry.children));
      }
    }
    return result;
  }

  /**
   * Check if a chapter is actual content (not front/back matter)
   */
  private isContentChapter(title: string, pageCount: number): boolean {
    const normalized = title.trim().toLowerCase();
    if (NON_CONTENT_TITLES.some(bl => normalized === bl || normalized.startsWith(bl + ':'))) {
      return false;
    }
    // Single-page chapters with very short generic titles are likely non-content
    if (pageCount <= 1 && normalized.length <= 3) {
      return false;
    }
    return true;
  }

  /**
   * Calculate chapter page ranges from TOC
   */
  calculateChapterRanges(bookId: number): ChapterRange[] {
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId) as any;
    if (!book) throw new Error('书籍不存在');

    let toc: TOCEntry[] = [];
    if (book.table_of_contents) {
      try {
        toc = JSON.parse(book.table_of_contents);
      } catch {
        toc = [];
      }
    }

    const flatEntries = this.flattenTOC(toc);
    if (flatEntries.length === 0) {
      // No TOC - treat entire book as single chapter
      return [{
        id: 'full-book',
        title: book.original_name || 'Full Book',
        pageStart: 1,
        pageEnd: book.total_pages,
        isContent: true,
      }];
    }

    // Sort by page number
    flatEntries.sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0));

    // Deduplicate entries at the same page number (keep the first/top-level one)
    const deduped: TOCEntry[] = [];
    const seenPages = new Set<number>();
    for (const entry of flatEntries) {
      const pageNum = entry.pageNumber!;
      if (!seenPages.has(pageNum)) {
        seenPages.add(pageNum);
        deduped.push(entry);
      }
    }

    const ranges: ChapterRange[] = [];
    for (let i = 0; i < deduped.length; i++) {
      const entry = deduped[i];
      const nextEntry = deduped[i + 1];
      const pageStart = entry.pageNumber!;
      const pageEnd = nextEntry ? nextEntry.pageNumber! - 1 : book.total_pages;
      const pageCount = pageEnd - pageStart + 1;
      ranges.push({
        id: entry.id || `ch-${i}`,
        title: entry.title,
        pageStart,
        pageEnd,
        isContent: this.isContentChapter(entry.title, pageCount),
      });
    }

    return ranges;
  }

  /**
   * Gather text content for a page range, preferring translated text
   */
  gatherChapterContent(bookId: number, pageStart: number, pageEnd: number): string {
    const capability = assertBookTextAvailable(bookId);
    const pages = db.prepare(`
      SELECT p.original_text,
             COALESCE(p.translated_text, pc.translated_text) as translated_text
      FROM pages p
      LEFT JOIN page_cache pc ON pc.id = (
        SELECT pc2.id FROM page_cache pc2
        WHERE pc2.page_hash = p.page_hash
        ORDER BY pc2.updated_at DESC, pc2.id DESC
        LIMIT 1
      )
      WHERE p.book_id = ? AND p.page_number >= ? AND p.page_number <= ?
      ORDER BY p.page_number
    `).all(bookId, pageStart, pageEnd) as any[];

    const texts: string[] = [];
    for (const page of pages) {
      if (capability.fileType === 'pdf' && !isMeaningfulExtractedText(page.original_text)) continue;
      // Prefer translated (Chinese) text, fall back to original
      let text = page.translated_text || page.original_text || '';
      // Strip HTML tags
      text = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) texts.push(text);
    }

    return texts.join('\n\n');
  }

  /**
   * Split content into chunks at paragraph boundaries
   */
  chunkContent(content: string, tokenBudget?: number): string[] {
    if (tokenBudget !== undefined) {
      return splitTextByTokenBudget(content, Math.max(1, tokenBudget));
    }
    if (content.length <= MAX_CHUNK_SIZE) {
      return [content];
    }

    const paragraphs = content.split(/\n\n+/);
    const chunks: string[] = [];
    let currentChunk = '';

    for (const paragraph of paragraphs) {
      if (currentChunk.length + paragraph.length + 2 > MAX_CHUNK_SIZE && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = paragraph;
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks.length > 0 ? chunks : [content.substring(0, MAX_CHUNK_SIZE)];
  }

  /**
   * Call the active third-party API through the shared model gateway.
   */
  async callLLM(
    systemPrompt: string,
    userMessage: string,
    maxTokens: number = 8000,
    modelContext: ModelExecutionContext = modelGateway.createContext(),
    responseFormat: 'text' | 'json' = 'text',
  ): Promise<{ text: string; model: string }> {
    const response = await modelGateway.call({
      systemPrompt,
      userMessage,
      task: '生成用户要求的简体中文书籍分析内容。',
      maxTokens,
      responseFormat,
      timeoutMs: Number.parseInt(process.env.SUMMARY_TIMEOUT_MS || '', 10) || undefined,
    }, modelContext);
    return { text: response.text, model: response.model };
  }

  /**
   * Summarize content that may be long (multi-chunk)
   */
  async summarizeContent(
    content: string,
    prompt: string,
    modelContext: ModelExecutionContext = modelGateway.createContext(),
  ): Promise<{ text: string; model: string }> {
    const inputBudget = modelGateway.getInputTokenBudget({
      systemPrompt: prompt,
      userMessage: '',
      task: '生成用户要求的简体中文书籍分析内容。',
      maxTokens: 8000,
    }, modelContext);
    if (inputBudget !== null && inputBudget < 64) {
      throw new ModelGatewayError('当前模型上下文窗口不足以执行摘要，请增大上下文窗口或降低最大输出长度', 422);
    }
    const chunks = this.chunkContent(content, inputBudget ?? undefined);

    if (chunks.length === 1) {
      return this.callLLM(prompt, chunks[0], 8000, modelContext);
    }

    // Multi-chunk: summarize each chunk, then merge
    console.log(`  [Summary] Content split into ${chunks.length} chunks`);
    const chunkSummaries: string[] = [];
    let modelUsed = '';

    for (let i = 0; i < chunks.length; i++) {
      console.log(`  [Summary] Summarizing chunk ${i + 1}/${chunks.length}...`);
      const result = await this.callLLM(CHUNK_SUMMARY_PROMPT, chunks[i], 4000, modelContext);
      chunkSummaries.push(result.text);
      modelUsed = result.model;
    }

    const reduced = await this.reduceSummariesToFit(chunkSummaries, modelContext);
    const mergedInput = reduced.map((s, i) => `### 第${i + 1}部分\n${s}`).join('\n\n');
    const result = await this.callLLM(MERGE_CHUNK_SUMMARIES_PROMPT, mergedInput, 8000, modelContext);
    return { text: result.text, model: result.model || modelUsed };
  }

  private async reduceSummariesToFit(
    initial: string[],
    modelContext: ModelExecutionContext,
  ): Promise<string[]> {
    const mergeBudget = modelGateway.getInputTokenBudget({
      systemPrompt: MERGE_CHUNK_SUMMARIES_PROMPT,
      userMessage: '',
      task: '生成用户要求的简体中文书籍分析内容。',
      maxTokens: 8000,
    }, modelContext);
    if (mergeBudget === null) return initial;

    let summaries = initial;
    for (let level = 0; level < 12; level += 1) {
      const combined = summaries.map((summary, index) => `### 第${index + 1}部分\n${summary}`).join('\n\n');
      if (textFitsTokenBudget(combined, mergeBudget)) return summaries;

      const groups: string[][] = [];
      let current: string[] = [];
      for (const summary of summaries) {
        const candidate = [...current, summary]
          .map((item, index) => `### 第${index + 1}部分\n${item}`)
          .join('\n\n');
        if (current.length > 0 && !textFitsTokenBudget(candidate, mergeBudget)) {
          groups.push(current);
          current = [summary];
        } else {
          current.push(summary);
        }
      }
      if (current.length > 0) groups.push(current);

      const next: string[] = [];
      for (const group of groups) {
        const groupInput = group.map((item, index) => `### 第${index + 1}部分\n${item}`).join('\n\n');
        const result = await this.callLLM(
          CHUNK_SUMMARY_PROMPT,
          groupInput,
          3000,
          modelContext,
        );
        next.push(result.text);
      }
      summaries = next;
    }
    throw new Error('摘要层级过多，无法在当前本地模型上下文中完成归并');
  }

  /**
   * Get all summaries for a book
   */
  getSummaries(bookId: number): SummaryRecord[] {
    return db.prepare(
      'SELECT * FROM book_summaries WHERE book_id = ? ORDER BY summary_type DESC, page_start ASC'
    ).all(bookId) as SummaryRecord[];
  }

  /**
   * Get book-level summary
   */
  getBookSummary(bookId: number): SummaryRecord | undefined {
    return db.prepare(
      "SELECT * FROM book_summaries WHERE book_id = ? AND summary_type = 'book'"
    ).get(bookId) as SummaryRecord | undefined;
  }

  /**
   * Get chapter summary
   */
  getChapterSummary(bookId: number, chapterId: string): SummaryRecord | undefined {
    return db.prepare(
      "SELECT * FROM book_summaries WHERE book_id = ? AND summary_type = 'chapter' AND chapter_id = ?"
    ).get(bookId, chapterId) as SummaryRecord | undefined;
  }

  /**
   * Generate a single chapter summary
   */
  async generateChapterSummary(
    bookId: number,
    chapterId: string,
    modelContext?: ModelExecutionContext,
  ): Promise<SummaryRecord> {
    assertBookTextAvailable(bookId);
    const executionContext = modelContext || modelGateway.createContext();
    const ranges = this.calculateChapterRanges(bookId);
    const chapter = ranges.find(r => r.id === chapterId);
    if (!chapter) throw new Error(`章节 ${chapterId} 不存在`);

    // Upsert pending record
    db.prepare(`
      INSERT INTO book_summaries (book_id, summary_type, chapter_id, chapter_title, page_start, page_end, status)
      VALUES (?, 'chapter', ?, ?, ?, ?, 'generating')
      ON CONFLICT(book_id, summary_type, chapter_id) DO UPDATE SET
        status = 'generating', error_message = NULL, updated_at = CURRENT_TIMESTAMP
    `).run(bookId, chapter.id, chapter.title, chapter.pageStart, chapter.pageEnd);

    try {
      console.log(`[Summary] Generating chapter summary: "${chapter.title}" (p.${chapter.pageStart}-${chapter.pageEnd})`);
      const content = this.gatherChapterContent(bookId, chapter.pageStart, chapter.pageEnd);

      if (!content.trim()) {
        throw new Error('没有找到可用于生成摘要的章节内容');
      }

      const { text, model } = await this.summarizeContent(content, CHAPTER_SUMMARY_PROMPT, executionContext);

      db.prepare(`
        UPDATE book_summaries SET summary_text = ?, status = 'completed', model_used = ?, updated_at = CURRENT_TIMESTAMP
        WHERE book_id = ? AND summary_type = 'chapter' AND chapter_id = ?
      `).run(text, model, bookId, chapter.id);

      console.log(`[Summary] Chapter summary completed: "${chapter.title}"`);
      return this.getChapterSummary(bookId, chapter.id)!;
    } catch (error: any) {
      db.prepare(`
        UPDATE book_summaries SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE book_id = ? AND summary_type = 'chapter' AND chapter_id = ?
      `).run(error.message, bookId, chapter.id);
      throw error;
    }
  }

  /**
   * Generate book-level summary
   */
  async generateBookSummary(
    bookId: number,
    modelContext?: ModelExecutionContext,
  ): Promise<SummaryRecord> {
    assertBookTextAvailable(bookId);
    const executionContext = modelContext || modelGateway.createContext();
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId) as any;
    if (!book) throw new Error('书籍不存在');

    // Upsert pending record
    db.prepare(`
      INSERT INTO book_summaries (book_id, summary_type, chapter_id, page_start, page_end, status)
      VALUES (?, 'book', NULL, 1, ?, 'generating')
      ON CONFLICT(book_id, summary_type, chapter_id) DO UPDATE SET
        status = 'generating', error_message = NULL, updated_at = CURRENT_TIMESTAMP
    `).run(bookId, book.total_pages);

    try {
      // Check if chapter summaries exist — synthesize from them if so
      const chapterSummaries = db.prepare(
        "SELECT * FROM book_summaries WHERE book_id = ? AND summary_type = 'chapter' AND status = 'completed' ORDER BY page_start"
      ).all(bookId) as SummaryRecord[];

      let text: string;
      let model: string;

      if (chapterSummaries.length > 0) {
        console.log(`[Summary] Synthesizing book summary from ${chapterSummaries.length} chapter summaries`);
        const input = chapterSummaries.map(s =>
          `### ${s.chapter_title || 'Untitled'} (p.${s.page_start}-${s.page_end})\n${s.summary_text}`
        ).join('\n\n');
        const result = await this.summarizeContent(input, BOOK_SUMMARY_FROM_CHAPTERS_PROMPT, executionContext);
        text = result.text;
        model = result.model;
      } else {
        console.log(`[Summary] Generating book summary directly from content`);
        const content = this.gatherChapterContent(bookId, 1, book.total_pages);
        if (!content.trim()) {
          throw new Error('没有找到可用于生成摘要的全书内容');
        }
        const result = await this.summarizeContent(content, BOOK_SUMMARY_DIRECT_PROMPT, executionContext);
        text = result.text;
        model = result.model;
      }

      db.prepare(`
        UPDATE book_summaries SET summary_text = ?, status = 'completed', model_used = ?, updated_at = CURRENT_TIMESTAMP
        WHERE book_id = ? AND summary_type = 'book' AND chapter_id IS NULL
      `).run(text, model, bookId);

      console.log(`[Summary] Book summary completed`);
      return this.getBookSummary(bookId)!;
    } catch (error: any) {
      db.prepare(`
        UPDATE book_summaries SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE book_id = ? AND summary_type = 'book' AND chapter_id IS NULL
      `).run(error.message, bookId);
      throw error;
    }
  }

  /**
   * Delete all summaries for a book
   */
  deleteSummaries(bookId: number): void {
    db.prepare('DELETE FROM book_summaries WHERE book_id = ?').run(bookId);
  }
}

export const summaryService = new SummaryService();
