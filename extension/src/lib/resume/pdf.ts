import { normalizeWhitespace } from '../util';
import { ResumeFileError } from './errors';

/** PDF text extractor (pdf.js text layer). Runs locally; nothing is uploaded. */

export const MAX_PDF_PAGES = 15;

const isPdf = (data: Uint8Array) => [0x25, 0x50, 0x44, 0x46, 0x2d].every((b, i) => data[i] === b);

/* ----------------------------------------------------------------------------
 * PDF: pdf.js text layer, regrouped into lines by vertical position
 * ------------------------------------------------------------------------- */

interface PdfTextItem {
  str: string;
  transform: number[];
  hasEOL?: boolean;
}

interface PdfLink {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  display: string;
  used: boolean;
}

/** Web links on a page (mailto/tel and other schemes are ignored; the address is usually in the text already). */
async function pageLinks(page: { getAnnotations(): Promise<unknown[]> }): Promise<PdfLink[]> {
  let annotations: unknown[];
  try {
    annotations = await page.getAnnotations();
  } catch {
    return [];
  }
  const links: PdfLink[] = [];
  for (const raw of annotations) {
    const a = raw as { subtype?: string; url?: unknown; rect?: number[] };
    if (a.subtype !== 'Link' || typeof a.url !== 'string' || !Array.isArray(a.rect) || a.rect.length !== 4) continue;
    let url: URL;
    try {
      url = new URL(a.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    // A bare "github.com" or "linkedin.com" link identifies nobody.
    if (/(^|\.)(linkedin|github|gitlab)\.com$/i.test(url.hostname) && url.pathname.replace(/\/+$/, '') === '') continue;
    const [x1, y1, x2, y2] = a.rect as [number, number, number, number];
    const display = `${url.host.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}`.slice(0, 200);
    links.push({ x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2), display, used: false });
  }
  return links;
}

export interface PdfText {
  text: string;
  /** Pages read (at most MAX_PDF_PAGES). */
  pages: number;
  totalPages: number;
  /** Non-blank characters found on each page that was read. */
  pageChars: number[];
}

/** Reads the text layer of every page. Pages without text (scans) simply come back empty; see `assessText`. */
export async function readPdf(data: Uint8Array, opts: { workerSrc?: string } = {}): Promise<PdfText> {
  if (!isPdf(data)) throw new ResumeFileError('This file is not a valid PDF.');
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = opts.workerSrc ?? (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  }
  let doc;
  try {
    // A copy is passed because pdf.js transfers (detaches) the buffer to its worker.
    doc = await pdfjs.getDocument({ data: data.slice(), disableFontFace: true, useSystemFonts: false, stopAtErrors: false }).promise;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'PasswordException') throw new ResumeFileError('This PDF is password-protected. Remove the password or upload a DOCX instead.');
    throw new ResumeFileError('This PDF could not be read; it may be damaged.');
  }
  try {
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    const out: string[] = [];
    const pageChars: number[] = [];
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const pageStart = out.length;
      const content = await page.getTextContent();
      const links = await pageLinks(page);
      let line = '';
      let lastY: number | null = null;
      let lastEndX = 0;
      let gap = false;
      for (const raw of content.items as unknown[]) {
        const item = raw as PdfTextItem;
        if (typeof item.str !== 'string') continue;
        const y = item.transform[5] ?? 0;
        const x = item.transform[4] ?? 0;
        const size = Math.abs(item.transform[3] ?? 0) || 10;
        const width = (item as unknown as { width?: number }).width ?? 0;
        const columnGap = Math.max(18, size * 2.5);
        if (lastY !== null && Math.abs(y - lastY) > 2) {
          out.push(line);
          line = '';
          gap = false;
        }
        // A wide gap (an empty space or one stretched whitespace item) is a column
        // break, e.g. right-aligned dates or a location: keep it as " | ".
        if (!item.str.trim()) {
          if (width > columnGap) gap = true;
        } else if (line.trim() && (gap || x - lastEndX > columnGap)) {
          line = `${line.trimEnd()} | `;
          gap = false;
        } else if (line && x - lastEndX > 2 && !line.endsWith(' ') && !item.str.startsWith(' ')) line += ' ';
        line += item.str;
        // Hyperlinked words ("LinkedIn", "GitHub", a project name) keep their target URL.
        const link = item.str.trim() && links.find((l) => !l.used && x < l.x2 && x + width > l.x1 && y + size / 2 >= l.y1 && y + size / 2 <= l.y2);
        if (link) {
          link.used = true;
          if (!line.includes(link.display)) line += ` ${link.display}`;
        }
        lastY = y;
        lastEndX = x + width;
        if (item.hasEOL) {
          out.push(line);
          line = '';
          lastY = null;
          gap = false;
        }
      }
      if (line) out.push(line);
      pageChars.push(out.slice(pageStart).join('').replace(/\s/g, '').length);
      out.push('');
    }
    return { text: normalizeWhitespace(out.join('\n')), pages, totalPages: doc.numPages, pageChars };
  } finally {
    void doc.loadingTask.destroy();
  }
}

/** The text of a PDF. Throws when there is no usable text layer (a scanned image needs OCR). */
export async function extractPdfText(data: Uint8Array, opts: { workerSrc?: string } = {}): Promise<string> {
  const pdf = await readPdf(data, opts);
  if (pdf.text.replace(/\s/g, '').length < 50) throw new ResumeFileError(SCANNED_PDF);
  return pdf.text;
}

export const SCANNED_PDF =
  'No selectable text found. This PDF looks like a scanned image, so its text would need to be recognised (OCR) first. Upload the Word (.docx) version, export the PDF again from your editor, or run it through an OCR tool and upload the result.';
