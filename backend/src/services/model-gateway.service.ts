import axios from 'axios';
import {
  modelServiceConfigService,
  type ModelProviderType,
  type ModelServiceConfig,
} from './model-service-config.service';
import {
  estimateTokenCount,
  getModelContextBudget,
} from './model-context-budget.service';

export interface ModelRequest {
  systemPrompt?: string;
  userMessage: string;
  task?: string;
  maxTokens?: number;
  timeoutMs?: number;
  responseFormat?: 'text' | 'json';
  signal?: AbortSignal;
}

export interface ModelResponse {
  text: string;
  model: string;
  providerType: ModelProviderType;
  configId: number;
  configRevision: number;
  elapsedMs: number;
}

export interface ModelExecutionContext {
  readonly config: ModelServiceConfig;
}

export class ModelGatewayError extends Error {
  public readonly expose = true;

  constructor(
    message: string,
    public readonly status: number = 502,
    public readonly upstreamStatus?: number,
    public readonly code?: 'reasoning-exhausted',
  ) {
    super(message);
    this.name = 'ModelGatewayError';
  }
}

interface QueuedTask<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

interface QueueState {
  active: number;
  maxConcurrency: number;
  pending: QueuedTask<unknown>[];
}

export interface ModelHttpTransport {
  post(
    url: string,
    body: unknown,
    options: {
      headers: Record<string, string>;
      timeout: number;
      signal?: AbortSignal;
      validateStatus: () => boolean;
    },
  ): Promise<{ status: number; data: any }>;
}

const axiosTransport: ModelHttpTransport = {
  post: (url, body, options) => axios.post(url, body, options),
};

export class ModelGatewayService {
  private readonly queues = new Map<string, QueueState>();

  constructor(private readonly httpTransport: ModelHttpTransport = axiosTransport) {}

  createContext(configId?: number): ModelExecutionContext {
    const config = configId === undefined
      ? modelServiceConfigService.getActive()
      : modelServiceConfigService.getById(configId);
    return { config: { ...config } };
  }

  async call(request: ModelRequest, context?: ModelExecutionContext): Promise<ModelResponse> {
    const executionContext = context || this.createContext();
    const config = executionContext.config;
    const queueKey = `${config.id}:${config.revision}`;
    return this.enqueue(
      queueKey,
      config.maxConcurrency,
      () => this.execute(request, config),
      request.signal,
    );
  }

  async test(config: ModelServiceConfig): Promise<ModelResponse> {
    return this.call({
      systemPrompt: '这是模型服务连接测试。',
      userMessage: '请用简短中文确认连接正常。',
      task: '返回一条简短的中文纯文本连接确认。',
      maxTokens: 32,
      timeoutMs: Math.min(config.timeoutMs, config.providerType === 'ollama' ? 300000 : 60000),
    }, { config: { ...config } });
  }

  getFingerprint(config: ModelServiceConfig): string {
    const endpoint = normalizeModelEndpoint(config.providerType, config.baseUrl || '');
    return [
      config.providerType,
      endpoint,
      config.model,
      config.contextWindow ?? '',
    ].join('|');
  }

  getInputTokenBudget(request: ModelRequest, context?: ModelExecutionContext): number | null {
    const executionContext = context || this.createContext();
    const prompt = buildSystemPrompt(request);
    return getModelContextBudget(
      executionContext.config,
      prompt,
      request.maxTokens,
    )?.inputTokens ?? null;
  }

  private async execute(request: ModelRequest, config: ModelServiceConfig): Promise<ModelResponse> {
    if (request.signal?.aborted) throw createAbortError();
    const startedAt = Date.now();

    const timeoutMs = request.timeoutMs && request.timeoutMs > 0
      ? Math.min(request.timeoutMs, config.timeoutMs)
      : config.timeoutMs;
    const systemPrompt = buildSystemPrompt(request);
    const endpoint = normalizeModelEndpoint(config.providerType, config.baseUrl || '');
    const contextBudget = getModelContextBudget(config, systemPrompt, request.maxTokens);
    if (contextBudget && estimateTokenCount(request.userMessage) > contextBudget.inputTokens) {
      throw new ModelGatewayError(
        `输入内容超过本地模型上下文限制（预计 ${estimateTokenCount(request.userMessage)} 词元，可用约 ${contextBudget.inputTokens} 词元），请缩短内容或增大上下文窗口`,
        422,
      );
    }
    const maxOutputTokens = contextBudget?.maxOutputTokens ?? request.maxTokens;

    try {
      if (config.providerType === 'ollama') {
        const response = await this.httpTransport.post(endpoint, {
          model: config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: request.userMessage },
          ],
          stream: false,
          think: false,
          ...(request.responseFormat === 'json' ? { format: 'json' } : {}),
          options: {
            num_ctx: config.contextWindow || 32768,
            ...(maxOutputTokens ? { num_predict: maxOutputTokens } : {}),
          },
        }, {
          headers: { 'Content-Type': 'application/json' },
          timeout: timeoutMs,
          signal: request.signal,
          validateStatus: () => true,
        });

        if (response.status < 200 || response.status >= 300) {
          const upstreamMessage = extractUpstreamMessage(response.data);
          if (response.status === 404 || /model.+not found|no such model/i.test(upstreamMessage)) {
            throw new ModelGatewayError(
              `Ollama 中未找到模型 ${config.model}，请等待模型下载完成或在设置页重试`,
              503,
              response.status,
            );
          }
          if (
            response.status === 400
            && /context (?:length|window)|too many tokens|input.+too long|maximum context/i.test(upstreamMessage)
          ) {
            throw new ModelGatewayError(
              `输入超过 Ollama 模型上下文限制，请缩短内容或增大上下文窗口（当前 ${config.contextWindow || 32768} 词元）`,
              422,
              response.status,
            );
          }
          throw createHttpError(response.status, response.data, null);
        }
        const text = parseOllamaText(response.data);
        return {
          text,
          model: typeof response.data?.model === 'string' ? response.data.model : config.model,
          providerType: config.providerType,
          configId: config.id,
          configRevision: config.revision,
          elapsedMs: Date.now() - startedAt,
        };
      }

      if (config.providerType === 'openai-compatible') {
        const requestBody = {
          model: config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: request.userMessage },
          ],
          ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
          ...(request.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
          stream: false,
        };
        const postOptions = {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey || ''}`,
          },
          timeout: timeoutMs,
          signal: request.signal,
          validateStatus: () => true,
        };

        let response = await this.httpTransport.post(endpoint, requestBody, postOptions);
        if (response.status < 200 || response.status >= 300) {
          throw createHttpError(response.status, response.data, config.apiKey);
        }

        let text: string;
        try {
          text = parseOpenAIText(response.data);
        } catch (parseError: unknown) {
          const reasoningExhausted = parseError instanceof ModelGatewayError
            && parseError.code === 'reasoning-exhausted';
          if (!reasoningExhausted) throw parseError;
          // 思考型模型把输出预算耗在了思考上：尝试关闭思考重试一次
          // （DeepSeek 官方支持 thinking 参数；不支持该参数的端点会拒绝，此时回抛原错误）
          const retryResponse = await this.httpTransport.post(endpoint, {
            ...requestBody,
            thinking: { type: 'disabled' },
          }, postOptions);
          if (retryResponse.status < 200 || retryResponse.status >= 300) throw parseError;
          text = parseOpenAIText(retryResponse.data);
          response = retryResponse;
        }

        return {
          text,
          model: typeof response.data?.model === 'string' ? response.data.model : config.model,
          providerType: config.providerType,
          configId: config.id,
          configRevision: config.revision,
          elapsedMs: Date.now() - startedAt,
        };
      }

      const response = await this.httpTransport.post(endpoint, {
        model: config.model,
        max_tokens: maxOutputTokens || 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: request.userMessage }],
        stream: false,
      }, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey || '',
          'anthropic-version': '2023-06-01',
        },
        timeout: timeoutMs,
        signal: request.signal,
        validateStatus: () => true,
      });

      if (response.status < 200 || response.status >= 300) {
        throw createHttpError(response.status, response.data, config.apiKey);
      }
      const text = parseAnthropicText(response.data);
      return {
        text,
        model: typeof response.data?.model === 'string' ? response.data.model : config.model,
        providerType: config.providerType,
        configId: config.id,
        configRevision: config.revision,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (error instanceof ModelGatewayError) throw error;
      if (axios.isCancel(error) || request.signal?.aborted) throw createAbortError();
      if (axios.isAxiosError(error) && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT')) {
        throw new ModelGatewayError(`模型服务调用超时（${timeoutMs} 毫秒）`, 504);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (config.providerType === 'ollama' && /ECONNREFUSED|ENOTFOUND|fetch failed/i.test(message)) {
        throw new ModelGatewayError('无法连接 Ollama，本地模型服务可能尚未启动', 503);
      }
      throw new ModelGatewayError(`模型服务请求失败：${sanitizeMessage(message, config.apiKey)}`, 502);
    }
  }

  private enqueue<T>(
    key: string,
    maxConcurrency: number,
    run: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(createAbortError());

    let state = this.queues.get(key);
    if (!state) {
      state = { active: 0, maxConcurrency: Math.max(1, maxConcurrency), pending: [] };
      this.queues.set(key, state);
    } else {
      state.maxConcurrency = Math.max(1, maxConcurrency);
    }

    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = { run, resolve, reject, signal };
      const abortListener = () => {
        const queue = this.queues.get(key);
        if (!queue) return;
        const index = queue.pending.indexOf(task as QueuedTask<unknown>);
        if (index >= 0) {
          queue.pending.splice(index, 1);
          reject(createAbortError());
          this.cleanupQueue(key, queue);
        }
      };
      task.abortListener = abortListener;
      signal?.addEventListener('abort', abortListener, { once: true });
      state!.pending.push(task as QueuedTask<unknown>);
      this.drain(key, state!);
    });
  }

  private drain(key: string, state: QueueState): void {
    while (state.active < state.maxConcurrency && state.pending.length > 0) {
      const task = state.pending.shift()!;
      task.signal?.removeEventListener('abort', task.abortListener!);
      if (task.signal?.aborted) {
        task.reject(createAbortError());
        continue;
      }

      state.active += 1;
      task.run()
        .then(task.resolve)
        .catch(task.reject)
        .finally(() => {
          state.active -= 1;
          this.drain(key, state);
          this.cleanupQueue(key, state);
        });
    }
  }

  private cleanupQueue(key: string, state: QueueState): void {
    if (state.active === 0 && state.pending.length === 0) this.queues.delete(key);
  }
}

export function normalizeModelEndpoint(providerType: ModelProviderType, rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new ModelGatewayError('API 地址格式无效', 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ModelGatewayError('API 地址只支持 http 或 https', 400);
  }

  let pathname = url.pathname.replace(/\/+$/, '');
  if (providerType === 'openai-compatible') {
    if (!/\/chat\/completions$/i.test(pathname)) {
      pathname += /\/v1$/i.test(pathname) ? '/chat/completions' : '/v1/chat/completions';
    }
  } else if (providerType === 'anthropic-compatible') {
    if (!/\/messages$/i.test(pathname)) {
      pathname += /\/v1$/i.test(pathname) ? '/messages' : '/v1/messages';
    }
  } else if (providerType === 'ollama') {
    if (!/\/api\/chat$/i.test(pathname)) {
      pathname += /\/api$/i.test(pathname) ? '/chat' : '/api/chat';
    }
  }
  url.pathname = pathname;
  return url.toString();
}

function buildSystemPrompt(request: ModelRequest): string {
  const parts = [
    '你是阅读与翻译应用的后端模型服务。',
    '除非任务明确要求保留原文或输出固定结构，否则所有面向用户的自然语言内容都必须使用简体中文。',
    '只返回用户要求的最终内容，不要添加无关前言、致辞或签名。',
  ];
  if (request.maxTokens) parts.push(`回答尽量控制在约 ${request.maxTokens} 个词元以内。`);
  if (request.task) parts.push(`任务：${request.task}`);
  if (request.systemPrompt) parts.push(request.systemPrompt);
  return parts.join('\n\n');
}

function parseOpenAIText(data: unknown): string {
  const choice = (data as any)?.choices?.[0];
  const content = choice?.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => typeof part?.text === 'string' ? part.text : '').join('')
      : '';
  if (!text.trim()) {
    // 思考型模型（如 DeepSeek）的思考也计入 max_tokens：预算被思考耗尽时最终答案为空
    if (choice?.finish_reason === 'length') {
      throw new ModelGatewayError('模型输出超出 max_tokens 限制被截断（思考型模型的思考内容也计入该限制），请重试或提高输出词元上限', 502, undefined, 'reasoning-exhausted');
    }
    const reasoning = choice?.message?.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.trim()) {
      throw new ModelGatewayError('模型只返回了思考内容而没有最终答案，请重试', 502, undefined, 'reasoning-exhausted');
    }
    throw new ModelGatewayError('OpenAI 兼容服务没有返回文本内容', 502);
  }
  return text.trim();
}

function parseAnthropicText(data: unknown): string {
  const content = (data as any)?.content;
  const text = Array.isArray(content)
    ? content.map((part) => part?.type === 'text' && typeof part.text === 'string' ? part.text : '').join('')
    : '';
  if (!text.trim()) throw new ModelGatewayError('Anthropic 兼容服务没有返回文本内容', 502);
  return text.trim();
}

function parseOllamaText(data: unknown): string {
  const content = (data as any)?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new ModelGatewayError('Ollama 没有返回文本内容', 502);
  }
  return content.trim();
}

function createHttpError(status: number, data: unknown, apiKey: string | null): ModelGatewayError {
  const rawMessage = extractUpstreamMessage(data) || `HTTP ${status}`;
  const safeMessage = sanitizeMessage(String(rawMessage), apiKey);
  const statusText = status === 401 || status === 403
    ? '鉴权失败'
    : status === 429
      ? '请求过于频繁'
      : '请求失败';
  return new ModelGatewayError(`上游模型服务${statusText} (${status}): ${safeMessage}`, status === 408 ? 504 : 502, status);
}

function extractUpstreamMessage(data: unknown): string {
  const raw = (data as any)?.error?.message
    || (data as any)?.error?.type
    || (data as any)?.error
    || (data as any)?.message
    || '';
  return typeof raw === 'string' ? raw : String(raw || '');
}

function sanitizeMessage(message: string, apiKey: string | null): string {
  let sanitized = message.replace(/[\r\n\t]+/g, ' ').trim();
  if (apiKey) sanitized = sanitized.split(apiKey).join('[已隐藏]');
  sanitized = sanitized
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:api[_-]?key|x-api-key|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]')
    .replace(/([?&](?:api[_-]?key|key|token|access_token)=)[^&\s]+/gi, '$1[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, '[已隐藏]');
  return sanitized.length > 800 ? `${sanitized.slice(0, 800)}…` : sanitized;
}

function createAbortError(): Error {
  const error = new Error('模型服务调用已取消');
  error.name = 'AbortError';
  return error;
}

export function isModelAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export const modelGateway = new ModelGatewayService();
