import { Router } from 'express';
import { aiChatService, ChatContext } from '../services/ai-chat.service';
import type { AiChatIntent } from '../services/book-ai-context.service';
import { assertBookAccess } from '../services/book.service';
import { getErrorMessage } from '../utils/errors';
import { assertBookTextAvailable } from '../services/book-text-capability.service';
import { modelGateway } from '../services/model-gateway.service';

const router = Router();
const CHAT_INTENTS = new Set<AiChatIntent>(['qa', 'summarize_page', 'explain_concepts', 'translate_selection']);

function parseIntent(value: unknown): AiChatIntent | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    return typeof value === 'string' && CHAT_INTENTS.has(value as AiChatIntent)
        ? value as AiChatIntent
        : undefined;
}

/**
 * POST /api/ai/chat
 * Send a chat message to the AI assistant
 */
router.post('/chat', async (req, res, next) => {
    try {
        const { bookId, pageNumber, selectedText, question, conversationHistory, intent } = req.body;

        // Validate required fields
        if (!bookId || typeof bookId !== 'number') {
            return res.status(400).json({ error: 'bookId 为必填项且必须是数字' });
        }

        if (!pageNumber || typeof pageNumber !== 'number') {
            return res.status(400).json({ error: 'pageNumber 为必填项且必须是数字' });
        }

        if (!question || typeof question !== 'string' || question.trim() === '') {
            return res.status(400).json({ error: 'question 为必填项且不能为空' });
        }
        if (intent !== undefined && !parseIntent(intent)) {
            return res.status(400).json({ error: 'intent 参数无效' });
        }
        assertBookAccess(req.userId!, bookId);
        assertBookTextAvailable(bookId);

        const context: ChatContext = {
            bookId,
            pageNumber,
            selectedText: selectedText || undefined,
            question: question.trim(),
            intent: parseIntent(intent),
            conversationHistory: conversationHistory || [],
        };

        const response = await aiChatService.chat(context);

        res.json({
            success: true,
            data: response,
        });
    } catch (error: unknown) {
        const message = getErrorMessage(error);

        // Return appropriate error status
        if (message.includes('不存在') || message.includes('未找到')) {
            return res.status(404).json({ error: message });
        }
        if (message.includes('尚未配置')) {
            return res.status(503).json({ error: message });
        }

        next(error);
    }
});

/**
 * POST /api/ai/chat/stream
 * Send a chat message to the AI assistant with streaming response
 */
router.post('/chat/stream', async (req, res, next) => {
    try {
        const { bookId, pageNumber, selectedText, question, conversationHistory, intent } = req.body;

        // Validate required fields
        if (!bookId || typeof bookId !== 'number') {
            return res.status(400).json({ error: 'bookId 为必填项且必须是数字' });
        }

        if (!pageNumber || typeof pageNumber !== 'number') {
            return res.status(400).json({ error: 'pageNumber 为必填项且必须是数字' });
        }

        if (!question || typeof question !== 'string' || question.trim() === '') {
            return res.status(400).json({ error: 'question 为必填项且不能为空' });
        }
        if (intent !== undefined && !parseIntent(intent)) {
            return res.status(400).json({ error: 'intent 参数无效' });
        }
        assertBookAccess(req.userId!, bookId);
        assertBookTextAvailable(bookId);

        const context: ChatContext = {
            bookId,
            pageNumber,
            selectedText: selectedText || undefined,
            question: question.trim(),
            intent: parseIntent(intent),
            conversationHistory: conversationHistory || [],
        };

        // Resolve availability before sending SSE headers so a preparing local
        // model can return a real HTTP 503 with its progress message.
        modelGateway.createContext();

        // Set up SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
        res.flushHeaders();

        // Stream the response
        for await (const event of aiChatService.chatStream(context)) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        // Send done signal
        res.write(`data: [DONE]\n\n`);
        res.end();
    } catch (error: unknown) {
        const message = getErrorMessage(error);

        // If headers already sent, we can't send error response
        if (res.headersSent) {
            res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
            res.end();
            return;
        }

        // Return appropriate error status
        if (message.includes('不存在') || message.includes('未找到')) {
            return res.status(404).json({ error: message });
        }
        if (message.includes('尚未配置')) {
            return res.status(503).json({ error: message });
        }

        next(error);
    }
});

export default router;
