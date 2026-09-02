import { describe, expect, it } from 'vitest';
import { canUseBookTextFeatures, getDefaultReadingMode } from './bookCapabilities';

describe('book text capabilities', () => {
  it('opens books in original English mode by default', () => {
    expect(getDefaultReadingMode()).toBe('original');
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
