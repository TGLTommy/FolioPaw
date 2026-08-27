import { Router } from 'express';
import { ttsService, TtsInputError } from '../services/tts.service';

const router = Router();

/**
 * POST /api/tts/speak
 * Synthesize speech from text: { text } → audio/mpeg stream
 */
router.post('/speak', async (req, res) => {
  const { text } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text 参数不能为空' });
  }

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

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.concat(chunks));
  } catch (error: unknown) {
    if (error instanceof TtsInputError) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(503).json({ error: '语音服务暂时不可用，请稍后重试' });
  }
});

export default router;
