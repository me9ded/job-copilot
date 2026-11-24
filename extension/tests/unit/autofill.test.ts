import { beforeEach, describe, expect, it, vi } from 'vitest';
import { answerQuestion, classify, findQuestions, optionScore, runApplication, submitApplication, type FillData, type FillRequest } from '../../src/lib/autofill/fill';
import { fillValues, profileFillValues, resolveResume, resumeChoices } from '../../src/lib/autofill/run';
import { addOriginalResume, putResumeFile } from '../../src/lib/storage/repo';
import { AutofillSettings, type ResumeVersion } from '../../src/lib/types';
import { makeProfile } from '../helpers';

const DATA: FillData = {
  firstName: 'Sam',
  lastName: 'Rivera',
  fullName: 'Sam Rivera',
  email: 'sam@example.com',
  phone: '+1 416 555 0100',
  location: 'Toronto, ON',
  city: 'Toronto',
  linkedin: 'https://linkedin.com/in/sam-rivera',
  github: 'https://github.com/samr',
  website: '',
  currentTitle: 'Senior Software Engineer',
  currentCompany: 'Initech',
  school: 'University of Waterloo',
  degree: 'Bachelor of Science',
  discipline: 'Computer Science',
  address: '',
  state: '',
  postalCode: '',
  country: '',
};

const NO_ANSWERS = { standard: {}, saved: [], tickConsent: false };
const req = (over: Partial<FillRequest> = {}): FillRequest => ({ data: DATA, overwrite: false, answers: NO_ANSWERS, advance: false, ...over });
const fillDocument = (doc: Document, r: FillRequest) => runApplication(doc, r);
const $ = <T extends Element = HTMLInputElement>(sel: string) => document.querySelector(sel) as T;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('form autofill', () => {
  it('fills a Greenhouse-style form by id, name and label', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="first_name">First Name *</label><input id="first_name" name="job_application[first_name]" type="text">
        <label for="last_name">Last Name *</label><input id="last_name" name="job_application[last_name]" type="text">
        <label for="email">Email *</label><input id="email" name="job_application[email]" type="text">
        <label for="phone">Phone</label><input id="phone" name="job_application[phone]" type="text">
        <label for="q1">LinkedIn Profile</label><input id="q1" name="job_application[answers_attributes][0][text_value]" type="text">
        <label for="q2">Website</label><input id="q2" name="job_application[answers_attributes][1][text_value]" type="text">
        <label for="q3">Are you legally authorized to work in Canada? *</label><input id="q3" name="job_application[answers_attributes][2][text_value]" type="text">
        <label for="q4">What are your salary expectations?</label><input id="q4" type="text">
        <label for="gender">Gender</label><input id="gender" type="text">
        <label for="q5">Why do you want to work here?</label><textarea id="q5"></textarea>
        <button type="submit">Submit application</button>
      </form>`;
    const submit = vi.fn((e: Event) => e.preventDefault());
    const click = vi.fn();
    $('form').addEventListener('submit', submit);
    $('button').addEventListener('click', click);

    const r = await fillDocument(document, req());
    expect($('#first_name').value).toBe('Sam');
    expect($('#last_name').value).toBe('Rivera');
    expect($('#email').value).toBe('sam@example.com');
    expect($('#phone').value).toBe('+1 416 555 0100');
    expect($('#q1').value).toBe('https://linkedin.com/in/sam-rivera');
    // Eligibility, salary, demographics and written answers are left without saved answers.
    for (const id of ['#q3', '#q4', '#gender']) expect($(id).value).toBe('');
    expect($<HTMLTextAreaElement>('#q5').value).toBe('');
    expect(r.unanswered.map((u) => u.label)).toEqual(['Are you legally authorized to work in Canada?', 'What are your salary expectations?', 'Gender', 'Why do you want to work here?']);
    expect(r.unanswered[0]?.required).toBe(true);
    expect(r.stop).toBe('needs_answers');
    expect(r.submitLabel).toBe('submit application');
    expect(r.noValue).toEqual(['Website']);
    expect(r.filled.map((f) => f.key)).toEqual(['firstName', 'lastName', 'email', 'phone', 'linkedin']);
    expect(r.filled[0]?.label).toBe('First Name');
    expect(submit).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect($('#first_name').hasAttribute('data-job-copilot-filled')).toBe(true);
  });

  it('fills Lever-style names (name, org, urls[…]) and Ashby system fields', async () => {
    document.body.innerHTML = `
      <input name="name" type="text"><input name="email" type="email"><input name="phone" type="tel">
      <input name="location" type="text"><input name="org" type="text">
      <input name="urls[LinkedIn]" type="text"><input name="urls[GitHub]" type="text">
      <div><label for="a1">Name</label><input id="a1" name="_systemfield_name"></div>`;
    await fillDocument(document, req());
    expect($('[name=name]').value).toBe('Sam Rivera');
    expect($('[name=email]').value).toBe('sam@example.com');
    expect($('[name=location]').value).toBe('Toronto, ON');
    expect($('[name=org]').value).toBe('Initech');
    expect($('[name="urls[LinkedIn]"]').value).toBe('https://linkedin.com/in/sam-rivera');
    expect($('[name="urls[GitHub]"]').value).toBe('https://github.com/samr');
    expect($('#a1').value).toBe('');
    // A second full-name field is left alone; only email may repeat (confirmation).
  });

  it('uses autocomplete tokens and unlabelled container text', async () => {
    document.body.innerHTML = `
      <input id="x1" autocomplete="given-name"><input id="x2" autocomplete="section-a family-name">
      <div class="field"><span>Current company</span><div><input id="x3"></div></div>`;
    await fillDocument(document, req());
    expect($('#x1').value).toBe('Sam');
    expect($('#x2').value).toBe('Rivera');
    expect($('#x3').value).toBe('Initech');
  });

  it('keeps values already typed unless overwrite is on, and skips hidden or disabled fields', async () => {
    document.body.innerHTML = `
      <label for="e">Email</label><input id="e" value="me@work.example">
      <label for="f">First name</label><input id="f" disabled>
      <div style="display:none"><label for="l">Last name</label><input id="l"></div>
      <label for="p">Phone</label><input id="p" type="hidden">`;
    const r = await fillDocument(document, req());
    expect($('#e').value).toBe('me@work.example');
    expect(r.kept).toEqual(['Email']);
    expect($('#f').value).toBe('');
    expect($('#l').value).toBe('');
    expect(r.filled).toHaveLength(0);
    await fillDocument(document, req({ overwrite: true }));
    expect($('#e').value).toBe('sam@example.com');
  });

  it('sets values through the native setter so controlled (React) inputs see the change', async () => {
    document.body.innerHTML = `<label for="n">Full name</label><input id="n">`;
    const el = $('#n');
    // React replaces `value` on the instance to track it; writing through it would hide the change.
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    let tracked = '';
    Object.defineProperty(el, 'value', {
      configurable: true,
      get() {
        return proto.get!.call(this);
      },
      set(v: string) {
        tracked = v;
        proto.set!.call(this, v);
      },
    });
    const seen: string[] = [];
    el.addEventListener('input', () => seen.push(el.value));
    el.addEventListener('change', () => seen.push(`change:${el.value}`));
    await fillDocument(document, req());
    expect(el.value).toBe('Sam Rivera');
    expect(tracked).toBe('');
    expect(seen).toEqual(['Sam Rivera', 'change:Sam Rivera']);
  });

  it('respects maxlength and leaves pickers without a matching choice', async () => {
    document.body.innerHTML = `
      <label for="c">Current title</label><input id="c" maxlength="10">
      <label for="s">School</label><input id="s" role="combobox">
      <label for="loc">Location (City)</label><input id="loc" role="combobox">`;
    const r = await fillDocument(document, req());
    expect($('#c').value).toBe('Senior Sof');
    // A picker with no matching suggestion is cleared and reported as not filled; free-text location keeps the typed value.
    expect($('#s').value).toBe('');
    expect($('#loc').value).toBe('Toronto, ON');
    expect(r.failed?.map((u) => u.label)).toEqual(['School']);
    expect(r.filled.map((f) => f.label)).not.toContain('School');
  }, 15_000);

  it('recognises résumé file inputs but not cover-letter ones', async () => {
    document.body.innerHTML = `
      <label for="r">Resume/CV</label><input id="r" type="file">
      <label for="cl">Cover letter</label><input id="cl" type="file">`;
    // jsdom has no DataTransfer: the input is found, attaching is reported as not done.
    const r = await fillDocument(document, req({ resume: { name: 'cv.pdf', type: 'application/pdf', base64: 'JVBERi0=' } }));
    expect(r.resumeInputFound).toBe(true);
    expect(r.filled).toHaveLength(0);
  });

  it('classifies common labels', async () => {
    const make = (label: string) => {
      document.body.innerHTML = `<label for="z">${label}</label><input id="z">`;
      return classify($('#z'));
    };
    expect(make('Legal first name')).toBe('firstName');
    expect(make('Surname')).toBe('lastName');
    expect(make('Mobile number')).toBe('phone');
    expect(make('Portfolio URL')).toBe('website');
    expect(make('Company name')).toBe('currentCompany');
    expect(make('Field of study')).toBe('discipline');
    expect(make('Do you require visa sponsorship?')).toBe('sponsorship');
    expect(make('Race / ethnicity')).toBe('race');
    expect(make('How did you hear about us?')).toBe('hearAbout');
    expect(make('Social Security Number')).toBe('never');
    expect(make('Favourite colour')).toBeNull();
  });
});

describe('answering questions and stepping through forms', () => {
  const ANSWERS = {
    standard: { workAuthorized: 'Yes', sponsorship: 'No', gender: 'Decline to self-identify', veteran: 'I am not a protected veteran', salary: '$75,000' },
    saved: [{ question: 'Have you previously worked for Northwind?', answer: 'No' }],
    tickConsent: false,
  };

  it('answers selects, radios and checkboxes only from saved answers', async () => {
    document.body.innerHTML = `
      <label for="auth">Are you legally authorized to work in Canada? *</label>
      <select id="auth" required><option value="">Select...</option><option value="1">Yes</option><option value="0">No</option></select>
      <fieldset><legend>Will you now or in the future require visa sponsorship?</legend>
        <label><input type="radio" name="sp" value="y"> Yes</label><label><input type="radio" name="sp" value="n"> No</label></fieldset>
      <label for="g">Gender</label>
      <select id="g"><option value="">--</option><option>Male</option><option>Female</option><option>Decline To Self Identify</option></select>
      <div role="radiogroup" aria-label="Veteran status">
        <label><input type="radio" name="vet" value="1"> I identify as one or more of the classifications of protected veteran</label>
        <label><input type="radio" name="vet" value="2"> I am not a protected veteran</label></div>
      <p>Have you previously worked for Northwind?</p><label><input type="checkbox" name="prev"> Yes</label>
      <label for="sal">Desired salary</label><input id="sal">
      <label><input type="checkbox" name="privacy"> I agree to the privacy policy *</label>`;
    const r = await runApplication(document, req({ answers: ANSWERS }));
    expect($<HTMLSelectElement>('#auth').value).toBe('1');
    expect($('[name=sp][value=n]').checked).toBe(true);
    expect($<HTMLSelectElement>('#g').selectedOptions[0]?.textContent).toBe('Decline To Self Identify');
    expect($('[name=vet][value="2"]').checked).toBe(true);
    expect($('[name=prev]').checked).toBe(false);
    expect($('#sal').value).toBe('$75,000');
    // Consent is the user's own statement: left unless they opted in.
    expect($('[name=privacy]').checked).toBe(false);
    expect(r.unanswered.map((u) => u.label)).toEqual(['I agree to the privacy policy']);
    expect(r.filled.map((f) => f.key)).toEqual(['workAuthorized', 'sponsorship', 'gender', 'veteran', 'salary']);

    await runApplication(document, req({ answers: { ...ANSWERS, tickConsent: true } }));
    expect($('[name=privacy]').checked).toBe(true);
  });

  it('matches saved answers by wording', async () => {
    document.body.innerHTML = `<label for="x">Have you ever previously worked for Northwind Labs?</label><select id="x"><option value="">Select</option><option>Yes</option><option>No</option></select>`;
    await runApplication(document, req({ answers: ANSWERS }));
    expect($<HTMLSelectElement>('#x').selectedOptions[0]?.textContent).toBe('No');
  });

  it('scores options sensibly', () => {
    expect(optionScore('Yes, I will require sponsorship', 'Yes')).toBeGreaterThan(0.8);
    expect(optionScore('No', 'Yes')).toBe(0);
    expect(optionScore('Not a protected veteran', 'No')).toBe(0);
    expect(optionScore('I don’t wish to answer', 'Decline to self-identify')).toBeGreaterThan(0.9);
  });

  it('types into a picker and chooses the matching suggestion', async () => {
    document.body.innerHTML = `
      <label for="school">School</label><input id="school" role="combobox" aria-controls="list">
      <ul id="list" role="listbox"></ul>`;
    const input = $('#school');
    // A typical async autocomplete: suggestions appear after typing.
    input.addEventListener('input', () => {
      setTimeout(() => {
        $('#list').innerHTML = ['University of Toronto', 'University of Waterloo'].map((s) => `<li role="option">${s}</li>`).join('');
        for (const li of Array.from(document.querySelectorAll('li'))) li.addEventListener('click', () => {
          input.value = li.textContent!;
          input.dataset.chosen = li.textContent!;
        });
      }, 50);
    });
    await runApplication(document, req());
    expect(input.dataset.chosen).toBe('University of Waterloo');
  });

  it('opens a custom listbox button and picks an option', async () => {
    document.body.innerHTML = `
      <label id="lbl">Gender</label><button type="button" aria-haspopup="listbox" aria-labelledby="lbl" id="btn">Select One</button>
      <div id="pop"></div>`;
    $<HTMLButtonElement>('#btn').addEventListener('click', () => {
      $('#pop').innerHTML = '<div role="option">Male</div><div role="option">Female</div><div role="option">I do not wish to answer</div>';
      for (const o of Array.from(document.querySelectorAll('[role=option]'))) o.addEventListener('click', () => ($('#btn').textContent = o.textContent));
    });
    await runApplication(document, req({ answers: ANSWERS }));
    expect($('#btn').textContent).toBe('I do not wish to answer');
  });

  it('presses Next through steps and stops at the final submit button without pressing it', async () => {
    document.body.innerHTML = `
      <form id="f">
        <section id="s1"><label for="fn">First name</label><input id="fn" required><button type="button" id="next">Next</button></section>
        <section id="s2" hidden><label for="em">Email</label><input id="em" required>
          <label for="auth">Are you authorized to work in Canada?</label><select id="auth"><option value="">Select</option><option>Yes</option><option>No</option></select>
          <button type="button" id="next2">Save and continue</button></section>
        <section id="s3" hidden><p>Review your application</p><button type="submit">Submit application</button></section>
      </form>`;
    const submitted = vi.fn((e: Event) => e.preventDefault());
    $('#f').addEventListener('submit', submitted);
    $('#next').addEventListener('click', () => {
      $<HTMLElement>('#s1').hidden = true;
      $<HTMLElement>('#s2').hidden = false;
    });
    $('#next2').addEventListener('click', () => {
      $<HTMLElement>('#s2').hidden = true;
      $<HTMLElement>('#s3').hidden = false;
    });
    const r = await runApplication(document, req({ answers: ANSWERS, advance: true }));
    expect($('#fn').value).toBe('Sam');
    expect($('#em').value).toBe('sam@example.com');
    expect($<HTMLSelectElement>('#auth').value).toBe('Yes');
    expect(r.steps).toBe(2);
    expect(r.stop).toBe('submit_ready');
    expect(r.submitLabel).toBe('submit application');
    expect(submitted).not.toHaveBeenCalled();

    // Only submitApplication presses it (the extension calls it after the user confirms).
    $('#f').addEventListener('submit', () => ($<HTMLElement>('#s3').innerHTML = '<p>Thank you for applying!</p>'));
    const out = await submitApplication(document);
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(out.status).toBe('submitted');
  }, 20_000);

  it('stops on required questions without answers, on validation errors and at CAPTCHAs', async () => {
    document.body.innerHTML = `<label for="q">Why do you want this job? *</label><textarea id="q" required></textarea><button type="button">Next</button>`;
    const pressed = vi.fn();
    $('button').addEventListener('click', pressed);
    expect((await runApplication(document, req({ advance: true }))).stop).toBe('needs_answers');
    expect(pressed).not.toHaveBeenCalled();

    document.body.innerHTML = `<label for="fn">First name</label><input id="fn"><button type="button" id="n">Continue</button><div role="alert" hidden id="err">Phone is required</div>`;
    $('#n').addEventListener('click', () => ($<HTMLElement>('#err').hidden = false));
    const r = await runApplication(document, req({ advance: true }));
    expect(r.stop).toBe('errors');
    expect(r.errors).toEqual(['Phone is required']);

    document.body.innerHTML = `<label for="fn">First name</label><input id="fn"><div class="g-recaptcha" data-sitekey="x"></div><button>Submit</button>`;
    const c = await runApplication(document, req({ advance: true }));
    expect(c.stop).toBe('captcha');
    expect($('#fn').value).toBe('Sam');
    expect((await submitApplication(document)).status).toBe('captcha');
  }, 20_000);

  it('opens the form behind an Apply button and never uses third-party apply buttons', async () => {
    document.body.innerHTML = `<button id="li">Apply with LinkedIn</button><button id="ap">Apply for this job</button><div id="form"></div>`;
    const li = vi.fn();
    $('#li').addEventListener('click', li);
    $('#ap').addEventListener('click', () => ($('#form').innerHTML = '<label for="e">Email</label><input id="e"><button type="submit">Submit application</button>'));
    const r = await runApplication(document, req({ advance: true }));
    expect(li).not.toHaveBeenCalled();
    expect($('#e').value).toBe('sam@example.com');
    expect(r.stop).toBe('submit_ready');
  }, 20_000);

  it('never fills identity numbers or passwords, even with a saved answer', async () => {
    document.body.innerHTML = `<label for="s">Social Security Number</label><input id="s"><label for="p">Password</label><input id="p" type="text">`;
    await runApplication(document, req({ answers: { ...ANSWERS, saved: [{ question: 'Social Security Number', answer: '123' }] } }));
    expect($('#s').value).toBe('');
    expect($('#p').value).toBe('');
  });

  it('answers a single question from the side panel by its label', async () => {
    document.body.innerHTML = `<label for="h">How did you hear about us?</label><select id="h"><option value="">Select</option><option>LinkedIn</option><option>Company website</option></select>`;
    expect(findQuestions(document).map((q) => q.label)).toEqual(['How did you hear about us?']);
    expect(await answerQuestion(document, 'How did you hear about us?', 'company website')).toBe(true);
    expect($<HTMLSelectElement>('#h').value).toBe('Company website');
    expect(await answerQuestion(document, 'How did you hear about us?', 'a podcast')).toBe(false);
  });
});

describe('autofill values', () => {
  it('derives values from the profile and applies overrides', async () => {
    const p = makeProfile({ basics: { name: 'Ana María López', headline: '', email: 'ana@example.com', phone: '555', location: 'Ottawa, ON', links: ['linkedin.com/in/ana', 'github.com/ana', 'ana.dev'], summary: '' } });
    const v = profileFillValues(p);
    expect(v).toMatchObject({ firstName: 'Ana María', lastName: 'López', city: 'Ottawa', linkedin: 'https://linkedin.com/in/ana', github: 'https://github.com/ana', website: 'https://ana.dev' });
    // The current role (end = present) wins over list order.
    expect(v).toMatchObject({ currentTitle: 'Senior Software Engineer', currentCompany: 'Initech', school: 'University of Waterloo' });
    const s = AutofillSettings.parse({ overrides: { firstName: 'Ana', lastName: 'María López', phone: '  ' } });
    expect(fillValues(p, s)).toMatchObject({ firstName: 'Ana', lastName: 'María López', phone: '555' });
  });

  it('attaches the uploaded original file in auto mode, else generates a PDF', async () => {
    const profile = makeProfile();
    const generated = await resolveResume('auto', profile, []);
    expect(generated?.type).toBe('application/pdf');
    expect(atob(generated!.base64).startsWith('%PDF-')).toBe(true);
    expect(generated?.name).toBe('Sam-Rivera-resume.pdf');

    const now = new Date().toISOString();
    const v = await addOriginalResume({ id: 'res_1', name: 'Original — cv.pdf', kind: 'original', content: profile, sourceFileName: 'cv.pdf', createdAt: now, updatedAt: now } as ResumeVersion);
    await putResumeFile(v.id, { name: 'cv.pdf', type: 'application/pdf', size: 5, base64: 'JVBERi0=', savedAt: now });
    expect(await resolveResume('auto', profile, [v])).toEqual({ name: 'cv.pdf', type: 'application/pdf', base64: 'JVBERi0=' });
    expect(await resolveResume('none', profile, [v])).toBeUndefined();
    expect(resumeChoices([v], new Set([v.id])).map((c) => c.value)).toEqual(['auto', 'res_1', 'profile', 'none']);
  }, 20_000);
});
