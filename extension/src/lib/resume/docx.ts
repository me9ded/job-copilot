import { strFromU8, unzipSync } from 'fflate';
import { normalizeWhitespace } from '../util';
import { ResumeFileError } from './errors';

/**
 * DOCX text extractor: unzips word/document.xml and reads paragraphs, tabs,
 * breaks, list items, tables and text boxes in reading order. Runs locally;
 * nothing is uploaded.
 */

const SKIP = new Set(['w:pPr', 'w:rPr', 'w:instrText', 'w:delText', 'mc:Fallback', 'w:txbxContent', 'w:footnoteReference']);

/** Text of one paragraph. Text boxes anchored in it are read separately (as their own lines). */
function paragraphText(p: Element): string {
  let text = '';
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName;
      if (tag === 'w:t') text += child.textContent ?? '';
      else if (tag === 'w:tab' || tag === 'w:ptab') text += '\t';
      else if (tag === 'w:br' || tag === 'w:cr') text += '\n';
      else if (tag === 'w:noBreakHyphen') text += '-';
      else if (!SKIP.has(tag)) walk(child);
    }
  };
  walk(p);
  // Tabs usually separate columns (title ⇥ dates); keep them as a visible separator.
  return text.trim().replace(/[  ]*\t[\t  ]*/g, ' | ');
}

/** Text boxes inside a paragraph (the modern drawing, not its legacy VML fallback copy). */
function textBoxes(p: Element): Element[] {
  return Array.from(p.getElementsByTagName('w:txbxContent')).filter((tb) => {
    for (let n = tb.parentElement; n && n !== p; n = n.parentElement) if (n.tagName === 'mc:Fallback' || n.tagName === 'w:txbxContent') return false;
    return true;
  });
}

function readBlock(el: Element, lines: string[]): void {
  for (const child of Array.from(el.children)) {
    const tag = child.tagName;
    if (tag === 'w:p') {
      const text = paragraphText(child);
      const isListItem = child.getElementsByTagName('w:numPr').length > 0;
      if (text) lines.push(isListItem ? `• ${text}` : text);
      for (const tb of textBoxes(child)) readBlock(tb, lines);
    } else if (tag === 'w:tbl') {
      for (const row of Array.from(child.children).filter((r) => r.tagName === 'w:tr')) {
        const cells = Array.from(row.children).filter((c) => c.tagName === 'w:tc');
        const cellLines = cells.map((c) => {
          const out: string[] = [];
          readBlock(c, out);
          return out;
        });
        // A row of short cells ("Title | Dates") is one line; layout tables (whole columns of a résumé) are read column by column.
        if (cellLines.every((c) => c.length <= 1)) {
          const line = cellLines.map((c) => c[0] ?? '').filter(Boolean).join(' | ');
          if (line) lines.push(line);
        } else for (const c of cellLines) lines.push(...c);
      }
    } else if (!SKIP.has(tag)) readBlock(child, lines);
  }
}

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
  const body = xml.getElementsByTagName('w:body')[0];
  if (!body) throw new ResumeFileError('This .docx file has no document body.');
  const lines: string[] = [];
  readBlock(body, lines);
  return normalizeWhitespace(lines.join('\n'));
}
