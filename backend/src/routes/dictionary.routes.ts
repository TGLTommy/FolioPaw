import { Router } from 'express';
import { dictionaryService } from '../services/dictionary.service';

const router = Router();

/**
 * GET /api/dictionary/lookup
 * Look up a word in the English-Chinese dictionary
 */
router.get('/lookup', async (req, res, next) => {
    try {
        const word = req.query.word as string;

        if (!word || typeof word !== 'string' || word.trim() === '') {
            return res.status(400).json({ error: 'word 参数不能为空' });
        }

        const result = await dictionaryService.lookup(word);

        res.json({
            success: true,
            data: result,
        });
    } catch (error: unknown) {
        next(error);
    }
});

/**
 * POST /api/dictionary/lookup-multiple
 * Look up multiple words at once
 */
router.post('/lookup-multiple', async (req, res, next) => {
    try {
        const { words } = req.body;

        if (!words || !Array.isArray(words) || words.length === 0) {
            return res.status(400).json({ error: 'words 数组不能为空' });
        }

        // Limit to 10 words to prevent abuse
        const limitedWords = words.slice(0, 10);
        const results = await dictionaryService.lookupMultiple(limitedWords);

        res.json({
            success: true,
            data: results,
        });
    } catch (error: unknown) {
        next(error);
    }
});

export default router;
