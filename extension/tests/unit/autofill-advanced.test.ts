import { beforeEach, describe, expect, it } from 'vitest';
import { findQuestions, runApplication, answerQuestion, toIsoDate, type FillData, type FillRequest } from '../../src/lib/autofill/fill';
import { fillHistory } from '../../src/lib/autofill/run';
import { makeProfile } from '../helpers';

const DATA = { firstName: 'Sam', lastName: 'Rivera', fullName: 'Sam Rivera', email: 'sam@example.com', phone: '', location: '', city: '', linkedin: '', github: '', website: '', currentTitle: 'Senior Software Engineer', currentCompany: 'Initech', school: '', degree: '', discipline: '' } as FillData;
const NO_ANSWERS = { standard: {}, saved: [], tickConsent: false };
const req = (over: Partial<FillRequest> = {}): FillRequest => ({ data: DATA, overwrite: false, answers: NO_ANSWERS, advance: false, ...over });
const $ = <T extends Element = HTMLInputElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

beforeEach(() => {
  document.body.innerHTML = '';
});

/** A Workday-like "My Experience" step: an Add button appends an entry with title, company, dates and description. */
function workdayExperience() {
  document.body.innerHTML = `
    <div data-automation-id="applyFlowMyExpPage">
      <section data-automation-id="workExperienceSection">
        <h3>Work Experience</h3>
        <div id="entries"></div>
        <button type="button" data-automation-id="Add" aria-label="Add Work Experience">Add</button>
      </section>
      <section data-automation-id="educationSection">
        <h3>Education</h3>
        <div id="edu"></div>
        <button type="button" data-automation-id="Add" aria-label="Add Education">Add</button>
      </section>
      <button type="button" data-automation-id="bottom-navigation-next-button">Save and Continue</button>
    </div>`;
  let n = 0;
  $('[aria-label="Add Work Experience"]').addEventListener('click', () => {
    n++;
    const div = document.createElement('div');
    div.setAttribute('data-automation-id', `workExperience-${n}`);
    div.innerHTML = `
      <h4>Work Experience ${n}</h4>
      <div data-automation-id="formField-jobTitle"><label for="t${n}">Job Title*</label><input id="t${n}" type="text"></div>
      <div data-automation-id="formField-companyName"><label for="c${n}">Company*</label><input id="c${n}" type="text"></div>
      <div data-automation-id="formField-location"><label for="l${n}">Location</label><input id="l${n}" type="text"></div>
      <div data-automation-id="formField-currentlyWorkHere"><input type="checkbox" id="cur${n}"><label for="cur${n}">I currently work here</label></div>
      <div data-automation-id="formField-startDate"><label>From*</label>
        <input data-automation-id="dateSectionMonth-input" aria-label="Month" placeholder="MM" class="sm">
        <input data-automation-id="dateSectionYear-input" aria-label="Year" placeholder="YYYY" class="sy"></div>
      <div data-automation-id="formField-endDate" class="end"><label>To*</label>
        <input data-automation-id="dateSectionMonth-input" aria-label="Month" placeholder="MM" class="em">
        <input data-automation-id="dateSectionYear-input" aria-label="Year" placeholder="YYYY" class="ey"></div>
      <div data-automation-id="formField-roleDescription"><label for="d${n}">Role Description</label><textarea id="d${n}"></textarea></div>`;
    $('#entries').appendChild(div);
    // Like Workday: ticking "I currently work here" removes the end date.
    $<HTMLInputElement>(`#cur${n}`).addEventListener('change', (e) => {
      ($('.end', div) as HTMLElement).hidden = (e.target as HTMLInputElement).checked;
    });
  });
  $('[aria-label="Add Education"]').addEventListener('click', () => {
    const div = document.createElement('div');
    div.innerHTML = `
      <label for="s1">School or University*</label><input id="s1" type="text">
      <label for="dg">Degree*</label><select id="dg"><option value="">Select One</option><option value="b">Bachelor's Degree</option><option value="m">Master's Degree</option></select>
      <label for="f1">Field of Study</label><input id="f1" type="text">
      <div><label>To (Actual or Expected)</label><input data-automation-id="dateSectionYear-input" aria-label="Year" placeholder="YYYY" class="gy"></div>`;
    $('#edu').appendChild(div);
  });
}

describe('work history and education sections', () => {
  it('presses Add for each role on the résumé and fills title, company, dates and description', async () => {
    workdayExperience();
    const profile = makeProfile();
    profile.education[0]!.end = '2018';
    const r = await runApplication(document, req({ history: fillHistory(profile) }));
    const entries = document.querySelectorAll('[data-automation-id^=workExperience-]');
    expect(entries).toHaveLength(2);
    const [globex, initech] = Array.from(entries);
    expect($('input[id^=t]', globex!).value).toBe('Software Engineer');
    expect($('input[id^=c]', globex!).value).toBe('Globex');
    expect([$('.sm', globex!).value, $('.sy', globex!).value, $('.em', globex!).value, $('.ey', globex!).value]).toEqual(['01', '2019', '06', '2021']);
    expect($('textarea', globex!).value).toContain('• Built REST APIs in Python');
    expect($('input[id^=t]', initech!).value).toBe('Senior Software Engineer');
    expect($<HTMLInputElement>('input[type=checkbox]', initech!).checked).toBe(true);
    expect([$('.sm', initech!).value, $('.sy', initech!).value]).toEqual(['07', '2021']);
    expect($('.em', initech!).value).toBe('');
    // Education: school, degree option matched from "Bachelor of Science", field and year.
    expect($('#s1').value).toBe('University of Waterloo');
    expect($<HTMLSelectElement>('#dg').value).toBe('b');
    expect($('#f1').value).toBe('Computer Science');
    expect($('.gy').value).toBe('2018');
    expect(r.filled.filter((f) => f.key === 'history').map((f) => f.label)).toEqual(['Work experience 1: Software Engineer at Globex', 'Work experience 2: Senior Software Engineer at Initech', 'Education 1: University of Waterloo']);

    // Running again doesn't add duplicate entries.
    await runApplication(document, req({ history: fillHistory(profile) }));
    expect(document.querySelectorAll('[data-automation-id^=workExperience-]')).toHaveLength(2);
  });

  it('never puts the current title into every entry (entry fields are left to the history filler)', async () => {
    workdayExperience();
    $<HTMLButtonElement>('[aria-label="Add Work Experience"]').click();
    $<HTMLButtonElement>('[aria-label="Add Work Experience"]').click();
    const r = await runApplication(document, req({ history: { experience: [], education: [] } }));
    // With no history to use, the generic "current title" rule fills the first job title only.
    const titles = Array.from(document.querySelectorAll<HTMLInputElement>('input[id^=t]')).map((i) => i.value);
    expect(titles.filter((t) => t === 'Senior Software Engineer').length).toBeLessThanOrEqual(1);
    expect(r).toBeTruthy();
  });

  it('uses the Workday next button but never treats its "Submit" text as Next', async () => {
    document.body.innerHTML = `<label for="fn">First Name</label><input id="fn"><button type="button" data-automation-id="bottom-navigation-next-button">Submit</button>`;
    history.replaceState(null, '', '/');
    const r = await runApplication(document, req({ advance: true }));
    expect(r.stop).toBe('submit_ready');
    expect(r.steps).toBe(0);
  });
});

describe('harder controls', () => {
  it('fills inputs inside open shadow roots (web-component forms)', async () => {
    document.body.innerHTML = `<spl-input id="host"></spl-input>`;
    const root = $('#host').attachShadow({ mode: 'open' });
    root.innerHTML = `<label for="e">Email</label><input id="e" type="email">`;
    const r = await runApplication(document, req());
    expect((root.getElementById('e') as HTMLInputElement).value).toBe('sam@example.com');
    expect(r.filled.map((f) => f.key)).toContain('email');
  });

  it('answers Yes / No button questions from saved answers and lists their choices otherwise', async () => {
    document.body.innerHTML = `
      <div><label>Are you legally authorized to work in the United States?*</label>
        <div><button type="button" class="yes">Yes</button><button type="button" class="no">No</button></div></div>
      <div><label>Have you worked here before?</label>
        <div><button type="button">Yes</button><button type="button">No</button></div></div>`;
    document.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => b.setAttribute('aria-pressed', 'true')));
    const r = await runApplication(document, req({ answers: { ...NO_ANSWERS, standard: { workAuthorized: 'Yes' } } }));
    expect($('.yes').getAttribute('aria-pressed')).toBe('true');
    expect($('.no').getAttribute('aria-pressed')).toBeNull();
    expect(r.unanswered).toEqual([expect.objectContaining({ label: 'Have you worked here before?', kind: 'buttons', options: ['Yes', 'No'] })]);
    expect(await answerQuestion(document, 'Have you worked here before?', 'No')).toBe(true);
  });

  it('fills follow-up questions revealed by an answer', async () => {
    document.body.innerHTML = `
      <label for="s">Will you now or in the future require sponsorship?</label>
      <select id="s"><option value="">Select</option><option>Yes</option><option>No</option></select>
      <div id="follow" hidden><label for="v">Please describe your visa status</label><input id="v"></div>`;
    $('#s').addEventListener('change', () => {
      ($('#follow') as HTMLElement).hidden = ($('#s') as unknown as HTMLSelectElement).value !== 'Yes';
    });
    const r = await runApplication(document, req({ answers: { ...NO_ANSWERS, standard: { sponsorship: 'Yes' }, saved: [{ question: 'Please describe your visa status', answer: 'Study permit, eligible for PGWP' }] } }));
    expect($('#v').value).toBe('Study permit, eligible for PGWP');
    expect(r.filled.map((f) => f.label)).toContain('Please describe your visa status');
  });

  it('reports options, kind and length limit of unanswered questions for the side panel', async () => {
    document.body.innerHTML = `
      <label for="a">Tell us about your Python experience</label><textarea id="a" maxlength="500"></textarea>
      <label for="b">Preferred office</label><select id="b"><option value="">Choose…</option><option>Toronto</option><option>Ottawa</option></select>`;
    const r = await runApplication(document, req());
    expect(r.unanswered).toMatchObject([
      { label: 'Tell us about your Python experience', required: false, kind: 'textarea', options: undefined, maxLength: 500, id: 'textarea:tell us about your python experience#1', reason: 'no_answer' },
      { label: 'Preferred office', required: false, kind: 'select', options: ['Toronto', 'Ottawa'], maxLength: undefined, category: 'relocation' },
    ]);
  });

  it('treats skill-specific "years of X" as a question, not the total-years answer', async () => {
    document.body.innerHTML = `<label for="y">How many years of Python experience do you have?</label><input id="y">
      <label for="t">Years of professional experience</label><input id="t">`;
    await runApplication(document, req({ answers: { ...NO_ANSWERS, standard: { yearsExperience: '5' } } }));
    expect($('#y').value).toBe('');
    expect($('#t').value).toBe('5');
  });

  it('fills date inputs from saved answers in any common format', async () => {
    document.body.innerHTML = `<label for="d">Earliest start date</label><input id="d" type="date">`;
    await runApplication(document, req({ answers: { ...NO_ANSWERS, standard: { startDate: 'Jan 15, 2027' } } }));
    expect($('#d').value).toBe('2027-01-15');
    expect(toIsoDate('03/2026', 'month')).toBe('2026-03');
    expect(toIsoDate('2 weeks notice', 'date')).toBeNull();
    expect(findQuestions(document)[0]!.kind).toBe('date');
  });

  it('names the field in validation messages', async () => {
    document.body.innerHTML = `<label for="e">Email</label><input id="e" aria-invalid="true" aria-describedby="err" value="x"><p id="err" role="alert">Enter a valid email</p><button type="button">Next</button>`;
    const r = await runApplication(document, req({ advance: true }));
    expect(r.stop).toBe('errors');
    expect(r.errors[0]).toBe('Email: Enter a valid email');
  });
});
