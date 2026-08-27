import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { test } from 'vitest';
import { db, initDatabase, migrateModelServiceConfigsToV3 } from '../config/database';
import { CURRENT_SCHEMA_VERSION } from '../config/migration-manager';
import {
  modelServiceConfigService,
  type ModelProviderType,
  type ModelServiceConfig,
} from './model-service-config.service';
import {
  ModelGatewayError,
  ModelGatewayService,
  normalizeModelEndpoint,
  type ModelHttpTransport,
} from './model-gateway.service';
import {
  estimateTokenCount,
  splitTextByTokenBudget,
} from './model-context-budget.service';

function makeConfig(overrides: Partial<ModelServiceConfig> = {}): ModelServiceConfig {
  return {
    id: 100,
    name: 'test config',
    providerType: 'openai-compatible',
    model: 'test-model',
    baseUrl: 'https://example.test/v1',
    apiKey: 'example-test-credential',
    contextWindow: null,
    managedBy: null,
    timeoutMs: 5000,
    maxConcurrency: 2,
    isActive: false,
    revision: 1,
    testStatus: 'untested',
    testedRevision: null,
    lastTestMessage: null,
    lastTestStatusCode: null,
    lastTestResponseMs: null,
    lastTestedAt: null,
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
    ...overrides,
  };
}

test('database migration removes CLI configs, imports legacy API configs, and stays idempotent', () => {
  db.exec(`
    CREATE TABLE model_service_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      provider_type TEXT NOT NULL
        CHECK(provider_type IN ('codex-cli', 'openai-compatible', 'anthropic-compatible')),
      model TEXT NOT NULL,
      base_url TEXT,
      api_key TEXT,
      cli_path TEXT,
      reasoning_effort TEXT,
      timeout_ms INTEGER NOT NULL DEFAULT 180000,
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 1,
      test_status TEXT NOT NULL DEFAULT 'untested'
        CHECK(test_status IN ('untested', 'success', 'failed')),
      tested_revision INTEGER,
      last_test_message TEXT,
      last_test_status_code INTEGER,
      last_test_response_ms INTEGER,
      last_tested_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO model_service_configs (
      name, provider_type, model, cli_path, reasoning_effort, is_active
    ) VALUES ('Removed CLI', 'codex-cli', 'local-model', 'codex', 'low', 1);
    INSERT INTO model_service_configs (
      name, provider_type, model, base_url, api_key
    ) VALUES ('Existing API', 'anthropic-compatible', 'claude-test', 'https://anthropic.test', 'existing-key');

    CREATE TABLE translation_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      api_url TEXT NOT NULL,
      api_key TEXT,
      model TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO translation_configs (name, api_url, api_key, model)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?)
  `).run(
    '__env_config__', 'https://ignored.test/v1', 'ignored-key', 'ignored-model',
    'Legacy Gateway', 'https://legacy.test/v1', 'legacy-secret', 'legacy-model',
  );

  initDatabase();
  initDatabase();

  const configs = db.prepare(`
    SELECT name, provider_type, is_active, test_status
    FROM model_service_configs
    ORDER BY id
  `).all() as Array<{
    name: string;
    provider_type: ModelProviderType;
    is_active: number;
    test_status: string;
  }>;

  assert.equal(configs.filter((config) => config.is_active === 1).length, 0);
  assert.equal(configs.some((config) => config.name === 'Removed CLI'), false);
  assert.equal(configs.some((config) => config.name === 'Existing API'), true);
  assert.deepEqual(
    configs.find((config) => config.name === 'Legacy Gateway'),
    {
      name: 'Legacy Gateway',
      provider_type: 'openai-compatible',
      is_active: 0,
      test_status: 'untested',
    },
  );
  assert.equal(configs.some((config) => config.name === '__env_config__'), false);
  assert.equal(
    (db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version,
    CURRENT_SCHEMA_VERSION,
  );
  const configColumns = db.pragma('table_info(model_service_configs)') as Array<{ name: string }>;
  assert.equal(configColumns.some((column) => column.name === 'context_window'), true);
  assert.equal(configColumns.some((column) => column.name === 'managed_by'), true);

  const jobColumn = (db.pragma('table_info(translation_jobs)') as Array<{ name: string }>)
    .some((column) => column.name === 'model_config_id');
  const guideColumn = (db.pragma('table_info(book_reading_guides)') as Array<{ name: string }>)
    .some((column) => column.name === 'model_config_id');
  assert.equal(jobColumn, true);
  assert.equal(guideColumn, true);

  const legacy = db.prepare(
    "SELECT id FROM model_service_configs WHERE name = 'Legacy Gateway'"
  ).get() as { id: number };
  db.prepare('UPDATE model_service_configs SET is_active = 1 WHERE id = ?').run(legacy.id);
  assert.throws(
    () => db.prepare("UPDATE model_service_configs SET is_active = 1 WHERE name = 'Existing API'").run(),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO model_service_configs (
        name, provider_type, model, base_url, api_key
      ) VALUES ('Invalid CLI', 'codex-cli', 'model', 'https://example.test', 'key')
    `).run(),
    /CHECK constraint failed/,
  );
});

test('v2 to v3 model migration preserves config IDs, test state, activation, and task references', () => {
  const legacy = new Database(':memory:');
  try {
    legacy.exec(`
      CREATE TABLE model_service_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        provider_type TEXT NOT NULL CHECK(provider_type IN ('openai-compatible', 'anthropic-compatible')),
        model TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL DEFAULT 180000,
        max_concurrency INTEGER NOT NULL DEFAULT 1,
        is_active INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        test_status TEXT NOT NULL DEFAULT 'untested',
        tested_revision INTEGER,
        last_test_message TEXT,
        last_test_status_code INTEGER,
        last_test_response_ms INTEGER,
        last_tested_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO model_service_configs (
        id, name, provider_type, model, base_url, api_key, is_active, revision,
        test_status, tested_revision, last_test_message, last_test_response_ms
      ) VALUES (
        42, 'Preserved Cloud', 'openai-compatible', 'cloud-model',
        'https://cloud.test/v1', 'secret', 1, 7, 'success', 7, 'ok', 99
      );
      CREATE TABLE translation_jobs (id INTEGER PRIMARY KEY, model_config_id INTEGER);
      CREATE TABLE book_reading_guides (id INTEGER PRIMARY KEY, model_config_id INTEGER);
      INSERT INTO translation_jobs VALUES (1, 42);
      INSERT INTO book_reading_guides VALUES (2, 42);
    `);

    migrateModelServiceConfigsToV3(legacy);

    const preserved = legacy.prepare(`
      SELECT id, is_active, revision, test_status, tested_revision, context_window, managed_by
      FROM model_service_configs WHERE id = 42
    `).get() as Record<string, unknown>;
    assert.deepEqual(preserved, {
      id: 42,
      is_active: 1,
      revision: 7,
      test_status: 'success',
      tested_revision: 7,
      context_window: null,
      managed_by: null,
    });
    assert.equal(
      (legacy.prepare('SELECT model_config_id FROM translation_jobs WHERE id = 1').get() as any).model_config_id,
      42,
    );
    assert.equal(
      (legacy.prepare('SELECT model_config_id FROM book_reading_guides WHERE id = 2').get() as any).model_config_id,
      42,
    );
    assert.doesNotThrow(() => legacy.prepare(`
      INSERT INTO model_service_configs (
        name, provider_type, model, base_url, api_key, context_window
      ) VALUES ('Local', 'ollama', 'qwen3.5:4b', 'http://ollama:11434', '', 32768)
    `).run());
  } finally {
    legacy.close();
  }
});

test('the first successfully tested config becomes active and legacy inactive state self-heals', () => {
  db.prepare('UPDATE model_service_configs SET is_active = 0').run();
  const created = modelServiceConfigService.create({
    name: 'First usable profile',
    providerType: 'openai-compatible',
    model: 'first-usable-model',
    baseUrl: 'https://first-usable.test/v1',
    apiKey: 'first-usable-key',
    timeoutMs: 9000,
    maxConcurrency: 1,
  });

  const tested = modelServiceConfigService.recordTest(created.id, created.revision, {
    success: true,
    message: 'ok',
    responseTime: 12,
  });
  assert.equal(tested.isActive, true);
  assert.equal(modelServiceConfigService.getActive().id, created.id);

  // Simulate a database written by the older two-step test/activate flow.
  db.prepare('UPDATE model_service_configs SET is_active = 0 WHERE id = ?').run(created.id);
  const repaired = modelServiceConfigService.list().find((config) => config.id === created.id);
  assert.equal(repaired?.isActive, true);
  assert.equal(modelServiceConfigService.getActive().id, created.id);
});

test('config service never exposes API keys and enforces revision testing before activation', () => {
  const secret = 'example-never-return-this-secret';
  const created = modelServiceConfigService.create({
    name: 'OpenAI test profile',
    providerType: 'openai-compatible',
    model: 'gpt-test',
    baseUrl: 'https://provider.test/v1',
    apiKey: secret,
    timeoutMs: 9000,
    maxConcurrency: 3,
  });

  assert.equal(created.hasApiKey, true);
  assert.equal('apiKey' in created, false);
  assert.equal('managedBy' in created, false);
  assert.equal(JSON.stringify(created).includes(secret), false);
  assert.throws(() => modelServiceConfigService.activate(created.id), /尚未测试成功/);

  const updated = modelServiceConfigService.update(created.id, {
    name: created.name,
    providerType: 'openai-compatible',
    model: 'gpt-test-v2',
    baseUrl: 'https://provider.test/v1',
    apiKey: '',
    timeoutMs: 10000,
    maxConcurrency: 2,
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.testStatus, 'untested');
  assert.equal(modelServiceConfigService.getById(created.id).apiKey, secret);

  modelServiceConfigService.recordTest(created.id, updated.revision, {
    success: true,
    message: 'ok',
    responseTime: 12,
  });
  const activated = modelServiceConfigService.activate(created.id);
  assert.equal(activated.isActive, true);
  assert.equal(modelServiceConfigService.list().filter((config) => config.isActive).length, 1);
  assert.throws(
    () => modelServiceConfigService.update(created.id, {
      name: created.name,
      providerType: 'openai-compatible',
      model: 'another-model',
      baseUrl: 'https://provider.test/v1',
      timeoutMs: 10000,
      maxConcurrency: 2,
    }),
    /激活中的配置不能编辑/,
  );
});

test('Ollama accepts an empty API key while cloud providers still reject it', () => {
  const ollama = modelServiceConfigService.create({
    name: 'Local Ollama test profile',
    providerType: 'ollama',
    model: 'qwen3.5:4b',
    baseUrl: 'http://127.0.0.1:11434',
    apiKey: '',
    contextWindow: 32768,
    timeoutMs: 1800000,
    maxConcurrency: 1,
  });
  assert.equal(ollama.hasApiKey, false);
  assert.equal(ollama.contextWindow, 32768);
  assert.equal('apiKey' in ollama, false);
  assert.throws(() => modelServiceConfigService.create({
    name: 'Cloud without key',
    providerType: 'openai-compatible',
    model: 'cloud-model',
    baseUrl: 'https://cloud-without-key.test/v1',
    apiKey: '',
    timeoutMs: 10000,
    maxConcurrency: 1,
  }), /API Key 不能为空/);
});

test('Docker-managed Ollama is idempotent, immutable while managed, and reclaimable after release', () => {
  const input = {
    name: 'Docker managed test profile',
    providerType: 'ollama' as const,
    model: 'qwen3.5:4b',
    baseUrl: 'http://ollama:11434',
    apiKey: '',
    contextWindow: 32768,
    timeoutMs: 1800000,
    maxConcurrency: 1,
  };
  const first = modelServiceConfigService.upsertManagedOllama(input);
  const repeated = modelServiceConfigService.upsertManagedOllama(input);
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.revision, first.revision);
  assert.equal(repeated.isManaged, true);
  assert.throws(() => modelServiceConfigService.delete(first.id), /Docker 本地模型服务托管/);

  modelServiceConfigService.releaseManaged('docker-bootstrap');
  assert.equal(modelServiceConfigService.toPublic(modelServiceConfigService.getById(first.id)).isManaged, false);
  const reclaimed = modelServiceConfigService.upsertManagedOllama(input);
  assert.equal(reclaimed.id, first.id);
  assert.equal(reclaimed.isManaged, true);
});

test('protocol changes preserve the saved API key and in-use configs are locked', () => {
  const config = modelServiceConfigService.create({
    name: 'Switchable profile',
    providerType: 'anthropic-compatible',
    model: 'claude-test',
    baseUrl: 'https://anthropic.test',
    apiKey: 'anthropic-secret',
    timeoutMs: 10000,
    maxConcurrency: 1,
  });
  modelServiceConfigService.update(config.id, {
    name: config.name,
    providerType: 'openai-compatible',
    model: 'gpt-test',
    baseUrl: 'https://openai.test/v1',
    apiKey: '',
    timeoutMs: 10000,
    maxConcurrency: 1,
  });
  const switched = modelServiceConfigService.getById(config.id);
  assert.equal(switched.baseUrl, 'https://openai.test/v1');
  assert.equal(switched.apiKey, 'anthropic-secret');

  const bookId = Number(db.prepare(`
    INSERT INTO books (
      filename, original_name, file_path, file_type, file_size, total_pages, user_id
    ) VALUES ('test.epub', 'Test', '/tmp/test.epub', 'epub', 1, 1, 1)
  `).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO translation_jobs (
      book_id, user_id, status, start_page, end_page, total_pages,
      current_page, processed_pages, model_config_id
    ) VALUES (?, 1, 'processing', 1, 1, 1, 1, 0, ?)
  `).run(bookId, config.id);

  assert.equal(modelServiceConfigService.isInUse(config.id), true);
  assert.throws(() => modelServiceConfigService.delete(config.id), /后台任务使用/);
});

test('normalizes base and complete provider endpoints', () => {
  assert.equal(
    normalizeModelEndpoint('openai-compatible', 'https://api.example.test/v1'),
    'https://api.example.test/v1/chat/completions',
  );
  assert.equal(
    normalizeModelEndpoint('openai-compatible', 'https://api.example.test/chat/completions'),
    'https://api.example.test/chat/completions',
  );
  assert.equal(
    normalizeModelEndpoint('anthropic-compatible', 'https://api.example.test'),
    'https://api.example.test/v1/messages',
  );
  assert.equal(
    normalizeModelEndpoint('ollama', 'http://ollama:11434'),
    'http://ollama:11434/api/chat',
  );
  assert.equal(
    normalizeModelEndpoint('ollama', 'http://ollama:11434/api'),
    'http://ollama:11434/api/chat',
  );
  assert.throws(
    () => normalizeModelEndpoint('openai-compatible', 'file:///tmp/provider'),
    /只支持 http 或 https/,
  );
});

test('Ollama adapter uses native chat JSON mode without authorization headers', async () => {
  const captures: Array<{ url: string; body: any; headers: Record<string, string>; timeout: number }> = [];
  const gateway = new ModelGatewayService({
    async post(url, body, options) {
      captures.push({ url, body, headers: options.headers, timeout: options.timeout });
      return { status: 200, data: { model: 'qwen3.5:4b', message: { content: ' {"ok":true} ' } } };
    },
  });
  const config = makeConfig({
    providerType: 'ollama',
    baseUrl: 'http://ollama:11434/api',
    model: 'qwen3.5:4b',
    apiKey: null,
    contextWindow: 32768,
    timeoutMs: 1800000,
    maxConcurrency: 1,
  });
  const response = await gateway.call({
    userMessage: 'Return JSON',
    maxTokens: 512,
    responseFormat: 'json',
  }, { config });

  assert.equal(response.text, '{"ok":true}');
  assert.equal(captures[0].url, 'http://ollama:11434/api/chat');
  assert.deepEqual(captures[0].headers, { 'Content-Type': 'application/json' });
  assert.equal('Authorization' in captures[0].headers, false);
  assert.equal(captures[0].body.stream, false);
  assert.equal(captures[0].body.think, false);
  assert.equal(captures[0].body.format, 'json');
  assert.equal(captures[0].body.options.num_ctx, 32768);
  assert.equal(captures[0].body.options.num_predict, 512);
  assert.equal(captures[0].timeout, 1800000);
  assert.match(captures[0].body.messages[0].content, /自然语言内容都必须使用简体中文/);
});

test('Ollama adapter reports missing models and rejects requests over the context budget', async () => {
  const config = makeConfig({
    providerType: 'ollama',
    baseUrl: 'http://ollama:11434',
    model: 'missing-model',
    apiKey: null,
    contextWindow: 4096,
  });
  let calls = 0;
  const missingGateway = new ModelGatewayService({
    async post() {
      calls += 1;
      return { status: 404, data: { error: 'model not found' } };
    },
  });
  await assert.rejects(
    missingGateway.call({ userMessage: 'short' }, { config }),
    /未找到模型 missing-model/,
  );
  assert.equal(calls, 1);

  const upstreamContextGateway = new ModelGatewayService({
    async post() {
      return { status: 400, data: { error: 'input exceeds maximum context length' } };
    },
  });
  await assert.rejects(
    upstreamContextGateway.call(
      { userMessage: 'short' },
      { config: { ...config, model: 'qwen3.5:4b', contextWindow: 32768 } },
    ),
    (error: unknown) =>
      error instanceof ModelGatewayError
      && error.status === 422
      && error.upstreamStatus === 400,
  );

  const oversizedGateway = new ModelGatewayService({
    async post() {
      calls += 1;
      return { status: 200, data: { message: { content: 'should not run' } } };
    },
  });
  await assert.rejects(
    oversizedGateway.call({ userMessage: '中'.repeat(3000), maxTokens: 1024 }, { config }),
    (error: unknown) => error instanceof ModelGatewayError && error.status === 422,
  );
  assert.equal(calls, 1);
});

test('context estimator and splitter keep mixed-language chunks inside the budget', () => {
  assert.equal(estimateTokenCount('abc'), 1);
  assert.equal(estimateTokenCount('中文'), 3);
  assert.equal(estimateTokenCount('abc中文'), 4);
  const chunks = splitTextByTokenBudget(`第一段${'中'.repeat(50)}\n\n${'ascii '.repeat(60)}`, 40);
  assert.ok(chunks.length > 2);
  assert.equal(chunks.every((chunk) => estimateTokenCount(chunk) <= 40), true);
  assert.equal(chunks.join('').replace(/\s/g, '').includes('第一段'), true);
});

test('OpenAI compatible adapter sends standard Chat Completions request', async () => {
  const captures: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const transport: ModelHttpTransport = {
    async post(url, body, options) {
      captures.push({ url, body, headers: options.headers });
      return {
        status: 200,
        data: { model: 'returned-model', choices: [{ message: { content: '  hello  ' } }] },
      };
    },
  };
  const gateway = new ModelGatewayService(transport);
  const config = makeConfig();
  const response = await gateway.call({
    systemPrompt: 'Be precise.',
    userMessage: 'Say hello',
    task: 'Test OpenAI transport',
    maxTokens: 20,
  }, { config });

  assert.equal(response.text, 'hello');
  assert.equal(response.model, 'returned-model');
  const captured = captures[0];
  assert.ok(captured);
  assert.equal(captured.url, 'https://example.test/v1/chat/completions');
  assert.deepEqual(Object.keys(captured.headers).sort(), ['Authorization', 'Content-Type']);
  assert.equal(captured.headers.Authorization, `Bearer ${config.apiKey}`);
  assert.equal(captured.body.model, config.model);
  assert.equal(captured.body.messages[0].role, 'system');
  assert.equal(captured.body.messages[1].content, 'Say hello');
  assert.equal(captured.body.max_tokens, 20);
});

test('Anthropic compatible adapter sends standard Messages request', async () => {
  const captures: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const transport: ModelHttpTransport = {
    async post(url, body, options) {
      captures.push({ url, body, headers: options.headers });
      return {
        status: 200,
        data: {
          model: 'claude-returned',
          content: [{ type: 'text', text: 'first' }, { type: 'text', text: ' second' }],
        },
      };
    },
  };
  const gateway = new ModelGatewayService(transport);
  const config = makeConfig({
    providerType: 'anthropic-compatible',
    baseUrl: 'https://anthropic.example.test/v1/messages',
  });
  const response = await gateway.call({ userMessage: 'Hello', maxTokens: 50 }, { config });

  assert.equal(response.text, 'first second');
  const captured = captures[0];
  assert.ok(captured);
  assert.equal(captured.url, 'https://anthropic.example.test/v1/messages');
  assert.deepEqual(Object.keys(captured.headers).sort(), ['Content-Type', 'anthropic-version', 'x-api-key']);
  assert.equal(captured.headers['x-api-key'], config.apiKey);
  assert.equal(captured.body.system.includes('后端模型服务'), true);
  assert.deepEqual(captured.body.messages, [{ role: 'user', content: 'Hello' }]);
});

test('upstream auth errors stay non-401 and redact API keys', async () => {
  const config = makeConfig({ apiKey: 'example-private-upstream-key' });
  const gateway = new ModelGatewayService({
    async post() {
      return {
        status: 401,
        data: { error: { message: `invalid api_key=${config.apiKey} Bearer ${config.apiKey}` } },
      };
    },
  });

  await assert.rejects(
    gateway.call({ userMessage: 'hello' }, { config }),
    (error: unknown) => {
      assert.ok(error instanceof ModelGatewayError);
      assert.equal(error.status, 502);
      assert.equal(error.upstreamStatus, 401);
      assert.equal(error.message.includes(config.apiKey!), false);
      assert.match(error.message, /鉴权失败/);
      return true;
    },
  );
});

test('gateway enforces configured concurrency and honors queued cancellation', async () => {
  let active = 0;
  let peak = 0;
  const gateway = new ModelGatewayService({
    async post() {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { status: 200, data: { choices: [{ message: { content: 'ok' } }] } };
    },
  });
  const config = makeConfig({ maxConcurrency: 2 });
  const controller = new AbortController();
  const calls = [
    gateway.call({ userMessage: 'one' }, { config }),
    gateway.call({ userMessage: 'two' }, { config }),
    gateway.call({ userMessage: 'three', signal: controller.signal }, { config }),
  ];
  controller.abort();

  const results = await Promise.allSettled(calls);
  assert.equal(peak, 2);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
  assert.equal(results[2].status, 'rejected');
  if (results[2].status === 'rejected') {
    assert.equal(results[2].reason.name, 'AbortError');
  }
});

test('OpenAI compatible adapter requests structured JSON output when responseFormat is json', async () => {
  const captures: Array<{ body: any }> = [];
  const transport: ModelHttpTransport = {
    async post(_url, body) {
      captures.push({ body });
      return {
        status: 200,
        data: { model: 'm', choices: [{ message: { content: '{"pages":[]}' } }] },
      };
    },
  };
  const gateway = new ModelGatewayService(transport);
  await gateway.call({
    userMessage: '翻译',
    maxTokens: 100,
    responseFormat: 'json',
  }, { config: makeConfig() });

  assert.deepEqual(captures[0].body.response_format, { type: 'json_object' });
});

test('OpenAI compatible adapter omits response_format for plain text requests', async () => {
  const captures: Array<{ body: any }> = [];
  const transport: ModelHttpTransport = {
    async post(_url, body) {
      captures.push({ body });
      return {
        status: 200,
        data: { model: 'm', choices: [{ message: { content: 'ok' } }] },
      };
    },
  };
  const gateway = new ModelGatewayService(transport);
  await gateway.call({ userMessage: 'hi', maxTokens: 100 }, { config: makeConfig() });

  assert.equal('response_format' in captures[0].body, false);
});

test('OpenAI compatible adapter explains output truncated by max_tokens instead of a generic empty error', async () => {
  const transport: ModelHttpTransport = {
    async post() {
      return {
        status: 200,
        data: {
          model: 'm',
          choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: '思考中……' } }],
        },
      };
    },
  };
  const gateway = new ModelGatewayService(transport);
  await assert.rejects(
    gateway.call({ userMessage: '翻译', maxTokens: 100 }, { config: makeConfig() }),
    (error: unknown) => {
      assert.ok(error instanceof ModelGatewayError);
      assert.match(error.message, /截断|max_tokens/);
      return true;
    },
  );
});

test('OpenAI compatible adapter explains reasoning-only responses without a final answer', async () => {
  const transport: ModelHttpTransport = {
    async post() {
      return {
        status: 200,
        data: {
          model: 'm',
          choices: [{ finish_reason: 'stop', message: { content: '', reasoning_content: '只有思考内容' } }],
        },
      };
    },
  };
  const gateway = new ModelGatewayService(transport);
  await assert.rejects(
    gateway.call({ userMessage: '翻译', maxTokens: 100 }, { config: makeConfig() }),
    (error: unknown) => {
      assert.ok(error instanceof ModelGatewayError);
      assert.match(error.message, /思考|最终答案/);
      return true;
    },
  );
});
