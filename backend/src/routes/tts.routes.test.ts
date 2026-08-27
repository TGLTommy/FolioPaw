import { Readable } from 'node:stream';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { synthesizeMock } = vi.hoisted(() => ({ synthesizeMock: vi.fn() }));

vi.mock('../services/tts.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tts.service')>();
  return {
    ...actual,
    ttsService: { synthesize: synthesizeMock },
  };
});

import { createApp } from '../app';
import { initDatabase } from '../config/database';
import { TtsInputError } from '../services/tts.service';

describe('POST /api/tts/speak', () => {
  beforeAll(() => {
    initDatabase();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a request without text before calling the speech engine', async () => {
    const app = createApp();
    const res = await request(app).post('/api/tts/speak').send({}).expect(400);
    expect(res.body.error).toBe('text 参数不能为空');
    expect(synthesizeMock).not.toHaveBeenCalled();
  });

  it('maps invalid input reported by the service to 400', async () => {
    synthesizeMock.mockRejectedValue(new TtsInputError('朗读文本不能为空'));
    const app = createApp();
    const res = await request(app).post('/api/tts/speak').send({ text: '---' }).expect(400);
    expect(res.body.error).toBe('朗读文本不能为空');
  });

  it('streams synthesized audio back as audio/mpeg', async () => {
    const audio = Buffer.from('fake-mp3-bytes');
    synthesizeMock.mockResolvedValue(Readable.from([audio]));

    const app = createApp();
    const res = await request(app)
      .post('/api/tts/speak')
      .send({ text: '## 摘要\n\n正文。' })
      .expect(200)
      .expect('Content-Type', /audio\/mpeg/);

    expect(synthesizeMock).toHaveBeenCalledWith('## 摘要\n\n正文。');
    expect(res.body).toEqual(audio);
  });

  it('returns 503 when the speech service is unreachable', async () => {
    synthesizeMock.mockRejectedValue(new Error('websocket connect failed'));
    const app = createApp();
    const res = await request(app).post('/api/tts/speak').send({ text: '正文' }).expect(503);
    expect(res.body.error).toBe('语音服务暂时不可用，请稍后重试');
  });
});
