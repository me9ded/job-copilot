import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { emptyReport, type FillData, type FillReport, type FillRequest } from '../../src/lib/autofill/fill';
import { runSteps, type AdvanceOutcome, type StepDriver, type StepFacts } from '../../src/lib/autofill/progress';
import { autofillTab } from '../../src/lib/autofill/run';

/* ----------------------------------------------------------------------------
 * The loop, with a scripted driver
 * ------------------------------------------------------------------------- */

const facts = (f: Partial<StepFacts> = {}): StepFacts => ({ form: true, captcha: false, login: false, missing: 0, invalid: [], ...f });
const step = (label: string, f: Partial<StepFacts>, extra: Partial<FillReport> = {}) => ({
  report: { ...emptyReport(`https://jobs.example/${label}`), filled: [{ label, key: 'saved' as const, id: `text:${label}#1` }], ...extra },
  facts: facts(f),
});

function scripted(steps: Array<ReturnType<typeof step>>, moves: AdvanceOutcome[]) {
  const calls: string[] = [];
  const driver: StepDriver = {
    async fill() {
      const s = steps.shift();
      if (!s) throw new Error('no more steps');
      calls.push(`fill:${s.report.filled[0]?.label}`);
      return s;
    },
    async advance(how) {
      calls.push(`advance:${how}`);
      return moves.shift() ?? { outcome: 'unchanged', errors: [] };
    },
  };
  return { driver, calls };
}

describe('the application loop', () => {
  it('steps through a multi-step form and stops at the final submit', async () => {
    const { driver, calls } = scripted([step('one', { next: 'next' }), step('two', { next: 'continue' }), step('three', { submit: 'submit application' })], [{ outcome: 'moved' }, { outcome: 'navigated' }]);
    const r = await runSteps(driver, { advance: true });
    expect(calls).toEqual(['fill:one', 'advance:next', 'fill:two', 'advance:next', 'fill:three']);
    expect(r.stop).toBe('submit_ready');
    expect(r.steps).toBe(2);
    expect(r.submitLabel).toBe('submit application');
    expect(r.filled.map((f) => f.label)).toEqual(['one', 'two', 'three']);
  });

  it('never calls a step ready while something required is empty or invalid', async () => {
    let r = await runSteps(scripted([step('a', { submit: 'submit', missing: 1 })], []).driver, { advance: true });
    expect(r.stop).toBe('needs_answers');
    r = await runSteps(scripted([step('a', { submit: 'submit', invalid: ['Email: invalid'] })], []).driver, { advance: true });
    expect(r.stop).toBe('errors');
    expect(r.errors).toEqual(['Email: invalid']);
    // Invalid fields stop the run before Next is pressed.
    const s = scripted([step('a', { next: 'next', invalid: ['Phone: too short'] })], []);
    r = await runSteps(s.driver, { advance: true });
    expect(s.calls).toEqual(['fill:a']);
    expect(r.stop).toBe('errors');
  });

  it('reports a step the page refused, with its messages', async () => {
    const r = await runSteps(scripted([step('a', { next: 'next' })], [{ outcome: 'unchanged', errors: ['Phone is required'] }]).driver, { advance: true });
    expect(r.stop).toBe('errors');
    expect(r.errors).toEqual(['Phone is required']);
  });

  it('opens the form behind Apply, then fills it', async () => {
    const { driver, calls } = scripted([step('job page', { form: false, open: 'apply' }), step('form', { submit: 'submit' })], [{ outcome: 'navigated' }]);
    const r = await runSteps(driver, { advance: true });
    expect(calls).toEqual(['fill:job page', 'advance:open', 'fill:form']);
    expect(r.stop).toBe('submit_ready');
  });

  it('continues in a new tab, and stops with what it needs when access is missing', async () => {
    let r = await runSteps(scripted([step('a', { next: 'next' }), step('b', { submit: 'submit' })], [{ outcome: 'new_tab', tabId: 7 }]).driver, { advance: true });
    expect(r.newTab).toEqual({ tabId: 7, accessible: true });
    expect(r.tabId).toBe(7);
    expect(r.stop).toBe('submit_ready');
    r = await runSteps(scripted([step('a', { next: 'next' })], [{ outcome: 'no_access', host: 'acme.icims.com', origin: 'https://acme.icims.com', newTab: 9 }]).driver, { advance: true });
    expect(r.stop).toBe('needs_access');
    expect(r.needsAccess).toMatchObject({ host: 'acme.icims.com' });
    expect(r.newTab).toEqual({ tabId: 9, accessible: false });
  });

  it('stops for CAPTCHAs, log-ins, blocked frames and the step limit', async () => {
    expect((await runSteps(scripted([step('a', { captcha: true, next: 'next' })], []).driver, { advance: true })).stop).toBe('captcha');
    expect((await runSteps(scripted([step('a', { form: false, login: true })], []).driver, { advance: true })).stop).toBe('login');
    const blocked = step('a', { form: false }, { needsAccess: { host: 'boards.greenhouse.io', origin: 'https://boards.greenhouse.io' } });
    expect((await runSteps(scripted([blocked], []).driver, { advance: true })).stop).toBe('needs_access');
    const many = scripted([step('1', { next: 'next' }), step('2', { next: 'next' }), step('3', { next: 'next' })], [{ outcome: 'moved' }, { outcome: 'moved' }]);
    expect((await runSteps(many.driver, { advance: true, maxSteps: 2 })).stop).toBe('max_steps');
  });

  it('leaves Next alone when stepping through is off, and says more steps follow', async () => {
    const s = scripted([step('a', { next: 'next' })], []);
    const r = await runSteps(s.driver, { advance: false });
    expect(s.calls).toEqual(['fill:a']);
    expect(r.moreSteps).toBe(true);
    expect(r.stop).toBe('done');
  });
});

/* ----------------------------------------------------------------------------
 * The tab driver, with the real filler running in this document
 * ------------------------------------------------------------------------- */

const DATA = {
  firstName: 'Jordan',
  lastName: 'Avery',
  fullName: 'Jordan Avery',
  email: 'jordan@example.com',
  phone: '',
  location: '',
  address: '',
  city: '',
  state: '',
  postalCode: '',
  country: '',
  linkedin: '',
  github: '',
  website: '',
  currentTitle: '',
  currentCompany: '',
  school: '',
  degree: '',
  discipline: '',
} satisfies FillData;
const REQ: FillRequest = { data: DATA, overwrite: false, answers: { standard: {}, saved: [], tickConsent: false }, advance: true };

type G = typeof globalThis & { __jobCopilotFiller?: unknown };

/** A fake tab around this jsdom document: navigation swaps its content and document id. */
function fakeTab() {
  const tab = { id: 1, url: 'https://careers.example/apply', status: 'complete', pendingUrl: undefined as string | undefined };
  let docId = 'doc-1';
  let access = true;
  const others: Array<{ id: number; openerTabId?: number; status: string; url?: string }> = [];
  vi.spyOn(fakeBrowser.tabs, 'get').mockImplementation(async (id: number) => {
    if (id === 1) return { ...tab } as never;
    const o = others.find((t) => t.id === id);
    if (!o) throw new Error('No tab with id');
    return { ...o } as never;
  });
  vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => [{ ...tab }, ...others] as never);
  vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (inj: { target: { tabId: number; frameIds?: number[] }; files?: string[]; func?: (...a: unknown[]) => unknown; args?: unknown[]; world?: string }) => {
    if (inj.target.tabId !== 1 || !access) throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
    if (inj.target.frameIds && !inj.target.frameIds.includes(0)) return [];
    if (inj.world === 'MAIN') return [{ frameId: 0, documentId: docId, result: null }];
    if (inj.files) {
      const mod = await import('../../src/entrypoints/form-filler');
      (mod.default as unknown as { main: () => void }).main();
      return [{ frameId: 0, documentId: docId, result: null }];
    }
    const result = await inj.func!(...(inj.args ?? []));
    return [{ frameId: 0, documentId: docId, result }];
  }) as never);
  return {
    tab,
    others,
    /** A full page load: new content, new document id, no filler until injected again. */
    navigate(url: string, html: string) {
      tab.url = url;
      docId = `doc-${Math.random()}`;
      delete (globalThis as G).__jobCopilotFiller;
      document.body.innerHTML = html;
    },
    revoke() {
      access = false;
    },
  };
}

const $ = <T extends HTMLElement = HTMLInputElement>(s: string) => document.querySelector(s) as T;

describe('the tab driver', () => {
  beforeEach(() => {
    delete (globalThis as G).__jobCopilotFiller;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('fills a single-page multi-step form and stops before submit', async () => {
    fakeTab();
    document.body.innerHTML = `<form><label for="fn">First name</label><input id="fn"><button type="button" id="next">Next</button></form>`;
    $('#next').addEventListener('click', () => {
      document.body.innerHTML = `<form><label for="em">Email</label><input id="em" type="email"><button type="submit" id="go">Submit application</button></form>`;
      $('#go').addEventListener('click', () => {
        throw new Error('submitted');
      });
    });
    const r = await autofillTab(1, REQ);
    expect(r.filled.map((f) => f.label)).toEqual(['First name', 'Email']);
    expect($('#em').value).toBe('jordan@example.com');
    expect(r.steps).toBe(1);
    expect(r.stop).toBe('submit_ready');
    expect(r.submitLabel).toBe('submit application');
  }, 20_000);

  it('keeps the report of a step when Next loads a new page, then fills that page', async () => {
    const t = fakeTab();
    document.body.innerHTML = `<form><label for="fn">First name</label><input id="fn"><button type="button" id="next">Continue</button></form>`;
    $('#next').addEventListener('click', () => t.navigate('https://careers.example/apply/2', `<form><label for="ln">Last name</label><input id="ln"><button type="submit">Submit</button></form>`));
    const r = await autofillTab(1, REQ);
    expect(r.filled.map((f) => f.label)).toEqual(['First name', 'Last name']);
    // The first step's report survived the page load (a new document id), and the new page was filled.
    expect(r.steps).toBe(1);
    expect(r.stop).toBe('submit_ready');
  }, 20_000);

  it('stops with a clear "needs access" when the next page can’t be opened', async () => {
    const t = fakeTab();
    document.body.innerHTML = `<form><label for="fn">First name</label><input id="fn"><button type="button" id="next">Next</button></form>`;
    $('#next').addEventListener('click', () => {
      t.navigate('https://acme.icims.com/jobs/1/apply', '<form><input aria-label="Email"></form>');
      t.revoke();
    });
    const r = await autofillTab(1, REQ);
    expect(r.filled.map((f) => f.label)).toEqual(['First name']);
    expect(r.stop).toBe('needs_access');
    expect(r.needsAccess).toMatchObject({ host: 'acme.icims.com', origin: 'https://acme.icims.com' });
  }, 20_000);

  it('reports an embedded application frame it can’t reach instead of “no form”', async () => {
    fakeTab();
    document.body.innerHTML = `<h1>Backend Developer</h1><iframe src="https://boards.greenhouse.io/embed/job_app?token=1"></iframe>`;
    vi.spyOn(HTMLIFrameElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 640, height: 900, top: 0, left: 0, right: 640, bottom: 900, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const r = await autofillTab(1, REQ);
    expect(r.frames?.inaccessible).toEqual([{ host: 'boards.greenhouse.io', url: 'https://boards.greenhouse.io/embed/job_app?token=1' }]);
    expect(r.stop).toBe('needs_access');
    expect(r.needsAccess?.host).toBe('boards.greenhouse.io');
  }, 20_000);
});
