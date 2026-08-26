import { Router } from 'express';
import { z } from 'zod';
import { modelGateway, ModelGatewayError } from '../services/model-gateway.service';
import {
  modelServiceConfigService,
  ModelServiceConfigError,
  type ModelServiceConfigInput,
} from '../services/model-service-config.service';
import {
  ModelBootstrapError,
  ollamaBootstrapService,
} from '../services/ollama-bootstrap.service';

const router = Router();

const commonFields = {
  name: z.string().trim().min(1, '配置名称不能为空').max(80),
  model: z.string().trim().min(1, '模型不能为空').max(200),
  timeoutMs: z.number().int().min(1000).max(1800000),
  maxConcurrency: z.number().int().min(1).max(32),
};

const contextWindow = z.number().int().min(4096).max(262144);

const apiUrl = z.string().trim().url('API 地址格式无效').refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'API 地址只支持 http 或 https');

const modelServiceInputSchema = z.discriminatedUnion('providerType', [
  z.object({
    ...commonFields,
    providerType: z.literal('openai-compatible'),
    baseUrl: apiUrl,
    apiKey: z.string().max(4000).optional(),
    contextWindow: z.null().optional(),
  }),
  z.object({
    ...commonFields,
    providerType: z.literal('anthropic-compatible'),
    baseUrl: apiUrl,
    apiKey: z.string().max(4000).optional(),
    contextWindow: z.null().optional(),
  }),
  z.object({
    ...commonFields,
    providerType: z.literal('ollama'),
    baseUrl: apiUrl,
    apiKey: z.string().max(4000).optional(),
    contextWindow,
  }),
]);

router.get('/bootstrap', async (_req, res, next) => {
  try {
    const status = await ollamaBootstrapService.getStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    next(normalizeRouteError(error));
  }
});

router.post('/bootstrap/retry', async (_req, res, next) => {
  try {
    const status = await ollamaBootstrapService.retry();
    res.status(202).json({ success: true, data: status });
  } catch (error) {
    next(normalizeRouteError(error));
  }
});

router.get('/', (_req, res, next) => {
  try {
    res.json({ success: true, data: modelServiceConfigService.list() });
  } catch (error) {
    next(error);
  }
});

router.post('/', (req, res, next) => {
  try {
    const input = parseInput(req.body);
    const config = modelServiceConfigService.create(input);
    res.status(201).json({ success: true, data: config });
  } catch (error) {
    next(normalizeRouteError(error));
  }
});

router.put('/:id', (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const input = parseInput(req.body);
    const config = modelServiceConfigService.update(id, input);
    res.json({ success: true, data: config });
  } catch (error) {
    next(normalizeRouteError(error));
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    modelServiceConfigService.delete(parseId(req.params.id));
    res.json({ success: true });
  } catch (error) {
    next(normalizeRouteError(error));
  }
});

router.post('/:id/test', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const config = modelServiceConfigService.getById(id);
    const startedAt = Date.now();

    try {
      const response = await modelGateway.test(config);
      const testMessage = `连接成功，模型 ${response.model} 已返回有效响应`;
      const updatedConfig = modelServiceConfigService.recordTest(id, config.revision, {
        success: true,
        message: testMessage,
        responseTime: response.elapsedMs,
      });
      const autoActivated = !config.isActive && updatedConfig.isActive;
      const message = autoActivated
        ? `${testMessage}；当前没有激活服务，已自动启用此配置`
        : testMessage;
      res.json({
        success: true,
        data: {
          success: true,
          provider: providerLabel(config.providerType),
          providerType: config.providerType,
          model: response.model,
          message,
          responseTime: response.elapsedMs,
          config: updatedConfig,
        },
      });
    } catch (error) {
      const responseTime = Date.now() - startedAt;
      const statusCode = error instanceof ModelGatewayError ? error.upstreamStatus : undefined;
      const message = error instanceof Error ? error.message : '模型服务连接失败';
      const updatedConfig = modelServiceConfigService.recordTest(id, config.revision, {
        success: false,
        message,
        statusCode,
        responseTime,
      });
      res.json({
        success: true,
        data: {
          success: false,
          provider: providerLabel(config.providerType),
          providerType: config.providerType,
          model: config.model,
          message,
          responseTime,
          statusCode,
          error: message,
          config: updatedConfig,
        },
      });
    }
  } catch (error) {
    next(normalizeRouteError(error));
  }
});

router.put('/:id/activate', (req, res, next) => {
  try {
    const config = modelServiceConfigService.activate(parseId(req.params.id));
    res.json({ success: true, data: config });
  } catch (error) {
    next(normalizeRouteError(error));
  }
});

function parseInput(value: unknown): ModelServiceConfigInput {
  const result = modelServiceInputSchema.safeParse(value);
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join('；');
    throw new ModelServiceConfigError(message || '配置参数无效', 400);
  }
  return result.data;
}

function parseId(value: string): number {
  const id = Number.parseInt(value, 10);
  if (!Number.isFinite(id) || id <= 0) throw new ModelServiceConfigError('配置 ID 无效', 400);
  return id;
}

function normalizeRouteError(error: unknown): unknown {
  if (
    error instanceof ModelServiceConfigError
    || error instanceof ModelGatewayError
    || error instanceof ModelBootstrapError
  ) return error;
  return error;
}

function providerLabel(providerType: string): string {
  if (providerType === 'anthropic-compatible') return 'Anthropic 兼容';
  if (providerType === 'ollama') return 'Ollama 本地';
  return 'OpenAI 兼容';
}

export default router;
