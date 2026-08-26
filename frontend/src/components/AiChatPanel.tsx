import { useState, useRef, useEffect } from 'react';
import { X, Loader, User, BookOpen, FileText, Sparkles, MessageSquare, Trash2, ArrowUp } from 'lucide-react';
import { aiApi, type AiChatIntent, type AiSource } from '../services/api';
import ReactMarkdown from 'react-markdown';
import { getErrorMessage } from '../utils/error';

interface Message {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
    sources?: AiSource[];
}

interface AiChatPanelProps {
    isOpen: boolean;
    onClose: () => void;
    bookId: number;
    bookTitle: string;
    currentPage: number;
    totalPages: number;
    selectedText?: string;
    onClearSelection?: () => void;
    onNavigateToPage?: (pageNumber: number) => void;
}

export default function AiChatPanel({
    isOpen,
    onClose,
    bookId,
    bookTitle,
    currentPage,
    totalPages,
    selectedText,
    onClearSelection,
    onNavigateToPage,
}: AiChatPanelProps) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [inputValue, setInputValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    // Scroll to bottom when messages change
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Focus input when panel opens
    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isOpen]);

    // Clear messages when book changes
    useEffect(() => {
        setMessages([]);
        setError(null);
    }, [bookId]);

    // Auto-resize textarea
    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + 'px';
        }
    }, [inputValue]);

    const sourceReasonLabel: Record<AiSource['reason'], string> = {
        selection: '选区',
        current: '当前页',
        adjacent: '前后页',
        chapter: '章节',
        search: '检索',
    };

    const updateLastAssistantMessage = (updater: (message: Message) => Message) => {
        setMessages((prev) => {
            const newMessages = [...prev];
            const lastIndex = newMessages.length - 1;
            if (lastIndex >= 0 && newMessages[lastIndex].role === 'assistant') {
                newMessages[lastIndex] = updater(newMessages[lastIndex]);
            }
            return newMessages;
        });
    };

    const handleSendMessage = async (overrideQuestion?: string, intent: AiChatIntent = 'qa') => {
        const question = (overrideQuestion ?? inputValue).trim();
        if (!question || isLoading) return;

        if (intent === 'translate_selection' && !selectedText?.trim()) {
            setError('请先在正文中选中需要翻译的文本。');
            inputRef.current?.focus();
            return;
        }

        const userMessage: Message = {
            role: 'user',
            content: question,
            timestamp: new Date(),
        };

        setMessages((prev) => [...prev, userMessage]);
        setInputValue('');
        setIsLoading(true);
        setError(null);

        try {
            // Limit conversation history to last 50 messages to prevent memory issues
            const MAX_HISTORY = 50;
            const recentMessages = messages.slice(-MAX_HISTORY);
            const conversationHistory = recentMessages.map((msg) => ({
                role: msg.role,
                content: msg.content,
            }));

            const assistantMessage: Message = {
                role: 'assistant',
                content: '',
                timestamp: new Date(),
            };
            setMessages((prev) => [...prev, assistantMessage]);

            let fullContent = '';
            const stream = aiApi.streamChat(
                bookId,
                currentPage,
                userMessage.content,
                selectedText,
                conversationHistory,
                intent
            );

            for await (const event of stream) {
                if (event.type === 'sources') {
                    updateLastAssistantMessage((message) => ({
                        ...message,
                        sources: event.context.sources,
                    }));
                    continue;
                }

                fullContent += event.content;
                updateLastAssistantMessage((message) => ({
                    ...message,
                    content: fullContent,
                }));
            }
        } catch (err: unknown) {
            console.error('AI Chat error:', err);
            setError(getErrorMessage(err, '获取回答失败'));
            setMessages((prev) => {
                const lastMessage = prev[prev.length - 1];
                if (lastMessage?.role === 'assistant' && !lastMessage.content) {
                    return prev.slice(0, -1);
                }
                return prev;
            });
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void handleSendMessage();
        }
    };

    const handleClearSelection = () => {
        onClearSelection?.();
    };

    const handleClearChat = () => {
        setMessages([]);
        setError(null);
    };

    const suggestions: Array<{ label: string; intent: AiChatIntent; disabled?: boolean; title?: string }> = [
        { label: '总结本页内容', intent: 'summarize_page' },
        { label: '解释核心概念', intent: 'explain_concepts' },
        {
            label: '翻译选中文本',
            intent: 'translate_selection',
            disabled: !selectedText?.trim(),
            title: selectedText?.trim() ? undefined : '请先选中正文文本',
        },
    ];

    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 transition-opacity"
                onClick={onClose}
            />

            {/* Panel */}
            <div
                ref={panelRef}
                className="fixed right-0 top-0 h-full w-[420px] max-w-[90vw] z-50 flex flex-col bg-white/95 dark:bg-gray-900/95 backdrop-blur-xl shadow-[-8px_0_30px_-10px_rgba(0,0,0,0.15)] animate-[slideIn_0.3s_ease-out]"
                style={{ animation: 'slideIn 0.3s ease-out' }}
            >
                {/* Header */}
                <div className="flex-shrink-0 px-5 pt-5 pb-4">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-violet-500/25">
                                <Sparkles size={18} className="text-white" />
                            </div>
                            <div>
                                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">AI 助手</h2>
                                <p className="text-xs text-gray-500 dark:text-gray-400">智能阅读伴侣</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-1">
                            {messages.length > 0 && (
                                <button
                                    onClick={handleClearChat}
                                    className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                                    title="清除对话"
                                >
                                    <Trash2 size={16} />
                                </button>
                            )}
                            <button
                                onClick={onClose}
                                className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                                aria-label="关闭"
                            >
                                <X size={18} />
                            </button>
                        </div>
                    </div>

                    {/* Context badge */}
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded-full text-xs">
                            <BookOpen size={12} />
                            <span className="max-w-[200px] truncate">{bookTitle}</span>
                        </span>
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded-full text-xs">
                            <FileText size={12} />
                            {currentPage} / {totalPages}
                        </span>
                    </div>
                </div>

                <div className="h-px bg-gradient-to-r from-transparent via-gray-200 dark:via-gray-700 to-transparent" />

                {/* Selected text indicator */}
                {selectedText && (
                    <div className="flex-shrink-0 mx-4 mt-3 mb-1">
                        <div className="relative bg-violet-50 dark:bg-violet-950/30 border border-violet-200/60 dark:border-violet-800/40 rounded-xl p-3">
                            <div className="flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5 text-violet-600 dark:text-violet-400 text-xs font-medium mb-1.5">
                                        <Sparkles size={11} />
                                        选中文本
                                    </div>
                                    <p className="text-xs text-violet-700 dark:text-violet-300 leading-relaxed line-clamp-2 italic">
                                        "{selectedText}"
                                    </p>
                                </div>
                                <button
                                    onClick={handleClearSelection}
                                    className="p-1 hover:bg-violet-200/50 dark:hover:bg-violet-800/50 rounded-md text-violet-400 dark:text-violet-500 transition-colors"
                                    title="清除选中"
                                >
                                    <X size={14} />
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Messages area */}
                <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5 scroll-smooth">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center px-6">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-100 to-indigo-100 dark:from-violet-900/30 dark:to-indigo-900/30 flex items-center justify-center mb-5">
                                <MessageSquare size={28} className="text-violet-500 dark:text-violet-400" />
                            </div>
                            <p className="text-base font-medium text-gray-800 dark:text-gray-200 mb-2">有什么想问的？</p>
                            <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                                我可以帮你解释概念、分析段落、<br />回答关于这本书的任何问题
                            </p>
                            <div className="mt-6 flex flex-wrap gap-2 justify-center">
                                {suggestions.map((suggestion) => (
                                    <button
                                        key={suggestion.intent}
                                        disabled={suggestion.disabled || isLoading}
                                        title={suggestion.title}
                                        onClick={() => {
                                            void handleSendMessage(suggestion.label, suggestion.intent);
                                        }}
                                        className="px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 hover:bg-violet-100 hover:text-violet-700 dark:hover:bg-violet-900/30 dark:hover:text-violet-400 rounded-full transition-colors border border-gray-200 dark:border-gray-700 hover:border-violet-300 dark:hover:border-violet-700 disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:bg-gray-100 disabled:hover:text-gray-600 dark:disabled:hover:bg-gray-800 dark:disabled:hover:text-gray-400"
                                    >
                                        {suggestion.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {messages.map((message, index) => (
                        <div
                            key={index}
                            className={`flex gap-3 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}
                        >
                            {/* Avatar */}
                            <div className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5 ${
                                message.role === 'user'
                                    ? 'bg-gray-800 dark:bg-gray-200 text-white dark:text-gray-800'
                                    : 'bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-sm shadow-violet-500/20'
                            }`}>
                                {message.role === 'user' ? <User size={14} /> : <Sparkles size={14} />}
                            </div>

                            {/* Message bubble */}
                            <div className={`flex-1 max-w-[85%] ${
                                message.role === 'user' ? 'flex justify-end' : ''
                            }`}>
                                <div className={`px-3.5 py-2.5 rounded-2xl ${
                                    message.role === 'user'
                                        ? 'bg-gray-800 dark:bg-gray-200 text-white dark:text-gray-900 rounded-tr-md'
                                        : 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-tl-md'
                                }`}>
                                    {message.role === 'user' ? (
                                        <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>
                                    ) : (
                                        <div>
                                            <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed
                                                prose-p:my-1.5 prose-p:leading-relaxed
                                                prose-headings:mt-3 prose-headings:mb-1.5 prose-headings:font-semibold
                                                prose-h3:text-sm prose-h4:text-sm
                                                prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5
                                                prose-strong:font-semibold prose-strong:text-inherit
                                                prose-code:bg-white/50 prose-code:dark:bg-gray-700 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:text-xs prose-code:font-mono
                                                prose-pre:bg-white/50 prose-pre:dark:bg-gray-700 prose-pre:p-3 prose-pre:rounded-xl prose-pre:overflow-x-auto
                                                prose-blockquote:border-l-2 prose-blockquote:border-violet-400 prose-blockquote:pl-3 prose-blockquote:italic prose-blockquote:my-2 prose-blockquote:text-gray-600 prose-blockquote:dark:text-gray-400">
                                                <ReactMarkdown>{message.content}</ReactMarkdown>
                                            </div>
                                            {message.sources && message.sources.length > 0 && (
                                                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-gray-200/70 dark:border-gray-700/70 pt-2">
                                                    {message.sources.map((source) => (
                                                        <button
                                                            key={`${source.pageNumber}-${source.reason}`}
                                                            onClick={() => onNavigateToPage?.(source.pageNumber)}
                                                            className="inline-flex items-center gap-1 rounded-full border border-violet-200/80 dark:border-violet-800/70 bg-white/70 dark:bg-gray-900/70 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/40 transition-colors"
                                                            title={source.title || sourceReasonLabel[source.reason]}
                                                        >
                                                            <FileText size={10} />
                                                            第 {source.pageNumber} 页
                                                            <span className="text-violet-400 dark:text-violet-500">
                                                                {sourceReasonLabel[source.reason]}
                                                            </span>
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}

                    {/* Loading indicator */}
                    {isLoading && (messages.length === 0 || messages[messages.length - 1]?.role !== 'assistant' || !messages[messages.length - 1]?.content) && (
                        <div className="flex gap-3">
                            <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-white shadow-sm shadow-violet-500/20 mt-0.5">
                                <Sparkles size={14} />
                            </div>
                            <div className="bg-gray-100 dark:bg-gray-800 px-4 py-3 rounded-2xl rounded-tl-md">
                                <div className="flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
                                    <span className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
                                    <span className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-bounce" />
                                </div>
                            </div>
                        </div>
                    )}

                    {error && (
                        <div className="mx-2 bg-red-50 dark:bg-red-950/30 border border-red-200/60 dark:border-red-800/40 rounded-xl p-3">
                            <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
                        </div>
                    )}

                    <div ref={messagesEndRef} />
                </div>

                {/* Input area */}
                <div className="flex-shrink-0 px-4 pb-4 pt-2">
                    <div className="relative bg-gray-100 dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 focus-within:border-violet-400 dark:focus-within:border-violet-500 focus-within:ring-2 focus-within:ring-violet-500/10 transition-all">
                        <textarea
                            ref={inputRef}
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="输入你的问题..."
                            className="w-full resize-none bg-transparent px-4 pt-3 pb-10 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none"
                            rows={1}
                            disabled={isLoading}
                            style={{ minHeight: '44px', maxHeight: '120px' }}
                        />
                        <div className="absolute bottom-2 left-3 right-3 flex items-center justify-between">
                            <span className="text-[11px] text-gray-400 dark:text-gray-500 select-none">
                                按 Enter 发送，按 Shift+Enter 换行
                            </span>
                            <button
                                onClick={() => void handleSendMessage()}
                                disabled={!inputValue.trim() || isLoading}
                                className="w-7 h-7 flex items-center justify-center rounded-lg bg-violet-600 hover:bg-violet-700 disabled:bg-gray-300 dark:disabled:bg-gray-600 disabled:cursor-not-allowed text-white transition-all hover:scale-105 active:scale-95 disabled:hover:scale-100"
                                aria-label="发送"
                            >
                                {isLoading ? <Loader size={14} className="animate-spin" /> : <ArrowUp size={15} strokeWidth={2.5} />}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <style>{`
                @keyframes slideIn {
                    from {
                        transform: translateX(100%);
                        opacity: 0.5;
                    }
                    to {
                        transform: translateX(0);
                        opacity: 1;
                    }
                }
            `}</style>
        </>
    );
}
