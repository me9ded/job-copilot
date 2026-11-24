import DOMPurify from 'dompurify';

/**
 * Job descriptions are untrusted third-party HTML. Only a small structural
 * allowlist survives; scripts, styles, event handlers, forms, images and
 * iframes are removed. Links are forced to open safely in a new tab.
 */
const ALLOWED_TAGS = ['p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'blockquote', 'span', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];

let hooked = false;

export function sanitizeHtml(html: string): string {
  if (!hooked) {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') ?? '';
        if (!/^https?:\/\//i.test(href)) node.removeAttribute('href');
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer nofollow');
      }
    });
    hooked = true;
  }
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
