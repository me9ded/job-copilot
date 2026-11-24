import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseLocation } from '../../src/lib/geo';
import { assessText, decodeText, extractDocxText, readResumeFile } from '../../src/lib/resume/files';
import { commitResumeImport, readResumeDraft, textResumeDraft } from '../../src/lib/resume/importer';
import { applyImport, fileStem, findFamily, planCounts, planImport, replanEntry } from '../../src/lib/resume/merge';
import { normalizeContent, tidyName } from '../../src/lib/resume/normalize';
import { normalizeDate, parseResumeText, splitDegree } from '../../src/lib/resume/parse';
import { headingKey, splitSections } from '../../src/lib/resume/sections';
import { getProfile, getResumeFile, listResumes, saveProfile } from '../../src/lib/storage/repo';
import { Profile, ResumeContent, type ResumeVersion } from '../../src/lib/types';
import { makeProfile } from '../helpers';

const asFile = (name: string, data: Uint8Array) => ({ name, size: data.length, arrayBuffer: async () => data.slice().buffer });

function docxXml(body: string): Uint8Array {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${body}</w:body></w:document>`;
  return zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(xml) });
}
const p = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const li = (text: string) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
const cell = (...paras: string[]) => `<w:tc>${paras.join('')}</w:tc>`;

async function pdfWith(pages: string[][], blankPages: number[] = []): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const total = Math.max(pages.length, ...blankPages.map((n) => n + 1));
  for (let i = 0, t = 0; i < total; i++) {
    const page = doc.addPage([612, 792]);
    if (blankPages.includes(i)) {
      // A "scanned" page: only a drawn shape, no text layer.
      page.drawRectangle({ x: 40, y: 40, width: 500, height: 700, borderWidth: 1 });
      continue;
    }
    (pages[t++] ?? []).forEach((line, j) => page.drawText(line, { x: 50, y: 740 - j * 14, size: 10, font }));
  }
  return doc.save();
}

const CLASSIC = `Jordan Avery
Ottawa, ON | jordan.avery@example.com | (613) 555-0142 | linkedin.com/in/jordan-avery | jordanavery.dev

Summary
Embedded software developer who enjoys test automation and tooling.

Work Experience
Software Developer Co-op | Northwind Systems | Ottawa, ON | May 2024 – Aug 2024
• Automated regression tests in Python, cutting manual test time by 40%
• Triaged nightly build failures with GDB and Valgrind
Technologies: Python, pytest, Jenkins

Northwind Systems | Ottawa, ON
QA Analyst | Jan. 2023 – Apr. 2023
• Wrote 120 test cases for the release pipeline

Education
Carleton University
Bachelor of Science in Computer Science | Sep 2021 – Expected May 2025
GPA: 3.8/4.0
Relevant coursework: Operating Systems, Compilers, Data Structures

Projects
Tiny Shell | C, Make | github.com/javery/tiny-shell
• Built a POSIX shell with pipes and job control

Skills
Languages: C, Python, Go
Tools: Docker, Git, GDB

Languages
English (native), French (professional working proficiency)

Awards
• Dean's Honour List, 2022 and 2023
• First place, Ottawa Hackathon 2023

Certifications
AWS Certified Cloud Practitioner (2023)

Volunteer Experience
Coding Mentor | Code Club Ottawa | 2022 – Present
• Mentor 10 kids weekly in Scratch and Python

Interests
Climbing, chess`;

describe('résumé upload manager', () => {
  it('reads a PDF and warns about a page with no text layer (scanned)', async () => {
    const data = await pdfWith([['Jordan Avery', 'Experience', 'QA Analyst | Northwind Systems | 2023 - 2024', '- Wrote test plans and automated regression checks for the release pipeline'.repeat(2)]], [1]);
    const r = await readResumeFile(asFile('cv.pdf', data));
    expect(r.kind).toBe('pdf');
    expect(r.pages).toBe(2);
    expect(r.text).toContain('Northwind Systems');
    expect(r.warnings.join(' ')).toMatch(/Page 2 has no selectable text.*OCR may be required/);
  }, 20_000);

  it('rejects a fully scanned PDF and says OCR would be needed', async () => {
    const data = await pdfWith([], [0, 1]);
    await expect(readResumeFile(asFile('scan.pdf', data))).rejects.toThrow(/No selectable text.*\(OCR\)/);
  }, 20_000);

  it('flags undecodable text (fonts without a character map)', () => {
    const garbled = ' '.repeat(40) + 'Jordan Avery';
    expect(assessText(garbled, { kind: 'pdf' }).fatal).toMatch(/couldn’t be decoded.*OCR/);
    const partly = `Jordan Avery ${'Software developer with test automation experience. '.repeat(4)}${String.fromCharCode(0xe001).repeat(12)}`;
    expect(assessText(partly, { kind: 'pdf', pageChars: [400] }).warnings.join(' ')).toMatch(/couldn’t be decoded/);
  });

  it('rejects images, RTF and OpenDocument files with clear messages', async () => {
    await expect(readResumeFile(asFile('cv.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])))).rejects.toThrow(/image.*OCR/);
    await expect(readResumeFile(asFile('cv.rtf', strToU8('{\\rtf1 hello}')))).rejects.toThrow(/RTF/);
    await expect(readResumeFile(asFile('cv.odt', zipSync({ 'content.xml': strToU8('<x/>') })))).rejects.toThrow(/OpenDocument/);
    await expect(readResumeFile(asFile('cv.txt', strToU8('too short')))).rejects.toThrow(/almost no text/);
  });

  it('decodes UTF-8 (with BOM), UTF-16 and Windows-1252 text files', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8('Résumé')]))).toBe('Résumé');
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x52, 0, 0xe9, 0]))).toBe('Ré');
    expect(decodeText(new Uint8Array([0x52, 0xe9, 0x73]))).toBe('Rés');
  });

  it('reads DOCX tables (one line per row of short cells), layout tables by column, and text boxes once', () => {
    const textBox = `<w:p><w:r><mc:AlternateContent><mc:Choice><w:drawing><w:txbxContent>${p('Ottawa, ON | jordan@example.com')}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${p('Ottawa, ON | jordan@example.com')}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`;
    const data = docxXml(
      p('Jordan Avery') +
        textBox +
        p('Experience') +
        `<w:tbl><w:tr>${cell(p('QA Analyst'))}${cell(p('Jan 2023 – Apr 2023'))}</w:tr></w:tbl>` +
        li('Wrote 120 test cases') +
        `<w:tbl><w:tr>${cell(p('Skills'), p('Python'), p('Docker'))}${cell(p('Education'), p('Carleton University'))}</w:tr></w:tbl>`,
    );
    const text = extractDocxText(data);
    expect(text.split('\n')).toEqual(['Jordan Avery', 'Ottawa, ON | jordan@example.com', 'Experience', 'QA Analyst | Jan 2023 – Apr 2023', '• Wrote 120 test cases', 'Skills', 'Python', 'Docker', 'Education', 'Carleton University']);
  });
});

describe('résumé section detector', () => {
  it('recognises heading variants', () => {
    expect(headingKey('WORK EXPERIENCE')).toBe('experience');
    expect(headingKey('E X P E R I E N C E')).toBe('experience');
    expect(headingKey('Professional Experience (cont.)')).toBe('experience');
    expect(headingKey('— Education —')).toBe('education');
    expect(headingKey('Technical Skills:')).toBe('skills');
    expect(headingKey('Relevant Coursework')).toBe('coursework');
    expect(headingKey('Honours & Awards')).toBe('awards');
    expect(headingKey('Volunteer Experience')).toBe('volunteer');
    expect(headingKey('Languages')).toBe('languages');
    expect(headingKey('Built REST APIs for the billing team')).toBeNull();
  });

  it('routes labelled lines out of the header and skills, keeping document order', () => {
    const s = splitSections(['Jordan Avery', 'Skills: Python, Go', 'Experience', 'Dev | Acme | 2020 - 2021', 'Skills', 'Languages: English, French', 'Tools: Git']);
    expect(s.map((x) => [x.key, x.lines])).toEqual([
      ['preamble', ['Jordan Avery']],
      ['skills', ['Python, Go']],
      ['experience', ['Dev | Acme | 2020 - 2021']],
      ['skills', []],
      ['languages', ['English, French']],
      ['skills', ['Tools: Git']],
    ]);
  });
});

describe('résumé parser', () => {
  it('extracts every section of a classic résumé', () => {
    const { content, issues } = parseResumeText(CLASSIC);
    expect(content.basics).toMatchObject({ name: 'Jordan Avery', email: 'jordan.avery@example.com', phone: '(613) 555-0142', location: 'Ottawa, ON' });
    expect(content.basics.links).toEqual(['linkedin.com/in/jordan-avery', 'jordanavery.dev']);
    expect(content.basics.summary).toBe('Embedded software developer who enjoys test automation and tooling.');

    const [coop, qa, mentor] = content.experience;
    expect(coop).toMatchObject({ title: 'Software Developer Co-op', company: 'Northwind Systems', location: 'Ottawa, ON', start: '2024-05', end: '2024-08', employmentType: 'co-op' });
    // Original wording is kept; the "Technologies:" line becomes the role's tools.
    expect(coop!.bullets).toEqual(['Automated regression tests in Python, cutting manual test time by 40%', 'Triaged nightly build failures with GDB and Valgrind']);
    expect(coop!.skills).toEqual(['Python', 'pytest', 'Jenkins']);
    expect(qa).toMatchObject({ title: 'QA Analyst', company: 'Northwind Systems', start: '2023-01', end: '2023-04' });
    expect(mentor).toMatchObject({ title: 'Coding Mentor', company: 'Code Club Ottawa', start: '2022', end: 'present', employmentType: 'volunteer' });

    expect(content.education[0]).toMatchObject({ institution: 'Carleton University', degree: 'Bachelor of Science', field: 'Computer Science', start: '2021-09', end: '2025-05' });
    expect(content.education[0]!.details).toContain('GPA: 3.8/4.0');
    expect(content.education[0]!.coursework).toEqual(['Operating Systems', 'Compilers', 'Data Structures']);

    expect(content.projects[0]).toMatchObject({ name: 'Tiny Shell', url: 'github.com/javery/tiny-shell' });
    expect(content.projects[0]!.skills).toEqual(expect.arrayContaining(['C', 'Make']));
    expect(content.skills).toEqual(['C', 'Python', 'Go', 'Docker', 'Git', 'GDB']);
    expect(content.languages).toEqual(['English (native)', 'French (professional working proficiency)']);
    expect(content.awards).toEqual(["Dean's Honour List, 2022 and 2023", 'First place, Ottawa Hackathon 2023']);
    expect(content.certifications).toEqual(['AWS Certified Cloud Practitioner (2023)']);
    expect(content.extras).toEqual([{ heading: 'Interests', items: ['Climbing', 'chess'] }]);
    expect(issues).toEqual([]);
  });

  it('handles a one-line-per-role layout with spaced headings and an all-caps name', () => {
    const { content } = parseResumeText(`PRIYA NAIR, P.Eng.
Software Engineer
Toronto, Ontario, Canada · priya@example.org · +1 416 555 0199

E X P E R I E N C E
Senior Software Engineer at Globex Corporation (Mar 2021 - Present)
- Led the payments team of 6 engineers
Software Engineer at Initech Ltd. (06/2017 - 02/2021)
- Built billing APIs in Java and Spring

E D U C A T I O N
University of Toronto — B.Sc. Computer Science, 2017`);
    const c = normalizeContent(content);
    expect(c.basics).toMatchObject({ name: 'Priya Nair', headline: 'Software Engineer', location: 'Toronto, Ontario, Canada', phone: '+1 416 555 0199' });
    expect(c.experience.map((e) => [e.title, e.company, e.start, e.end])).toEqual([
      ['Senior Software Engineer', 'Globex Corporation', '2021-03', 'present'],
      ['Software Engineer', 'Initech Ltd.', '2017-06', '2021-02'],
    ]);
    expect(c.education[0]).toMatchObject({ institution: 'University of Toronto', degree: 'B.Sc.', field: 'Computer Science', end: '2017' });
  });

  it('understands many date formats', () => {
    expect(normalizeDate('Jan. 2020')).toBe('2020-01');
    expect(normalizeDate('September, 2019')).toBe('2019-09');
    expect(normalizeDate('03/2019')).toBe('2019-03');
    expect(normalizeDate('2019-3')).toBe('2019-03');
    expect(normalizeDate('Summer 2021')).toBe('2021-06');
    expect(normalizeDate("Apr '21")).toBe('2021-04');
    expect(normalizeDate('Expected May 2025')).toBe('2025-05');
    expect(normalizeDate('Ongoing')).toBe('present');
    expect(normalizeDate('2018')).toBe('2018');
    expect(normalizeDate('13/2019')).toBe('');
    const { content } = parseResumeText(`A Person
Experience
Analyst | Acme Bank | 2019-03 to 2020-08
- a
Intern | Acme Bank | Summer 2018
- b
Clerk | Shop Inc | Sept 2016 – Apr '17
- c
Tutor | Learning Co | 2014 - 2015
- d`);
    expect(content.experience.map((e) => [e.start, e.end])).toEqual([
      ['2019-03', '2020-08'],
      ['', ''],
      ['2016-09', '2017-04'],
      ['2014', '2015'],
    ]);
  });

  it('splits degrees into level and field', () => {
    expect(splitDegree('Bachelor of Science in Computer Science, 2018')).toEqual({ degree: 'Bachelor of Science', field: 'Computer Science' });
    expect(splitDegree('Master of Engineering (MEng), Electrical')).toEqual({ degree: 'Master of Engineering', field: 'Electrical' });
    expect(splitDegree('Bachelor of Computer Science')).toEqual({ degree: 'Bachelor of Computer Science', field: 'Computer Science' });
    expect(splitDegree('B.Eng. Software Engineering')).toEqual({ degree: 'B.Eng.', field: 'Software Engineering' });
  });

  it('reports missing sections and fields instead of guessing', () => {
    const r = parseResumeText(`Alex Kim
Summary
Curious learner.`);
    expect(r.content.experience).toEqual([]);
    const paths = r.issues.map((i) => `${i.path}:${i.level}`);
    expect(paths).toEqual(expect.arrayContaining(['basics.email:missing', 'basics.phone:missing', 'experience:missing', 'education:missing', 'skills:missing']));
    expect(r.warnings.join(' ')).toMatch(/No “Experience” section/);
  });

  it('copes with a poorly formatted export (page markers, repeated header, no bullets)', () => {
    const { content, unrecognized } = parseResumeText(`Sam Lee
sam.lee@example.com    613-555-0177
Open to relocation

Experience
Support Technician | Contoso Ltd | 2019 - 2021
Answered 40 tickets a day
Page 1 of 2
Sam Lee
sam.lee@example.com    613-555-0177
Network Technician | Fabrikam Inc | 2017 - 2019
Kept the office network running

Skills
Networking; Windows Server | Active Directory`);
    expect(content.basics.phone).toBe('613-555-0177');
    expect(content.experience.map((e) => e.company)).toEqual(['Contoso Ltd', 'Fabrikam Inc']);
    expect(content.experience.every((e) => !/Sam Lee|Page/.test(e.title + e.company))).toBe(true);
    expect(content.skills).toEqual(['Networking', 'Windows Server', 'Active Directory']);
    // Header text that fits nowhere is listed rather than dropped silently.
    expect(unrecognized).toEqual([{ heading: 'Top of the résumé', lines: ['Open to relocation'] }]);
  });

  it('never treats a year range or a date as a phone number', () => {
    const { content } = parseResumeText(`Lee Park
leepark@example.com | 2019 - 2021
Experience
Analyst | Acme Bank | 2019 - 2021`);
    expect(content.basics.phone).toBe('');
  });
});

describe('profile normalizer', () => {
  it('tidies capitalisation, links and duplicate skills without touching bullets', () => {
    expect(tidyName('JEAN-LUC DE LA CROIX')).toBe('Jean-Luc de la Croix');
    expect(tidyName("o'neil mcdonald")).toBe("O'Neil Mcdonald");
    expect(tidyName('Ana María López')).toBe('Ana María López');
    const c = normalizeContent(
      ResumeContent.parse({
        basics: { email: ' Mailto:Jo@Example.COM ', links: ['github.com/jo', 'https://www.github.com/jo/'] },
        skills: ['JS', 'JavaScript', 'reactjs', 'React'],
        experience: [
          { id: 'a', title: 'Dev', company: 'Acme', start: '2020', end: '2021', bullets: ['Shipped  it.'] },
          { id: 'b', title: 'Dev', company: 'Acme', start: '2020', end: '2021', bullets: ['Shipped it.', 'Fixed bugs'] },
        ],
      }),
    );
    expect(c.basics.email).toBe('jo@example.com');
    expect(c.basics.links).toEqual(['github.com/jo']);
    expect(c.skills).toEqual(['JavaScript', 'React']);
    expect(c.experience).toHaveLength(1);
    expect(c.experience[0]!.bullets).toEqual(['Shipped it.', 'Fixed bugs']);
  });

  it('splits locations into city, province / state and country', () => {
    expect(parseLocation('Ottawa, ON')).toMatchObject({ city: 'Ottawa', region: 'Ontario', regionCode: 'ON', country: 'Canada', countryCode: 'CA', countryInferred: true });
    expect(parseLocation('Austin, Texas, USA')).toMatchObject({ city: 'Austin', region: 'Texas', regionCode: 'TX', country: 'United States', countryInferred: false });
    expect(parseLocation('Atlanta, Georgia')).toMatchObject({ city: 'Atlanta', regionCode: 'GA', countryCode: 'US' });
    expect(parseLocation('Tunis, Tunisia')).toMatchObject({ city: 'Tunis', region: '', countryCode: 'TN' });
    expect(parseLocation('Remote (Canada)')).toMatchObject({ remote: true, countryCode: 'CA', city: '' });
    expect(parseLocation('Montréal, QC H3A 0G4')).toMatchObject({ city: 'Montréal', regionCode: 'QC', postalCode: 'H3A 0G4' });
  });
});

describe('profile merge and conflict resolver', () => {
  const current = () =>
    makeProfile({
      basics: { name: 'Sam Rivera', headline: '', email: 'sam@example.com', phone: '+1 416 555 0100', location: '', links: ['linkedin.com/in/sam-rivera'], summary: '' },
    });
  const incoming = () =>
    ResumeContent.parse({
      basics: { name: 'Sam Rivera', email: 'SAM@example.com', phone: '416-555-0199', location: 'Toronto, ON', links: ['linkedin.com/in/samrivera-2', 'github.com/samr'] },
      skills: ['Python', 'Go', 'Kubernetes'],
      experience: [
        // Same role, one new bullet and an exact start date.
        { id: 'n1', title: 'Sr. Software Engineer', company: 'Initech Inc.', start: '2021-07', end: 'present', bullets: ['Led migration of services to AWS with Terraform', 'Cut cloud spend by 30%'] },
        // Same role, but the résumé says it ended earlier: a conflict.
        { id: 'n2', title: 'Software Engineer', company: 'Globex', start: '2019-01', end: '2021-05', bullets: ['Built REST APIs in Python and Flask serving 2M requests/day'] },
        // Same title at the same employer in another period: a possible duplicate, added separately.
        { id: 'n3', title: 'Software Engineer', company: 'Globex', start: '2015-01', end: '2016-01', bullets: [] },
        { id: 'n4', title: 'Intern', company: 'Hooli', start: '2014-05', end: '2014-08', bullets: ['Wrote tests'] },
      ],
      education: [{ id: 'd1', institution: 'The University of Waterloo', degree: 'B.Sc.', field: 'Computer Science', end: '2018' }],
      certifications: ['AWS Solutions Architect'],
      languages: ['English'],
    });

  it('classifies each entry and never overwrites by default', () => {
    const plan = planImport(current(), incoming());
    const byId = Object.fromEntries(plan.experience.map((e) => [e.incoming.id, e]));
    expect(byId.n1).toMatchObject({ existingId: 'e2', status: 'update', action: 'merge' });
    expect(byId.n1!.adds).toEqual(['1 new bullet']);
    expect(byId.n2).toMatchObject({ existingId: 'e1', status: 'conflict', action: 'merge' });
    expect(byId.n2!.conflicts).toEqual([{ field: 'end', label: 'End date', current: '2021-06', incoming: '2021-05', take: 'current' }]);
    expect(byId.n3).toMatchObject({ status: 'new', similarId: 'e1', action: 'add' });
    expect(byId.n4).toMatchObject({ status: 'new', action: 'add' });
    expect(plan.education[0]).toMatchObject({ existingId: 'ed1', status: 'update' });

    const basics = Object.fromEntries(plan.basics.map((b) => [b.field, b]));
    expect(basics.email!.status).toBe('same');
    expect(basics.phone).toMatchObject({ status: 'conflict', take: 'current' });
    expect(basics.location).toMatchObject({ status: 'new', take: 'incoming' });
    expect(plan.links).toEqual([
      { url: 'linkedin.com/in/samrivera-2', kind: 'linkedin', status: 'conflict', replaces: 'linkedin.com/in/sam-rivera', include: false },
      { url: 'github.com/samr', kind: 'github', status: 'new', include: true },
    ]);
    expect(plan.lists.skills.added.map((s) => s.value)).toEqual(['Go', 'Kubernetes']);
    expect(plan.lists.skills.alreadyHave).toEqual(['Python']);
    expect(planCounts(plan)).toMatchObject({ conflicts: 3, possibleDuplicates: 1 });

    const next = applyImport(current(), plan, 'res_new');
    expect(next.basics).toMatchObject({ phone: '+1 416 555 0100', location: 'Toronto, ON', links: ['linkedin.com/in/sam-rivera', 'github.com/samr'] });
    const e2 = next.experience.find((e) => e.id === 'e2')!;
    expect(e2.bullets).toEqual(['Led migration of services to AWS with Terraform', 'Mentored 3 junior engineers', 'Responsible for on-call rotation', 'Cut cloud spend by 30%']);
    expect(next.experience.find((e) => e.id === 'e1')!.end).toBe('2021-06');
    // New roles are slotted in by date; nothing is duplicated.
    expect(next.experience.map((e) => e.company)).toEqual(['Globex', 'Initech', 'Globex', 'Hooli']);
    expect(next.skills).toEqual([...current().skills, 'Go', 'Kubernetes']);
    expect(next.languages).toEqual(['English']);
    expect(next.provenance).toMatchObject({ 'basics.location': ['res_new'], 'basics.email': ['res_new'], 'experience:e2': ['res_new'], 'skills:go': ['res_new'], 'skills:python': ['res_new'] });
  });

  it('applies the choices made during review', () => {
    const plan = planImport(current(), incoming());
    plan.basics.find((b) => b.field === 'phone')!.take = 'incoming';
    plan.links[0]!.include = true;
    plan.experience.find((e) => e.incoming.id === 'n2')!.conflicts[0]!.take = 'incoming';
    plan.experience.find((e) => e.incoming.id === 'n4')!.action = 'skip';
    plan.lists.skills.added.find((s) => s.value === 'Go')!.include = false;
    const next = applyImport(current(), plan, 'res_new');
    expect(next.basics.phone).toBe('416-555-0199');
    expect(next.basics.links).toEqual(['linkedin.com/in/samrivera-2', 'github.com/samr']);
    expect(next.experience.find((e) => e.id === 'e1')!.end).toBe('2021-05');
    expect(next.experience.some((e) => e.company === 'Hooli')).toBe(false);
    expect(next.skills).not.toContain('Go');
  });

  it('re-checks an entry edited during review', () => {
    const plan = planImport(current(), incoming());
    const n2 = plan.experience.find((e) => e.incoming.id === 'n2')!;
    const fixed = replanEntry('experience', { ...n2, incoming: { ...n2.incoming, end: '2021-06' } }, current().experience);
    expect(fixed.status).toBe('duplicate');
  });

  it('finds nothing new when the same résumé is uploaded twice', () => {
    const c = normalizeContent(parseResumeText(CLASSIC).content);
    const first = applyImport(Profile.parse({ basics: {} }), planImport(null, c), 'r1');
    const again = planImport(first, normalizeContent(parseResumeText(CLASSIC).content));
    expect(again.experience.every((e) => e.status === 'duplicate')).toBe(true);
    expect(again.education.every((e) => e.status === 'duplicate')).toBe(true);
    expect(planCounts(again)).toMatchObject({ added: 0, conflicts: 0, merged: 0 });
  });

  it('replaces the profile only when asked, keeping job preferences', () => {
    const profile = current();
    profile.preferences.roleTitles = ['Backend Engineer'];
    const next = applyImport(profile, planImport(null, incoming()), 'res_new', { replace: true });
    expect(next.experience).toHaveLength(4);
    expect(next.basics.phone).toBe('416-555-0199');
    expect(next.preferences.roleTitles).toEqual(['Backend Engineer']);
  });

  it('groups uploads of the same résumé into versions', () => {
    expect(fileStem('Jordan_Avery_Resume (3).pdf')).toBe(fileStem('jordan-avery-resume-v2.docx'));
    const prior = { id: 'r1', name: 'x', kind: 'original', sourceFileName: 'Jordan_Avery_CV.pdf', content: parseResumeText(CLASSIC).content, createdAt: '', updatedAt: '' } as ResumeVersion;
    expect(findFamily([prior], 'Jordan_Avery_CV (1).pdf', ResumeContent.parse({ basics: {} }))?.id).toBe('r1');
    expect(findFamily([prior], 'cv-final.pdf', parseResumeText(CLASSIC).content)?.id).toBe('r1');
    expect(findFamily([prior], 'other.pdf', parseResumeText('Someone Else\nExperience\nChef | Diner | 2020 - 2021').content)).toBeUndefined();
  });
});

describe('résumé import storage', () => {
  it('saves nothing until confirmed, then stores the original, its file and the merged profile', async () => {
    const draft = await readResumeDraft(asFile('jordan.pdf', await pdfWith([CLASSIC.split('\n').slice(0, 30)])));
    expect(draft.kind).toBe('pdf');
    expect(draft.file?.type).toBe('application/pdf');
    expect(await listResumes()).toEqual([]);
    const plan = planImport(await getProfile(), draft.parsed.content);
    const { profile, resume } = await commitResumeImport(draft, draft.parsed.content, plan);
    expect(profile.basics.name).toBe('Jordan Avery');
    expect(resume).toMatchObject({ kind: 'original', sourceFileName: 'jordan.pdf', fileKind: 'pdf', family: resume.id });
    expect((await getResumeFile(resume.id))?.name).toBe('jordan.pdf');
    expect(profile.provenance?.['basics.name']).toEqual([resume.id]);
  }, 20_000);

  it('merges a second version into the profile without duplicates', async () => {
    const first = textResumeDraft(CLASSIC, 'jordan.txt');
    await commitResumeImport(first, first.parsed.content, planImport(await getProfile(), first.parsed.content));
    const v2 = textResumeDraft(CLASSIC.replace('• Wrote 120 test cases for the release pipeline', '• Wrote 120 test cases for the release pipeline\n• Added flaky-test detection'), 'jordan (2).txt');
    const plan = planImport(await getProfile(), v2.parsed.content);
    expect(plan.experience.map((e) => e.status)).toEqual(['duplicate', 'update', 'duplicate']);
    const { profile } = await commitResumeImport(v2, v2.parsed.content, plan, { family: (await listResumes())[0]!.id });
    expect(profile.experience).toHaveLength(3);
    expect(profile.experience[1]!.bullets).toEqual(['Wrote 120 test cases for the release pipeline', 'Added flaky-test detection']);
    const versions = await listResumes();
    expect(versions).toHaveLength(2);
    expect(versions[1]!.family).toBe(versions[0]!.id);
  });

  it('removes the stored original if the profile cannot be saved', async () => {
    const draft = textResumeDraft(CLASSIC, 'x.txt');
    const plan = planImport(null, draft.parsed.content);
    // An invalid preferences object makes the profile fail validation on save.
    await saveProfile(Profile.parse({ basics: {} }));
    const broken = { ...plan, basics: plan.basics.map((b) => (b.field === 'name' ? { ...b, incoming: 5 as unknown as string } : b)) };
    await expect(commitResumeImport(draft, draft.parsed.content, broken)).rejects.toThrow();
    expect(await listResumes()).toEqual([]);
  });
});
