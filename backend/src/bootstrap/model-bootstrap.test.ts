import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'vitest';
import { loadBootstrapOptions, ModelBootstrapRunner } from './model-bootstrap';

const MODEL_FILE = 'Qwen_Qwen3.5-4B-Q4_K_M.gguf';

describe.sequential('model bootstrap', () => {
  test('uses the official Ollama pull when it is available and prevents duplicate jobs', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'foliopaw-bootstrap-official-'));
    const originalFetch = globalThis.fetch;
    let modelAvailable = false;
    try {
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url.endsWith('/api/tags')) {
          return jsonResponse({
            models: modelAvailable ? [{ name: 'qwen3.5:4b' }] : [],
          });
        }
        if (url.endsWith('/api/pull')) {
          assert.equal(init?.method, 'POST');
          modelAvailable = true;
          return new Response(
            '{"status":"pulling manifest"}\n{"status":"success","completed":2,"total":2}\n',
            { status: 200 },
          );
        }
        if (url.endsWith('/api/chat')) {
          return jsonResponse({ message: { content: 'OK' } });
        }
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch;

      const runner = new ModelBootstrapRunner(loadBootstrapOptions({
        MODEL_CACHE_DIR: cacheDir,
        MODEL_BOOTSTRAP_STATUS_FILE: path.join(cacheDir, 'status.json'),
        MODEL_DOWNLOAD_SOURCE: 'ollama',
        OLLAMA_BASE_URL: 'http://ollama.test:11434',
      }));
      assert.equal(await runner.startJob(), true);
      assert.equal(await runner.startJob(), false);
      const status = await waitForPhase(runner, 'ready');
      assert.equal(status.source, 'ollama-registry');
      assert.equal(status.percent, 100);
      assert.equal(status.canRetry, false);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('falls back to ModelScope, resumes with Range, verifies, imports, and removes the GGUF', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'foliopaw-bootstrap-fallback-'));
    const originalFetch = globalThis.fetch;
    const originalMarker = process.env.MODEL_BOOTSTRAP_TEST_MARKER;
    const payload = Buffer.from('foliopaw tiny gguf fixture');
    const prefixSize = 7;
    const markerPath = path.join(cacheDir, 'imported');
    const cliPath = createFakeOllamaCli(cacheDir);
    writeFileSync(path.join(cacheDir, `${MODEL_FILE}.part`), payload.subarray(0, prefixSize));
    process.env.MODEL_BOOTSTRAP_TEST_MARKER = markerPath;
    let sawRange = false;
    try {
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url.endsWith('/api/tags')) {
          return jsonResponse({
            models: existsSync(markerPath) ? [{ name: 'qwen3.5:4b' }] : [],
          });
        }
        if (url.endsWith('/api/pull')) throw new TypeError('official registry blocked');
        if (url === 'https://modelscope.test/model.gguf') {
          const range = headerValue(init?.headers, 'Range');
          assert.equal(range, `bytes=${prefixSize}-`);
          sawRange = true;
          return new Response(payload.subarray(prefixSize), {
            status: 206,
            headers: {
              'Content-Range': `bytes ${prefixSize}-${payload.length - 1}/${payload.length}`,
            },
          });
        }
        if (url.endsWith('/api/chat')) return jsonResponse({ message: { content: 'OK' } });
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch;

      const runner = new ModelBootstrapRunner(loadBootstrapOptions({
        MODEL_CACHE_DIR: cacheDir,
        MODEL_BOOTSTRAP_STATUS_FILE: path.join(cacheDir, 'status.json'),
        MODEL_DOWNLOAD_SOURCE: 'auto',
        MODELSCOPE_MODEL_URL: 'https://modelscope.test/model.gguf',
        MODELSCOPE_MODEL_SIZE: String(payload.length),
        MODELSCOPE_MODEL_SHA256: sha256(payload),
        OLLAMA_BINARY: cliPath,
        OLLAMA_BASE_URL: 'http://ollama.test:11434',
      }));
      assert.equal(await runner.startJob(), true);
      const status = await waitForPhase(runner, 'ready');
      assert.equal(status.source, 'modelscope');
      assert.equal(sawRange, true);
      assert.equal(existsSync(markerPath), true);
      assert.equal(existsSync(path.join(cacheDir, MODEL_FILE)), false);
      assert.equal(existsSync(path.join(cacheDir, `${MODEL_FILE}.part`)), false);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalMarker === undefined) delete process.env.MODEL_BOOTSTRAP_TEST_MARKER;
      else process.env.MODEL_BOOTSTRAP_TEST_MARKER = originalMarker;
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('cleans a checksum failure and succeeds through the retry path', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'foliopaw-bootstrap-retry-'));
    const originalFetch = globalThis.fetch;
    const originalMarker = process.env.MODEL_BOOTSTRAP_TEST_MARKER;
    const goodPayload = Buffer.from('good');
    const badPayload = Buffer.from('bad!');
    let downloadPayload = badPayload;
    const markerPath = path.join(cacheDir, 'imported');
    const cliPath = createFakeOllamaCli(cacheDir);
    process.env.MODEL_BOOTSTRAP_TEST_MARKER = markerPath;
    try {
      globalThis.fetch = (async (input) => {
        const url = String(input);
        if (url.endsWith('/api/tags')) {
          return jsonResponse({
            models: existsSync(markerPath) ? [{ name: 'qwen3.5:4b' }] : [],
          });
        }
        if (url === 'https://modelscope.test/model.gguf') {
          return new Response(downloadPayload, { status: 200 });
        }
        if (url.endsWith('/api/chat')) return jsonResponse({ message: { content: 'OK' } });
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch;

      const runner = new ModelBootstrapRunner(loadBootstrapOptions({
        MODEL_CACHE_DIR: cacheDir,
        MODEL_BOOTSTRAP_STATUS_FILE: path.join(cacheDir, 'status.json'),
        MODEL_DOWNLOAD_SOURCE: 'modelscope',
        MODELSCOPE_MODEL_URL: 'https://modelscope.test/model.gguf',
        MODELSCOPE_MODEL_SIZE: String(goodPayload.length),
        MODELSCOPE_MODEL_SHA256: sha256(goodPayload),
        OLLAMA_BINARY: cliPath,
        OLLAMA_BASE_URL: 'http://ollama.test:11434',
      }));
      assert.equal(await runner.startJob(), true);
      const failed = await waitForPhase(runner, 'failed');
      assert.equal(failed.canRetry, true);
      assert.match(failed.message, /SHA-256 校验失败/);
      assert.equal(existsSync(path.join(cacheDir, MODEL_FILE)), false);
      assert.equal(existsSync(markerPath), false);

      downloadPayload = goodPayload;
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(await runner.startJob(), true);
      const ready = await waitForPhase(runner, 'ready');
      assert.equal(ready.source, 'modelscope');
      assert.equal(existsSync(markerPath), true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalMarker === undefined) delete process.env.MODEL_BOOTSTRAP_TEST_MARKER;
      else process.env.MODEL_BOOTSTRAP_TEST_MARKER = originalMarker;
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('keeps a verified GGUF after model-test failure and removes it after a successful retry', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'foliopaw-bootstrap-test-retry-'));
    const originalFetch = globalThis.fetch;
    const originalMarker = process.env.MODEL_BOOTSTRAP_TEST_MARKER;
    const payload = Buffer.from('verified model fixture');
    const markerPath = path.join(cacheDir, 'imported');
    const cliPath = createFakeOllamaCli(cacheDir);
    process.env.MODEL_BOOTSTRAP_TEST_MARKER = markerPath;
    let downloadCalls = 0;
    let chatCalls = 0;
    try {
      globalThis.fetch = (async (input) => {
        const url = String(input);
        if (url.endsWith('/api/tags')) {
          return jsonResponse({
            models: existsSync(markerPath) ? [{ name: 'qwen3.5:4b' }] : [],
          });
        }
        if (url === 'https://modelscope.test/model.gguf') {
          downloadCalls += 1;
          return new Response(payload, { status: 200 });
        }
        if (url.endsWith('/api/chat')) {
          chatCalls += 1;
          return chatCalls === 1
            ? new Response('{"error":"load failed"}', { status: 500 })
            : jsonResponse({ message: { content: 'OK' } });
        }
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch;

      const runner = new ModelBootstrapRunner(loadBootstrapOptions({
        MODEL_CACHE_DIR: cacheDir,
        MODEL_BOOTSTRAP_STATUS_FILE: path.join(cacheDir, 'status.json'),
        MODEL_DOWNLOAD_SOURCE: 'modelscope',
        MODELSCOPE_MODEL_URL: 'https://modelscope.test/model.gguf',
        MODELSCOPE_MODEL_SIZE: String(payload.length),
        MODELSCOPE_MODEL_SHA256: sha256(payload),
        OLLAMA_BINARY: cliPath,
        OLLAMA_BASE_URL: 'http://ollama.test:11434',
      }));
      assert.equal(await runner.startJob(), true);
      await waitForPhase(runner, 'failed');
      assert.equal(existsSync(path.join(cacheDir, MODEL_FILE)), true);
      assert.equal(downloadCalls, 1);

      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(await runner.startJob(), true);
      await waitForPhase(runner, 'ready');
      assert.equal(downloadCalls, 1);
      assert.equal(existsSync(path.join(cacheDir, MODEL_FILE)), false);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalMarker === undefined) delete process.env.MODEL_BOOTSTRAP_TEST_MARKER;
      else process.env.MODEL_BOOTSTRAP_TEST_MARKER = originalMarker;
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('does not delete a user-mounted local GGUF when verification fails', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'foliopaw-bootstrap-local-'));
    const originalFetch = globalThis.fetch;
    const localPath = path.join(cacheDir, 'user-model.gguf');
    const payload = Buffer.from('local model fixture');
    writeFileSync(localPath, payload);
    try {
      globalThis.fetch = (async (input) => {
        const url = String(input);
        if (url.endsWith('/api/tags')) return jsonResponse({ models: [] });
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch;

      const runner = new ModelBootstrapRunner(loadBootstrapOptions({
        MODEL_CACHE_DIR: cacheDir,
        MODEL_BOOTSTRAP_STATUS_FILE: path.join(cacheDir, 'status.json'),
        MODEL_DOWNLOAD_SOURCE: 'local',
        MODEL_LOCAL_GGUF_PATH: localPath,
        MODELSCOPE_MODEL_SIZE: String(payload.length),
        MODELSCOPE_MODEL_SHA256: sha256(Buffer.from('different fixture')),
        OLLAMA_BASE_URL: 'http://ollama.test:11434',
      }));
      assert.equal(await runner.startJob(), true);
      const failed = await waitForPhase(runner, 'failed');
      assert.match(failed.message, /原文件已保留/);
      assert.equal(existsSync(localPath), true);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('keeps the pinned ModelScope defaults and validates source selection', () => {
    const options = loadBootstrapOptions({});
    assert.equal(options.source, 'auto');
    assert.equal(options.model, 'qwen3.5:4b');
    assert.equal(options.contextWindow, 32768);
    assert.equal(options.modelScopeSize, 3_013_027_808);
    assert.equal(
      options.modelScopeSha256,
      '13c16f426047e2de38cd075bdade4a7bcbc8c774384876f677740cda65f8a983',
    );
    assert.match(options.modelScopeUrl, /71b231d64df1bbbe8a03f63ea4274c3921da4700/);
    assert.throws(
      () => loadBootstrapOptions({ MODEL_DOWNLOAD_SOURCE: 'unknown' }),
      /必须是 auto、ollama、modelscope 或 local/,
    );
  });
});

async function waitForPhase(
  runner: ModelBootstrapRunner,
  phase: 'ready' | 'failed',
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const status = runner.getStatus();
    if (status.phase === phase) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for bootstrap phase ${phase}: ${JSON.stringify(runner.getStatus())}`);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function createFakeOllamaCli(directory: string): string {
  const filePath = path.join(directory, 'ollama-test-cli');
  writeFileSync(filePath, '#!/bin/sh\n: > "$MODEL_BOOTSTRAP_TEST_MARKER"\n', { mode: 0o700 });
  chmodSync(filePath, 0o700);
  return filePath;
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  return new Headers(headers).get(name);
}
