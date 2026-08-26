import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  ModelBootstrapSource,
  ModelBootstrapStatus,
} from '../services/model-bootstrap-state';

const DEFAULT_MODELSCOPE_REVISION = '71b231d64df1bbbe8a03f63ea4274c3921da4700';
const DEFAULT_MODELSCOPE_FILE = 'Qwen_Qwen3.5-4B-Q4_K_M.gguf';
const DEFAULT_MODELSCOPE_SIZE = 3_013_027_808;
const DEFAULT_MODELSCOPE_SHA256 = '13c16f426047e2de38cd075bdade4a7bcbc8c774384876f677740cda65f8a983';
const DEFAULT_MODELSCOPE_URL = `https://modelscope.cn/models/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/${DEFAULT_MODELSCOPE_REVISION}/${DEFAULT_MODELSCOPE_FILE}`;

type DownloadSource = 'auto' | 'ollama' | 'modelscope' | 'local';

interface BootstrapOptions {
  host: string;
  port: number;
  ollamaBaseUrl: string;
  model: string;
  contextWindow: number;
  source: DownloadSource;
  idleTimeoutMs: number;
  cacheDir: string;
  statusFile: string;
  localGgufPath: string | null;
  modelScopeUrl: string;
  modelScopeSize: number;
  modelScopeSha256: string;
  ollamaBinary: string;
}

class OfficialSourceUnavailableError extends Error {}

export class ModelBootstrapRunner {
  private status: ModelBootstrapStatus;
  private running = false;

  constructor(private readonly options: BootstrapOptions) {
    mkdirSync(options.cacheDir, { recursive: true });
    this.status = this.loadStatus();
  }

  start(): void {
    const server = createServer((request, response) => void this.handleRequest(request, response));
    server.listen(this.options.port, this.options.host, () => {
      console.log(`Model bootstrap listening on http://${this.options.host}:${this.options.port}`);
      void this.startJob();
    });
  }

  getStatus(): ModelBootstrapStatus {
    return { ...this.status };
  }

  async startJob(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    this.updateStatus({
      phase: 'waiting',
      source: null,
      message: '正在等待 Ollama 服务',
      receivedBytes: null,
      totalBytes: null,
      canRetry: false,
    });
    void this.run().finally(() => {
      this.running = false;
    });
    return true;
  }

  private async run(): Promise<void> {
    try {
      await this.waitForOllama();
      this.updateStatus({ phase: 'checking', message: '正在检查本地模型' });
      if (await this.modelExists()) {
        await this.testModel();
        if (this.options.source !== 'local') this.cleanupCachedGguf();
        this.ready('模型已存在，可离线使用');
        return;
      }

      if (this.options.source === 'ollama' || this.options.source === 'auto') {
        try {
          await this.pullFromOllama();
        } catch (error) {
          if (this.options.source === 'ollama') throw error;
          if (!(error instanceof OfficialSourceUnavailableError)) throw error;
          console.warn(`Official Ollama pull failed, switching to ModelScope: ${safeError(error)}`);
          // Continue with the pinned ModelScope artifact.
          return await this.prepareFallbackModel();
        }
        await this.testModel();
        this.ready('模型已从 Ollama 官方源准备完成', 'ollama-registry');
        return;
      }

      await this.prepareFallbackModel();
    } catch (error) {
      console.error('Model bootstrap failed:', safeError(error));
      this.updateStatus({
        phase: 'failed',
        message: safeError(error),
        canRetry: true,
      });
    }
  }

  private async prepareFallbackModel(): Promise<void> {
    let temporaryGgufPath: string | null = null;
    if (this.options.source === 'local') {
      if (!this.options.localGgufPath) throw new Error('MODEL_LOCAL_GGUF_PATH 未配置');
      await this.importGguf(this.options.localGgufPath, 'local');
    } else {
      temporaryGgufPath = await this.downloadFromModelScope();
      await this.importGguf(temporaryGgufPath, 'modelscope');
    }
    await this.testModel();
    if (temporaryGgufPath) this.cleanupCachedGguf();
    this.ready(
      this.options.source === 'local' ? '本地 GGUF 模型已导入' : '模型已通过 ModelScope 回退源准备完成',
      this.options.source === 'local' ? 'local' : 'modelscope',
    );
  }

  private async waitForOllama(): Promise<void> {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try {
        const response = await fetch(`${this.ollamaUrl()}/api/tags`, {
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) return;
      } catch {
        // Ollama can take a while to initialize its runtime.
      }
      await delay(2000);
    }
    throw new Error('等待 Ollama 启动超时');
  }

  private async modelExists(): Promise<boolean> {
    const response = await fetch(`${this.ollamaUrl()}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Ollama 模型列表请求失败 (${response.status})`);
    const data = await response.json() as { models?: Array<{ name?: string; model?: string }> };
    return (data.models || []).some((model) =>
      model.name === this.options.model || model.model === this.options.model
    );
  }

  private async pullFromOllama(): Promise<void> {
    this.updateStatus({
      phase: 'pulling-official',
      source: 'ollama-registry',
      message: '正在从 Ollama 官方源下载模型',
      receivedBytes: 0,
      totalBytes: null,
    });
    const controller = new AbortController();
    let idleTimer = this.idleTimer(controller);
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = this.idleTimer(controller);
    };

    try {
      const response = await fetch(`${this.ollamaUrl()}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.options.model, stream: true }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        if (response.status === 404 || response.status >= 500) {
          throw new OfficialSourceUnavailableError(`Ollama 官方下载请求失败 (${response.status})`);
        }
        throw new Error(`Ollama 官方下载被拒绝 (${response.status})`);
      }
      resetIdleTimer();
      const decoder = new TextDecoder();
      let buffer = '';
      const progress = { completed: -1, status: '' };
      for await (const chunk of response.body as any) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (this.consumePullStatus(line, progress)) resetIdleTimer();
        }
      }
      if (buffer.trim() && this.consumePullStatus(buffer, progress)) resetIdleTimer();
      if (!await this.modelExists()) {
        throw new OfficialSourceUnavailableError('Ollama 官方下载结束，但模型未出现在本地列表中');
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new OfficialSourceUnavailableError('Ollama 官方源长时间无下载进度');
      }
      if (error instanceof OfficialSourceUnavailableError) throw error;
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      if (
        error instanceof TypeError
        || /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(rawErrorMessage)
      ) {
        throw new OfficialSourceUnavailableError('无法连接 Ollama 官方模型源');
      }
      throw error;
    } finally {
      clearTimeout(idleTimer);
    }
  }

  private consumePullStatus(
    line: string,
    progress: { completed: number; status: string },
  ): boolean {
    if (!line.trim()) return false;
    try {
      const event = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
      if (event.error) throw new Error(localizeOllamaError(event.error));
      const completed = finiteNumber(event.completed);
      const total = finiteNumber(event.total);
      const status = event.status || '';
      const advanced = (completed !== null && completed > progress.completed)
        || (Boolean(status) && status !== progress.status);
      if (completed !== null) progress.completed = Math.max(progress.completed, completed);
      if (status) progress.status = status;
      this.updateStatus({
        phase: 'pulling-official',
        source: 'ollama-registry',
        message: status ? `Ollama 官方源：${localizeOllamaStatus(status)}` : '正在从 Ollama 官方源下载模型',
        ...(completed !== null ? { receivedBytes: completed } : {}),
        ...(total !== null ? { totalBytes: total } : {}),
      });
      return advanced;
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  }

  private async downloadFromModelScope(): Promise<string> {
    const finalPath = path.join(this.options.cacheDir, DEFAULT_MODELSCOPE_FILE);
    const partialPath = `${finalPath}.part`;
    const finalSize = fileSize(finalPath);
    if (finalSize === this.options.modelScopeSize) {
      await this.verifyFile(finalPath);
      return finalPath;
    }
    if (finalSize > 0) unlinkIfExists(finalPath);
    let received = fileSize(partialPath);
    if (received > this.options.modelScopeSize) {
      unlinkIfExists(partialPath);
      received = 0;
    }
    this.updateStatus({
      phase: 'downloading-modelscope',
      source: 'modelscope',
      message: received > 0 ? '正在从 ModelScope 断点续传模型' : '正在从 ModelScope 下载模型',
      receivedBytes: received,
      totalBytes: this.options.modelScopeSize,
    });

    if (received < this.options.modelScopeSize) {
      const controller = new AbortController();
      let idleTimer = this.idleTimer(controller);
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = this.idleTimer(controller);
      };
      try {
        const response = await fetch(this.options.modelScopeUrl, {
          headers: received > 0 ? { Range: `bytes=${received}-` } : undefined,
          redirect: 'follow',
          signal: controller.signal,
        });
        if (![200, 206].includes(response.status) || !response.body) {
          throw new Error(`ModelScope 下载请求失败 (${response.status})`);
        }
        if (received > 0 && response.status !== 206) {
          unlinkIfExists(partialPath);
          received = 0;
        }
        if (response.status === 206) {
          const range = response.headers.get('content-range');
          const match = range?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
          if (!match || Number(match[1]) !== received || Number(match[3]) !== this.options.modelScopeSize) {
            throw new Error('ModelScope 断点续传响应无效');
          }
        }

        const output = createWriteStream(partialPath, { flags: received > 0 ? 'a' : 'w', mode: 0o600 });
        try {
          let lastReportedAt = 0;
          for await (const chunk of response.body as any) {
            resetIdleTimer();
            const data = Buffer.from(chunk);
            if (received + data.length > this.options.modelScopeSize) {
              throw new Error('ModelScope 响应超过预期模型大小，已停止下载');
            }
            if (!output.write(data)) await once(output, 'drain');
            received += data.length;
            if (Date.now() - lastReportedAt > 500) {
              lastReportedAt = Date.now();
              this.updateStatus({
                phase: 'downloading-modelscope',
                source: 'modelscope',
                message: '正在从 ModelScope 下载模型',
                receivedBytes: received,
                totalBytes: this.options.modelScopeSize,
              });
            }
          }
          output.end();
          await once(output, 'finish');
        } catch (error) {
          output.destroy();
          throw error;
        }
      } catch (error) {
        if (safeError(error).includes('超过预期模型大小')) unlinkIfExists(partialPath);
        if (controller.signal.aborted) throw new Error('ModelScope 长时间无下载进度，可稍后重试并断点续传');
        throw error;
      } finally {
        clearTimeout(idleTimer);
      }
    }

    if (fileSize(partialPath) !== this.options.modelScopeSize) {
      throw new Error(`ModelScope 模型文件大小不完整，可重试续传`);
    }
    renameSync(partialPath, finalPath);
    await this.verifyFile(finalPath);
    return finalPath;
  }

  private async verifyFile(filePath: string, removeOnFailure = true): Promise<void> {
    this.updateStatus({
      phase: 'verifying',
      message: '正在校验模型 SHA-256',
      receivedBytes: this.options.modelScopeSize,
      totalBytes: this.options.modelScopeSize,
    });
    if (fileSize(filePath) !== this.options.modelScopeSize) {
      if (removeOnFailure) unlinkIfExists(filePath);
      throw new Error(removeOnFailure
        ? '模型文件大小校验失败，损坏文件已清理'
        : '本地 GGUF 文件大小校验失败，原文件已保留');
    }
    const digest = createHash('sha256');
    const input = createReadStream(filePath);
    for await (const chunk of input) digest.update(chunk as Buffer);
    if (digest.digest('hex').toLowerCase() !== this.options.modelScopeSha256.toLowerCase()) {
      if (removeOnFailure) unlinkIfExists(filePath);
      throw new Error(removeOnFailure
        ? '模型 SHA-256 校验失败，损坏文件已清理'
        : '本地 GGUF 的 SHA-256 校验失败，原文件已保留');
    }
  }

  private cleanupCachedGguf(): void {
    const finalPath = path.join(this.options.cacheDir, DEFAULT_MODELSCOPE_FILE);
    unlinkIfExists(finalPath);
    unlinkIfExists(`${finalPath}.part`);
  }

  private async importGguf(filePath: string, source: Exclude<ModelBootstrapSource, null>): Promise<void> {
    if (source === 'local') await this.verifyLocalFile(filePath);
    this.updateStatus({
      phase: 'importing',
      source,
      message: '正在将 GGUF 模型导入 Ollama',
      receivedBytes: this.options.modelScopeSize,
      totalBytes: this.options.modelScopeSize,
    });
    const modelFile = path.join(this.options.cacheDir, 'FolioPaw.Modelfile');
    writeFileSync(modelFile, `FROM ${filePath}\n`, { mode: 0o600 });
    try {
      await runCommand(
        this.options.ollamaBinary,
        ['create', this.options.model, '-f', modelFile],
        { ...process.env, OLLAMA_HOST: this.ollamaUrl() },
      );
    } finally {
      unlinkIfExists(modelFile);
    }
    if (!await this.modelExists()) throw new Error('GGUF 导入完成后未找到目标模型');
  }

  private async verifyLocalFile(filePath: string): Promise<void> {
    if (fileSize(filePath) <= 0) throw new Error('本地 GGUF 文件不存在或为空');
    if (this.options.modelScopeSha256 === DEFAULT_MODELSCOPE_SHA256 && fileSize(filePath) !== DEFAULT_MODELSCOPE_SIZE) {
      throw new Error('本地 GGUF 与默认 Qwen3.5-4B 文件大小不一致；自定义文件需同时配置 SHA-256 和大小');
    }
    await this.verifyFile(filePath, false);
  }

  private async testModel(): Promise<void> {
    this.updateStatus({ phase: 'testing', message: '正在测试本地模型响应', canRetry: false });
    const response = await fetch(`${this.ollamaUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.options.model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        stream: false,
        think: false,
        options: { num_ctx: this.options.contextWindow, num_predict: 8 },
      }),
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok) throw new Error(`本地模型测试失败 (${response.status})`);
    const data = await response.json() as { message?: { content?: string } };
    if (!data.message?.content?.trim()) throw new Error('本地模型测试未返回文本');
  }

  private ready(message: string, source: ModelBootstrapSource = null): void {
    this.updateStatus({
      phase: 'ready',
      source: source ?? this.status.source,
      message,
      receivedBytes: this.status.totalBytes,
      canRetry: false,
    });
  }

  private updateStatus(patch: Partial<ModelBootstrapStatus>): void {
    const totalBytes = patch.totalBytes === undefined ? this.status.totalBytes : patch.totalBytes;
    const receivedBytes = patch.receivedBytes === undefined ? this.status.receivedBytes : patch.receivedBytes;
    const percent = totalBytes && receivedBytes !== null
      ? Math.max(0, Math.min(100, Math.round((receivedBytes / totalBytes) * 100)))
      : null;
    this.status = {
      ...this.status,
      ...patch,
      enabled: true,
      model: this.options.model,
      totalBytes,
      receivedBytes,
      percent,
      updatedAt: new Date().toISOString(),
    };
    this.persistStatus();
  }

  private loadStatus(): ModelBootstrapStatus {
    try {
      const value = JSON.parse(readFileSync(this.options.statusFile, 'utf8')) as ModelBootstrapStatus;
      if (value && typeof value.phase === 'string') return value;
    } catch {
      // A missing or interrupted status file is equivalent to a fresh start.
    }
    return {
      enabled: true,
      phase: 'waiting',
      source: null,
      model: this.options.model,
      receivedBytes: null,
      totalBytes: null,
      percent: null,
      message: '模型引导服务正在启动',
      updatedAt: new Date().toISOString(),
      canRetry: false,
    };
  }

  private persistStatus(): void {
    const temporary = `${this.options.statusFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.status), { mode: 0o600 });
    renameSync(temporary, this.options.statusFile);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && request.url === '/health') {
      response.statusCode = 200;
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/status') {
      response.statusCode = 200;
      response.end(JSON.stringify(this.getStatus()));
      return;
    }
    if (request.method === 'POST' && request.url === '/retry') {
      if (this.running || this.status.phase === 'ready') {
        response.statusCode = 409;
        response.end(JSON.stringify({ error: this.running ? '任务正在运行' : '模型已经就绪' }));
        return;
      }
      await this.startJob();
      response.statusCode = 202;
      response.end(JSON.stringify(this.getStatus()));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: '接口不存在' }));
  }

  private idleTimer(controller: AbortController): NodeJS.Timeout {
    const timer = setTimeout(() => controller.abort(), this.options.idleTimeoutMs);
    timer.unref();
    return timer;
  }

  private ollamaUrl(): string {
    return this.options.ollamaBaseUrl.replace(/\/+$/, '');
  }
}

export function loadBootstrapOptions(environment: NodeJS.ProcessEnv = process.env): BootstrapOptions {
  const source = environment.MODEL_DOWNLOAD_SOURCE || 'auto';
  if (!['auto', 'ollama', 'modelscope', 'local'].includes(source)) {
    throw new Error('MODEL_DOWNLOAD_SOURCE 必须是 auto、ollama、modelscope 或 local');
  }
  const cacheDir = environment.MODEL_CACHE_DIR || '/cache';
  return {
    host: environment.BOOTSTRAP_HOST || '0.0.0.0',
    port: parseInteger(environment.BOOTSTRAP_PORT, 8080, 1, 65535),
    ollamaBaseUrl: environment.OLLAMA_BASE_URL || 'http://ollama:11434',
    model: environment.OLLAMA_MODEL || 'qwen3.5:4b',
    contextWindow: parseInteger(environment.OLLAMA_CONTEXT_WINDOW, 32768, 4096, 262144),
    source: source as DownloadSource,
    idleTimeoutMs: parseInteger(environment.MODEL_DOWNLOAD_IDLE_TIMEOUT_MS, 90000, 10000, 1800000),
    cacheDir,
    statusFile: environment.MODEL_BOOTSTRAP_STATUS_FILE || path.join(cacheDir, 'status.json'),
    localGgufPath: environment.MODEL_LOCAL_GGUF_PATH || null,
    modelScopeUrl: environment.MODELSCOPE_MODEL_URL || DEFAULT_MODELSCOPE_URL,
    modelScopeSize: parseInteger(environment.MODELSCOPE_MODEL_SIZE, DEFAULT_MODELSCOPE_SIZE, 1, Number.MAX_SAFE_INTEGER),
    modelScopeSha256: environment.MODELSCOPE_MODEL_SHA256 || DEFAULT_MODELSCOPE_SHA256,
    ollamaBinary: environment.OLLAMA_BINARY || '/usr/local/bin/ollama',
  };
}

function parseInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function unlinkIfExists(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function runCommand(binary: string, args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-2000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else {
        console.error(`Ollama import failed (${code ?? 'unknown'}): ${output.trim()}`);
        reject(new Error(`Ollama 导入失败（退出码 ${code ?? '未知'}），请检查模型文件和磁盘空间后重试`));
      }
    });
  });
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = message
    .replace(/https?:\/\/[^\s]+/gi, '[下载地址]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
  if (/[\u3400-\u9fff]/.test(sanitized)) return sanitized;
  if (/ENOSPC|no space left/i.test(sanitized)) return '磁盘空间不足，无法继续准备模型';
  if (/EACCES|permission denied/i.test(sanitized)) return '模型文件或缓存目录没有写入权限';
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(sanitized)) {
    return '模型下载网络连接失败，请检查网络或代理后重试';
  }
  return '模型准备失败，请检查网络、磁盘空间和部署配置后重试';
}

function localizeOllamaStatus(status: string): string {
  if (/[\u3400-\u9fff]/.test(status)) return status;
  const normalized = status.trim().toLowerCase();
  if (normalized === 'pulling manifest') return '正在获取模型清单';
  if (normalized === 'verifying sha256 digest') return '正在校验模型文件';
  if (normalized === 'writing manifest') return '正在写入模型清单';
  if (normalized === 'removing any unused layers') return '正在清理无用模型分层';
  if (normalized === 'success') return '下载完成';
  if (/^pulling\s+[a-f0-9]+/.test(normalized)) return '正在下载模型分层';
  return '正在处理模型下载';
}

function localizeOllamaError(message: string): string {
  if (/[\u3400-\u9fff]/.test(message)) return message;
  if (/not found|does not exist|manifest/i.test(message)) return 'Ollama 官方源未找到指定模型';
  if (/unauthorized|forbidden|permission/i.test(message)) return 'Ollama 官方源拒绝访问';
  if (/timeout|timed out/i.test(message)) return 'Ollama 官方源请求超时';
  return 'Ollama 官方源下载失败';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
