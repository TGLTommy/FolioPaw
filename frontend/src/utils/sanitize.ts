import DOMPurify from 'dompurify';

const FORBIDDEN_TAGS = [
  'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
  'form', 'input', 'button', 'textarea', 'select', 'foreignObject', 'style',
];

export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: ['style'],
  });
}

export function getVisibleText(html: string): string {
  if (!html) return '';
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
  });
  return sanitized.replace(/\s+/g, ' ').trim();
}

export function hasRenderableEpubContent(html: string): boolean {
  return Boolean(getVisibleText(html)) || /<(img|image|svg|picture|figure)\b/i.test(html);
}

export function sanitizeEpubHtml(html: string): string {
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: ['style', 'srcdoc'],
  });
  if (typeof DOMParser === 'undefined') return sanitized;

  const parsed = new DOMParser().parseFromString(sanitized, 'text/html');
  const root = parsed.body || parsed.documentElement;
  if (!root) return '';

  root.querySelectorAll('[hidden], .hidden_content, [aria-hidden="true"]').forEach((element) => {
    element.remove();
  });

  root.querySelectorAll('svg[preserveAspectRatio="none"]').forEach((svg) => {
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  });

  root.querySelectorAll('svg').forEach((svg) => {
    const images = svg.querySelectorAll('image');
    if (images.length !== 1) return;
    const image = images[0];
    const src = image.getAttribute('href') || image.getAttribute('xlink:href');
    if (!src || !isSafeBookAssetUrl(src)) return;

    const img = parsed.createElement('img');
    img.src = src;
    img.alt = image.getAttribute('alt') || parsed.querySelector('title')?.textContent || '';
    img.className = 'epub-cover-image';
    svg.replaceWith(img);
  });

  root.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'style') {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (['href', 'src', 'xlink:href'].includes(name) && !isSafeBookAssetUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  });

  return root.innerHTML;
}

function isSafeBookAssetUrl(value: string): boolean {
  const normalized = Array.from(value.trim())
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('');
  return /^(\/uploads\/|#|data:image\/(?:png|jpeg|jpg|gif|webp);base64,)/i.test(normalized);
}
