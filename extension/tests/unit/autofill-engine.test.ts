import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerQuestionDetailed, findQuestions, optionScore, runApplication, type FillData, type FillRequest } from '../../src/lib/autofill/fill';
import { classifyQuestion } from '../../src/lib/autofill/engine/classify';
import { detectScope, scopedQuestions } from '../../src/lib/autofill/engine/detect';
import { pickOption, phoneCodeValues, sameText } from '../../src/lib/autofill/engine/match';
import { findNext } from '../../src/lib/autofill/engine/steps';
import { mergeInto, emptyReport } from '../../src/lib/autofill/engine/report';
import { inferredKeys, profileFillValues } from '../../src/lib/autofill/run';
import { AutofillSettings } from '../../src/lib/types';
import { makeProfile } from '../helpers';

/** A fictional applicant. */
const DATA: FillData = {
  firstName: 'Jordan',
  lastName: 'Avery',
  fullName: 'Jordan Avery',
  email: 'jordan@example.com',
  phone: '+1 613 555 0142',
  location: 'Ottawa, ON K1P 5J2',
  address: '',
  city: 'Ottawa',
  state: 'Ontario',
  postalCode: 'K1P 5J2',
  country: 'Canada',
  linkedin: 'https://linkedin.com/in/jordan-avery',
  github: '',
  website: '',
  currentTitle: 'Software Developer',
  currentCompany: 'Northwind Systems',
  school: 'Carleton University',
  degree: 'Bachelor of Science',
  discipline: 'Computer Science',
};

const NO_ANSWERS = { standard: {}, saved: [], tickConsent: false };
const req = (over: Partial<FillRequest> = {}): FillRequest => ({ data: DATA, overwrite: false, answers: NO_ANSWERS, advance: false, ...over });
const $ = <T extends HTMLElement = HTMLInputElement>(s: string) => document.querySelector(s) as T;

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('form detection', () => {
  it('fills the application, not the site search, newsletter or cookie banner', async () => {
    document.body.innerHTML = `
      <header><form role="search"><input name="q" aria-label="Search jobs"></form></header>
      <div id="onetrust-banner-sdk"><label><input type="checkbox" id="ck"> Accept all cookies</label></div>
      <form id="newsletter"><p>Subscribe to our newsletter</p><label for="nl">Email</label><input id="nl" type="email"><button>Subscribe</button></form>
      <form id="apply"><label for="fn">First name</label><input id="fn"><label for="em">Email</label><input id="em" type="email"><button type="submit">Submit application</button></form>`;
    const r = await runApplication(document, req());
    expect($('#nl').value).toBe('');
    expect($('#ck').checked).toBe(false);
    expect($('#em').value).toBe('jordan@example.com');
    expect(r.filled.map((f) => f.label)).toEqual(['First name', 'Email']);
    expect(r.stop).toBe('submit_ready');
  });

  it('does not call a job page with only “Apply now” and a search box ready to submit', async () => {
    document.body.innerHTML = `
      <nav><input type="search" aria-label="Search"></nav>
      <h1>Backend Developer</h1><p>Join our team.</p><button type="button" id="apply">Apply now</button>`;
    const r = await runApplication(document, req());
    expect(r.stop).toBe('no_form');
    expect(r.submitLabel).toBeUndefined();
  });

  it('opens the form behind “Apply” and fills it', async () => {
    document.body.innerHTML = `<h1>Backend Developer</h1><button type="button" id="apply">Apply</button><div id="slot"></div>`;
    $('#apply').addEventListener('click', () => {
      $('#slot').innerHTML = `<form><label for="fn">First name</label><input id="fn"><button type="submit">Submit</button></form>`;
    });
    const r = await runApplication(document, req({ advance: true }));
    expect($('#fn').value).toBe('Jordan');
    expect(r.stop).toBe('submit_ready');
  }, 15_000);

  it('excludes honeypots and keeps scoped questions stable', () => {
    document.body.innerHTML = `<form><label for="a">Email</label><input id="a"><input name="hp_field" aria-label="Leave this field blank"></form>`;
    const qs = scopedQuestions(document, detectScope(document));
    expect(qs.map((q) => q.label)).toEqual(['Email']);
  });
});

describe('classification', () => {
  it('never gives a reference or emergency contact the applicant’s details', async () => {
    document.body.innerHTML = `
      <form>
        <section><h3>Your details</h3><label for="n">Full name</label><input id="n"><label for="e">Email</label><input id="e"></section>
        <section><h3>Professional reference</h3><label for="rn">Full name</label><input id="rn"><label for="re">Email</label><input id="re"></section>
      </form>`;
    const r = await runApplication(document, req());
    expect($('#n').value).toBe('Jordan Avery');
    expect($('#e').value).toBe('jordan@example.com');
    expect($('#rn').value).toBe('');
    expect($('#re').value).toBe('');
    expect(r.unanswered.map((u) => [u.label, u.section])).toEqual([
      ['Full name', 'Professional reference'],
      ['Email', 'Professional reference'],
    ]);
  });

  it('never signs, and never types identity numbers', async () => {
    document.body.innerHTML = `
      <label for="sig">Signature (type your full name) *</label><input id="sig" required>
      <label for="sin">Social Insurance Number</label><input id="sin">`;
    const r = await runApplication(document, req({ answers: { ...NO_ANSWERS, saved: [{ question: 'Social Insurance Number', answer: '123 456 789' }] } }));
    expect($('#sig').value).toBe('');
    expect($('#sin').value).toBe('');
    expect(r.unanswered).toMatchObject([{ label: 'Signature (type your full name)', reason: 'signature', category: 'consent', required: true }]);
    expect(r.skipped?.map((s) => s.label)).toEqual(['Social Insurance Number']);
    expect(r.stop).toBe('needs_answers');
  });

  it('weighs a field’s own label above its name attribute', () => {
    document.body.innerHTML = `<label for="x">Last name</label><input id="x" name="first_name">`;
    const [q] = findQuestions(document);
    expect(classifyQuestion(q!)).toMatchObject({ type: 'profile', key: 'lastName' });
  });

  it('fills address parts from the location and reports the street address as missing', async () => {
    document.body.innerHTML = `
      <label for="a">Street address</label><input id="a">
      <label for="c">City</label><input id="c">
      <label for="p">Province</label><select id="p"><option value="">Select</option><option value="AB">Alberta</option><option value="ON">Ontario</option><option value="QC">Quebec</option></select>
      <label for="z">Postal code</label><input id="z">
      <label for="k">Country</label><select id="k"><option value="">Select</option><option value="US">United States</option><option value="CA">Canada</option></select>`;
    const r = await runApplication(document, req({ inferred: ['state', 'country'] }));
    expect($('#c').value).toBe('Ottawa');
    expect($<HTMLSelectElement>('#p').value).toBe('ON');
    expect($('#z').value).toBe('K1P 5J2');
    expect($<HTMLSelectElement>('#k').value).toBe('CA');
    expect(r.noValue).toEqual(['Street address']);
    expect(r.filled.filter((f) => f.basis === 'inferred').map((f) => f.key)).toEqual(['state', 'country']);
  });

  it('answers “Do you have experience with X?” only for skills on the résumé', async () => {
    document.body.innerHTML = `
      <fieldset><legend>Do you have experience with TypeScript?</legend><label><input type="radio" name="ts" value="y">Yes</label><label><input type="radio" name="ts" value="n">No</label></fieldset>
      <fieldset><legend>Do you have experience with Rust?</legend><label><input type="radio" name="rs" value="y">Yes</label><label><input type="radio" name="rs" value="n">No</label></fieldset>`;
    const r = await runApplication(document, req({ lists: { skills: ['TypeScript', 'React'], languages: [], certifications: [] } }));
    expect($('input[name=ts][value=y]').checked).toBe(true);
    expect(document.querySelectorAll('input[name=rs]:checked')).toHaveLength(0);
    expect(r.filled).toMatchObject([{ label: 'Do you have experience with TypeScript?', key: 'skill', basis: 'explicit' }]);
    expect(r.unanswered).toMatchObject([{ label: 'Do you have experience with Rust?', reason: 'skill' }]);
  });
});

describe('strict option matching', () => {
  it('never picks an option because the text merely looks similar', () => {
    expect(optionScore('Female', 'Male')).toBe(0);
    expect(optionScore('Man', 'Male')).toBeGreaterThanOrEqual(0.9);
    expect(optionScore('JavaScript', 'Java')).toBe(0);
    expect(optionScore('Canada (+1)', 'Canada')).toBeGreaterThanOrEqual(0.6);
    expect(optionScore('ON', 'Ontario')).toBeGreaterThanOrEqual(0.9);
    expect(optionScore('CA', 'Canada')).toBe(0);
    expect(optionScore("Bachelor's Degree", 'Bachelor of Science')).toBeGreaterThanOrEqual(0.85);
    expect(optionScore('Bachelor of Arts', 'Bachelor of Science')).toBe(0);
    expect(optionScore('Ottawa, Ontario, Canada', 'Ottawa, ON', { place: true })).toBeGreaterThan(0.9);
    expect(optionScore('Ottawa, Illinois, United States', 'Ottawa, ON', { place: true })).toBe(0);
  });

  it('asks instead of choosing between near-identical options', () => {
    const pick = pickOption(['Software Engineer I', 'Software Engineer II', 'Designer'], (x) => x, 'Software Engineer');
    expect(pick && 'ambiguous' in pick ? pick.ambiguous : null).toEqual(['Software Engineer I', 'Software Engineer II']);
  });

  it('reads back values the way fields format them', () => {
    expect(sameText('(613) 555-0142', '+1 613 555 0142')).toBe(true);
    expect(sameText('linkedin.com/in/jordan-avery', 'https://linkedin.com/in/jordan-avery')).toBe(true);
    expect(sameText('Jordan', 'Jordan Avery')).toBe(false);
    expect(phoneCodeValues('Canada', '+44 20 7946 0958', true)).toEqual(['United Kingdom (+44)', 'United Kingdom', '+44']);
    expect(phoneCodeValues('Canada', '613 555 0142', false)).toEqual(['+1']);
  });

  it('reports an ambiguous select as a question, with the choices', async () => {
    document.body.innerHTML = `<label for="t">Current title</label><select id="t"><option value="">Choose</option><option>Software Developer I</option><option>Software Developer II</option></select>`;
    const r = await runApplication(document, req());
    expect($<HTMLSelectElement>('#t').value).toBe('');
    expect(r.unanswered).toMatchObject([{ label: 'Current title', reason: 'ambiguous', options: ['Software Developer I', 'Software Developer II'] }]);
  });
});

describe('verification', () => {
  it('reports a field that refuses the value as failed, never as filled', async () => {
    document.body.innerHTML = `<label for="e">Email</label><input id="e">`;
    const el = $('#e');
    el.addEventListener('change', () => (el.value = ''));
    el.addEventListener('keyup', () => (el.value = ''));
    const r = await runApplication(document, req());
    expect(r.filled).toEqual([]);
    expect(r.failed).toMatchObject([{ label: 'Email', reason: 'The field didn’t keep the value.' }]);
    expect(el.getAttribute('data-job-copilot')).toBe('failed');
  });

  it('moves a value the page clears afterwards to “unverified”', async () => {
    document.body.innerHTML = `<label for="c">Current company</label><input id="c">`;
    const el = $('#c');
    el.addEventListener('change', () => setTimeout(() => (el.value = ''), 40));
    const r = await runApplication(document, req());
    expect(r.filled).toEqual([]);
    expect(r.unverified).toMatchObject([{ label: 'Current company' }]);
  });

  it('types character by character when a field ignores a pasted value', async () => {
    document.body.innerHTML = `<label for="p">Phone</label><input id="p">`;
    const el = $('#p');
    // A mask that rebuilds its value from key presses and drops anything set directly.
    let digits = '';
    el.addEventListener('keydown', (e) => {
      if (/^\d$/.test(e.key)) digits += e.key;
      e.preventDefault();
    });
    el.addEventListener('input', () => {
      const d = digits.replace(/^1/, '').slice(0, 10);
      el.value = d.length > 6 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d;
    });
    const r = await runApplication(document, req());
    expect(el.value).toBe('(613) 555-0142');
    expect(r.filled.map((f) => f.key)).toEqual(['phone']);
  });
});

describe('readiness before “ready to submit”', () => {
  it('stops at needs_answers while a required field is empty, and marks it', async () => {
    document.body.innerHTML = `<form><label for="fn">First name</label><input id="fn"><label for="w">Why us? *</label><textarea id="w" required></textarea><button type="submit">Submit</button></form>`;
    const r = await runApplication(document, req());
    expect(r.stop).toBe('needs_answers');
    expect($('#w').getAttribute('data-job-copilot')).toBe('needed');
  });

  it('stops at errors when a kept value is invalid', async () => {
    document.body.innerHTML = `<form><label for="em">Email</label><input id="em" type="email" value="not-an-email"><button type="submit">Submit</button></form>`;
    const r = await runApplication(document, req());
    expect(r.stop).toBe('errors');
    expect(r.errors).toEqual(['Email: isn’t in the expected format']);
  });
});

describe('step buttons', () => {
  const nextFor = (label: string) => {
    document.body.innerHTML = `<form><label for="em">Email</label><input id="em" type="email"><button type="button">${label}</button></form>`;
    return findNext(document)?.textContent ?? null;
  };

  it('presses Next buttons that name the step they lead to', () => {
    for (const label of ['Next', 'Next →', 'Save and continue', 'Next: Experience', 'Next step: Review', 'Continue to questions', 'Next (2 of 4)']) {
      expect(nextFor(label), label).toBe(label);
    }
  });

  it('never takes a submit, sign-in or leave-the-form button for Next', () => {
    for (const label of ['Submit application', 'Next: Review & submit', 'Continue to submission', 'Continue with Google', 'Save and continue later', 'Next job', 'Continue to careers site']) {
      expect(nextFor(label), label).toBeNull();
    }
  });
});

describe('dynamic, duplicate, shadow and rich-text fields', () => {
  it('fills follow-up questions that appear after an answer', async () => {
    document.body.innerHTML = `<label for="s">Will you require sponsorship?</label><select id="s"><option value="">Select</option><option>Yes</option><option>No</option></select><div id="more"></div>`;
    $('#s').addEventListener('change', () =>
      setTimeout(() => {
        $('#more').innerHTML = `<label for="v">Which visa do you hold?</label><input id="v">`;
      }, 60),
    );
    const r = await runApplication(document, req({ answers: { ...NO_ANSWERS, standard: { sponsorship: 'Yes' }, saved: [{ question: 'Which visa do you hold?', answer: 'Study permit' }] } }));
    expect($('#v').value).toBe('Study permit');
    expect(r.filled.map((f) => f.label)).toEqual(['Will you require sponsorship?', 'Which visa do you hold?']);
  });

  it('gives questions with the same label their own ids and answers the right one', async () => {
    document.body.innerHTML = `
      <section><h3>Role 1</h3><fieldset><legend>Willing to travel?</legend><label><input type="radio" name="t1" value="y">Yes</label><label><input type="radio" name="t1" value="n">No</label></fieldset></section>
      <section><h3>Role 2</h3><fieldset><legend>Willing to travel?</legend><label><input type="radio" name="t2" value="y">Yes</label><label><input type="radio" name="t2" value="n">No</label></fieldset></section>`;
    const r = await runApplication(document, req());
    expect(r.unanswered.map((u) => u.id)).toEqual(['radio:willing to travel#1', 'radio:willing to travel#2']);
    // Told apart by the heading above them, not by their own legend.
    expect(r.unanswered.map((u) => u.section)).toEqual(['Role 1', 'Role 2']);
    const out = await answerQuestionDetailed(document, 'radio:willing to travel#2', 'No');
    expect(out.ok).toBe(true);
    expect($('input[name=t2][value=n]').checked).toBe(true);
    expect(document.querySelectorAll('input[name=t1]:checked')).toHaveLength(0);
  });

  it('fills fields inside open shadow roots with events that reach the host', async () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const root = $('#host').attachShadow({ mode: 'open' });
    root.innerHTML = `<input id="i" aria-label="First name">`;
    const seen: boolean[] = [];
    $('#host').addEventListener('input', (e) => seen.push(e.composed));
    const r = await runApplication(document, req());
    expect((root.getElementById('i') as HTMLInputElement).value).toBe('Jordan');
    expect(seen).toContain(true);
    expect(r.filled.map((f) => f.key)).toEqual(['firstName']);
  });

  it('writes saved answers into rich-text editors', async () => {
    document.body.innerHTML = `<div contenteditable="true" aria-label="Why do you want to work here?" id="ed"></div>`;
    const r = await runApplication(document, req({ answers: { ...NO_ANSWERS, saved: [{ question: 'Why do you want to work here?', answer: 'I build accessible tools.' }] } }));
    expect($('#ed').textContent).toBe('I build accessible tools.');
    expect(r.filled).toMatchObject([{ key: 'saved' }]);
  });
});

/** jsdom has no DataTransfer and only takes real FileLists, so the browser's part is stood in for here. */
function fakeFiles(input: HTMLInputElement, keep = true) {
  let files: File[] = [];
  Object.defineProperty(input, 'files', {
    configurable: true,
    get: () => files as unknown as FileList,
    set: (v: FileList) => {
      if (keep) files = Array.from(v as unknown as File[]);
    },
  });
  return { set: (f: File[]) => (files = f) };
}
class FakeDataTransfer {
  private list: File[] = [];
  items = { add: (f: File) => this.list.push(f) };
  get files() {
    return this.list as unknown as FileList;
  }
}
const RESUME = { name: 'jordan-avery.pdf', type: 'application/pdf', base64: btoa('%PDF-1.4 test') };

describe('résumé attachment', () => {
  const setup = (html: string) => {
    document.body.innerHTML = html;
    vi.stubGlobal('DataTransfer', FakeDataTransfer);
    (document.defaultView as unknown as { DataTransfer: unknown }).DataTransfer = FakeDataTransfer;
  };

  it('reports attached only when the input holds the file', async () => {
    setup(`<label for="r">Resume/CV</label><input id="r" type="file" accept=".pdf,.docx"><label for="t">Transcript</label><input id="t" type="file">`);
    fakeFiles($('#r'));
    const t = fakeFiles($('#t'));
    void t;
    const r = await runApplication(document, req({ resume: RESUME }));
    expect(r.resume).toEqual({ status: 'attached', file: 'jordan-avery.pdf', label: 'Resume/CV' });
    expect($('#t').files).toHaveLength(0);
    expect(r.filled.map((f) => f.label)).toEqual(['Résumé (jordan-avery.pdf)']);
  });

  it('reports rejected when the page drops the file or shows an error', async () => {
    setup(`<label for="r">Resume</label><input id="r" type="file">`);
    fakeFiles($('#r'), false);
    let r = await runApplication(document, req({ resume: RESUME }));
    expect(r.resume).toMatchObject({ status: 'rejected', reason: 'The page didn’t keep the file.' });
    expect(r.filled).toEqual([]);

    setup(`<div><label for="r2">Resume</label><input id="r2" type="file"><p class="upload-error" role="alert" hidden></p></div>`);
    fakeFiles($('#r2'));
    $('#r2').addEventListener('change', () => {
      const p = document.querySelector('.upload-error') as HTMLElement;
      p.hidden = false;
      p.textContent = 'File type not supported';
    });
    r = await runApplication(document, req({ resume: RESUME }));
    expect(r.resume).toMatchObject({ status: 'rejected', reason: 'File type not supported' });
  });

  it('respects accept=, existing files and the off switch', async () => {
    setup(`<label for="r">Resume</label><input id="r" type="file" accept=".doc">`);
    fakeFiles($('#r'));
    let r = await runApplication(document, req({ resume: RESUME }));
    expect(r.resume).toMatchObject({ status: 'not_accepted' });

    setup(`<label for="r">Resume</label><input id="r" type="file">`);
    fakeFiles($('#r')).set([new File(['x'], 'mine.pdf')]);
    r = await runApplication(document, req({ resume: RESUME }));
    expect(r.resume).toMatchObject({ status: 'already', file: 'mine.pdf' });

    setup(`<label for="r">Resume</label><input id="r" type="file">`);
    r = await runApplication(document, req({ resumeMode: 'off' }));
    expect(r.resume).toEqual({ status: 'off' });
  });
});

describe('work history and education entries', () => {
  const history = {
    experience: [{ title: 'Software Developer', company: 'Northwind Systems', location: '', start: '2022-03', end: 'present', description: '' }],
    education: [{ school: 'Carleton University', degree: 'Bachelor of Science', field: 'Computer Science', start: '', end: '2019' }],
  };

  it('leaves fields outside an education entry to the main pass instead of swallowing them', async () => {
    document.body.innerHTML = `<form>
      <h2>Most recent job</h2><label for="jt">Job title</label><input id="jt"><label for="co">Company</label><input id="co">
      <h2>Education</h2><label for="s">School or university</label><input id="s">
      <label for="d">Highest degree</label><select id="d"><option value="">Select</option><option>Bachelor's Degree</option><option>Master's Degree</option></select>
      <label for="f">Field of study</label><input id="f"></form>`;
    const r = await runApplication(document, req({ history }));
    expect(['#jt', '#co', '#s', '#f'].map((id) => $(id).value)).toEqual(['Software Developer', 'Northwind Systems', 'Carleton University', 'Computer Science']);
    expect($<HTMLSelectElement>('#d').value).toBe("Bachelor's Degree");
    expect(r.filled.map((f) => f.key)).toEqual(['history', 'currentTitle', 'currentCompany']);
  });

  it('reports an entry field whose value the page rejects', async () => {
    document.body.innerHTML = `<form><h2>Education</h2><label for="s">School</label><input id="s">
      <label for="d">Degree</label><select id="d"><option value="">Select</option><option>Diploma</option><option>Certificate</option></select>
      <label for="f">Field of study</label><input id="f"></form>`;
    const r = await runApplication(document, req({ history }));
    expect(r.failed).toMatchObject([{ label: 'Degree', reason: '“Bachelor of Science” wasn’t accepted.' }]);
    expect($('#d').getAttribute('data-job-copilot')).toBe('failed');
  });
});

describe('profile values and reports', () => {
  it('derives province, country and postal code from the location, marked as inferred', () => {
    const p = makeProfile({ basics: { ...makeProfile().basics, name: 'Jordan Avery', location: 'Ottawa, ON K1P 5J2' } });
    const v = profileFillValues(p);
    expect([v.city, v.state, v.postalCode, v.country, v.address]).toEqual(['Ottawa', 'Ontario', 'K1P 5J2', 'Canada', '']);
    expect(inferredKeys(p, AutofillSettings.parse({}))).toEqual(['firstName', 'lastName', 'city', 'state', 'country']);
  });

  it('merges step reports without double counting answered questions', () => {
    const a = { ...emptyReport('https://x.test/1'), unanswered: [{ id: 'text:why#1', label: 'Why?', required: true }] };
    const b = { ...emptyReport('https://x.test/2'), filled: [{ id: 'text:why#1', label: 'Why?', key: 'saved' as const }], stop: 'submit_ready' as const };
    const m = mergeInto(a, b, true);
    expect(m.unanswered).toEqual([]);
    expect(m.stop).toBe('submit_ready');
    expect(m.url).toBe('https://x.test/2');
  });
});
