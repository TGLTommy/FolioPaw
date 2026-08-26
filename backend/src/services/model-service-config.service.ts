import { db } from '../config/database';
import { getCachedModelBootstrapStatus } from './model-bootstrap-state';

export type ModelProviderType = 'openai-compatible' | 'anthropic-compatible' | 'ollama';
export type ModelTestStatus = 'untested' | 'success' | 'failed';
export type ModelConfigManager = 'docker-bootstrap';

export interface ModelServiceConfig {
  id: number;
  name: string;
  providerType: ModelProviderType;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  contextWindow: number | null;
  managedBy: ModelConfigManager | null;
  timeoutMs: number;
  maxConcurrency: number;
  isActive: boolean;
  revision: number;
  testStatus: ModelTestStatus;
  testedRevision: number | null;
  lastTestMessage: string | null;
  lastTestStatusCode: number | null;
  lastTestResponseMs: number | null;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicModelServiceConfig extends Omit<ModelServiceConfig, 'apiKey' | 'managedBy'> {
  hasApiKey: boolean;
  isInUse: boolean;
  isManaged: boolean;
}

export interface ModelServiceConfigInput {
  name: string;
  providerType: ModelProviderType;
  model: string;
  baseUrl?: string | null;
  apiKey?: string;
  contextWindow?: number | null;
  timeoutMs: number;
  maxConcurrency: number;
}

interface ModelServiceConfigRow {
  id: number;
  name: string;
  provider_type: ModelProviderType;
  model: string;
  base_url: string | null;
  api_key: string | null;
  context_window: number | null;
  managed_by: ModelConfigManager | null;
  timeout_ms: number;
  max_concurrency: number;
  is_active: number;
  revision: number;
  test_status: ModelTestStatus;
  tested_revision: number | null;
  last_test_message: string | null;
  last_test_status_code: number | null;
  last_test_response_ms: number | null;
  last_tested_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModelServiceTestRecord {
  success: boolean;
  message: string;
  statusCode?: number;
  responseTime: number;
}

interface NormalizedModelServiceConfigInput {
  name: string;
  providerType: ModelProviderType;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: number | null;
  timeoutMs: number;
  maxConcurrency: number;
}

export class ModelServiceConfigError extends Error {
  public readonly expose = true;

  constructor(message: string, public readonly status: number = 400) {
    super(message);
    this.name = 'ModelServiceConfigError';
  }
}

class ModelServiceConfigService {
  list(): PublicModelServiceConfig[] {
    this.activateSoleTestedConfigIfNeeded();
    const rows = db.prepare(`
      SELECT * FROM model_service_configs
      ORDER BY is_active DESC, updated_at DESC, id DESC
    `).all() as ModelServiceConfigRow[];

    return rows.map((row) => this.toPublic(this.fromRow(row)));
  }

  getById(id: number): ModelServiceConfig {
    const row = db.prepare('SELECT * FROM model_service_configs WHERE id = ?').get(id) as ModelServiceConfigRow | undefined;
    if (!row) throw new ModelServiceConfigError('模型服务配置不存在', 404);
    return this.fromRow(row);
  }

  getActive(): ModelServiceConfig {
    this.activateSoleTestedConfigIfNeeded();
    const row = db.prepare(
      'SELECT * FROM model_service_configs WHERE is_active = 1 LIMIT 1'
    ).get() as ModelServiceConfigRow | undefined;
    if (!row) {
      const managed = db.prepare(
        "SELECT 1 FROM model_service_configs WHERE managed_by = 'docker-bootstrap' LIMIT 1"
      ).get();
      if (managed) {
        const status = getCachedModelBootstrapStatus();
        const progress = status.percent === null ? '' : `（${status.percent}%）`;
        throw new ModelServiceConfigError(
          `本地模型正在准备${progress}：${status.message || status.phase}。请在设置页查看进度或重试`,
          503,
        );
      }
      throw new ModelServiceConfigError('尚未配置激活的模型服务，请前往设置页面完成配置', 503);
    }
    return this.fromRow(row);
  }

  create(input: ModelServiceConfigInput): PublicModelServiceConfig {
    const normalized = this.normalizeInput(input);
    try {
      const result = db.prepare(`
        INSERT INTO model_service_configs (
          name, provider_type, model, base_url, api_key, context_window,
          timeout_ms, max_concurrency, is_active, revision, test_status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'untested', CURRENT_TIMESTAMP)
      `).run(
        normalized.name,
        normalized.providerType,
        normalized.model,
        normalized.baseUrl,
        normalized.apiKey,
        normalized.contextWindow,
        normalized.timeoutMs,
        normalized.maxConcurrency,
      );
      return this.toPublic(this.getById(Number(result.lastInsertRowid)));
    } catch (error) {
      this.rethrowConstraintError(error);
    }
  }

  update(id: number, input: ModelServiceConfigInput): PublicModelServiceConfig {
    const existing = this.getById(id);
    this.assertMutable(existing);
    const normalized = this.normalizeInput(input, existing);

    try {
      db.prepare(`
        UPDATE model_service_configs
        SET name = ?,
            provider_type = ?,
            model = ?,
            base_url = ?,
            api_key = ?,
            context_window = ?,
            timeout_ms = ?,
            max_concurrency = ?,
            revision = revision + 1,
            test_status = 'untested',
            tested_revision = NULL,
            last_test_message = NULL,
            last_test_status_code = NULL,
            last_test_response_ms = NULL,
            last_tested_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        normalized.name,
        normalized.providerType,
        normalized.model,
        normalized.baseUrl,
        normalized.apiKey,
        normalized.contextWindow,
        normalized.timeoutMs,
        normalized.maxConcurrency,
        id,
      );
      return this.toPublic(this.getById(id));
    } catch (error) {
      this.rethrowConstraintError(error);
    }
  }

  delete(id: number): void {
    const existing = this.getById(id);
    this.assertMutable(existing);
    db.prepare('DELETE FROM model_service_configs WHERE id = ?').run(id);
  }

  getManaged(manager: ModelConfigManager): ModelServiceConfig | undefined {
    const row = db.prepare('SELECT * FROM model_service_configs WHERE managed_by = ? LIMIT 1')
      .get(manager) as ModelServiceConfigRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  upsertManagedOllama(input: ModelServiceConfigInput): PublicModelServiceConfig {
    const manager: ModelConfigManager = 'docker-bootstrap';
    let existing = this.getManaged(manager);
    if (!existing) {
      const reclaimable = db.prepare(`
        SELECT id FROM model_service_configs
        WHERE managed_by IS NULL AND provider_type = 'ollama' AND name = ?
        LIMIT 1
      `).get(input.name.trim()) as { id: number } | undefined;
      if (reclaimable) {
        db.prepare(`
          UPDATE model_service_configs
          SET managed_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(manager, reclaimable.id);
        existing = this.getById(reclaimable.id);
      }
    }
    const normalized = this.normalizeInput({ ...input, providerType: 'ollama' }, existing);

    if (!existing) {
      const name = this.uniqueManagedName(normalized.name);
      const result = db.prepare(`
        INSERT INTO model_service_configs (
          name, provider_type, model, base_url, api_key, context_window, managed_by,
          timeout_ms, max_concurrency, is_active, revision, test_status, updated_at
        ) VALUES (?, 'ollama', ?, ?, '', ?, ?, ?, ?, 0, 1, 'untested', CURRENT_TIMESTAMP)
      `).run(
        name,
        normalized.model,
        normalized.baseUrl,
        normalized.contextWindow,
        manager,
        normalized.timeoutMs,
        normalized.maxConcurrency,
      );
      return this.toPublic(this.getById(Number(result.lastInsertRowid)));
    }

    const changed = existing.name !== normalized.name
      || existing.model !== normalized.model
      || existing.baseUrl !== normalized.baseUrl
      || existing.contextWindow !== normalized.contextWindow
      || existing.timeoutMs !== normalized.timeoutMs
      || existing.maxConcurrency !== normalized.maxConcurrency;
    if (!changed) return this.toPublic(existing);

    db.prepare(`
      UPDATE model_service_configs
      SET name = ?, model = ?, base_url = ?, api_key = '', context_window = ?,
          timeout_ms = ?, max_concurrency = ?, is_active = 0,
          revision = revision + 1, test_status = 'untested', tested_revision = NULL,
          last_test_message = NULL, last_test_status_code = NULL,
          last_test_response_ms = NULL, last_tested_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      normalized.name,
      normalized.model,
      normalized.baseUrl,
      normalized.contextWindow,
      normalized.timeoutMs,
      normalized.maxConcurrency,
      existing.id,
    );
    return this.toPublic(this.getById(existing.id));
  }

  releaseManaged(manager: ModelConfigManager): void {
    db.prepare(`
      UPDATE model_service_configs
      SET managed_by = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE managed_by = ?
    `).run(manager);
  }

  recordTest(id: number, revision: number, result: ModelServiceTestRecord): PublicModelServiceConfig {
    const config = this.getById(id);
    if (config.revision !== revision) {
      throw new ModelServiceConfigError('配置在测试过程中已发生变化，请重新测试', 409);
    }

    db.prepare(`
      UPDATE model_service_configs
      SET test_status = ?,
          tested_revision = ?,
          last_test_message = ?,
          last_test_status_code = ?,
          last_test_response_ms = ?,
          last_tested_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ?
    `).run(
      result.success ? 'success' : 'failed',
      revision,
      result.message,
      result.statusCode ?? null,
      result.responseTime,
      id,
      revision,
    );

    // The first usable model should work immediately after a successful test.
    // Keep an existing active model unchanged when users are testing a
    // replacement configuration.
    if (result.success) this.activateIfNone(id);

    return this.toPublic(this.getById(id));
  }

  activate(id: number): PublicModelServiceConfig {
    const target = this.getById(id);
    if (target.isActive) return this.toPublic(target);
    if (target.testStatus !== 'success' || target.testedRevision !== target.revision) {
      throw new ModelServiceConfigError('当前版本尚未测试成功，不能启用', 409);
    }

    const activateTransaction = db.transaction(() => {
      db.prepare('UPDATE model_service_configs SET is_active = 0 WHERE is_active = 1').run();
      db.prepare(`
        UPDATE model_service_configs
        SET is_active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(id);
    });
    activateTransaction();
    return this.toPublic(this.getById(id));
  }

  isInUse(id: number): boolean {
    const job = db.prepare(`
      SELECT 1 FROM translation_jobs
      WHERE model_config_id = ? AND status IN ('pending', 'processing')
      LIMIT 1
    `).get(id);
    if (job) return true;

    return Boolean(db.prepare(`
      SELECT 1 FROM book_reading_guides
      WHERE model_config_id = ? AND status IN ('pending', 'generating')
      LIMIT 1
    `).get(id));
  }

  toPublic(config: ModelServiceConfig): PublicModelServiceConfig {
    const { apiKey, managedBy, ...safe } = config;
    return {
      ...safe,
      hasApiKey: Boolean(apiKey),
      isInUse: this.isInUse(config.id),
      isManaged: Boolean(managedBy),
    };
  }

  private assertMutable(config: ModelServiceConfig): void {
    if (config.managedBy) {
      throw new ModelServiceConfigError('该配置由 Docker 本地模型服务托管，不能手动编辑或删除', 409);
    }
    if (config.isActive) {
      throw new ModelServiceConfigError('激活中的配置不能编辑或删除，请先创建并启用另一套配置', 409);
    }
    if (this.isInUse(config.id)) {
      throw new ModelServiceConfigError('该配置正被后台任务使用，暂时不能编辑或删除', 409);
    }
  }

  private activateIfNone(id: number): boolean {
    const result = db.prepare(`
      UPDATE model_service_configs
      SET is_active = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND test_status = 'success'
        AND tested_revision = revision
        AND NOT EXISTS (
          SELECT 1 FROM model_service_configs WHERE is_active = 1
        )
    `).run(id);
    return result.changes > 0;
  }

  private activateSoleTestedConfigIfNeeded(): void {
    const candidates = db.prepare(`
      SELECT id
      FROM model_service_configs
      WHERE test_status = 'success' AND tested_revision = revision
        AND NOT EXISTS (
          SELECT 1 FROM model_service_configs WHERE is_active = 1
        )
      ORDER BY last_tested_at DESC, updated_at DESC, id DESC
      LIMIT 2
    `).all() as Array<{ id: number }>;

    // Repair data created by older versions, but avoid making an arbitrary
    // choice when several tested configurations are available.
    if (candidates.length === 1) this.activateIfNone(candidates[0].id);
  }

  private normalizeInput(
    input: ModelServiceConfigInput,
    existing?: ModelServiceConfig,
  ): NormalizedModelServiceConfigInput {
    const name = input.name.trim();
    const model = input.model.trim();
    if (!name || !model) throw new ModelServiceConfigError('配置名称和模型不能为空');

    const baseUrl = (input.baseUrl || '').trim();
    if (!baseUrl) throw new ModelServiceConfigError('API 地址不能为空');
    const isOllama = input.providerType === 'ollama';
    const apiKey = isOllama
      ? ''
      : input.apiKey?.trim() || existing?.apiKey || '';
    if (!isOllama && !apiKey) throw new ModelServiceConfigError('API Key 不能为空');

    const contextWindow = isOllama ? (input.contextWindow ?? 32768) : null;
    if (
      contextWindow !== null
      && (!Number.isInteger(contextWindow) || contextWindow < 4096 || contextWindow > 262144)
    ) {
      throw new ModelServiceConfigError('上下文窗口必须是 4096 到 262144 之间的整数');
    }

    return {
      ...input,
      name,
      model,
      baseUrl,
      apiKey,
      contextWindow,
    };
  }

  private fromRow(row: ModelServiceConfigRow): ModelServiceConfig {
    return {
      id: row.id,
      name: row.name,
      providerType: row.provider_type,
      model: row.model,
      baseUrl: row.base_url,
      apiKey: row.api_key,
      contextWindow: row.context_window,
      managedBy: row.managed_by,
      timeoutMs: row.timeout_ms,
      maxConcurrency: row.max_concurrency,
      isActive: row.is_active === 1,
      revision: row.revision,
      testStatus: row.test_status,
      testedRevision: row.tested_revision,
      lastTestMessage: row.last_test_message,
      lastTestStatusCode: row.last_test_status_code,
      lastTestResponseMs: row.last_test_response_ms,
      lastTestedAt: row.last_tested_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rethrowConstraintError(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed: model_service_configs\.name/i.test(message)) {
      throw new ModelServiceConfigError('配置名称已存在', 409);
    }
    throw error;
  }

  private uniqueManagedName(preferred: string): string {
    if (!db.prepare('SELECT 1 FROM model_service_configs WHERE name = ?').get(preferred)) return preferred;
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = `${preferred} ${suffix}`;
      if (!db.prepare('SELECT 1 FROM model_service_configs WHERE name = ?').get(candidate)) return candidate;
    }
    throw new ModelServiceConfigError('无法为 Docker Ollama 配置生成唯一名称', 409);
  }
}

export const modelServiceConfigService = new ModelServiceConfigService();
