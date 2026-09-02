import { describe, expect, it } from 'vitest';
import { canUseBookTextFeatures, getDefaultReadingMode } from './bookCapabilities';

describe('book text capabilities', () => {
  it('opens PDFs in original mode and EPUBs in translated mode', () => {
    expect(getDefaultReadingMode('pdf')).toBe('original');
    expect(getDefaultReadingMode('epub')).toBe('translated');
  });

  it('only disables text features for unavailable extraction', () => {
    expect(canUseBookTextFeatures({ text_extraction_status: 'ready' })).toBe(true);
    expect(canUseBookTextFeatures({ text_extraction_status: 'partial' })).toBe(true);
    expect(canUseBookTextFeatures({ text_extraction_status: 'unavailable' })).toBe(false);
    expect(canUseBookTextFeatures({ text_extraction_status: 'ready', import_status: 'pending' })).toBe(false);
    expect(canUseBookTextFeatures({ text_extraction_status: 'ready', import_status: 'processing' })).toBe(false);
    expect(canUseBookTextFeatures({ text_extraction_status: 'ready', import_status: 'failed' })).toBe(false);
    expect(canUseBookTextFeatures({ text_extraction_status: 'ready', import_status: 'ready' })).toBe(true);
  });
});
