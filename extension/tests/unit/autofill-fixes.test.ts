import { beforeEach, describe, expect, it } from 'vitest';
import { findQuestions, nationalNumber, pickedText, runApplication, type FillData, type FillRequest } from '../../src/lib/autofill/fill';

const DATA: FillData = {
  firstName: 'Sam',
  lastName: 'Rivera',
  fullName: 'Sam Rivera',
  email: 'sam@example.com',
  phone: '+1 (613) 555-0100',
  location: 'Ottawa, ON',
  city: 'Ottawa',
  linkedin: '',
  github: '',
  website: '',
  currentTitle: 'Software Developer',
  currentCompany: 'Initech',
  school: 'Algonquin College',
  degree: 'Advanced Diploma',
  discipline: 'Computer Engineering Technology',
};
const RESUME = { name: 'cv.pdf', type: 'application/pdf', base64: 'JVBERi0=' };
const NO_ANSWERS = { standard: {}, saved: [], tickConsent: false };
const req = (over: Partial<FillRequest> = {}): FillRequest => ({ data: DATA, overwrite: false, answers: NO_ANSWERS, advance: false, ...over });
const $ = <T extends Element = HTMLInputElement>(sel: string) => document.querySelector(sel) as T;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('résumé uploads without a label on the input', () => {
  it('finds a Workday-style drop zone from its section heading', async () => {
    document.body.innerHTML = `
      <div data-automation-id="resumeSection">
        <h3>Resume/CV</h3>
        <div><div data-automation-id="file-upload-drop-zone">
          <p>Drop files here</p>
          <button type="button" data-automation-id="select-files">Select files</button>
          <input type="file" data-automation-id="file-upload-input-ref">
        </div></div>
      </div>
      <div data-automation-id="websiteSection"><h3>Websites</h3><label for="w">URL</label><input id="w"></div>`;
    const r = await runApplication(document, req({ resume: RESUME }));
    expect(r.resumeInputFound).toBe(true);
  });

  it('treats the only upload as the résumé when the page asks for one', async () => {
    document.body.innerHTML = `<p>Please upload your résumé.</p><div><div><input type="file" id="f"></div></div>`;
    expect((await runApplication(document, req({ resume: RESUME }))).resumeInputFound).toBe(true);
  });

  it('does not attach the résumé to a transcript or cover-letter upload', async () => {
    document.body.innerHTML = `
      <p>Resume is optional for this role.</p>
      <section><h3>Transcript</h3><div><input type="file" id="t"></div></section>`;
    expect((await runApplication(document, req({ resume: RESUME }))).resumeInputFound).toBe(false);
    document.body.innerHTML = `
      <section><h3>Resume</h3><div><input type="file" id="r"></div></section>
      <section><h3>Cover letter</h3><div><input type="file" id="c"></div></section>`;
    const [r, c] = findQuestions(document).filter((q) => q.kind === 'file');
    expect(r!.ds.some((d) => /resume/.test(d))).toBe(true);
    expect(c!.ds.some((d) => /resume/.test(d))).toBe(false);
  });
});

/** react-select markup as Greenhouse renders it: the input is emptied after a choice, which is shown beside it. */
function reactSelect(id: string, label: string, chosen = '') {
  return `
    <div class="field"><label for="${id}">${label}</label>
      <div class="select__control"><div class="select__value-container">
        ${chosen ? `<div class="select__single-value">${chosen}</div>` : '<div class="select__placeholder">Select...</div>'}
        <div class="select__input-container"><input id="${id}" class="select__input" role="combobox" aria-autocomplete="list" value=""></div>
      </div></div>
    </div>`;
}

describe('search-style pickers', () => {
  it('sees a choice the user already made in a react-select and keeps it', async () => {
    document.body.innerHTML = reactSelect('loc', 'Location (City)', 'Kanata, Ontario');
    expect(pickedText($('#loc'))).toBe('kanata ontario');
    let typed = false;
    $('#loc').addEventListener('input', () => (typed = true));
    const r = await runApplication(document, req());
    expect(typed).toBe(false);
    expect(r.kept).toContain('Location (City)');
  });

  it('presses Enter when a search prompt shows nothing until you search', async () => {
    document.body.innerHTML = `
      <label for="s">School or University</label><input id="s" role="combobox" data-automation-id="searchBox">
      <div id="pop"></div>`;
    const input = $('#s');
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter') return;
      $('#pop').innerHTML = ['Algonquin College', 'Carleton University'].map((s) => `<div data-automation-id="promptOption">${s}</div>`).join('');
      for (const o of Array.from(document.querySelectorAll('[data-automation-id=promptOption]'))) o.addEventListener('click', () => (input.dataset.chosen = o.textContent!));
    });
    await runApplication(document, req());
    expect(input.dataset.chosen).toBe('Algonquin College');
  }, 15_000);

  it('never presses Enter while a list is open, so a highlighted wrong option is not picked', async () => {
    document.body.innerHTML = `
      <label for="s">School</label><input id="s" role="combobox" aria-controls="list">
      <ul id="list" role="listbox"><li role="option">University of Ottawa</li></ul>`;
    let enter = false;
    $('#s').addEventListener('keydown', (e) => (enter ||= (e as KeyboardEvent).key === 'Enter'));
    await runApplication(document, req());
    expect(enter).toBe(false);
  }, 15_000);
});

describe('phone numbers', () => {
  it('leaves Workday’s Country Phone Code picker alone and types the national number in the phone box', async () => {
    document.body.innerHTML = `
      <label for="cc">Country Phone Code*</label><input id="cc" data-automation-id="countryPhoneCode">
      <label for="ph">Phone Number*</label><input id="ph" data-automation-id="phone-number">`;
    await runApplication(document, req());
    expect($('#cc').value).toBe('');
    expect($('#ph').value).toBe('(613) 555-0100');
  });

  it('keeps the full number when there is no separate country code', async () => {
    document.body.innerHTML = `<label for="ph">Phone</label><input id="ph">`;
    await runApplication(document, req());
    expect($('#ph').value).toBe('+1 (613) 555-0100');
  });

  it('strips only a country code it can tell apart', () => {
    expect(nationalNumber('+1 (613) 555-0100')).toBe('(613) 555-0100');
    expect(nationalNumber('+1-613-555-0100')).toBe('613-555-0100');
    expect(nationalNumber('+16135550100')).toBe('6135550100');
    expect(nationalNumber('+44 20 7946 0958')).toBe('20 7946 0958');
    expect(nationalNumber('613-555-0100')).toBe('613-555-0100');
    expect(nationalNumber('+442079460958')).toBe('+442079460958');
  });
});

describe('Apply buttons around embedded forms', () => {
  it('does not press the careers page’s Apply button when the form is in a Greenhouse frame', async () => {
    document.body.innerHTML = `
      <h1>Firmware Engineer</h1>
      <button type="button" id="apply">Apply now</button>
      <iframe src="https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1"></iframe>`;
    let pressed = false;
    $('#apply').addEventListener('click', () => (pressed = true));
    const r = await runApplication(document, req({ advance: true }));
    expect(pressed).toBe(false);
    expect(r.stop).toBe('no_form');
  });

  it('still opens a form behind Apply when nothing is embedded', async () => {
    document.body.innerHTML = `<button type="button" id="apply">Apply now</button><div id="form"></div>`;
    $('#apply').addEventListener('click', () => ($('#form').innerHTML = '<label for="fn">First name</label><input id="fn">'));
    await runApplication(document, req({ advance: true }));
    expect($('#fn').value).toBe('Sam');
  });
});
