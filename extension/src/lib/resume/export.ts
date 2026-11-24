import { AlignmentType, BorderStyle, Document, Packer, Paragraph, TextRun } from 'docx';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ResumeContent } from '../types';

/**
 * ATS-friendly exports: single column, real text (no images or tables),
 * standard section headings, no headers/footers. Fully deterministic.
 */

function formatDate(d: string): string {
  if (!d) return '';
  if (d === 'present') return 'Present';
  const m = d.match(/^(\d{4})-(\d{2})$/);
  if (!m) return d;
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1]} ${m[1]}`;
}
const range = (s: string, e: string) => [formatDate(s), formatDate(e)].filter(Boolean).join(' – ');

interface Line {
  kind: 'name' | 'contact' | 'headline' | 'heading' | 'entry' | 'meta' | 'text' | 'bullet' | 'gap';
  text: string;
}

/** Single source of layout truth for text, DOCX and PDF output. */
export function resumeLines(c: ResumeContent): Line[] {
  const out: Line[] = [];
  out.push({ kind: 'name', text: c.basics.name || 'Your Name' });
  if (c.basics.headline) out.push({ kind: 'headline', text: c.basics.headline });
  const contact = [c.basics.email, c.basics.phone, c.basics.location, ...c.basics.links].filter(Boolean).join(' | ');
  if (contact) out.push({ kind: 'contact', text: contact });
  const section = (title: string) => {
    out.push({ kind: 'gap', text: '' });
    out.push({ kind: 'heading', text: title.toUpperCase() });
  };
  if (c.basics.summary) {
    section('Summary');
    out.push({ kind: 'text', text: c.basics.summary });
  }
  if (c.experience.length) {
    section('Experience');
    for (const e of c.experience) {
      out.push({ kind: 'entry', text: [e.title, e.company].filter(Boolean).join(' — ') });
      const meta = [e.location, range(e.start, e.end)].filter(Boolean).join(' | ');
      if (meta) out.push({ kind: 'meta', text: meta });
      for (const b of e.bullets) out.push({ kind: 'bullet', text: b });
    }
  }
  if (c.projects.length) {
    section('Projects');
    for (const p of c.projects) {
      out.push({ kind: 'entry', text: [p.name, p.skills.length ? p.skills.join(', ') : ''].filter(Boolean).join(' — ') });
      if (p.url) out.push({ kind: 'meta', text: p.url });
      if (p.description) out.push({ kind: 'text', text: p.description });
      for (const b of p.bullets) out.push({ kind: 'bullet', text: b });
    }
  }
  if (c.education.length) {
    section('Education');
    for (const e of c.education) {
      out.push({ kind: 'entry', text: [[e.degree, e.field].filter(Boolean).join(', '), e.institution].filter(Boolean).join(' — ') });
      const r = range(e.start, e.end);
      if (r) out.push({ kind: 'meta', text: r });
      for (const d of e.details) out.push({ kind: 'bullet', text: d });
    }
  }
  if (c.skills.length) {
    section('Skills');
    out.push({ kind: 'text', text: c.skills.join(', ') });
  }
  if (c.certifications.length) {
    section('Certifications');
    for (const cert of c.certifications) out.push({ kind: 'bullet', text: cert });
  }
  return out;
}

export function resumeToText(c: ResumeContent): string {
  return resumeLines(c)
    .map((l) => (l.kind === 'bullet' ? `• ${l.text}` : l.text))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ----------------------------------------------------------------------------
 * DOCX
 * ------------------------------------------------------------------------- */

function docxParagraph(l: Line): Paragraph {
  switch (l.kind) {
    case 'name':
      return new Paragraph({ children: [new TextRun({ text: l.text, bold: true, size: 32 })], spacing: { after: 40 } });
    case 'headline':
      return new Paragraph({ children: [new TextRun({ text: l.text, size: 22 })] });
    case 'contact':
      return new Paragraph({ children: [new TextRun({ text: l.text, size: 19, color: '444444' })], spacing: { after: 60 } });
    case 'heading':
      return new Paragraph({
        children: [new TextRun({ text: l.text, bold: true, size: 21 })],
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '999999', space: 2 } },
        spacing: { before: 80, after: 80 },
      });
    case 'entry':
      return new Paragraph({ children: [new TextRun({ text: l.text, bold: true, size: 21 })], spacing: { before: 100 } });
    case 'meta':
      return new Paragraph({ children: [new TextRun({ text: l.text, italics: true, size: 19, color: '444444' })] });
    case 'bullet':
      return new Paragraph({ children: [new TextRun({ text: l.text, size: 20 })], bullet: { level: 0 } });
    case 'gap':
      return new Paragraph({ children: [] });
    default:
      return new Paragraph({ children: [new TextRun({ text: l.text, size: 20 })], alignment: AlignmentType.LEFT });
  }
}

function buildDoc(paragraphs: Paragraph[]): Document {
  return new Document({
    creator: 'Job Copilot',
    styles: { default: { document: { run: { font: 'Calibri' } } } },
    sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 1000, right: 1000 } } }, children: paragraphs }],
  });
}

export const resumeDocx = (c: ResumeContent) => buildDoc(resumeLines(c).map(docxParagraph));
export const letterDocx = (body: string) =>
  buildDoc(body.split(/\n{2,}/).map((p) => new Paragraph({ children: p.split('\n').flatMap((line, i) => [...(i ? [new TextRun({ break: 1 })] : []), new TextRun({ text: line, size: 22 })]), spacing: { after: 200 } })));

export async function docxBlob(doc: Document): Promise<Blob> {
  return Packer.toBlob(doc);
}

/* ----------------------------------------------------------------------------
 * PDF (standard fonts → WinAnsi; unsupported characters are replaced)
 * ------------------------------------------------------------------------- */

const REPLACEMENTS: Record<string, string> = { '→': '->', '←': '<-', '✓': 'v', '✔': 'v', ' ': ' ', ' ': ' ', '​': '' };

function safeText(font: PDFFont, text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const c = REPLACEMENTS[ch] ?? ch;
    try {
      font.encodeText(c);
      out += c;
    } catch {
      const stripped = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
      try {
        font.encodeText(stripped);
        out += stripped;
      } catch {
        out += '?';
      }
    }
  }
  return out;
}

class PdfWriter {
  private page!: PDFPage;
  private y = 0;
  constructor(
    private doc: PDFDocument,
    private regular: PDFFont,
    private bold: PDFFont,
    private italic: PDFFont,
    private margin = 54,
    private width = 612,
    private height = 792,
  ) {
    this.newPage();
  }
  private newPage() {
    this.page = this.doc.addPage([this.width, this.height]);
    this.y = this.height - this.margin;
  }
  private wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const words = safeText(font, text).split(/\s+/);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > maxWidth && cur) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
  }
  write(text: string, opts: { font?: 'regular' | 'bold' | 'italic'; size?: number; indent?: number; bullet?: boolean; after?: number; color?: number; rule?: boolean } = {}) {
    const font = opts.font === 'bold' ? this.bold : opts.font === 'italic' ? this.italic : this.regular;
    const size = opts.size ?? 10.5;
    const lead = size * 1.32;
    const indent = (opts.indent ?? 0) + (opts.bullet ? 12 : 0);
    const lines = this.wrap(text, font, size, this.width - this.margin * 2 - indent);
    lines.forEach((line, i) => {
      if (this.y - lead < this.margin) this.newPage();
      this.y -= lead;
      if (opts.bullet && i === 0) this.page.drawText('•', { x: this.margin + (opts.indent ?? 0) + 2, y: this.y, size, font: this.regular });
      this.page.drawText(line, { x: this.margin + indent, y: this.y, size, font, color: rgb(opts.color ?? 0.07, opts.color ?? 0.07, opts.color ?? 0.07) });
    });
    if (opts.rule) {
      this.y -= 3;
      this.page.drawLine({ start: { x: this.margin, y: this.y }, end: { x: this.width - this.margin, y: this.y }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) });
    }
    this.y -= opts.after ?? 0;
  }
  gap(h: number) {
    this.y -= h;
  }
}

async function newPdf(title: string) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('Job Copilot');
  doc.setProducer('Job Copilot');
  const [regular, bold, italic] = await Promise.all([
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
    doc.embedFont(StandardFonts.HelveticaOblique),
  ]);
  return { doc, w: new PdfWriter(doc, regular, bold, italic) };
}

export async function resumePdf(c: ResumeContent): Promise<Uint8Array> {
  const { doc, w } = await newPdf(`${c.basics.name || 'Résumé'} — Résumé`);
  for (const l of resumeLines(c)) {
    if (l.kind === 'name') w.write(l.text, { font: 'bold', size: 18, after: 2 });
    else if (l.kind === 'headline') w.write(l.text, { size: 11 });
    else if (l.kind === 'contact') w.write(l.text, { size: 9.5, color: 0.3, after: 2 });
    else if (l.kind === 'heading') w.write(l.text, { font: 'bold', size: 10.5, rule: true, after: 3 });
    else if (l.kind === 'entry') {
      w.gap(3);
      w.write(l.text, { font: 'bold', size: 10.5 });
    } else if (l.kind === 'meta') w.write(l.text, { font: 'italic', size: 9.5, color: 0.3 });
    else if (l.kind === 'bullet') w.write(l.text, { bullet: true, size: 10 });
    else if (l.kind === 'gap') w.gap(6);
    else w.write(l.text, { size: 10 });
  }
  return doc.save();
}

export async function letterPdf(body: string, title = 'Cover letter'): Promise<Uint8Array> {
  const { doc, w } = await newPdf(title);
  for (const para of body.split(/\n{2,}/)) {
    for (const line of para.split('\n')) w.write(line, { size: 11 });
    w.gap(10);
  }
  return doc.save();
}

/* ----------------------------------------------------------------------------
 * Download helper (extension pages; no "downloads" permission needed)
 * ------------------------------------------------------------------------- */

export function downloadBlob(data: Blob | Uint8Array | string, filename: string, type = 'application/octet-stream'): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function safeFilename(s: string): string {
  return s.replace(/[^\p{L}\p{N} _.-]+/gu, '').replace(/\s+/g, '-').slice(0, 80) || 'export';
}
