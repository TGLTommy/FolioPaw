import assert from 'node:assert/strict';
import { beforeAll, describe, test } from 'vitest';
import { db, initDatabase } from '../config/database';
import { AiChatService } from './ai-chat.service';
import { bookAiContextService, type BookAiContext } from './book-ai-context.service';
import { estimateTokenCount } from './model-context-budget.service';
import {
  modelGateway,
  type ModelExecutionContext,
  type ModelRequest,
} from './model-gateway.service';
import { MindmapService } from './mindmap.service';
import { selectReadingGuidePages } from './reading-guide.service';
import { SummaryService, summaryService } from './summary.service';
import { translateText, type TranslationConfig } from './translation.service';

beforeAll(() => initDatabase());

describe.sequential('local model context strategies', () => {
  test('summary recursively reduces chunk summaries until the final merge fits', async () => {
    const service = new SummaryService();
    const context = makeModelContext();
    const originalBudget = modelGateway.getInputTokenBudget;
    const originalCall = modelGateway.call;
    const captured: ModelRequest[] = [];
    try {
      (modelGateway as any).getInputTokenBudget = () => 100;
      (modelGateway as any).call = async (request: ModelRequest) => {
        captured.push(request);
        return {
          text: `要点${captured.length}`,
          model: 'qwen3.5:4b',
          providerType: 'ollama',
          configId: context.config.id,
          configRevision: 1,
          elapsedMs: 1,
        };
      };
      const content = '超长章节内容'.repeat(300);
      const initialChunks = service.chunkContent(content, 100).length;
      const result = await service.summarizeContent(content, '生成摘要', context);

      assert.equal(result.model, 'qwen3.5:4b');
      assert.ok(initialChunks > 2);
      assert.ok(captured.length > initialChunks + 1, 'expected at least one recursive reduction call');
      assert.equal(captured.every((request) => estimateTokenCount(request.userMessage) <= 100), true);
      assert.equal(captured.every((request) => request.systemPrompt?.includes('简体中文')), true);
    } finally {
      (modelGateway as any).getInputTokenBudget = originalBudget;
      (modelGateway as any).call = originalCall;
    }
  });

  test('plain-text translation splits oversized input and preserves chunk order', async () => {
    const context = makeModelContext();
    const config: TranslationConfig = {
      id: context.config.id,
      apiUrl: context.config.baseUrl || '',
      apiKey: '',
      model: context.config.model,
      sourceLang: 'en',
      targetLang: 'zh',
      mode: 'normal',
      modelContext: context,
    };
    const originalBudget = modelGateway.getInputTokenBudget;
    const originalCall = modelGateway.call;
    const inputs: string[] = [];
    const prompts: string[] = [];
    try {
      (modelGateway as any).getInputTokenBudget = () => 80;
      (modelGateway as any).call = async (request: ModelRequest) => {
        inputs.push(request.userMessage);
        prompts.push(request.systemPrompt || '');
        return {
          text: `译文${inputs.length}`,
          model: 'qwen3.5:4b',
          providerType: 'ollama',
          configId: context.config.id,
          configRevision: 1,
          elapsedMs: 1,
        };
      };
      const translated = await translateText('translation source '.repeat(120), config);
      assert.ok(inputs.length > 1);
      assert.equal(inputs.every((input) => estimateTokenCount(input) <= 80), true);
      assert.equal(prompts.every((prompt) => prompt.includes('简体中文')), true);
      assert.equal(
        translated,
        inputs.map((_input, index) => `译文${index + 1}`).join('\n\n'),
      );
    } finally {
      (modelGateway as any).getInputTokenBudget = originalBudget;
      (modelGateway as any).call = originalCall;
    }
  });

  test('reading-guide sampling covers early, middle, and late chapters evenly', () => {
    const toc = Array.from({ length: 40 }, (_value, index) => ({
      title: `Chapter ${index + 1}`,
      pageNumber: 10 + index * 24,
      depth: 0,
    }));
    const pages = selectReadingGuidePages(1000, toc);
    assert.equal(pages.includes(1), true);
    assert.equal(pages.includes(1000), true);
    assert.equal(pages.some((page) => page >= 450 && page <= 550), true);
    assert.equal(pages.some((page) => page >= 900 && page < 996), true);
    assert.ok(pages.length < 90, 'large books should be sampled rather than prefixed wholesale');
  });

  test('mindmap creates an intermediate summary when raw chapter text exceeds the budget', async () => {
    const service = new MindmapService();
    const context = makeModelContext();
    const bookId = insertTextBook('mindmap-context-test.epub', 'Mindmap Context Test');
    const originalRanges = summaryService.calculateChapterRanges;
    const originalGather = summaryService.gatherChapterContent;
    const originalSummarize = summaryService.summarizeContent;
    const originalCallLLM = summaryService.callLLM;
    const originalBudget = modelGateway.getInputTokenBudget;
    let intermediateCalls = 0;
    try {
      (summaryService as any).calculateChapterRanges = () => [{
        id: 'chapter-1', title: '第一章', pageStart: 1, pageEnd: 1, isContent: true,
      }];
      (summaryService as any).gatherChapterContent = () => '很长的章节正文'.repeat(300);
      (summaryService as any).summarizeContent = async () => {
        intermediateCalls += 1;
        return { text: '中间摘要：核心结构与概念', model: 'qwen3.5:4b' };
      };
      (summaryService as any).callLLM = async (prompt: string, input: string) => {
        assert.match(prompt, /简体中文/);
        assert.match(input, /中间摘要/);
        return {
          text: '{"title":"核心","children":[{"label":"主题","children":[{"label":"概念"}]}]}',
          model: 'qwen3.5:4b',
        };
      };
      (modelGateway as any).getInputTokenBudget = () => 600;

      const record = await service.generateMindmap(bookId, 'chapter-1', context);
      assert.equal(intermediateCalls, 1);
      assert.equal(record.status, 'completed');
      assert.match(record.svg_content || '', /<svg/);
    } finally {
      (summaryService as any).calculateChapterRanges = originalRanges;
      (summaryService as any).gatherChapterContent = originalGather;
      (summaryService as any).summarizeContent = originalSummarize;
      (summaryService as any).callLLM = originalCallLLM;
      (modelGateway as any).getInputTokenBudget = originalBudget;
    }
  });

  test('AI chat keeps the question and current page while dropping lower-priority retrieval', async () => {
    const service = new AiChatService();
    const context = makeModelContext();
    const originalBuild = bookAiContextService.buildContext;
    const originalCreate = modelGateway.createContext;
    const originalBudget = modelGateway.getInputTokenBudget;
    const originalCall = modelGateway.call;
    let captured: ModelRequest | null = null;
    try {
      const aiContext: BookAiContext = {
        book: {
          id: 1,
          original_name: 'Context Book',
          file_type: 'epub',
          total_pages: 100,
        },
        author: 'Author',
        contextText: [
          '# Book\nTitle: Context Book\nCurrent page: 10 / 100',
          '# Current chapter\nChapter One (p.1-20)',
          `## Current page [p.10]\n${'当前页'.repeat(20)}`,
          `## Adjacent context [p.9]\n${'相邻页'.repeat(30)}`,
          `## Full-book search result [p.50]\n${'检索片段'.repeat(60)}`,
        ].join('\n\n---\n\n'),
        sources: [
          { pageNumber: 10, reason: 'current' },
          { pageNumber: 9, reason: 'adjacent' },
          { pageNumber: 50, reason: 'search' },
        ],
      };
      (bookAiContextService as any).buildContext = () => aiContext;
      (modelGateway as any).createContext = () => context;
      (modelGateway as any).getInputTokenBudget = () => 260;
      (modelGateway as any).call = async (request: ModelRequest) => {
        captured = request;
        return {
          text: '回答',
          model: 'qwen3.5:4b',
          providerType: 'ollama',
          configId: context.config.id,
          configRevision: 1,
          elapsedMs: 1,
        };
      };

      const response = await service.chat({
        bookId: 1,
        pageNumber: 10,
        question: '当前页的核心观点是什么？',
        conversationHistory: [{ role: 'user', content: '很早以前的问题'.repeat(30) }],
      });
      assert.ok(captured);
      assert.match((captured as ModelRequest).userMessage, /当前页的核心观点是什么/);
      assert.match((captured as ModelRequest).systemPrompt || '', /Current page \[p\.10\]/);
      assert.doesNotMatch((captured as ModelRequest).systemPrompt || '', /Full-book search result/);
      assert.match((captured as ModelRequest).systemPrompt || '', /所有回答必须使用.*简体中文/);
      assert.deepEqual(response.context.sources, [{ pageNumber: 10, reason: 'current' }]);
    } finally {
      (bookAiContextService as any).buildContext = originalBuild;
      (modelGateway as any).createContext = originalCreate;
      (modelGateway as any).getInputTokenBudget = originalBudget;
      (modelGateway as any).call = originalCall;
    }
  });
});

function makeModelContext(): ModelExecutionContext {
  return {
    config: {
      id: 900,
      name: 'Local test model',
      providerType: 'ollama',
      model: 'qwen3.5:4b',
      baseUrl: 'http://ollama:11434',
      apiKey: null,
      contextWindow: 32768,
      managedBy: null,
      timeoutMs: 1800000,
      maxConcurrency: 1,
      isActive: true,
      revision: 1,
      testStatus: 'success',
      testedRevision: 1,
      lastTestMessage: 'ok',
      lastTestStatusCode: null,
      lastTestResponseMs: 1,
      lastTestedAt: '2026-01-01 00:00:00',
      createdAt: '2026-01-01 00:00:00',
      updatedAt: '2026-01-01 00:00:00',
    },
  };
}

function insertTextBook(filename: string, name: string): number {
  const result = db.prepare(`
    INSERT INTO books (
      filename, original_name, file_path, file_type, file_size, total_pages, user_id
    ) VALUES (?, ?, ?, 'epub', 100, 1, 1)
  `).run(filename, name, `/tmp/${filename}`);
  const bookId = Number(result.lastInsertRowid);
  db.prepare(`
    INSERT INTO pages (book_id, page_number, original_text)
    VALUES (?, 1, 'chapter text')
  `).run(bookId);
  return bookId;
}
