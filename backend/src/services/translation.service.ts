import { db } from '../config/database';
import { cacheService } from './cache.service';
import { deduplicationService } from './deduplication.service';
import { assertBookAccess, getAdjacentPageContext } from './book.service';
import { ModelGatewayError, modelGateway, type ModelExecutionContext } from './model-gateway.service';
import {
  assertBookTextAvailable,
  isMeaningfulExtractedText,
} from './book-text-capability.service';
import {
  splitTextByTokenBudget,
  textFitsTokenBudget,
} from './model-context-budget.service';

export interface TranslationConfig {
  id?: number;
  apiUrl: string;
  apiKey: string;
  model: string;
  sourceLang: string;
  targetLang: string;
  mode: 'normal' | 'literary' | 'technical';
  modelContext: ModelExecutionContext;
}

export interface TranslationResult {
  translatedText: string;
  cacheSource: 'memory' | 'database' | 'api' | 'skipped';
  configId: number;
  processingTimeMs: number;
  cachedAt?: Date;
}

export interface TranslationPageBatchResult {
  page: number;
  status: 'translated' | 'memory' | 'database' | 'skipped' | 'failed';
  translatedText: string | null;
  cacheSource: TranslationResult['cacheSource'] | 'error';
  configId: number;
  processingTimeMs: number;
  cachedAt?: Date;
  error: string | null;
}

interface PageRow {
  id: number;
  book_id: number;
  page_number: number;
  original_text: string;
  translated_text: string | null;
  translation_status: string;
}

interface PendingPage {
  page: PageRow;
  pageHash: string;
  startedAt: number;
}

interface ParsedTranslationPage {
  pageNumber: number;
  translatedText: string;
}

interface HtmlTextSegment {
  id: string;
  text: string;
}

interface HtmlTextToken {
  type: 'text';
  value: string;
  segmentId?: string;
  leadingWhitespace?: string;
  trailingWhitespace?: string;
}

interface HtmlTagToken {
  type: 'tag';
  value: string;
}

type HtmlToken = HtmlTextToken | HtmlTagToken;

interface HtmlPagePayload {
  pending: PendingPage;
  tokens: HtmlToken[];
  segments: HtmlTextSegment[];
}

interface ParsedHtmlSegment {
  id: string;
  translatedText: string;
}

interface ParsedHtmlSegmentPage {
  pageNumber: number;
  segments: ParsedHtmlSegment[];
}

export interface TranslatePageOptions {
  forceRetranslate?: boolean;
  skipIfTranslated?: boolean;
  modelConfigId?: number;
  userId: number;
}

export async function getActiveTranslationConfig(): Promise<TranslationConfig | null> {
  const modelContext = modelGateway.createContext();
  const modelConfig = modelContext.config;
  return {
    id: modelConfig.id,
    apiUrl: modelConfig.baseUrl || '',
    apiKey: '',
    model: modelConfig.model,
    sourceLang: process.env.TRANSLATION_SOURCE_LANG || 'en',
    targetLang: process.env.TRANSLATION_TARGET_LANG || 'zh',
    mode: (process.env.TRANSLATION_MODE as 'normal' | 'literary' | 'technical') || 'normal',
    modelContext,
  };
}

export function getTranslationBatchSize(): number {
  const parsed = Number.parseInt(process.env.TRANSLATION_BATCH_SIZE || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 3;
  return Math.min(parsed, 5);
}

export function getTranslationFingerprint(config: TranslationConfig): string {
  const promptVersion = process.env.TRANSLATION_PROMPT_VERSION || 'v2';
  return [
    promptVersion,
    modelGateway.getFingerprint(config.modelContext.config),
    config.sourceLang,
    config.targetLang,
    config.mode,
  ].join('|');
}

export async function translateText(
  text: string,
  config?: TranslationConfig | null,
  context?: { before?: string; after?: string }
): Promise<string> {
  if (!config) {
    const activeConfig = await getActiveTranslationConfig();
    if (!activeConfig) {
      throw new Error('未找到有效的翻译配置');
    }
    config = activeConfig;
  }

  const containsHTML = containsHtml(text);
  const systemPrompt = buildSinglePageSystemPrompt(config, containsHTML, Boolean(context?.before || context?.after));
  const userMessage = buildSinglePageUserMessage(text, context);
  const inputBudget = modelGateway.getInputTokenBudget({
    systemPrompt,
    userMessage: '',
    task: '按照系统要求把输入内容翻译为简体中文。',
    maxTokens: getTranslationMaxTokens(1),
  }, config.modelContext);

  if (inputBudget !== null && !textFitsTokenBudget(userMessage, inputBudget)) {
    if (containsHTML) {
      throw new ModelGatewayError('HTML 页面超过本地模型上下文限制，请使用保留标签的页面翻译流程', 422);
    }
    const plainPrompt = buildSinglePageSystemPrompt(config, false, false);
    const plainBudget = modelGateway.getInputTokenBudget({
      systemPrompt: plainPrompt,
      userMessage: '',
      task: '按照系统要求把输入内容翻译为简体中文。',
      maxTokens: getTranslationMaxTokens(1),
    }, config.modelContext) ?? inputBudget;
    if (plainBudget < 32) {
      throw new ModelGatewayError('当前模型上下文窗口不足以安全拆分翻译内容，请增大上下文窗口', 422);
    }
    const chunks = splitTextByTokenBudget(text, plainBudget);
    const translations: string[] = [];
    for (const chunk of chunks) translations.push(await translateText(chunk, config));
    return translations.join('\n\n');
  }

  try {
    const response = await modelGateway.call({
      systemPrompt,
      userMessage,
      task: '按照系统要求把输入内容翻译为简体中文。',
      maxTokens: getTranslationMaxTokens(1),
      timeoutMs: Number.parseInt(process.env.TRANSLATION_TIMEOUT_MS || '', 10) || undefined,
    }, config.modelContext);
    return response.text;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`翻译失败: ${message}`);
  }
}

export async function shouldSkipTranslation(
  pageHash: string,
  sourceLang: string,
  targetLang: string,
  forceRetranslate: boolean = false,
  translationFingerprint: string = 'legacy'
): Promise<boolean> {
  if (forceRetranslate || !pageHash) {
    return false;
  }

  return deduplicationService.isPageTranslated(pageHash, sourceLang, targetLang, translationFingerprint);
}

export async function translatePage(
  bookId: number,
  pageNumber: number,
  options: TranslatePageOptions,
): Promise<TranslationResult> {
  const [result] = await translatePages(bookId, [pageNumber], options);

  if (!result) {
    throw new Error('页面不存在');
  }

  if (result.status === 'failed') {
    throw new ModelGatewayError(result.error || '翻译失败', 502);
  }

  return {
    translatedText: result.translatedText || '',
    cacheSource: result.cacheSource as TranslationResult['cacheSource'],
    configId: result.configId,
    processingTimeMs: result.processingTimeMs,
    cachedAt: result.cachedAt,
  };
}

export async function translatePages(
  bookId: number,
  pageNumbers: number[],
  options: TranslatePageOptions,
): Promise<TranslationPageBatchResult[]> {
  const { forceRetranslate = false, skipIfTranslated = true, userId } = options;
  const normalizedPageNumbers = [...new Set(pageNumbers)]
    .filter((pageNumber) => Number.isFinite(pageNumber))
    .sort((a, b) => a - b);

  if (normalizedPageNumbers.length === 0) {
    return [];
  }

  assertBookAccess(userId, bookId);
  const textCapability = assertBookTextAvailable(bookId);

  const pages = getPageRows(bookId, normalizedPageNumbers);

  if (pages.length !== normalizedPageNumbers.length) {
    const found = new Set(pages.map((page) => page.page_number));
    const missing = normalizedPageNumbers.filter((pageNumber) => !found.has(pageNumber));
    throw new Error(`页面不存在: ${missing.join(', ')}`);
  }

  const results = new Map<number, TranslationPageBatchResult>();
  const pendingPages: PendingPage[] = [];
  let config: TranslationConfig | null = null;
  let fingerprint = '';

  for (const page of pages) {
    const startedAt = Date.now();

    if (textCapability.fileType === 'pdf' && !isMeaningfulExtractedText(page.original_text)) {
      db.prepare(`
        UPDATE pages
        SET translation_status = 'skipped', translated_text = NULL, page_hash = NULL,
            is_cached = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(page.id);
      results.set(page.page_number, {
        page: page.page_number,
        status: 'skipped',
        translatedText: null,
        cacheSource: 'skipped',
        configId: options.modelConfigId || 0,
        processingTimeMs: Date.now() - startedAt,
        error: null,
      });
      continue;
    }

    if (
      skipIfTranslated
      && page.translation_status === 'completed'
      && page.translated_text
      && !forceRetranslate
    ) {
      results.set(page.page_number, {
        page: page.page_number,
        status: 'skipped',
        translatedText: page.translated_text,
        cacheSource: 'skipped',
        configId: options.modelConfigId || 0,
        processingTimeMs: Date.now() - startedAt,
        error: null,
      });
      continue;
    }

    if (!config) {
      config = await getRequiredTranslationConfig(options.modelConfigId);
      fingerprint = getTranslationFingerprint(config);
    }
    const pageHash = deduplicationService.calculatePageHash(page.original_text);

    const cachedTranslation = !forceRetranslate
      ? await cacheService.getTranslation(pageHash, config.sourceLang, config.targetLang, fingerprint)
      : null;

    if (cachedTranslation) {
      const cacheSource = cachedTranslation.cachedAt === undefined ? 'memory' : 'database';
      persistCachedTranslation(page.id, pageHash, cachedTranslation.translatedText);

      results.set(page.page_number, {
        page: page.page_number,
        status: cacheSource,
        translatedText: cachedTranslation.translatedText,
        cacheSource,
        configId: config.id!,
        processingTimeMs: Date.now() - startedAt,
        cachedAt: cachedTranslation.cachedAt,
        error: null,
      });
      continue;
    }

    db.prepare('UPDATE pages SET translation_status = ? WHERE id = ?').run('translating', page.id);
    pendingPages.push({ page, pageHash, startedAt });
  }

  if (config) {
    const groups = chunkPendingPages(pendingPages, getTranslationBatchSize());
    for (const group of groups) {
      await translatePendingGroup(bookId, group, config, fingerprint, results);
    }
  }

  return normalizedPageNumbers.map((pageNumber) => results.get(pageNumber) || {
    page: pageNumber,
    status: 'failed',
    translatedText: null,
    cacheSource: 'error',
    configId: config?.id || options.modelConfigId || 0,
    processingTimeMs: 0,
    error: '页面未处理',
  });
}

async function translatePendingGroup(
  bookId: number,
  group: PendingPage[],
  config: TranslationConfig,
  fingerprint: string,
  results: Map<number, TranslationPageBatchResult>
): Promise<void> {
  try {
    const translatedByPage = await translateFreshPageGroup(bookId, group, config);

    for (const pending of group) {
      const translatedText = translatedByPage.get(pending.page.page_number);
      if (!translatedText) {
        throw new Error(`第 ${pending.page.page_number} 页缺少翻译结果`);
      }

      await persistFreshTranslation(pending.page.id, pending.pageHash, translatedText, config, fingerprint);
      results.set(pending.page.page_number, {
        page: pending.page.page_number,
        status: 'translated',
        translatedText,
        cacheSource: 'api',
        configId: config.id!,
        processingTimeMs: Date.now() - pending.startedAt,
        error: null,
      });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`批量翻译失败，降级为单页翻译: ${message}`);
    for (const pending of group) {
      await translatePendingPageFallback(bookId, pending, config, fingerprint, results);
    }
  }
}

async function translatePendingPageFallback(
  bookId: number,
  pending: PendingPage,
  config: TranslationConfig,
  fingerprint: string,
  results: Map<number, TranslationPageBatchResult>
): Promise<void> {
  try {
    const { prevContext, nextContext } = getAdjacentPageContext(bookId, pending.page.page_number);
    const translationContext = (prevContext || nextContext)
      ? { before: prevContext || undefined, after: nextContext || undefined }
      : undefined;

    let translatedText: string;
    if (containsHtml(pending.page.original_text)) {
      const translatedByPage = await translateHtmlPageGroupPreservingTags(bookId, [pending], config);
      translatedText = translatedByPage.get(pending.page.page_number) || '';
      if (!translatedText) {
        throw new Error(`第 ${pending.page.page_number} 页缺少翻译结果`);
      }
    } else {
      translatedText = await translateText(pending.page.original_text, config, translationContext);
    }
    validateHtmlIntegrity(pending.page.original_text, translatedText, pending.page.page_number);
    await persistFreshTranslation(pending.page.id, pending.pageHash, translatedText, config, fingerprint);

    results.set(pending.page.page_number, {
      page: pending.page.page_number,
      status: 'translated',
      translatedText,
      cacheSource: 'api',
      configId: config.id!,
      processingTimeMs: Date.now() - pending.startedAt,
      error: null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare('UPDATE pages SET translation_status = ? WHERE id = ?').run('failed', pending.page.id);
    results.set(pending.page.page_number, {
      page: pending.page.page_number,
      status: 'failed',
      translatedText: null,
      cacheSource: 'error',
      configId: config.id!,
      processingTimeMs: Date.now() - pending.startedAt,
      error: message,
    });
  }
}

async function translateFreshPageGroup(
  bookId: number,
  group: PendingPage[],
  config: TranslationConfig
): Promise<Map<number, string>> {
  const firstPage = group[0].page.page_number;
  const lastPage = group[group.length - 1].page.page_number;
  const containsHTML = group.some(({ page }) => containsHtml(page.original_text));
  if (containsHTML) {
    return translateHtmlPageGroupPreservingTags(bookId, group, config);
  }

  const { prevContext } = getAdjacentPageContext(bookId, firstPage);
  const { nextContext } = getAdjacentPageContext(bookId, lastPage);
  const systemPrompt = buildBatchSystemPrompt(config, containsHTML);
  const userMessage = buildBatchUserMessage(group, {
    before: prevContext || undefined,
    after: nextContext || undefined,
  });
  const inputBudget = modelGateway.getInputTokenBudget({
    systemPrompt,
    userMessage: '',
    task: '把标记的书籍页面翻译为简体中文，并只返回指定 JSON。',
    maxTokens: getTranslationMaxTokens(group.length),
    responseFormat: 'json',
  }, config.modelContext);
  if (inputBudget !== null && !textFitsTokenBudget(userMessage, inputBudget)) {
    if (group.length === 1) {
      const translated = await translateText(group[0].page.original_text, config);
      return new Map([[group[0].page.page_number, translated]]);
    }
    const midpoint = Math.ceil(group.length / 2);
    const left = await translateFreshPageGroup(bookId, group.slice(0, midpoint), config);
    const right = await translateFreshPageGroup(bookId, group.slice(midpoint), config);
    return new Map([...left, ...right]);
  }
  const retryCount = getTranslationRetryCount();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      const response = await modelGateway.call({
        systemPrompt,
        userMessage,
        task: '把标记的书籍页面翻译为简体中文，并只返回指定 JSON。',
        maxTokens: getTranslationMaxTokens(group.length),
        responseFormat: 'json',
        timeoutMs: Number.parseInt(process.env.TRANSLATION_TIMEOUT_MS || '', 10) || undefined,
      }, config.modelContext);

      const parsedPages = parseBatchTranslationResponse(response.text);
      const translatedByPage = validateBatchTranslations(group, parsedPages);
      return translatedByPage;
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < retryCount) {
        console.warn('小批量翻译结果校验失败，准备重试');
      }
    }
  }

  throw lastError || new Error('小批量翻译失败');
}

async function translateHtmlPageGroupPreservingTags(
  bookId: number,
  group: PendingPage[],
  config: TranslationConfig
): Promise<Map<number, string>> {
  const firstPage = group[0].page.page_number;
  const lastPage = group[group.length - 1].page.page_number;
  const { prevContext } = getAdjacentPageContext(bookId, firstPage);
  const { nextContext } = getAdjacentPageContext(bookId, lastPage);
  const payloads = buildHtmlPagePayloads(group);
  if (payloads.every((payload) => payload.segments.length === 0)) {
    return rebuildHtmlTranslations(payloads, []);
  }

  const systemPrompt = buildHtmlSegmentSystemPrompt(config);
  const userMessage = buildHtmlSegmentUserMessage(payloads, {
    before: prevContext || undefined,
    after: nextContext || undefined,
  });
  const inputBudget = modelGateway.getInputTokenBudget({
    systemPrompt,
    userMessage: '',
    task: '把提取出的 HTML 文本片段翻译为简体中文，并只返回指定 JSON。',
    maxTokens: getTranslationMaxTokens(group.length),
    responseFormat: 'json',
  }, config.modelContext);
  if (inputBudget !== null && !textFitsTokenBudget(userMessage, inputBudget)) {
    if (group.length > 1) {
      const midpoint = Math.ceil(group.length / 2);
      const left = await translateHtmlPageGroupPreservingTags(bookId, group.slice(0, midpoint), config);
      const right = await translateHtmlPageGroupPreservingTags(bookId, group.slice(midpoint), config);
      return new Map([...left, ...right]);
    }
    return translateHtmlSegmentsIndividually(payloads, config);
  }
  const retryCount = getTranslationRetryCount();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      const response = await modelGateway.call({
        systemPrompt,
        userMessage,
        task: '把提取出的 HTML 文本片段翻译为简体中文，并只返回指定 JSON。',
        maxTokens: getTranslationMaxTokens(group.length),
        responseFormat: 'json',
        timeoutMs: Number.parseInt(process.env.TRANSLATION_TIMEOUT_MS || '', 10) || undefined,
      }, config.modelContext);

      const parsedPages = parseHtmlSegmentTranslationResponse(response.text);
      const translatedByPage = rebuildHtmlTranslations(payloads, parsedPages);
      return translatedByPage;
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < retryCount) {
        console.warn('HTML 分段翻译结果校验失败，准备重试');
      }
    }
  }

  console.warn('HTML 分段翻译失败，降级为逐段翻译');
  try {
    return await translateHtmlSegmentsIndividually(payloads, config);
  } catch (fallbackError: any) {
    const originalMessage = lastError?.message || 'HTML 分段翻译失败';
    const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
    throw new Error(`${originalMessage}; 逐段兜底失败: ${fallbackMessage}`);
  }
}

async function translateHtmlSegmentsIndividually(
  payloads: HtmlPagePayload[],
  config: TranslationConfig
): Promise<Map<number, string>> {
  const pages: ParsedHtmlSegmentPage[] = [];

  for (const payload of payloads) {
    if (payload.segments.length === 0) continue;

    const segments: ParsedHtmlSegment[] = [];
    for (const segment of payload.segments) {
      const translatedText = await translateText(segment.text, config);
      if (!translatedText.trim()) {
        throw new Error(`第 ${payload.pending.page.page_number} 页的 HTML 文本片段 ${segment.id} 译文为空`);
      }
      segments.push({ id: segment.id, translatedText });
    }

    pages.push({
      pageNumber: payload.pending.page.page_number,
      segments,
    });
  }

  return rebuildHtmlTranslations(payloads, pages);
}

function buildSinglePageSystemPrompt(config: TranslationConfig, containsHTML: boolean, hasContext: boolean): string {
  const baseSystemPrompts = {
    normal: `你是一名专业翻译。请把以下内容从 ${config.sourceLang} 准确、自然地翻译为 ${config.targetLang}；目标语言为中文时必须使用简体中文。`,
    literary: `你是一名文学翻译。请把以下内容从 ${config.sourceLang} 翻译为 ${config.targetLang}，保留原文的文学风格、语气和艺术表达；目标语言为中文时必须使用简体中文。`,
    technical: `你是一名技术翻译。请把以下内容从 ${config.sourceLang} 准确翻译为 ${config.targetLang}，保证术语和事实准确；目标语言为中文时必须使用简体中文。`,
  };

  const htmlInstructions = containsHTML ? `

重要：文本包含 HTML 标记。你必须：
1. 完整保留所有 HTML 标签及其属性。
2. 只翻译标签之间的文本内容。
3. 不得删除、修改、重排或新增 HTML 标签。` : '';

  const contextInstructions = hasContext ? `

重要：这段文字属于更长的文档。相邻上下文只供参考，用于处理跨页衔接、术语和语气。
只输出 [TRANSLATE] 区域的译文。` : '';

  return `${baseSystemPrompts[config.mode]}${htmlInstructions}${contextInstructions}`;
}

function buildSinglePageUserMessage(text: string, context?: { before?: string; after?: string }): string {
  if (!context?.before && !context?.after) {
    return text;
  }

  const parts: string[] = [];
  if (context.before) {
    parts.push(`[CONTEXT BEFORE]\n${context.before}`);
  }
  parts.push(`[TRANSLATE]\n${text}`);
  if (context.after) {
    parts.push(`[CONTEXT AFTER]\n${context.after}`);
  }
  return parts.join('\n\n');
}

function buildBatchSystemPrompt(config: TranslationConfig, containsHTML: boolean): string {
  const baseSystemPrompts = {
    normal: `你是一名专业翻译。请把书籍页面从 ${config.sourceLang} 准确、自然地翻译为 ${config.targetLang}；目标语言为中文时必须使用简体中文。`,
    literary: `你是一名文学翻译。请把书籍页面从 ${config.sourceLang} 翻译为 ${config.targetLang}，保留风格、语气和艺术表达；目标语言为中文时必须使用简体中文。`,
    technical: `你是一名技术翻译。请把书籍页面从 ${config.sourceLang} 准确翻译为 ${config.targetLang}，并保持术语一致；目标语言为中文时必须使用简体中文。`,
  };

  const htmlInstructions = containsHTML ? `

HTML 规则：
1. 完整保留每个 HTML 标签及其属性和顺序。
2. 只翻译标签之间的文本内容。
3. 不得删除图片、链接、class、id 或行内样式。` : '';

  return `${baseSystemPrompts[config.mode]}

准确性规则：
1. 每个标记页面必须且只能翻译一次。
2. 不得总结、遗漏、合并或跨页移动内容。
3. 保留每个页面的边界：PAGE N 的内容只能出现在 PAGE N 的 translatedText 中。
4. 上下文区域只供参考，不得翻译到任何输出页面。
5. 句子跨页时，应自然翻译各页片段，同时把内容保留在原页面。
${htmlInstructions}

只返回以下固定结构的有效 JSON：
{"pages":[{"pageNumber":1,"translatedText":"..."}]}

不要使用 Markdown 代码围栏包裹 JSON。`;
}

function buildBatchUserMessage(group: PendingPage[], context: { before?: string; after?: string }): string {
  const parts: string[] = [];

  if (context.before) {
    parts.push(`[CONTEXT BEFORE - REFERENCE ONLY]\n${context.before}`);
  }

  for (const pending of group) {
    parts.push([
      `[PAGE ${pending.page.page_number} START]`,
      pending.page.original_text,
      `[PAGE ${pending.page.page_number} END]`,
    ].join('\n'));
  }

  if (context.after) {
    parts.push(`[CONTEXT AFTER - REFERENCE ONLY]\n${context.after}`);
  }

  return parts.join('\n\n');
}

function buildHtmlSegmentSystemPrompt(config: TranslationConfig): string {
  const baseSystemPrompts = {
    normal: `你是一名专业翻译。请把提取出的 HTML 文本片段从 ${config.sourceLang} 准确、自然地翻译为 ${config.targetLang}；目标语言为中文时必须使用简体中文。`,
    literary: `你是一名文学翻译。请把提取出的 HTML 文本片段从 ${config.sourceLang} 翻译为 ${config.targetLang}，保留风格、语气和艺术表达；目标语言为中文时必须使用简体中文。`,
    technical: `你是一名技术翻译。请把提取出的 HTML 文本片段从 ${config.sourceLang} 准确翻译为 ${config.targetLang}，并保持术语一致；目标语言为中文时必须使用简体中文。`,
  };

  return `${baseSystemPrompts[config.mode]}

输入是 JSON。HTML 标签已经移除，并会在翻译后由程序恢复。

规则：
1. 每个文本片段必须且只能翻译一次。
2. 完整保留每个 pageNumber 和文本片段 id。
3. 按输入顺序返回相同的页面和文本片段。
4. 不得新增、删除、合并、拆分或重命名文本片段。
5. 不得输出 HTML 标签、Markdown、注释或说明。
6. 上下文字段只供参考，不得作为译文输出。

只返回以下固定结构的有效 JSON：
{"pages":[{"pageNumber":1,"segments":[{"id":"p1s1","translatedText":"..."}]}]}`;
}

function buildHtmlSegmentUserMessage(payloads: HtmlPagePayload[], context: { before?: string; after?: string }): string {
  return JSON.stringify({
    contextBefore: context.before ? stripHtmlTags(context.before) : undefined,
    pages: payloads
      .filter((payload) => payload.segments.length > 0)
      .map((payload) => ({
        pageNumber: payload.pending.page.page_number,
        segments: payload.segments,
      })),
    contextAfter: context.after ? stripHtmlTags(context.after) : undefined,
  });
}

function buildHtmlPagePayloads(group: PendingPage[]): HtmlPagePayload[] {
  return group.map((pending) => {
    const tokens = tokenizeHtml(pending.page.original_text);
    const segments: HtmlTextSegment[] = [];
    let segmentIndex = 1;

    for (const token of tokens) {
      if (token.type !== 'text') {
        continue;
      }

      const textParts = splitOuterWhitespace(token.value);
      if (!textParts.body || !isTranslatableHtmlText(textParts.body)) {
        continue;
      }

      const id = `p${pending.page.page_number}s${segmentIndex}`;
      segmentIndex += 1;
      token.segmentId = id;
      token.leadingWhitespace = textParts.leading;
      token.trailingWhitespace = textParts.trailing;
      segments.push({ id, text: textParts.body });
    }

    return { pending, tokens, segments };
  });
}

function tokenizeHtml(text: string): HtmlToken[] {
  return text
    .split(/(<[^>]+>)/g)
    .filter((part) => part.length > 0)
    .map((part): HtmlToken => {
      if (/^<[^>]+>$/.test(part)) {
        return { type: 'tag', value: part };
      }
      return { type: 'text', value: part };
    });
}

function splitOuterWhitespace(text: string): { leading: string; body: string; trailing: string } {
  const leading = text.match(/^\s*/)?.[0] || '';
  const trailing = text.match(/\s*$/)?.[0] || '';
  const bodyStart = leading.length;
  const bodyEnd = text.length - trailing.length;
  const body = bodyEnd > bodyStart ? text.slice(bodyStart, bodyEnd) : '';
  return { leading, body, trailing };
}

function isTranslatableHtmlText(text: string): boolean {
  return /\p{L}/u.test(text);
}

function parseHtmlSegmentTranslationResponse(text: string): ParsedHtmlSegmentPage[] {
  const candidate = extractJsonCandidate(text);
  const parsed = JSON.parse(candidate) as unknown;
  const pages = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.pages)
      ? parsed.pages
      : null;

  if (!pages) {
  throw new Error('模型服务返回内容不是预期的 HTML 文本片段 JSON');
  }

  return pages.map((page) => {
    if (!isRecord(page) || !Array.isArray(page.segments)) {
      throw new Error('模型服务返回的 HTML 页面条目格式错误');
    }

    const pageNumber = Number(page.pageNumber);
    const segments = page.segments.map((segment) => {
      if (!isRecord(segment)) {
    throw new Error('模型服务返回的 HTML 文本片段条目格式错误');
      }

      return {
        id: typeof segment.id === 'string' ? segment.id : '',
        translatedText: typeof segment.translatedText === 'string' ? segment.translatedText : '',
      };
    });

    return { pageNumber, segments };
  });
}

function rebuildHtmlTranslations(
  payloads: HtmlPagePayload[],
  pages: ParsedHtmlSegmentPage[]
): Map<number, string> {
  const payloadByPage = new Map(
    payloads
      .filter((payload) => payload.segments.length > 0)
      .map((payload) => [payload.pending.page.page_number, payload])
  );
  const expectedPages = new Set(payloadByPage.keys());
  const parsedByPage = new Map<number, ParsedHtmlSegmentPage>();

  for (const page of pages) {
    if (!Number.isFinite(page.pageNumber) || !expectedPages.has(page.pageNumber)) {
      throw new Error(`模型服务返回了非请求页码: ${page.pageNumber}`);
    }
    if (parsedByPage.has(page.pageNumber)) {
      throw new Error(`模型服务重复返回第 ${page.pageNumber} 页`);
    }
    parsedByPage.set(page.pageNumber, page);
  }

  const translatedByPage = new Map<number, string>();
  for (const payload of payloads) {
    const pageNumber = payload.pending.page.page_number;
    if (payload.segments.length === 0) {
      validateHtmlIntegrity(payload.pending.page.original_text, payload.pending.page.original_text, pageNumber);
      translatedByPage.set(pageNumber, payload.pending.page.original_text);
      continue;
    }

    const parsedPage = parsedByPage.get(pageNumber);
    if (!parsedPage) {
      throw new Error(`模型服务缺少页码: ${pageNumber}`);
    }

    const expectedSegmentIds = new Set(payload.segments.map((segment) => segment.id));
    const translatedSegments = new Map<string, string>();

    for (const segment of parsedPage.segments) {
      if (!expectedSegmentIds.has(segment.id)) {
      throw new Error(`第 ${pageNumber} 页返回了未请求的 HTML 文本片段：${segment.id}`);
      }
      if (translatedSegments.has(segment.id)) {
      throw new Error(`第 ${pageNumber} 页重复返回 HTML 文本片段：${segment.id}`);
      }
      if (!segment.translatedText.trim()) {
      throw new Error(`第 ${pageNumber} 页的 HTML 文本片段 ${segment.id} 译文为空`);
      }
      translatedSegments.set(segment.id, segment.translatedText);
    }

    if (translatedSegments.size !== expectedSegmentIds.size) {
      const missing = [...expectedSegmentIds].filter((id) => !translatedSegments.has(id));
    throw new Error(`第 ${pageNumber} 页缺少 HTML 文本片段：${missing.join(', ')}`);
    }

    const translatedText = payload.tokens.map((token) => {
      if (token.type === 'tag' || !token.segmentId) {
        return token.value;
      }

      return [
        token.leadingWhitespace || '',
        translatedSegments.get(token.segmentId),
        token.trailingWhitespace || '',
      ].join('');
    }).join('');

    validateHtmlIntegrity(payload.pending.page.original_text, translatedText, pageNumber);
    translatedByPage.set(pageNumber, translatedText);
  }

  return translatedByPage;
}

function parseBatchTranslationResponse(text: string): ParsedTranslationPage[] {
  const candidate = extractJsonCandidate(text);
  const parsed = JSON.parse(candidate) as unknown;
  const pages = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.pages)
      ? parsed.pages
      : null;

  if (!pages) {
    throw new Error('模型服务返回内容不是预期的 pages JSON');
  }

  return pages.map((page) => {
    if (!isRecord(page)) {
      throw new Error('模型服务返回的页面条目格式错误');
    }

    const pageNumber = Number(page.pageNumber);
    const translatedText = typeof page.translatedText === 'string' ? page.translatedText : '';
    return { pageNumber, translatedText };
  });
}

function extractJsonCandidate(text: string): string {
  let candidate = text.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    candidate = fenced[1].trim();
  }

  if (
    (candidate.startsWith('{') && candidate.endsWith('}'))
    || (candidate.startsWith('[') && candidate.endsWith(']'))
  ) {
    return candidate;
  }

  const firstBracket = candidate.indexOf('[');
  const lastBracket = candidate.lastIndexOf(']');
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');

  if (firstBracket >= 0 && lastBracket > firstBracket && (firstBrace < 0 || firstBracket < firstBrace)) {
    return candidate.slice(firstBracket, lastBracket + 1);
  }

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return candidate.slice(firstBrace, lastBrace + 1);
  }

  return candidate;
}

function validateBatchTranslations(group: PendingPage[], pages: ParsedTranslationPage[]): Map<number, string> {
  const expectedPages = new Set(group.map(({ page }) => page.page_number));
  const translatedByPage = new Map<number, string>();

  for (const translatedPage of pages) {
    if (!Number.isFinite(translatedPage.pageNumber) || !expectedPages.has(translatedPage.pageNumber)) {
      throw new Error(`模型服务返回了非请求页码: ${translatedPage.pageNumber}`);
    }
    if (translatedByPage.has(translatedPage.pageNumber)) {
      throw new Error(`模型服务重复返回第 ${translatedPage.pageNumber} 页`);
    }
    if (!translatedPage.translatedText.trim()) {
      throw new Error(`第 ${translatedPage.pageNumber} 页译文为空`);
    }
    translatedByPage.set(translatedPage.pageNumber, translatedPage.translatedText);
  }

  if (translatedByPage.size !== expectedPages.size) {
    const missing = [...expectedPages].filter((pageNumber) => !translatedByPage.has(pageNumber));
    throw new Error(`模型服务缺少页码: ${missing.join(', ')}`);
  }

  for (const pending of group) {
    validateHtmlIntegrity(
      pending.page.original_text,
      translatedByPage.get(pending.page.page_number)!,
      pending.page.page_number
    );
  }

  return translatedByPage;
}

function validateHtmlIntegrity(originalText: string, translatedText: string, pageNumber: number): void {
  if (!containsHtml(originalText)) {
    return;
  }

  const originalTags = originalText.match(/<[^>]+>/g) || [];
  const translatedTags = translatedText.match(/<[^>]+>/g) || [];

  if (originalTags.length !== translatedTags.length) {
    throw new Error(`第 ${pageNumber} 页 HTML 标签数量不一致`);
  }

  for (let i = 0; i < originalTags.length; i++) {
    if (originalTags[i] !== translatedTags[i]) {
      throw new Error(`第 ${pageNumber} 页 HTML 标签结构不一致`);
    }
  }
}

function containsHtml(text: string): boolean {
  return /<[^>]+>/.test(text);
}

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

function chunkPendingPages(pages: PendingPage[], batchSize: number): PendingPage[][] {
  const groups: PendingPage[][] = [];
  let current: PendingPage[] = [];

  for (const pending of pages) {
    const previous = current[current.length - 1];
    const isConsecutive = !previous || pending.page.page_number === previous.page.page_number + 1;

    if (!isConsecutive || current.length >= batchSize) {
      groups.push(current);
      current = [];
    }

    current.push(pending);
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function getPageRows(bookId: number, pageNumbers: number[]): PageRow[] {
  const placeholders = pageNumbers.map(() => '?').join(', ');
  return db.prepare(`
    SELECT p.*
    FROM pages p
    INNER JOIN books b ON b.id = p.book_id
    WHERE p.book_id = ? AND p.page_number IN (${placeholders})
    ORDER BY p.page_number
  `).all(bookId, ...pageNumbers) as PageRow[];
}

async function getRequiredTranslationConfig(modelConfigId?: number): Promise<TranslationConfig> {
  let config: TranslationConfig | null;
  if (modelConfigId !== undefined) {
    const modelContext = modelGateway.createContext(modelConfigId);
    const modelConfig = modelContext.config;
    config = {
      id: modelConfig.id,
      apiUrl: modelConfig.baseUrl || '',
      apiKey: '',
      model: modelConfig.model,
      sourceLang: process.env.TRANSLATION_SOURCE_LANG || 'en',
      targetLang: process.env.TRANSLATION_TARGET_LANG || 'zh',
      mode: (process.env.TRANSLATION_MODE as 'normal' | 'literary' | 'technical') || 'normal',
      modelContext,
    };
  } else {
    config = await getActiveTranslationConfig();
  }
  if (!config || config.id === undefined || config.id === null) {
    throw new Error('未找到有效的翻译配置');
  }
  return config;
}

function getTranslationRetryCount(): number {
  const parsed = Number.parseInt(process.env.TRANSLATION_RETRY_COUNT || '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return Math.min(parsed, 3);
}

function getTranslationMaxTokens(pageCount: number): number {
  const parsed = Number.parseInt(process.env.TRANSLATION_MAX_TOKENS || '', 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return Math.min(12000, Math.max(4000, pageCount * 4000));
}

async function persistFreshTranslation(
  pageId: number,
  pageHash: string,
  translatedText: string,
  config: TranslationConfig,
  fingerprint: string
): Promise<void> {
  await cacheService.setTranslation(
    pageHash,
    config.sourceLang,
    config.targetLang,
    translatedText,
    fingerprint
  );

  db.prepare(`
    UPDATE pages
    SET translated_text = ?,
        translation_status = ?,
        page_hash = ?,
        is_cached = 0,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(translatedText, 'completed', pageHash, pageId);
}

function persistCachedTranslation(pageId: number, pageHash: string, translatedText: string): void {
  db.prepare(`
    UPDATE pages
    SET translated_text = ?,
        translation_status = ?,
        page_hash = ?,
        is_cached = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(translatedText, 'completed', pageHash, pageId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
