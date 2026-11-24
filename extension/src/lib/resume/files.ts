import { normalizeWhitespace } from '../util';
import { extractDocxText } from './docx';
import { ResumeFileError } from './errors';
import { MAX_PDF_PAGES, readPdf, SCANNED_PDF } from './pdf';

export { extractDocxText } from './docx';
export { ResumeFileError } from './errors';
export { extractPdfText, readPdf } from './pdf';

/**
 * Résumé upload manager: checks the file, picks the extractor for its real
 * format (by content, not by name) and judges whether enough readable text
 * came out. Everything runs in the extension page; nothing is uploaded.
 */

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** The `accept` list for résumé file pickers. */
export const RESUME_ACCEPT = '.pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown';

const startsWith = (data: Uint8Array, bytes: number[]) => bytes.every((b, i) => data[i] === b);

export type ResumeFileKind = 'pdf' | 'docx' | 'text';

export function detectKind(name: string, data: Uint8Array): ResumeFileKind {
  if (startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04])) {
    if (/\.(odt|pages)$/i.test(name)) throw new ResumeFileError('OpenDocument (.odt) and Pages files are not supported. Export the résumé as .docx or PDF and try again.');
    return 'docx'; // PK zip
  }
  if (startsWith(data, [0xd0, 0xcf, 0x11, 0xe0]))
    throw new ResumeFileError('Legacy .doc files (and password-protected .docx files) are not supported. Save the résumé as .docx or PDF and try again.');
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47]) || startsWith(data, [0xff, 0xd8, 0xff]) || /\.(png|jpe?g|heic|webp|tiff?)$/i.test(name))
    throw new ResumeFileError('This is an image. Job Copilot reads the text of PDF, DOCX or TXT résumés; a photo or scan would need text recognition (OCR) first.');
  if (startsWith(data, [0x7b, 0x5c, 0x72, 0x74, 0x66])) throw new ResumeFileError('RTF files are not supported. Save the résumé as .docx or PDF and try again.');
  if (/\.(txt|md|text)$/i.test(name)) return 'text';
  if (/\.pdf$/i.test(name)) throw new ResumeFileError('This file has a .pdf name but is not a valid PDF.');
  if (/\.docx$/i.test(name)) throw new ResumeFileError('This file has a .docx name but is not a valid Word document.');
  throw new ResumeFileError('Unsupported file type. Upload a PDF, DOCX or plain-text résumé.');
}

export const FILE_TYPES: Record<ResumeFileKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  text: 'text/plain',
};

/** Decodes a text file: UTF-8 (with or without BOM), UTF-16 with BOM, else Windows-1252. */
export function decodeText(data: Uint8Array): string {
  if (startsWith(data, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (startsWith(data, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(data.subarray(2));
  const body = startsWith(data, [0xef, 0xbb, 0xbf]) ? data.subarray(3) : data;
  if (body.includes(0)) throw new ResumeFileError('This doesn’t look like a text file. Upload a PDF, DOCX or plain-text résumé.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextDecoder('windows-1252').decode(body);
  }
}

export interface TextQuality {
  /** Problems worth showing next to the extracted profile. */
  warnings: string[];
  /** Set when the text is unusable; the upload stops with this message. */
  fatal?: string;
}

const list = (ns: number[]) => (ns.length === 1 ? `Page ${ns[0]}` : `Pages ${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);

/**
 * Judges whether text extraction worked. Scanned pages have no text layer and
 * fonts without a character map come out as private-use or replacement
 * characters; both need OCR, which Job Copilot does not do.
 */
export function assessText(text: string, opts: { kind: ResumeFileKind; pageChars?: number[]; totalPages?: number }): TextQuality {
  const warnings: string[] = [];
  const solid = text.replace(/\s/g, '');
  if (solid.length < 50) {
    if (opts.kind === 'pdf') return { warnings, fatal: SCANNED_PDF };
    return { warnings, fatal: opts.kind === 'docx' ? 'The document contains almost no text.' : 'The file is empty or has almost no text.' };
  }
  const bad = (solid.match(/[�-\u0000-\u0008\u000E-\u001F]/g)?.length ?? 0) + (text.match(/\(cid:\d+\)/g)?.length ?? 0) * 6;
  const badRatio = bad / solid.length;
  if (badRatio > 0.3)
    return {
      warnings,
      fatal: 'The text in this file couldn’t be decoded (its fonts don’t map to real characters). It would need text recognition (OCR). Upload the Word (.docx) version or an OCR’d PDF instead.',
    };
  if (badRatio > 0.03) warnings.push('Some characters couldn’t be decoded, so names, dates or numbers may be wrong below. OCR may be required for those parts; check them before saving.');
  const letters = solid.match(/\p{L}/gu)?.length ?? 0;
  if (letters / solid.length < 0.45) warnings.push('Much of the text isn’t letters (tables, symbols or a damaged file). Check what was found carefully.');
  const pages = opts.pageChars ?? [];
  const empty = opts.kind === 'pdf' && pages.length > 1 ? pages.flatMap((n, i) => (n < 30 ? [i + 1] : [])) : [];
  if (empty.length && empty.length < pages.length) {
    warnings.push(`${list(empty)} ${empty.length === 1 ? 'has' : 'have'} no selectable text; ${empty.length === 1 ? 'it' : 'they'} may be scanned images (OCR may be required). Anything there is missing below.`);
  } else if (opts.kind === 'pdf' && solid.length < 400) {
    warnings.push('Very little text was found in this PDF. Parts of it may be images that need text recognition (OCR); anything in them is missing below.');
  }
  if (opts.totalPages && opts.totalPages > MAX_PDF_PAGES) warnings.push(`Only the first ${MAX_PDF_PAGES} of ${opts.totalPages} pages were read.`);
  return { warnings };
}

export interface ResumeFileRead {
  text: string;
  kind: ResumeFileKind;
  data: Uint8Array;
  /** PDF pages read. */
  pages?: number;
  /** Extraction problems to show during review (partly scanned, undecodable characters, …). */
  warnings: string[];
}

export async function readResumeFile(file: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }): Promise<ResumeFileRead> {
  if (file.size === 0) throw new ResumeFileError('The file is empty.');
  if (file.size > MAX_RESUME_BYTES) throw new ResumeFileError('The file is larger than 10 MB.');
  const data = new Uint8Array(await file.arrayBuffer());
  if (!data.length) throw new ResumeFileError('The file is empty.');
  const kind = detectKind(file.name, data);
  let text: string;
  let pages: number | undefined;
  let quality: TextQuality;
  if (kind === 'pdf') {
    const pdf = await readPdf(data);
    text = pdf.text;
    pages = pdf.pages;
    quality = assessText(text, { kind, pageChars: pdf.pageChars, totalPages: pdf.totalPages });
  } else {
    text = kind === 'docx' ? extractDocxText(data) : normalizeWhitespace(decodeText(data));
    quality = assessText(text, { kind });
  }
  if (quality.fatal) throw new ResumeFileError(quality.fatal);
  return { kind, data, text, pages, warnings: quality.warnings };
}
