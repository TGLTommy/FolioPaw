import axios from 'axios';
import { runtimeConfig } from '../config/env';
import { modelGateway, ModelGatewayError } from './model-gateway.service';
import {
  modelServiceConfigService,
  type ModelServiceConfigInput,
} from './model-service-config.service';
import {
  getCachedModelBootstrapStatus,
  setCachedModelBootstrapStatus,
  type ModelBootstrapPhase,
  type ModelBootstrapSource,
  type ModelBootstrapStatus,
} from './model-bootstrap-state';

const PHASES = new Set<ModelBootstrapPhase>([
  'disabled',
  'waiting',
  'checking',
  'pulling-official',
  'downloading-modelscope',
  'verifying',
  'importing',
  'testing',
  'ready',
  'failed',
  'unavailable',
]);
const SOURCES = new Set<Exclude<ModelBootstrapSource, null>>([
  'ollama-registry',
  'modelscope',
  'local',
]);

export class ModelBootstrapError extends Error {
  public readonly expose = true;

  constructor(message: string, public readonly status = 502) {
    super(message);
    this.name = 'ModelBootstrapError';
  }
}

class OllamaBootstrapService {
  private timer: NodeJS.Timeout | null = null;
  private reconciling = false;

  initialize(): void {
    const settings = runtimeConfig.ollamaBootstrap;
    if (!settings.enabled) {
      modelServiceConfigService.releaseManaged('docker-bootstrap');
      setCachedModelBootstrapStatus(this.disabledStatus());
      return;
    }

    const input: ModelServiceConfigInput = {
      name: settings.managedName,
      providerType: 'ollama',
      model: settings.model,
      baseUrl: settings.ollamaBaseUrl,
      apiKey: '',
      contextWindow: settings.contextWindow,
      timeoutMs: settings.timeoutMs,
      maxConcurrency: 1,
    };
    modelServiceConfigService.upsertManagedOllama(input);
    setCachedModelBootstrapStatus({
      enabled: true,
      phase: 'waiting',
      source: null,
      model: settings.model,
      receivedBytes: null,
      totalBytes: null,
      percent: null,
      message: '正在连接本地模型引导服务',
      updatedAt: new Date().toISOString(),
      canRetry: false,
    });
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 5000);
    this.timer.unref();
  }

  async getStatus(): Promise<ModelBootstrapStatus> {
    if (!runtimeConfig.ollamaBootstrap.enabled) return this.disabledStatus();
    await this.refresh();
    return getCachedModelBootstrapStatus();
  }

  async retry(): Promise<ModelBootstrapStatus> {
    if (!runtimeConfig.ollamaBootstrap.enabled) {
      throw new ModelBootstrapError('Docker 本地模型引导未启用', 409);
    }
    try {
      const response = await axios.post(
        `${stripTrailingSlash(runtimeConfig.ollamaBootstrap.serviceUrl)}/retry`,
        {},
        { timeout: 5000, validateStatus: () => true },
      );
      if (response.status === 409) throw new ModelBootstrapError('模型准备任务正在运行，请勿重复提交', 409);
      if (response.status < 200 || response.status >= 300) {
        throw new ModelBootstrapError('模型引导服务拒绝了重试请求', 502);
      }
      const status = normalizeStatus(response.data, runtimeConfig.ollamaBootstrap.model);
      setCachedModelBootstrapStatus(status);
      return status;
    } catch (error) {
      if (error instanceof ModelBootstrapError) throw error;
      throw new ModelBootstrapError('无法连接模型引导服务，请检查 Docker 服务状态', 503);
    }
  }

  private async refresh(): Promise<void> {
    if (!runtimeConfig.ollamaBootstrap.enabled || this.reconciling) return;
    this.reconciling = true;
    try {
      const response = await axios.get(
        `${stripTrailingSlash(runtimeConfig.ollamaBootstrap.serviceUrl)}/status`,
        { timeout: 3000, validateStatus: () => true },
      );
      if (response.status < 200 || response.status >= 300) throw new Error('模型引导状态暂时不可用');
      const status = normalizeStatus(response.data, runtimeConfig.ollamaBootstrap.model);
      setCachedModelBootstrapStatus(status);
      if (status.phase === 'ready') await this.reconcileReadyConfig();
    } catch {
      const previous = getCachedModelBootstrapStatus();
      setCachedModelBootstrapStatus({
        ...previous,
        enabled: true,
        phase: 'unavailable',
        message: '模型引导服务暂时不可用，FolioPaw 其他功能不受影响',
        updatedAt: new Date().toISOString(),
        canRetry: false,
      });
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileReadyConfig(): Promise<void> {
    const config = modelServiceConfigService.getManaged('docker-bootstrap');
    if (!config || config.testedRevision === config.revision) return;
    const startedAt = Date.now();
    try {
      const response = await modelGateway.test(config);
      modelServiceConfigService.recordTest(config.id, config.revision, {
        success: true,
        message: `连接成功，模型 ${response.model} 已返回有效响应`,
        responseTime: response.elapsedMs,
      });
    } catch (error) {
      const message = error instanceof ModelGatewayError || error instanceof Error
        ? error.message
        : 'Ollama 模型测试失败';
      modelServiceConfigService.recordTest(config.id, config.revision, {
        success: false,
        message,
        statusCode: error instanceof ModelGatewayError ? error.upstreamStatus : undefined,
        responseTime: Date.now() - startedAt,
      });
    }
  }

  private disabledStatus(): ModelBootstrapStatus {
    return {
      enabled: false,
      phase: 'disabled',
      source: null,
      model: runtimeConfig.ollamaBootstrap.model,
      receivedBytes: null,
      totalBytes: null,
      percent: null,
      message: 'Docker 本地模型引导未启用',
      updatedAt: new Date().toISOString(),
      canRetry: false,
    };
  }
}

function normalizeStatus(value: unknown, fallbackModel: string): ModelBootstrapStatus {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const phase = typeof raw.phase === 'string' && PHASES.has(raw.phase as ModelBootstrapPhase)
    ? raw.phase as ModelBootstrapPhase
    : 'unavailable';
  const source = typeof raw.source === 'string' && SOURCES.has(raw.source as Exclude<ModelBootstrapSource, null>)
    ? raw.source as Exclude<ModelBootstrapSource, null>
    : null;
  const receivedBytes = nonNegativeNumber(raw.receivedBytes);
  const totalBytes = nonNegativeNumber(raw.totalBytes);
  const percent = totalBytes && receivedBytes !== null
    ? Math.max(0, Math.min(100, Math.round((receivedBytes / totalBytes) * 100)))
    : nonNegativeNumber(raw.percent);
  return {
    enabled: true,
    phase,
    source,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.slice(0, 200) : fallbackModel,
    receivedBytes,
    totalBytes,
    percent: percent === null ? null : Math.min(100, percent),
    message: sanitizeMessage(raw.message, phase),
    updatedAt: validDate(raw.updatedAt),
    canRetry: phase === 'failed',
  };
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function sanitizeMessage(value: unknown, phase: ModelBootstrapPhase): string {
  const defaults: Record<ModelBootstrapPhase, string> = {
    disabled: 'Docker 本地模型引导未启用',
    waiting: '正在等待 Ollama 服务',
    checking: '正在检查本地模型',
    'pulling-official': '正在从 Ollama 官方源下载模型',
    'downloading-modelscope': '正在从 ModelScope 下载模型',
    verifying: '正在校验模型文件',
    importing: '正在将模型导入 Ollama',
    testing: '正在测试本地模型',
    ready: '本地模型已就绪',
    failed: '模型准备失败，请检查网络、磁盘空间和部署配置后重试',
    unavailable: '模型引导服务暂时不可用',
  };
  if (typeof value !== 'string') return defaults[phase];
  const sanitized = value
    .replace(/https?:\/\/[^\s]+/gi, '[下载地址]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
  return /[\u3400-\u9fff]/.test(sanitized) ? sanitized : defaults[phase];
}

function validDate(value: unknown): string {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  return new Date().toISOString();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export const ollamaBootstrapService = new OllamaBootstrapService();
