import { describe, expect, it } from 'vitest';
import { splitTextForTts, TTS_SEGMENT_MAX_LENGTH } from './ttsSegments';

describe('splitTextForTts', () => {
  it('keeps short text as a single segment', () => {
    expect(splitTextForTts('这是一段短文本。')).toEqual(['这是一段短文本。']);
  });

  it('returns an empty list for blank input', () => {
    expect(splitTextForTts('   \n  ')).toEqual([]);
  });

  it('splits long text at sentence boundaries without exceeding the limit', () => {
    const sentence = '这是一个完整的句子，用来验证分段逻辑是否正确。';
    const text = sentence.repeat(40); // 远超单段上限
    const segments = splitTextForTts(text);

    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(TTS_SEGMENT_MAX_LENGTH);
      expect(segment.endsWith('。')).toBe(true);
    }
    expect(segments.join('')).toBe(text);
  });

  it('force-splits an oversized run with no sentence boundary', () => {
    const text = '好'.repeat(TTS_SEGMENT_MAX_LENGTH + 100);
    const segments = splitTextForTts(text);

    expect(segments.length).toBe(2);
    expect(segments[0].length).toBe(TTS_SEGMENT_MAX_LENGTH);
    expect(segments.join('')).toBe(text);
  });

  it('treats newlines as sentence boundaries for markdown headings and lists', () => {
    const line = '核心观点要点内容\n';
    const text = line.repeat(80);
    const segments = splitTextForTts(text);

    expect(segments.length).toBeGreaterThan(1);
    expect(segments.join('')).toBe(text.trimEnd());
  });
});
