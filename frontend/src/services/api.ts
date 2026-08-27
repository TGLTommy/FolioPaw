import axios from 'axios';
import { API_BASE_URL } from '../config/backend';
import type {
  ModelBootstrapStatus,
  ModelServiceConfig,
  ModelServiceConfigInput,
  ModelServiceTestResult,
  ReadingGuide,
  ReadingStatus,
} from '../types';

export type SummaryStreamEvent =
  | { type: 'init'; totalChapters: number }
  | { type: 'chapter_start'; chapterId: string }
  | { type: 'chapter_complete'; chapterId: string; title: string; summary: string }
  | { type: 'chapter_error'; chapterId: string; error?: string }
  | { type: 'book_start' }
  | { type: 'book_complete'; summary: string }
  | { type: 'book_error'; error?: string };

export type MindmapStreamEvent =
  | { type: 'init'; totalChapters: number }
  | { type: 'chapter_start'; chapterId: string }
  | { type: 'chapter_complete'; chapterId: string; title: string; svgContent: string }
  | { type: 'chapter_error'; chapterId: string; error?: string };

export type AiChatIntent = 'qa' | 'summarize_page' | 'explain_concepts' | 'translate_selection';

export interface AiSource {
  pageNumber: number;
  reason: 'current' | 'adjacent' | 'chapter' | 'search' | 'selection';
  title?: string;
}

export type AiChatStreamEvent =
  | {
      type: 'sources';
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
  | { type: 'content'; content: string };

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 60000, // 60 second timeout for all requests (translation can take 20+ seconds)
});

// Track active translation requests by page
const translationAbortControllers = new Map<string, AbortController>();

// Book API
export const bookApi = {
  uploadBook: (file: File, folderId?: number | null) => {
    const formData = new FormData();
    formData.append('file', file);
    if (folderId && folderId !== null) {
      formData.append('folderId', String(folderId));
    }
    return api.post('/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  getAllBooks: (folderId?: number | null | 'all') => {
    const params: Record<string, string> = {};
    if (folderId !== undefined) {
      params.folderId = folderId === null ? 'null' : String(folderId);
    }
    return api.get('/books', { params });
  },

  getBook: (id: number) => api.get(`/books/${id}`),

  getPages: (bookId: number, pageNumber?: number) => {
    const params = pageNumber ? { page: pageNumber } : {};
    return api.get(`/books/${bookId}/pages`, { params });
  },

  updateLastRead: (bookId: number, pageNumber: number) =>
    api.put(`/books/${bookId}/last-read`, { pageNumber }),

  deleteBook: (id: number) => api.delete(`/books/${id}`),

  moveToFolder: (bookId: number, folderId: number | null) =>
    api.put(`/books/${bookId}/folder`, { folderId }),

  batchMoveToFolder: (bookIds: number[], folderId: number | null) =>
    api.put('/books/batch/folder', { bookIds, folderId }),

  togglePin: (bookId: number, pinned: boolean) =>
    api.put(`/books/${bookId}/pin`, { pinned }),

  updateReadingStatus: (bookId: number, status: ReadingStatus) =>
    api.put(`/books/${bookId}/reading-status`, { status }),
};

// Folder API
export const folderApi = {
  getAll: () => api.get('/folders'),

  getById: (id: number) => api.get(`/folders/${id}`),

  create: (data: { name: string; color?: string }) =>
    api.post('/folders', data),

  update: (id: number, data: { name?: string; color?: string; sort_order?: number }) =>
    api.put(`/folders/${id}`, data),

  delete: (id: number) => api.delete(`/folders/${id}`),
};

// Translation API with improved cancellation support
export const translationApi = {
  translatePage: (bookId: number, pageNumber: number) => {
    // Create a unique key for this translation request
    const requestKey = `${bookId}-${pageNumber}`;

    // Check if there's already an abort controller for this page
    // If there is, reuse it to prevent sending duplicate requests
    let abortController = translationAbortControllers.get(requestKey);

    if (abortController) {
      // An existing request is in progress, reuse the same abort controller
      // Still send the request with the same signal to avoid duplicate network calls
      // But return a fresh promise chain
    } else {
      // Create a new abort controller for this request
      abortController = new AbortController();
      translationAbortControllers.set(requestKey, abortController);
    }

    // Important: Always create a fresh promise, never cache/reuse promises
    // This prevents failed promises from being returned to subsequent callers
    return api.post('/translate/page', { bookId, pageNumber }, {
      signal: abortController.signal,
      timeout: 90000, // 90 second timeout specifically for translation (can take 20+ seconds)
    }).finally(() => {
      // Clean up the abort controller when the last request completes
      // We check if the controller is still the same before deleting
      if (translationAbortControllers.get(requestKey) === abortController) {
        translationAbortControllers.delete(requestKey);
      }
    });
  },

  translateBatch: (bookId: number, startPage: number, endPage: number) =>
    api.post('/translate/batch', { bookId, startPage, endPage }),

  startBatchJob: (bookId: number, startPage?: number, endPage?: number) =>
    api.post('/translate/batch-job/start', { bookId, startPage, endPage }),

  getJobStatus: (bookId: number) =>
    api.get(`/translate/batch-job/${bookId}`),

  stopJob: (bookId: number) =>
    api.post(`/translate/batch-job/stop/${bookId}`),
};

// AI Chat API
export const aiApi = {
  chat: (
    bookId: number,
    pageNumber: number,
    question: string,
    selectedText?: string,
    conversationHistory?: { role: 'user' | 'assistant'; content: string }[],
    intent?: AiChatIntent
  ) =>
    api.post('/ai/chat', {
      bookId,
      pageNumber,
      question,
      selectedText,
      conversationHistory,
      intent,
    }),

  /**
   * Stream chat - uses fetch API for SSE streaming
   */
  streamChat: async function* (
    bookId: number,
    pageNumber: number,
    question: string,
    selectedText?: string,
    conversationHistory?: { role: 'user' | 'assistant'; content: string }[],
    intent?: AiChatIntent
  ): AsyncGenerator<AiChatStreamEvent, void, unknown> {
    const response = await fetch(`${API_BASE_URL}/ai/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bookId,
        pageNumber,
        question,
        selectedText,
        conversationHistory,
        intent,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: '未知错误' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('服务端没有返回响应内容');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              return;
            }
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) {
                throw new Error(parsed.error);
              }
              if (parsed.type === 'sources' && parsed.context) {
                yield parsed as AiChatStreamEvent;
              } else if (parsed.type === 'content' && parsed.content) {
                yield parsed as AiChatStreamEvent;
              } else if (parsed.content) {
                yield { type: 'content', content: parsed.content };
              }
            } catch (e) {
              // Ignore JSON parse errors for incomplete chunks
              if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
                throw e;
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  },
};

// Dictionary API
export interface DictionaryResult {
  word: string;
  phonetic?: string;
  phoneticUs?: string;
  phoneticUk?: string;
  translation: string[];
  found: boolean;
}

export const dictionaryApi = {
  lookup: (word: string) =>
    api.get<{ success: boolean; data: DictionaryResult }>('/dictionary/lookup', {
      params: { word },
    }),

  lookupMultiple: (words: string[]) =>
    api.post<{ success: boolean; data: DictionaryResult[] }>('/dictionary/lookup-multiple', {
      words,
    }),
};


// Summary API
export const summaryApi = {
  getSummaries: (bookId: number) =>
    api.get(`/summary/${bookId}`),

  getBookSummary: (bookId: number) =>
    api.get(`/summary/${bookId}/book`),

  getChapterSummary: (bookId: number, chapterId: string) =>
    api.get(`/summary/${bookId}/chapter/${chapterId}`),

  generateChapterSummary: (bookId: number, chapterId: string) =>
    api.post(`/summary/${bookId}/generate`, { type: 'chapter', chapterId }, { timeout: 180000 }),

  generateBookSummary: (bookId: number) =>
    api.post(`/summary/${bookId}/generate`, { type: 'book' }, { timeout: 180000 }),

  deleteSummaries: (bookId: number) =>
    api.delete(`/summary/${bookId}`),

  /**
   * SSE stream: generate all chapter summaries + book summary
   */
  generateAllStream: async function* (bookId: number): AsyncGenerator<SummaryStreamEvent, void, unknown> {
    const response = await fetch(`${API_BASE_URL}/summary/${bookId}/generate/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: '未知错误' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('服务端没有返回响应内容');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') return;
            try {
              const parsed = JSON.parse(data);
              // Only throw on bare error objects (not typed events like chapter_error/book_error)
              if (parsed.error && !parsed.type) throw new Error(parsed.error);
              yield parsed as SummaryStreamEvent;
            } catch (e) {
              if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
                throw e;
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  },
};

// TTS API（Microsoft Edge 在线语音服务）
export const ttsApi = {
  speak: (text: string) =>
    api.post<Blob>('/tts/speak', { text }, { responseType: 'blob', timeout: 60000 }),
};

// Reading Guide API
export const readingGuideApi = {
  get: (bookId: number) =>
    api.get<{ success: boolean; data: ReadingGuide | null }>(`/reading-guide/${bookId}`),

  generate: (bookId: number, force: boolean = false) =>
    api.post<{ success: boolean; data: ReadingGuide }>(
      `/reading-guide/${bookId}/generate`,
      { force },
      { timeout: 10000 }
    ),

  cancel: (bookId: number) =>
    api.post<{ success: boolean; data: ReadingGuide | null }>(
      `/reading-guide/${bookId}/cancel`,
      {},
      { timeout: 10000 }
    ),
};

// Mindmap API
export const mindmapApi = {
  getMindmaps: (bookId: number) =>
    api.get(`/mindmap/${bookId}`),

  getMindmap: (bookId: number, chapterId: string) =>
    api.get(`/mindmap/${bookId}/chapter/${chapterId}`),

  generateMindmap: (bookId: number, chapterId: string) =>
    api.post(`/mindmap/${bookId}/generate`, { chapterId }, { timeout: 180000 }),

  deleteMindmaps: (bookId: number) =>
    api.delete(`/mindmap/${bookId}`),

  /**
   * SSE stream: generate all chapter mindmaps
   */
  generateAllStream: async function* (bookId: number): AsyncGenerator<MindmapStreamEvent, void, unknown> {
    const response = await fetch(`${API_BASE_URL}/mindmap/${bookId}/generate/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: '未知错误' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('服务端没有返回响应内容');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') return;
            try {
              const parsed = JSON.parse(data);
              if (parsed.error && !parsed.type) throw new Error(parsed.error);
              yield parsed as MindmapStreamEvent;
            } catch (e) {
              if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
                throw e;
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  },
};

// Shared model service configuration API
export const modelServiceApi = {
  list: () =>
    api.get<{ success: boolean; data: ModelServiceConfig[] }>('/model-services'),

  create: (input: ModelServiceConfigInput) =>
    api.post<{ success: boolean; data: ModelServiceConfig }>('/model-services', input),

  update: (id: number, input: ModelServiceConfigInput) =>
    api.put<{ success: boolean; data: ModelServiceConfig }>(`/model-services/${id}`, input),

  remove: (id: number) =>
    api.delete<{ success: boolean }>(`/model-services/${id}`),

  test: (id: number) =>
    api.post<{ success: boolean; data: ModelServiceTestResult }>(`/model-services/${id}/test`),

  activate: (id: number) =>
    api.put<{ success: boolean; data: ModelServiceConfig }>(`/model-services/${id}/activate`),

  bootstrapStatus: () =>
    api.get<{ success: boolean; data: ModelBootstrapStatus }>('/model-services/bootstrap'),

  retryBootstrap: () =>
    api.post<{ success: boolean; data: ModelBootstrapStatus }>('/model-services/bootstrap/retry'),
};

export default api;
