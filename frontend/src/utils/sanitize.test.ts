import { describe, expect, it } from 'vitest';
import { getVisibleText, sanitizeEpubHtml, sanitizeSvg } from './sanitize';

describe('untrusted document sanitization', () => {
  it('removes active content from generated SVG', () => {
    const result = sanitizeSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
        <script>alert(1)</script>
        <foreignObject><iframe src="https://attacker.invalid"></iframe></foreignObject>
        <a href="javascript:alert(1)"><text style="background:url(https://attacker.invalid)">Safe</text></a>
      </svg>
    `);

    expect(result).toContain('Safe');
    expect(result).not.toMatch(/script|foreignObject|iframe|onload|javascript:|style=/i);
  });

  it('keeps authenticated local book assets and removes remote URLs', () => {
    const result = sanitizeEpubHtml(`
      <p onclick="alert(1)">Hello <strong>reader</strong></p>
      <img src="/uploads/epub-resources/cover.png" />
      <img src="https://attacker.invalid/tracker.png" />
      <script>alert(1)</script>
    `);

    expect(result).toContain('/uploads/epub-resources/cover.png');
    expect(result).not.toContain('attacker.invalid');
    expect(result).not.toMatch(/onclick|script/i);
    expect(getVisibleText(result)).toContain('Hello reader');
  });
});

