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

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');

    audioStream.on('error', () => {
      if (!res.headersSent) {
        res.status(503).json({ error: '语音服务暂时不可用，请稍后重试' });
      } else {
        res.end();
      }
    });
    audioStream.pipe(res);
  } catch (error: unknown) {
    if (error instanceof TtsInputError) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(503).json({ error: '语音服务暂时不可用，请稍后重试' });
  }
});

export default router;
