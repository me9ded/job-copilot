import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { analyzeProfile } from '../../src/lib/matching/analysis';
import { computeMatch } from '../../src/lib/matching/engine';
import { draftCoverLetter } from '../../src/lib/resume/cover-letter';
import { diffLines } from '../../src/lib/resume/diff';
import { docxBlob, letterPdf, resumeDocx, resumePdf, resumeToText, safeFilename } from '../../src/lib/resume/export';
import { detectKind, extractDocxText, extractPdfText, readResumeFile, ResumeFileError } from '../../src/lib/resume/files';
import { parseResumeText } from '../../src/lib/resume/parse';
import { lintBullet, tailorResume } from '../../src/lib/resume/tailor';
import { buildPrep } from '../../src/lib/interview';
import { csvCell, toCsv } from '../../src/lib/export';
import { Settings } from '../../src/lib/types';
import { makeJob, makeProfile } from '../helpers';

const RESUME = `Sam Rivera
sam@example.com | +1 416 555 0100 | github.com/samr

Summary
Backend engineer focused on Python services.

Experience
Senior Software Engineer — Initech
Jul 2021 – Present
• Led migration of services to AWS with Terraform
• Mentored 3 junior engineers

Software Engineer, Globex
Jan 2019 - Jun 2021
- Built REST APIs in Python and Flask serving 2M requests/day

Education
University of Waterloo
Bachelor of Science in Computer Science, 2018

Skills
Languages: Python, Go, TypeScript
Tools: Docker, PostgreSQL, AWS`;

function docx(paragraphs: string[], extra: Record<string, Uint8Array> = {}): Uint8Array {
  const body = paragraphs
    .map((p) => (p.startsWith('• ') ? `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>${p.slice(2)}</w:t></w:r></w:p>` : `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`))
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(xml), ...extra });
}

const asFile = (name: string, data: Uint8Array) => ({ name, size: data.length, arrayBuffer: async () => data.slice().buffer });

describe('résumé files', () => {
  it('detects formats by content, not by name', () => {
    expect(detectKind('cv.bin', strToU8('%PDF-1.7\n'))).toBe('pdf');
    expect(detectKind('cv.pdf', docx(['x']))).toBe('docx');
    expect(detectKind('cv.txt', strToU8('hello'))).toBe('text');
  });

  it('rejects legacy .doc, renamed and unknown files with clear errors', () => {
    expect(() => detectKind('cv.doc', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]))).toThrow(/Legacy \.doc/);
    expect(() => detectKind('cv.pdf', strToU8('not a pdf'))).toThrow(/not a valid PDF/);
    expect(() => detectKind('cv.docx', strToU8('nope'))).toThrow(/not a valid Word/);
    expect(() => detectKind('cv.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(ResumeFileError);
  });

  it('extracts DOCX paragraphs and list items', () => {
    const text = extractDocxText(docx(['Sam Rivera', 'Experience', '• Built APIs in Python', '• Led AWS migration']));
    expect(text).toBe('Sam Rivera\nExperience\n• Built APIs in Python\n• Led AWS migration');
  });

  it('reports a DOCX without a body or a corrupt zip', () => {
    expect(() => extractDocxText(zipSync({ 'foo.txt': strToU8('x') }))).toThrow(/no document body/);
    const broken = docx(['x']).slice(0, 40);
    expect(() => extractDocxText(broken)).toThrow(ResumeFileError);
  });

  it('enforces empty and size limits before reading', async () => {
    await expect(readResumeFile({ name: 'a.pdf', size: 0, arrayBuffer: async () => new ArrayBuffer(0) })).rejects.toThrow(/empty/);
    await expect(readResumeFile({ name: 'a.pdf', size: 11 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) })).rejects.toThrow(/10 MB/);
  });

  it('reads text and docx résumés end to end', async () => {
    expect((await readResumeFile(asFile('cv.txt', strToU8(RESUME)))).text).toContain('Initech');
    const r = await readResumeFile(asFile('cv.docx', docx(RESUME.split('\n').filter(Boolean))));
    expect(r.kind).toBe('docx');
    expect(r.text).toContain('Led migration of services');
  });

  it('round-trips a generated PDF through the PDF extractor', async () => {
    const pdf = await resumePdf(makeProfile());
    expect(strFromU8(pdf.slice(0, 5))).toBe('%PDF-');
    const text = await extractPdfText(pdf);
    expect(text).toContain('Sam Rivera');
    expect(text).toContain('Led migration of services to AWS with Terraform');
  }, 20_000);

  it('keeps right-aligned columns apart and recovers hyperlink targets from a PDF', async () => {
    const { PDFDocument, PDFName, PDFString, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    const at = (text: string, x: number, y: number) => page.drawText(text, { x, y, size: 10, font });
    at('Sam Rivera', 50, 740);
    at('sam@example.com | LinkedIn', 50, 725);
    at('Experience', 50, 700);
    at('Developer Tools in Test Student', 50, 685);
    at('May 2026 - Aug 2026', 470, 685);
    at('Northwind Systems', 50, 672);
    at('Ottawa, ON', 510, 672);
    at('- Ran the regression suite and triaged failures in the nightly builds', 60, 659);
    const linkX = 50 + font.widthOfTextAtSize('sam@example.com | ', 10);
    const annot = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [linkX, 722, linkX + font.widthOfTextAtSize('LinkedIn', 10), 735],
        Border: [0, 0, 0],
        A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://www.linkedin.com/in/sam-rivera/') },
      }),
    );
    page.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    const text = await extractPdfText(await doc.save());
    expect(text).toContain('LinkedIn linkedin.com/in/sam-rivera');
    expect(text).toContain('Developer Tools in Test Student | May 2026 - Aug 2026');
    expect(text).toContain('Northwind Systems | Ottawa, ON');
    const { content } = parseResumeText(text);
    expect(content.experience[0]).toMatchObject({ title: 'Developer Tools in Test Student', company: 'Northwind Systems', location: 'Ottawa, ON' });
    expect(content.basics.links).toContain('linkedin.com/in/sam-rivera');
  }, 20_000);

  it('turns DOCX tabs into column separators', () => {
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Sales Associate</w:t></w:r><w:r><w:tab/><w:tab/><w:t>Jan 2020 – Present</w:t></w:r></w:p></w:body></w:document>`;
    expect(extractDocxText(zipSync({ 'word/document.xml': strToU8(xml) }))).toBe('Sales Associate | Jan 2020 – Present');
  });

  it('rejects a PDF without selectable text', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage();
    await expect(extractPdfText(await doc.save())).rejects.toThrow(/No selectable text/);
  }, 20_000);
});

describe('résumé parsing', () => {
  it('parses contact details, experience, education and skills', () => {
    const { content } = parseResumeText(RESUME);
    expect(content.basics.name).toBe('Sam Rivera');
    expect(content.basics.email).toBe('sam@example.com');
    expect(content.experience).toHaveLength(2);
    const [first, second] = content.experience;
    expect(first).toMatchObject({ title: 'Senior Software Engineer', company: 'Initech', start: '2021-07', end: 'present' });
    expect(first!.bullets).toEqual(['Led migration of services to AWS with Terraform', 'Mentored 3 junior engineers']);
    expect(second).toMatchObject({ company: 'Globex', start: '2019-01', end: '2021-06' });
    expect(content.education[0]?.institution).toContain('Waterloo');
    expect(content.skills).toEqual(expect.arrayContaining(['Python', 'Go', 'TypeScript', 'Docker', 'PostgreSQL', 'AWS']));
  });

  it('parses two-line "Title ⇥ Dates / Company ⇥ Location" headers (LaTeX templates)', () => {
    const { content } = parseResumeText(`Sam Rivera
555-010-0100 | sam@example.com | LinkedIn linkedin.com/in/sam-rivera

Education
Carleton University | Ottawa, ON
Computer Engineering Technology – Computing Science; GPA: 3.9/4.0 | Sep 2023 – Apr 2027

Experience
Developer Tools in Test Student | May 2026 – Aug 2026
Northwind Systems | Ottawa, ON
• Ran the regression suite and triaged failures
Platform Support Co-op | Sep 2025 – Dec 2025
Contoso | Toronto, ON
• Automated SSH retries in Python

Projects
Tiny Kernel | Jan 2024 – Mar 2024
C, Assembly, Make
• Wrote a VGA text console

Extracurricular Activities
Robotics Club | Nov 2024 – May 2026
• Mentored 15 students`);
    expect(content.basics.links).toEqual(['linkedin.com/in/sam-rivera']);
    expect(content.experience.map(({ title, company, location, start, end }) => ({ title, company, location, start, end }))).toEqual([
      { title: 'Developer Tools in Test Student', company: 'Northwind Systems', location: 'Ottawa, ON', start: '2026-05', end: '2026-08' },
      { title: 'Platform Support Co-op', company: 'Contoso', location: 'Toronto, ON', start: '2025-09', end: '2025-12' },
    ]);
    expect(content.education[0]).toMatchObject({ institution: 'Carleton University', degree: 'Computer Engineering Technology', field: 'Computing Science', details: ['GPA: 3.9/4.0'] });
    expect(content.projects.map((p) => [p.name, p.skills])).toEqual([['Tiny Kernel', ['C', 'Assembly', 'Make']]]);
  });

  it('uses the layout when no title word decides: the company sits with the location', () => {
    const { content } = parseResumeText(`Sam Rivera\n\nExperience\nGlobex | Toronto, ON\nCommand Line Tools | Jan 2020 – Present\n• Did things`);
    expect(content.experience[0]).toMatchObject({ title: 'Command Line Tools', company: 'Globex', location: 'Toronto, ON' });
  });

  it('warns instead of guessing when text has no structure', () => {
    const r = parseResumeText('just some words without any sections at all');
    expect(r.content.experience).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('tailoring', () => {
  const profile = makeProfile();
  const job = makeJob({ requiredQualifications: ['Kubernetes and Python'], preferredQualifications: [] });
  const match = computeMatch({ job: { ...job, fingerprint: "fp" }, profile, weights: Settings.parse({}).weights, dealBreakerCap: 40 });

  it('reorders bullets by relevance and never invents content', () => {
    const r = tailorResume(profile, job, match, { maxBulletsPerRole: 5, excludedExperience: [], excludedProjects: [], maxProjects: 3, hideUnrelatedSkills: false });
    const original = new Set(profile.experience.flatMap((e) => e.bullets));
    for (const b of r.content.experience.flatMap((e) => e.bullets)) expect(original.has(b)).toBe(true);
    expect(new Set(r.content.skills)).toEqual(new Set(profile.skills));
    const globex = r.content.experience.find((e) => e.company === 'Globex')!;
    expect(globex.bullets[0]).toMatch(/Python|Kubernetes/);
  });

  it('honours exclusions and trimming', () => {
    const r = tailorResume(profile, job, match, { maxBulletsPerRole: 1, excludedExperience: ['e1'], excludedProjects: [], maxProjects: 0, hideUnrelatedSkills: true });
    expect(r.content.experience.map((e) => e.id)).toEqual(['e2']);
    expect(r.content.experience[0]!.bullets).toHaveLength(1);
    expect(r.content.projects).toHaveLength(0);
    expect(r.content.skills.every((s) => profile.skills.includes(s))).toBe(true);
  });

  it('flags weak bullets', () => {
    expect(lintBullet('Responsible for on-call rotation').map((i) => i.code)).toEqual(expect.arrayContaining(['weak_opener', 'no_metric']));
    expect(lintBullet('Cut p95 latency 40% by adding a Redis cache')).toEqual([]);
  });

  it('diffs original and tailored text', () => {
    const ops = diffLines('a\nb\nc', 'a\nc\nd');
    expect(ops).toEqual([
      { type: 'same', value: 'a' },
      { type: 'del', value: 'b' },
      { type: 'same', value: 'c' },
      { type: 'add', value: 'd' },
    ]);
  });
});

describe('exports', () => {
  it('produces a valid DOCX with the résumé text', async () => {
    const blob = await docxBlob(resumeDocx(makeProfile()));
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const xml = strFromU8(files['word/document.xml']!);
    expect(xml).toContain('Sam Rivera');
    expect(xml).toContain('Initech');
    // Re-reading our own export works too.
    expect(extractDocxText(new Uint8Array(await blob.arrayBuffer()))).toContain('Mentored 3 junior engineers');
  });

  it('renders non-Latin-1 characters in PDFs without throwing', async () => {
    const pdf = await letterPdf('Dear team — I’d love to join. Résumé attached. 日本語 ✓');
    expect(pdf.length).toBeGreaterThan(500);
  });

  it('plain-text export uses standard headings', () => {
    const t = resumeToText(makeProfile());
    expect(t).toMatch(/EXPERIENCE/);
    expect(t).toMatch(/EDUCATION/);
  });

  it('makes safe filenames', () => {
    expect(safeFilename('Sam / Acme: "Senior" <Dev>')).not.toMatch(/[/:"<>]/);
  });

  it('neutralises spreadsheet formulas in CSV cells', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('plain')).toBe('plain');
    expect(toCsv(['a', 'b'], [['x,y', 'line\nbreak']])).toBe('a,b\r\n"x,y","line\nbreak"');
  });
});

describe('cover letters and interview prep', () => {
  const profile = makeProfile();
  const job = makeJob();
  const match = computeMatch({ job: { ...job, fingerprint: "fp" }, profile, weights: Settings.parse({}).weights, dealBreakerCap: 40 });

  it('drafts a letter using only profile facts', () => {
    const letter = draftCoverLetter(profile, job, match, { tone: 'warm', addressGaps: true });
    expect(letter).toContain('Acme');
    expect(letter).toContain('Sam Rivera');
    const numbers = letter.match(/\d[\d,.]*/g) ?? [];
    const source = JSON.stringify(profile) + JSON.stringify(job);
    for (const n of numbers) expect(source).toContain(n);
  });

  it('builds prep questions grounded in the profile', () => {
    const items = buildPrep(job, profile, match);
    const cats = new Set(items.map((i) => i.category));
    expect(cats.has('technical')).toBe(true);
    expect(cats.has('behavioral')).toBe(true);
    expect(cats.has('ask')).toBe(true);
    const evidence = items.flatMap((i) => i.suggestedEvidence);
    const allBullets = profile.experience.flatMap((e) => e.bullets).join('\n') + profile.projects.flatMap((p) => p.bullets).join('\n');
    for (const e of evidence) expect(allBullets).toContain(e.replace(/^[^:]{1,80}:\s*/, '').slice(0, 30));
    expect(analyzeProfile(profile).skills.size).toBeGreaterThan(0);
  });
});

describe('career profile extraction', () => {
  it('tags academic and personal projects, their dates, and the employment type', async () => {
    const { parseResumeText } = await import('../../src/lib/resume/parse');
    const { content } = parseResumeText(`Jamie Lee
jamie@example.com
Experience
Software Developer Co-op | Jan 2024 – Apr 2024
Acme Corp | Ottawa, ON
• Wrote Python tools
Academic Projects
Tiny Shell | C, Linux | Sep 2023 – Dec 2023
• Implemented a Unix shell with pipes
Personal Projects
Budget App | React
• Built a spending tracker
Skills
Languages: Python, C
Frameworks: React`);
    expect(content.experience[0]).toMatchObject({ title: 'Software Developer Co-op', company: 'Acme Corp', employmentType: 'co-op' });
    expect(content.projects.map((p) => [p.name, p.kind, p.start, p.end])).toEqual([
      ['Tiny Shell', 'academic', '2023-09', '2023-12'],
      ['Budget App', 'personal', '', ''],
    ]);
    expect(content.skills).toEqual(['Python', 'C', 'React']);
  });
});

describe('résumé parsing: grouped roles and parenthesised lists', () => {
  const TEXT = `Alex Chen
555-123-4567 | alex@example.com | github.com/alexc

Education
Northfield College | Ottawa, ON
Computer Engineering Technology – Computing Science, GPA: 3.8/4.0 (Dean’s Honour List) May 2024 – Apr 2027

Technical Skills
Languages: Python, C, Assembly (x86-64, AArch64), Bash
Embedded: ARM64 (SVE, PAuth), Linux

Experience
Acme Systems | Ottawa, ON
Co-op Student, Compiler Tools in Test | May 2026 – Aug 2026
• Wrote 8 C test cases for the compiler.
Co-op Student, Compiler Tools in Test | Sep 2025 – Dec 2025
• Added retry logic to the Python test automation.

Projects
Explainer | Sep 2026 – Present
Python, C, pytest | Course project, team of 2
• Built a CLI that explains compiler errors.
x86-64 Kernel Bootstrap | Jan 2024 – Mar 2024
C, Assembly, Make
• Wrote a VGA text-mode console.`;

  const { content } = parseResumeText(TEXT);

  it('keeps commas inside parentheses within one skill', () => {
    expect(content.skills).toEqual(['Python', 'C', 'Assembly (x86-64, AArch64)', 'Bash', 'ARM64 (SVE, PAuth)', 'Linux']);
  });

  it('gives every role listed under one employer that employer', () => {
    expect(content.experience.map((e) => [e.title, e.company, e.location, e.start, e.end])).toEqual([
      ['Co-op Student, Compiler Tools in Test', 'Acme Systems', 'Ottawa, ON', '2026-05', '2026-08'],
      ['Co-op Student, Compiler Tools in Test', 'Acme Systems', 'Ottawa, ON', '2025-09', '2025-12'],
    ]);
  });

  it('starts a new project at a header line that begins in lower case', () => {
    expect(content.projects.map((p) => [p.name, p.description, p.skills, p.bullets.length])).toEqual([
      ['Explainer', 'Course project, team of 2', ['Python', 'C', 'pytest'], 1],
      ['x86-64 Kernel Bootstrap', '', ['C', 'Assembly', 'Make'], 1],
    ]);
  });

  it('separates the field of study from the GPA and keeps its parenthesis', () => {
    expect(content.education[0]).toMatchObject({
      institution: 'Northfield College',
      degree: 'Computer Engineering Technology',
      field: 'Computing Science',
      details: ['GPA: 3.8/4.0 (Dean’s Honour List)'],
    });
  });
});
