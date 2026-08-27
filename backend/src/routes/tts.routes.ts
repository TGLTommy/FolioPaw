import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { ttsService, TtsInputError } from '../services/tts.service';
import { runtimeConfig } from '../config/env';

const router = Router();

// 朗读链路问题多与网络环境相关且难以复现，请求结果落盘便于事后诊断
function logTtsRequest(entry: Record<string, unknown>) {
  if (process.env.NODE_ENV === 'test') return;
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    fs.appendFileSync(path.join(path.dirname(runtimeConfig.dbPath), 'tts-debug.log'), line + '\n');
  } catch {
    // 日志失败不影响主流程
  }
}

/**
 * POST /api/tts/speak
 * Synthesize speech from text: { text } → audio/mpeg stream
 */
router.post('/speak', async (req, res) => {
  const { text } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text 参数不能为空' });
  }

  const startedAt = Date.now();
  try {
    const audioStream = await ttsService.synthesize(text);

    // 整段缓冲后再响应：上游中断时返回明确的 503，而不是无法解码的半截 200。
    // 朗读文本已在前端按句子分段（约 600 字/段），单段音频只有几十 KB。
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      audioStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      audioStream.once('end', resolve);
      audioStream.once('error', reject);
    });

    const audio = Buffer.concat(chunks);
    logTtsRequest({ ok: true, textChars: text.length, audioBytes: audio.length, elapsedMs: Date.now() - startedAt });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(audio);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logTtsRequest({ ok: false, textChars: text.length, elapsedMs: Date.now() - startedAt, error: message });
    if (error instanceof TtsInputError) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(503).json({ error: '语音服务暂时不可用，请稍后重试' });
  }
});

export default router;
