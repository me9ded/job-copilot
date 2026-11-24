import { strFromU8, unzipSync } from 'fflate';
import { normalizeWhitespace } from '../util';

/** Résumé files are parsed locally in the extension page. Nothing is uploaded. */

export class ResumeFileError extends Error {
  override name = 'ResumeFileError';
}

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PAGES = 15;

const startsWith = (data: Uint8Array, bytes: number[]) => bytes.every((b, i) => data[i] === b);

export type ResumeFileKind = 'pdf' | 'docx' | 'text';

export function detectKind(name: string, data: Uint8Array): ResumeFileKind {
  if (startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04])) return 'docx'; // PK zip
  if (startsWith(data, [0xd0, 0xcf, 0x11, 0xe0]))
    throw new ResumeFileError('Legacy .doc files (and password-protected .docx files) are not supported. Save the résumé as .docx or PDF and try again.');
  if (/\.(txt|md)$/i.test(name)) return 'text';
  if (/\.pdf$/i.test(name)) throw new ResumeFileError('This file has a .pdf name but is not a valid PDF.');
  if (/\.docx$/i.test(name)) throw new ResumeFileError('This file has a .docx name but is not a valid Word document.');
  throw new ResumeFileError('Unsupported file type. Upload a PDF, DOCX or plain-text résumé.');
}

/* ----------------------------------------------------------------------------
 * DOCX: unzip and read word/document.xml (paragraphs, tabs, breaks, list items)
 * ------------------------------------------------------------------------- */

export function extractDocxText(data: Uint8Array): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, { filter: (f) => f.name === 'word/document.xml' });
  } catch {
    throw new ResumeFileError('This Word document is damaged or not a real .docx file.');
  }
  const xmlBytes = files['word/document.xml'];
  if (!xmlBytes) throw new ResumeFileError('This .docx file has no document body (word/document.xml is missing).');
  if (xmlBytes.length > 20 * 1024 * 1024) throw new ResumeFileError('This document is too large to read.');
  const xml = new DOMParser().parseFromString(strFromU8(xmlBytes), 'application/xml');
  if (xml.getElementsByTagName('parsererror').length) throw new ResumeFileError('The document XML could not be read; the file may be corrupted.');

  const lines: string[] = [];
  for (const p of Array.from(xml.getElementsByTagName('w:p'))) {
    let text = '';
    const walk = (node: Element) => {
      for (const child of Array.from(node.children)) {
        const tag = child.tagName;
        if (tag === 'w:t') text += child.textContent ?? '';
        else if (tag === 'w:tab') text += '\t';
        else if (tag === 'w:br' || tag === 'w:cr') text += '\n';
        else if (tag !== 'w:pPr' && tag !== 'w:rPr' && tag !== 'w:instrText') walk(child);
      }
    };
    walk(p);
    const isListItem = p.getElementsByTagName('w:numPr').length > 0;
    // Tabs usually separate columns (title ⇥ dates); keep them as a visible separator.
    text = text.trim().replace(/[ \u00a0]*\t[\t \u00a0]*/g, ' | ');
    if (text) lines.push(isListItem ? `• ${text}` : text);
  }
  return normalizeWhitespace(lines.join('\n'));
}

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

export async function extractPdfText(data: Uint8Array, opts: { workerSrc?: string } = {}): Promise<string> {
  if (!startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d])) throw new ResumeFileError('This file is not a valid PDF.');
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
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
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
      out.push('');
    }
    const text = normalizeWhitespace(out.join('\n'));
    if (text.replace(/\s/g, '').length < 50)
      throw new ResumeFileError('No selectable text found. This PDF may be a scanned image; paste the résumé text instead.');
    return text;
  } finally {
    void doc.loadingTask.destroy();
  }
}

export const FILE_TYPES: Record<ResumeFileKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  text: 'text/plain',
};

export async function readResumeFile(file: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }): Promise<{ text: string; kind: ResumeFileKind; data: Uint8Array }> {
  if (file.size === 0) throw new ResumeFileError('The file is empty.');
  if (file.size > MAX_RESUME_BYTES) throw new ResumeFileError('The file is larger than 10 MB.');
  const data = new Uint8Array(await file.arrayBuffer());
  const kind = detectKind(file.name, data);
  if (kind === 'pdf') return { kind, data, text: await extractPdfText(data) };
  if (kind === 'docx') {
    const text = extractDocxText(data);
    if (text.replace(/\s/g, '').length < 50) throw new ResumeFileError('The document contains almost no text.');
    return { kind, data, text };
  }
  return { kind, data, text: normalizeWhitespace(new TextDecoder().decode(data)) };
}
