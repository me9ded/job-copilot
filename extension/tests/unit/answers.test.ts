import { describe, expect, it } from 'vitest';
import { classifyQuestion, composeAnswer, fitLength, hasSlot } from '../../src/lib/autofill/answers';
import { groupSkills, inferEmploymentType, skillEvidence, splitBullets } from '../../src/lib/profile/organize';
import { Profile } from '../../src/lib/types';
import { makeJob } from '../helpers';

const NOW = new Date('2026-11-01');

const profile = Profile.parse({
  basics: { name: 'Alex Kim', email: 'alex@example.com' },
  skills: ['Python', 'Linux', 'C', 'TypeScript', 'React', 'Git', 'Bash'],
  experience: [
    {
      id: 'qnx',
      title: 'Software Test Student',
      company: 'BlackBerry QNX',
      start: '2025-01',
      end: 'present',
      bullets: [
        'Developed Python test automation for command line tools on QNX and Linux, cutting regression time by 40%',
        'Maintained Bash scripts for nightly builds',
      ],
    },
    {
      id: 'web',
      title: 'Frontend Developer Intern',
      company: 'Shopify',
      start: '2024-05',
      end: '2024-08',
      bullets: ['Built React and TypeScript components for the checkout page', 'Responsible for accessibility fixes'],
    },
  ],
  projects: [
    { id: 'p1', name: 'Tiny Shell', kind: 'academic', bullets: ['Implemented a Unix shell in C with pipes and job control'], skills: ['C', 'Linux'] },
    { id: 'p2', name: 'Budget App', kind: 'personal', bullets: ['Built a React app to track spending'], skills: ['React'] },
  ],
});

const systemsJob = makeJob({ title: 'Systems Engineer', company: 'Acme', requiredQualifications: ['Python and Linux', 'Bash scripting'], preferredQualifications: [], descriptionText: 'Python Linux Bash' });
const frontendJob = makeJob({ title: 'Frontend Engineer', company: 'Globex', requiredQualifications: ['React and TypeScript'], preferredQualifications: [], descriptionText: 'React TypeScript' });

describe('question classification', () => {
  it.each([
    ['Tell us about your Python experience', 'skill_experience', ['Python']],
    ['Describe your experience with Linux.', 'skill_experience', ['Linux']],
    ['How many years of Python experience do you have?', 'years_of', ['Python']],
    ['Describe your previous work experience', 'work_experience', []],
    ['Describe a challenging technical project', 'project', []],
    ['Why do you want to work here?', 'motivation', []],
    ['What makes you a good candidate?', 'fit', []],
    ['Cover letter', 'cover_letter', []],
    ['Anything else we should know?', 'other', []],
  ])('%s → %s', (label, type, skills) => {
    const q = classifyQuestion(label, profile);
    expect(q.type).toBe(type);
    expect(q.skills).toEqual(skills);
  });
});

describe('answer composer', () => {
  it('answers a skill question only with bullets that mention the skill, quoted with their role', () => {
    const d = composeAnswer('Tell us about your Python experience', profile, null, { now: NOW });
    expect(d.text).toMatch(/^I have worked with Python for over a year\./);
    expect(d.text).toContain('As a Software Test Student at BlackBerry QNX, I developed Python test automation for command line tools on QNX and Linux, cutting regression time by 40%.');
    expect(d.text).not.toContain('React');
    expect(d.evidence.every((e) => e.skills.includes('Python'))).toBe(true);
  });

  it('never claims a skill the profile lacks', () => {
    const d = composeAnswer('Describe your experience with Kubernetes', profile);
    expect(d.text).toBe('');
    expect(d.missingSkills).toEqual(['Kubernetes']);
    expect(d.note).toMatch(/doesn’t mention Kubernetes|doesn't mention Kubernetes/);
  });

  it('tailors general answers to the job: systems roles get Python / Linux, frontend roles get React / TypeScript', () => {
    const sys = composeAnswer('What makes you a good candidate?', profile, systemsJob);
    const fe = composeAnswer('What makes you a good candidate?', profile, frontendJob);
    expect(sys.text).toMatch(/^I'd bring hands-on experience with (Python|Linux|Bash)/);
    expect(sys.evidence[0]!.id).toBe('qnx');
    expect(fe.text).toMatch(/^I'd bring hands-on experience with (React|TypeScript)/);
    expect(fe.evidence[0]!.id).toBe('web');
    for (const d of [sys, fe]) for (const e of d.evidence) expect(profile.experience.flatMap((x) => x.bullets).concat(profile.projects.flatMap((p) => p.bullets))).toContain(e.text);
  });

  it('leaves a slot for what only the user can say, and the slot blocks filling', () => {
    const d = composeAnswer('Why do you want to work here?', profile, systemsJob);
    expect(d.text).toContain('the Systems Engineer role at Acme');
    expect(hasSlot(d.text)).toBe(true);
    expect(hasSlot(d.text.replace(/\[[^\]]*\]/, 'I use your product daily'))).toBe(false);
  });

  it('describes the most relevant project and asks for the challenge', () => {
    const d = composeAnswer('Describe a challenging technical project', profile, systemsJob);
    expect(d.text).toContain('In my project Tiny Shell, I implemented a Unix shell in C with pipes and job control.');
    expect(hasSlot(d.text)).toBe(true);
  });

  it('counts years of a skill from the dated roles that mention it, and explains how', () => {
    const d = composeAnswer('How many years of experience do you have with React?', profile, null, { now: NOW });
    expect(d.text).toBe('0');
    expect(d.note).toContain('Frontend Developer Intern at Shopify');
    expect(composeAnswer('How many years of Python experience?', profile, null, { now: NOW }).text).toBe('1');
    expect(composeAnswer('Years of Kubernetes experience', profile).missingSkills).toEqual(['Kubernetes']);
  });

  it('summarises work experience from the most relevant roles', () => {
    const d = composeAnswer('Describe your previous work experience', profile, frontendJob);
    expect(d.text.startsWith('As a Frontend Developer Intern at Shopify, I built React and TypeScript components')).toBe(true);
    expect(d.text).toContain('I also was responsible for accessibility fixes.');
  });

  it('respects the field length, keeping whole sentences', () => {
    const d = composeAnswer('Tell us about your Python experience', profile, null, { maxLength: 120, now: NOW });
    expect(d.text.length).toBeLessThanOrEqual(120);
    expect(d.text.endsWith('.')).toBe(true);
    expect(fitLength(['A very long sentence that does not fit at all.'], 20)).toBe('A very long…');
  });
});

describe('profile organisation', () => {
  it('groups skills, splits achievements from responsibilities and guesses employment type', () => {
    expect(groupSkills(profile.skills).map((g) => [g.group, g.skills])).toEqual([
      ['languages', ['Python', 'C', 'TypeScript', 'Bash']],
      ['frameworks', ['React']],
      ['tools', ['Linux', 'Git']],
    ]);
    const { achievements, responsibilities } = splitBullets(profile.experience[0]!.bullets);
    expect(achievements).toHaveLength(1);
    expect(responsibilities).toEqual(['Maintained Bash scripts for nightly builds']);
    expect(inferEmploymentType('Software Test Student')).toBe('internship');
    expect(inferEmploymentType('Co-op Developer')).toBe('co-op');
    expect(inferEmploymentType('Software Engineer')).toBe('');
  });
  it('finds where a skill is used', () => {
    const e = skillEvidence(profile, 'Linux');
    expect(e.roles.map((r) => r.id)).toEqual(['qnx']);
    expect(e.projects.map((p) => p.id)).toEqual(['p1']);
  });
});
