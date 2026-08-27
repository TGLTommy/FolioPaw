import { describe, expect, it } from 'vitest';
import { getTranslationMaxTokens, parseBatchTranslationResponse } from './translation.service';

describe('parseBatchTranslationResponse', () => {
  it('parses a well-formed pages payload', () => {
    const raw = '{"pages":[{"pageNumber":9,"translatedText":"第一段\\n第二段"}]}';
    const pages = parseBatchTranslationResponse(raw);
    expect(pages).toEqual([{ pageNumber: 9, translatedText: '第一段\n第二段' }]);
  });

  it('repairs raw newlines that models emit inside JSON string values', () => {
    const raw = '{"pages":[{"pageNumber":9,"translatedText":"第一段\n\n第二段"}]}';
    const pages = parseBatchTranslationResponse(raw);
    expect(pages).toEqual([{ pageNumber: 9, translatedText: '第一段\n\n第二段' }]);
  });

  it('still rejects output that is truncated mid-string', () => {
    const raw = '{"pages":[{"pageNumber":9,"translatedText":"第一段';
    expect(() => parseBatchTranslationResponse(raw)).toThrow();
  });
});

describe('getTranslationMaxTokens', () => {
  it('gives a single page enough budget for reasoning models', () => {
    expect(getTranslationMaxTokens(1)).toBe(8000);
  });

  it('caps multi-page batches at the configured maximum', () => {
    expect(getTranslationMaxTokens(3)).toBe(12000);
  });
});
