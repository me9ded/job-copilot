import { act, createElement as h, Fragment, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { runApplication, type FillData, type FillRequest } from '../../src/lib/autofill/fill';

/**
 * Real framework behaviour: React 19 controlled components (which restore
 * their own value when a change isn't accepted), a dropdown rendered in a
 * portal, and vanilla stand-ins for Angular-style commit-on-blur and
 * Vue-style commit-on-change models.
 */

const DATA: FillData = {
  firstName: 'Jordan',
  lastName: 'Avery',
  fullName: 'Jordan Avery',
  email: 'jordan@example.com',
  phone: '+1 613 555 0142',
  location: 'Ottawa, ON',
  address: '',
  city: 'Ottawa',
  state: 'Ontario',
  postalCode: '',
  country: 'Canada',
  linkedin: '',
  github: '',
  website: '',
  currentTitle: 'Software Developer',
  currentCompany: 'Northwind Systems',
  school: '',
  degree: '',
  discipline: '',
};
const req = (over: Partial<FillRequest> = {}): FillRequest => ({ data: DATA, overwrite: false, answers: { standard: {}, saved: [], tickConsent: true }, advance: false, ...over });
const $ = <T extends HTMLElement = HTMLInputElement>(s: string) => document.querySelector(s) as T;

let root: Root | null = null;
async function render(node: ReactNode) {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  // Autofill runs outside act(), the way a page sees it.
  g.IS_REACT_ACT_ENVIRONMENT = false;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('React 19 controlled components', () => {
  function Form() {
    const [first, setFirst] = useState('');
    const [country, setCountry] = useState('');
    const [agree, setAgree] = useState(false);
    return h(
      'form',
      null,
      h('label', { htmlFor: 'fn' }, 'First name'),
      h('input', { id: 'fn', value: first, onChange: (e: { target: HTMLInputElement }) => setFirst(e.target.value) }),
      h('label', { htmlFor: 'co' }, 'Country'),
      h(
        'select',
        { id: 'co', value: country, onChange: (e: { target: HTMLSelectElement }) => setCountry(e.target.value) },
        h('option', { value: '' }, 'Select…'),
        h('option', { value: 'US' }, 'United States'),
        h('option', { value: 'CA' }, 'Canada'),
      ),
      h('label', null, h('input', { type: 'checkbox', id: 'ok', checked: agree, onChange: (e: { target: HTMLInputElement }) => setAgree(e.target.checked) }), 'I agree to the privacy policy'),
      h('output', { id: 'state' }, JSON.stringify({ first, country, agree })),
    );
  }

  it('updates React state, not just the DOM', async () => {
    await render(h(Form));
    const r = await runApplication(document, req());
    expect(JSON.parse($('#state').textContent!)).toEqual({ first: 'Jordan', country: 'CA', agree: true });
    expect(r.filled.map((f) => f.key)).toEqual(['firstName', 'country', 'consent']);
  });

  it('reports a controlled input that rejects the change as failed', async () => {
    function Stuck() {
      const [v] = useState('');
      return h(Fragment, null, h('label', { htmlFor: 'em' }, 'Email'), h('input', { id: 'em', value: v, onChange: () => undefined }));
    }
    await render(h(Stuck));
    const r = await runApplication(document, req());
    expect($('#em').value).toBe('');
    expect(r.filled).toEqual([]);
    expect(r.failed?.map((f) => f.label)).toEqual(['Email']);
  });

  it('chooses from the dropdown it opened (rendered in a portal), not from a list already on the page', async () => {
    // Another list that is already open elsewhere on the page, with the same option text.
    document.body.insertAdjacentHTML('beforeend', `<ul role="listbox" id="decoy"><li role="option" id="decoy-ca">Canada</li></ul>`);
    let decoyClicked = false;
    $('#decoy-ca').addEventListener('click', () => (decoyClicked = true));
    function Dropdown() {
      const [open, setOpen] = useState(false);
      const [value, setValue] = useState('');
      return h(
        Fragment,
        null,
        h('span', { id: 'cl' }, 'Country of residence'),
        h('button', { type: 'button', id: 'pick', 'aria-haspopup': 'listbox', 'aria-labelledby': 'cl', 'aria-expanded': open, onClick: () => setOpen((o) => !o) }, value || 'Select…'),
        open &&
          createPortal(
            h(
              'ul',
              { role: 'listbox' },
              ['United States', 'Canada', 'Mexico'].map((c) => h('li', { key: c, role: 'option', 'aria-selected': c === value, onClick: () => (setValue(c), setOpen(false)) }, c)),
            ),
            document.body,
          ),
        h('output', { id: 'picked' }, value),
      );
    }
    await render(h(Dropdown));
    const r = await runApplication(document, req());
    expect($('#picked').textContent).toBe('Canada');
    expect(decoyClicked).toBe(false);
    expect(r.filled.map((f) => f.key)).toEqual(['country']);
  }, 15_000);

  it('reports a dropdown without a matching option, with the choices it offered', async () => {
    function Dropdown() {
      const [open, setOpen] = useState(false);
      return h(
        Fragment,
        null,
        h('span', { id: 'cl' }, 'Country'),
        h('button', { type: 'button', 'aria-haspopup': 'listbox', 'aria-controls': 'lb', 'aria-labelledby': 'cl', onClick: () => setOpen(true) }, 'Select…'),
        open && h('ul', { role: 'listbox', id: 'lb' }, h('li', { role: 'option' }, 'France'), h('li', { role: 'option' }, 'Germany')),
      );
    }
    await render(h(Dropdown));
    const r = await runApplication(document, req());
    expect(r.filled).toEqual([]);
    expect(r.failed).toMatchObject([{ label: 'Country', options: ['France', 'Germany'] }]);
  }, 15_000);
});

describe('framework-style models', () => {
  it('commits on blur (Angular / Knockout style)', async () => {
    document.body.innerHTML = `<label for="c">Current company</label><input id="c">`;
    const el = $('#c');
    const model = { pending: '', value: '' };
    el.addEventListener('input', () => (model.pending = el.value));
    el.addEventListener('blur', () => (model.value = model.pending));
    const r = await runApplication(document, req());
    expect(model.value).toBe('Northwind Systems');
    expect(r.filled.map((f) => f.key)).toEqual(['currentCompany']);
  });

  it('commits on change (Vue lazy model style) and sees focusin / focusout', async () => {
    document.body.innerHTML = `<label for="t">Current title</label><input id="t">`;
    const el = $('#t');
    const events: string[] = [];
    let model = '';
    for (const type of ['focusin', 'input', 'change', 'focusout']) el.addEventListener(type, () => events.push(type));
    el.addEventListener('change', () => (model = el.value));
    await runApplication(document, req());
    expect(model).toBe('Software Developer');
    expect(events.slice(0, 4)).toEqual(['focusin', 'input', 'change', 'focusout']);
  });
});
