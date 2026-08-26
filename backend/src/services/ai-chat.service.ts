import { ModelGatewayError, modelGateway } from './model-gateway.service';
import {
    AiChatIntent,
    AiSource,
    BookAiContext,
    bookAiContextService,
} from './book-ai-context.service';
import {
    estimateTokenCount,
    textFitsTokenBudget,
    truncateTextToTokenBudget,
} from './model-context-budget.service';

export interface ChatContext {
    bookId: number;
    pageNumber: number;
    selectedText?: string;
    question: string;
    intent?: AiChatIntent;
    conversationHistory?: { role: 'user' | 'assistant'; content: string }[];
}

export interface ChatResponse {
    answer: string;
    context: {
        bookTitle: string;
        author: string;
        currentChapter?: string;
        currentPage: number;
        totalPages: number;
        basedOnSelection: boolean;
        sources: AiSource[];
    };
}

export type ChatStreamEvent =
    | { type: 'sources'; context: ChatResponse['context'] }
    | { type: 'content'; content: string };

const DEFAULT_INTENT: AiChatIntent = 'qa';

const INTENT_TASKS: Record<AiChatIntent, string> = {
    qa: '根据提供的书籍阅读上下文，用简体中文回答用户问题。',
    summarize_page: '只依据当前页内容，用简体中文总结本页。',
    explain_concepts: '结合当前页和附近上下文，用简体中文解释核心概念。',
    translate_selection: '把用户选中的书籍文本翻译为自然、准确的简体中文并进行必要说明。',
};

/**
 * AI Chat Service for EPUB/PDF-grounded reading Q&A.
 */
export class AiChatService {
    private buildSystemPrompt(context: BookAiContext, intent: AiChatIntent, contextText = context.contextText): string {
        const formatLabel = context.book.file_type.toUpperCase();
        const lines = [
            `你是 ${formatLabel} 图书《${context.book.original_name}》的 AI 阅读助手，作者为 ${context.author}。`,
            '',
            `以提供的 ${formatLabel} 内容为主要事实依据。`,
            '引用书中观点时，请在相关内容后以内联形式标注页码，例如「[第 12 页]」。',
            '如果提供的上下文不足，请先明确说明，再补充并清楚标记必要的外部知识。',
            '所有回答必须使用自然、准确的简体中文；表达应简洁、严谨。即使用户使用其他语言提问，也要用简体中文回答。',
            '',
        ];

        if (intent === 'summarize_page') {
            lines.push(
                '任务模式：总结当前页。',
                '以当前页为依据；只有在帮助理解上下文衔接时，才使用相邻页面或章节内容。',
                '按「核心内容」「关键概念」「本页作用」三个部分输出。',
            );
        } else if (intent === 'explain_concepts') {
            lines.push(
                '任务模式：解释核心概念。',
                '从当前页识别 3–6 个重要概念，用通俗中文解释，并说明它们与全书内容的关系。',
            );
        } else if (intent === 'translate_selection') {
            lines.push(
                '任务模式：翻译选中文本。',
                '把选中文本翻译为自然、严谨的简体中文，并保留必要的人名、术语、引用与格式线索。',
                '周边内容只用于消除歧义，不要总结整页。',
            );
        } else {
            lines.push(
                '任务模式：回答阅读问题。',
                '优先使用当前页和选中文本，其次使用相邻页或章节上下文，最后使用全书检索结果。',
            );
        }

        lines.push('', `[${formatLabel} 阅读上下文]`, contextText);
        return lines.join('\n');
    }

    private buildConversationPrompt(
        question: string,
        intent: AiChatIntent,
        conversationHistory?: { role: 'user' | 'assistant'; content: string }[]
    ): string {
        const parts: string[] = [];
        if (conversationHistory && conversationHistory.length > 0) {
            const recentHistory = conversationHistory.slice(-10);
            parts.push('[最近对话]');
            for (const msg of recentHistory) {
                parts.push(`${msg.role === 'assistant' ? '助手' : '用户'}：${msg.content}`);
            }
            parts.push('');
        }

        parts.push(`[任务类型]\n${intent}`);
        parts.push('');
        parts.push('[当前问题]');
        parts.push(question);
        return parts.join('\n');
    }

    private buildResponseContext(context: BookAiContext, pageNumber: number): ChatResponse['context'] {
        return {
            bookTitle: context.book.original_name,
            author: context.author,
            currentChapter: context.currentChapter?.title,
            currentPage: pageNumber,
            totalPages: context.book.total_pages,
            basedOnSelection: !!context.selectedText,
            sources: context.sources,
        };
    }

    private prepare(context: ChatContext): { aiContext: BookAiContext; intent: AiChatIntent; responseContext: ChatResponse['context'] } {
        const intent = context.intent || DEFAULT_INTENT;
        const aiContext = bookAiContextService.buildContext(
            context.bookId,
            context.pageNumber,
            context.question,
            context.selectedText,
            intent
        );

        return {
            aiContext,
            intent,
            responseContext: this.buildResponseContext(aiContext, context.pageNumber),
        };
    }

    private prepareModelRequest(
        context: ChatContext,
        aiContext: BookAiContext,
        intent: AiChatIntent,
        modelContext: ReturnType<typeof modelGateway.createContext>,
    ): { systemPrompt: string; userMessage: string; responseContext: ChatResponse['context'] } {
        const task = INTENT_TASKS[intent];
        const baseSystemPrompt = this.buildSystemPrompt(aiContext, intent, '');
        const baseUserMessage = this.buildConversationPrompt(context.question, intent);
        const combinedBudget = modelGateway.getInputTokenBudget({
            systemPrompt: baseSystemPrompt,
            userMessage: '',
            task,
            maxTokens: 2400,
        }, modelContext);

        if (combinedBudget === null) {
            return {
                systemPrompt: this.buildSystemPrompt(aiContext, intent),
                userMessage: this.buildConversationPrompt(context.question, intent, context.conversationHistory),
                responseContext: this.buildResponseContext(aiContext, context.pageNumber),
            };
        }

        const contextBudget = combinedBudget - estimateTokenCount(baseUserMessage);
        if (contextBudget < 128) {
            throw new ModelGatewayError('当前问题过长，无法同时保留当前页内容；请缩短问题或增大模型上下文窗口', 422);
        }
        const fittedSections: string[] = [];
        let usedTokens = 0;
        for (const section of aiContext.contextText.split(/\n\n---\n\n/)) {
            const sectionTokens = estimateTokenCount(section);
            if (usedTokens + sectionTokens <= contextBudget) {
                fittedSections.push(section);
                usedTokens += sectionTokens;
                continue;
            }
            const remaining = contextBudget - usedTokens;
            if (remaining >= 128) fittedSections.push(truncateTextToTokenBudget(section, remaining));
            break;
        }

        const fittedContextText = fittedSections.join('\n\n---\n\n');
        const systemPrompt = this.buildSystemPrompt(aiContext, intent, fittedContextText);
        const userBudget = modelGateway.getInputTokenBudget({
            systemPrompt,
            userMessage: '',
            task,
            maxTokens: 2400,
        }, modelContext) ?? estimateTokenCount(baseUserMessage);
        const history = context.conversationHistory?.slice(-10) || [];
        let selectedHistory: typeof history = [];
        for (let index = history.length - 1; index >= 0; index -= 1) {
            const candidate = [history[index], ...selectedHistory];
            const prompt = this.buildConversationPrompt(context.question, intent, candidate);
            if (!textFitsTokenBudget(prompt, userBudget)) break;
            selectedHistory = candidate;
        }

        const includedPages = new Set<number>();
        for (const match of fittedContextText.matchAll(/\[第\s*(\d+)\s*页\]|(?:\[p\.|\bp\.)(\d+)/g)) {
            includedPages.add(Number(match[1] || match[2]));
        }
        const responseContext = this.buildResponseContext(aiContext, context.pageNumber);
        responseContext.sources = responseContext.sources.filter((source) =>
            source.reason === 'selection'
            || source.pageNumber === context.pageNumber
            || includedPages.has(source.pageNumber)
        );
        return {
            systemPrompt,
            userMessage: this.buildConversationPrompt(context.question, intent, selectedHistory),
            responseContext,
        };
    }

    async chat(context: ChatContext): Promise<ChatResponse> {
        const { aiContext, intent } = this.prepare(context);

        try {
            const modelContext = modelGateway.createContext();
            const prepared = this.prepareModelRequest(context, aiContext, intent, modelContext);
            const response = await modelGateway.call({
                systemPrompt: prepared.systemPrompt,
                userMessage: prepared.userMessage,
                task: INTENT_TASKS[intent],
                maxTokens: 2400,
                timeoutMs: Number.parseInt(process.env.AI_CHAT_TIMEOUT_MS || '', 10) || undefined,
            }, modelContext);

            return {
                answer: response.text,
                context: prepared.responseContext,
            };
        } catch (error: unknown) {
            if (error instanceof ModelGatewayError) throw error;
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`AI 问答失败：${message}`);
        }
    }

    async *chatStream(context: ChatContext): AsyncGenerator<ChatStreamEvent> {
        const { aiContext, intent } = this.prepare(context);

        try {
            const modelContext = modelGateway.createContext();
            const prepared = this.prepareModelRequest(context, aiContext, intent, modelContext);
            yield { type: 'sources', context: prepared.responseContext };
            const response = await modelGateway.call({
                systemPrompt: prepared.systemPrompt,
                userMessage: prepared.userMessage,
                task: INTENT_TASKS[intent],
                maxTokens: 2400,
                timeoutMs: Number.parseInt(process.env.AI_CHAT_TIMEOUT_MS || '', 10) || undefined,
            }, modelContext);
            yield { type: 'content', content: response.text };
        } catch (error: unknown) {
            if (error instanceof ModelGatewayError) throw error;
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`AI 问答流式响应失败：${message}`);
        }
    }
}

export const aiChatService = new AiChatService();
