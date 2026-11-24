import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { Page } from '@playwright/test';
import type { Browser } from '@wxt-dev/browser';
import { expect, test } from './fixtures';

// Code inside evaluate() runs in extension contexts, where `chrome` exists.
declare const chrome: typeof Browser;

test.describe.configure({ mode: 'serial' });

const RESUME_LINES = [
  'Sam Rivera',
  'sam@example.com | +1 416 555 0100',
  'Summary',
  'Frontend engineer building accessible React and TypeScript products.',
  'Experience',
  'Senior Frontend Engineer — Initech',
  'Jul 2021 – Present',
  '• Built a React and TypeScript design system used by 6 product teams',
  '• Led accessibility audit and fixed 120 WCAG issues in CSS and markup',
  'Frontend Developer, Globex',
  'Jan 2018 - Jun 2021',
  '• Shipped Next.js storefront pages',
  'Education',
  'University of Waterloo',
  'Bachelor of Science in Computer Science, 2017',
  'Skills',
  'React, TypeScript, CSS, Accessibility, JavaScript, HTML, Jest',
];

async function resumePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  RESUME_LINES.forEach((line, i) => page.drawText(line.replace('—', '-').replace('–', '-').replace('•', '-'), { x: 50, y: 740 - i * 18, size: 11, font }));
  return Buffer.from(await doc.save());
}

/** Clicks a button inside a closed shadow root (the on-page button) through CDP, which can see into it. */
async function clickInClosedShadow(page: Page, host: string, buttonClass: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  type N = { nodeId: number; nodeName: string; attributes?: string[]; children?: N[]; shadowRoots?: N[] };
  const find = (n: N, inside: boolean): N | undefined => {
    const attrs = n.attributes ?? [];
    const cls = attrs[attrs.indexOf('class') + 1] ?? '';
    if (inside && n.nodeName === 'BUTTON' && attrs.includes('class') && cls.split(' ').includes(buttonClass)) return n;
    const now = inside || n.nodeName === host.toUpperCase();
    for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) {
      const hit = find(c, now);
      if (hit) return hit;
    }
    return undefined;
  };
  let button: N | undefined;
  await expect.poll(async () => (button = find(((await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: N }).root, false)), { timeout: 10_000 }).toBeTruthy();
  const { object } = (await cdp.send('DOM.resolveNode', { nodeId: button!.nodeId })) as { object: { objectId: string } };
  await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { this.click(); }' });
  await cdp.detach();
}

const ext = (id: string, path: string) => `chrome-extension://${id}/${path}`;

/** Switches the side panel to one of its bottom tabs. */
async function openTab(panel: Page, name: 'Home' | 'Job' | 'Autofill' | 'Profile' | 'Tracker'): Promise<void> {
  await panel.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name, exact: true }).click();
}
const AUTOFILL_BUTTON = { name: /^(Autofill this page|Continue autofill)$/ };

/**
 * Opens popup.html in a tab, as if over `tabId`. A real popup sees the page it was opened on as the active tab;
 * a popup opened as a tab would see itself, so only that one lookup is pointed at `tabId`.
 */
async function openPopupFor(ctx: import('@playwright/test').BrowserContext, extensionId: string, tabId: number): Promise<Page> {
  const popup = await ctx.newPage();
  await popup.addInitScript((id) => {
    const tabs = (globalThis as unknown as { chrome: typeof Browser }).chrome.tabs;
    const query = tabs.query.bind(tabs);
    tabs.query = (async (q: Record<string, unknown>) => (q.active && q.currentWindow ? [await tabs.get(id)] : query(q as never))) as typeof tabs.query;
  }, tabId);
  await popup.goto(ext(extensionId, 'popup.html'));
  return popup;
}

async function storage<T>(page: Page, area: 'local' | 'session', key: string | null): Promise<T> {
  return page.evaluate(async ([a, k]) => (await chrome.storage[a as 'local'].get(k))[k ?? ''] ?? (k ? undefined : await chrome.storage[a as 'local'].get(null)), [area, key] as const) as Promise<T>;
}

test('manifest requests only minimal permissions', async ({ sw }) => {
  const m = await sw.evaluate(() => chrome.runtime.getManifest());
  expect(m.permissions).toEqual(['storage', 'unlimitedStorage', 'sidePanel', 'activeTab', 'scripting', 'alarms', 'contextMenus']);
  expect(m.permissions).not.toContain('tabs');
  expect(m.permissions).not.toContain('history');
  // The E2E build pre-grants only the loopback fixture server.
  expect(m.host_permissions).toEqual(['http://127.0.0.1/*']);
  expect(m.content_scripts).toBeUndefined();
  // The toolbar icon opens the popup (which grants activeTab); its buttons open the side panel.
  expect((m.action as { default_popup?: string }).default_popup).toBe('popup.html');
  expect(await sw.evaluate(() => chrome.sidePanel.getPanelBehavior())).toMatchObject({ openPanelOnActionClick: false });
  expect(Object.keys(m.commands ?? {})).toContain('autofill-page');
  expect((m.content_security_policy as { extension_pages?: string } | undefined)?.extension_pages).toContain("script-src 'self'");
});

test('side panel reads an uploaded PDF résumé locally and shows what it found', async ({ ctx, extensionId }) => {
  const panel = await ctx.newPage();
  const errors: string[] = [];
  panel.on('pageerror', (e) => errors.push(e.message));
  await panel.goto(ext(extensionId, 'sidepanel.html'));
  // Home asks for the résumé first and leads to the Profile tab.
  await panel.locator('#pane-home').getByRole('button', { name: 'Upload résumé' }).click();
  await expect(panel.getByRole('heading', { name: 'Career profile' })).toBeVisible();
  await panel.locator('#resume-file').setInputFiles({ name: 'resume.pdf', mimeType: 'application/pdf', buffer: await resumePdf() });
  const card = panel.locator('#pane-profile');
  await expect(card).toContainText('Read from resume.pdf', { timeout: 15_000 });
  await expect(card).toContainText('Sam Rivera');
  await expect(card).toContainText('sam@example.com');
  await expect(card).toContainText('Senior Frontend Engineer');
  await expect(card).toContainText('Initech');
  await expect(card).toContainText('Jul 2021 – Present');
  await expect(card).toContainText('University of Waterloo');
  await expect(card).toContainText('TypeScript');
  // Nothing found for a field is shown, not hidden.
  await expect(card).toContainText('Location');

  const profile = await storage<{ basics: { name: string }; skills: string[]; experience: Array<{ company: string }> }>(panel, 'local', 'profile');
  expect(profile.basics.name).toBe('Sam Rivera');
  expect(profile.skills).toEqual(expect.arrayContaining(['React', 'TypeScript']));
  expect(profile.experience.map((e) => e.company)).toEqual(expect.arrayContaining(['Initech']));
  const resumes = await storage<Array<{ kind: string }>>(panel, 'local', 'resumes');
  expect(resumes.map((r) => r.kind)).toEqual(['original']);

  // Skills are grouped; achievements are told apart from responsibilities.
  await expect(card.getByText('Programming languages')).toBeVisible();
  await expect(card.getByText('Frameworks & libraries')).toBeVisible();

  // Each item is edited in place.
  await card.getByRole('button', { name: 'Edit contact details' }).click();
  await card.getByLabel('Headline').fill('Frontend Engineer');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Edit contact details' })).toBeVisible();
  await expect(card).toContainText('Frontend Engineer');
  expect((await storage<{ basics: { headline: string } }>(panel, 'local', 'profile')).basics.headline).toBe('Frontend Engineer');
  await card.getByRole('button', { name: 'Edit Frontend Developer' }).click();
  await card.getByLabel('Type', { exact: true }).selectOption('full-time');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card).toContainText('Full-time');
  // A skill can be added and removed from the chips.
  const skills = card.getByRole('region', { name: 'Skills' });
  await skills.getByLabel('Add skills').fill('GraphQL');
  await skills.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Remove GraphQL' })).toBeVisible();
  await card.getByRole('button', { name: 'Remove GraphQL' }).click();
  await expect(card.getByRole('button', { name: 'Remove GraphQL' })).toHaveCount(0);
  expect(errors).toEqual([]);
  await panel.close();
});

test('fills an application form (including an iframe) and attaches the uploaded résumé, without submitting', async ({ ctx, extensionId, baseUrl }) => {
  const form = await ctx.newPage();
  await form.goto(`${baseUrl}/apply-form.html`);
  const panel = await ctx.newPage();
  await panel.goto(ext(extensionId, 'sidepanel.html'));
  await form.bringToFront(); // the panel follows the active tab
  await openTab(panel, 'Autofill');
  await panel.getByRole('button', AUTOFILL_BUTTON).click();
  const status = panel.getByRole('status').filter({ hasText: 'Nothing has been submitted yet' });
  await expect(status).toContainText('Filled 5 fields, attached your résumé.', { timeout: 15_000 });
  await expect(status).toContainText('yourself. It’s outlined in blue');
  await expect(status).toContainText('Not in your résumé: LinkedIn Profile');
  // Questions without a saved answer are listed for the user instead of guessed.
  await expect(panel.getByLabel('Answer: Will you now or in the future require sponsorship?')).toBeVisible();
  await expect(panel.getByLabel('Answer: Why do you want to join?')).toBeVisible();

  expect(await form.locator('#first_name').inputValue()).toBe('Sam');
  expect(await form.locator('#last_name').inputValue()).toBe('Rivera');
  expect(await form.locator('#email').inputValue()).toBe('sam@example.com');
  expect(await form.locator('#phone').inputValue()).toBe('+1 416 555 0100');
  expect(await form.locator('#sponsor').inputValue()).toBe('');
  expect(await form.locator('#why').inputValue()).toBe('');
  const seen = await form.evaluate(() => ({ seen: (window as unknown as { seen: Record<string, string> }).seen, submitted: (window as unknown as { submitted: boolean }).submitted, file: (document.getElementById('resume') as HTMLInputElement).files?.[0] }));
  // The page's own listeners saw the values (so framework-controlled inputs update), and nothing was submitted.
  expect(seen.seen).toMatchObject({ first_name: 'Sam', email: 'sam@example.com', resume: 'resume.pdf' });
  expect(seen.submitted).toBe(false);
  const frame = form.frameLocator('#extra');
  await expect(frame.locator('#co')).toHaveValue('Initech');
  // Re-filling never overwrites a correction the user made on the page.
  await form.locator('#first_name').fill('Samantha');
  await panel.getByRole('button', AUTOFILL_BUTTON).click();
  await expect(status).toContainText('Nothing new was filled');
  expect(await form.locator('#first_name').inputValue()).toBe('Samantha');
  expect(await form.evaluate(() => (window as unknown as { submitted: boolean }).submitted)).toBe(false);
  await form.close();
  await panel.close();
});

test('on a page Chrome has not let it into, Autofill explains the toolbar click and the popup offers to continue', async ({ ctx, extensionId, baseUrl }) => {
  // The E2E build is granted 127.0.0.1 only, so the same server under "localhost" is a page without access.
  const url = baseUrl.replace('127.0.0.1', 'localhost') + '/apply-form.html';
  const form = await ctx.newPage();
  await form.goto(url);
  const panel = await ctx.newPage();
  await panel.goto(ext(extensionId, 'sidepanel.html'));
  await form.bringToFront();
  await openTab(panel, 'Autofill');
  await panel.getByRole('button', AUTOFILL_BUTTON).click();
  await expect(panel.getByText('Click the Job Copilot icon in your browser toolbar')).toBeVisible({ timeout: 10_000 });
  const pending = await storage<{ tabId: number }>(panel, 'session', 'request:autofill-access');
  // (The extension can't even look this tab up by URL: it has no access to it.)
  const active = await panel.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
  expect(pending.tabId).toBe(active);
  expect(await form.locator('#email').inputValue()).toBe('');
  // Opening the popup on that tab (what grants access) offers to pick up where it stopped.
  const popup = await openPopupFor(ctx, extensionId, active!);
  await expect(popup.getByRole('button', { name: 'Continue autofill' })).toBeVisible();
  await popup.close();
  await form.close();
  await panel.close();
});

test('popup: Autofill hands the current tab to the side panel, which fills it', async ({ ctx, extensionId, sw, baseUrl }) => {
  const panel = await ctx.newPage();
  await panel.goto(ext(extensionId, 'sidepanel.html'));
  const form = await ctx.newPage();
  await form.goto(`${baseUrl}/apply-form.html`);
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]!.id!, `${baseUrl}/apply-form.html`);
  const popup = await openPopupFor(ctx, extensionId, tabId);
  const errors: string[] = [];
  popup.on('pageerror', (e) => errors.push(e.message));
  await expect(popup.getByRole('button', { name: 'Open side panel' })).toBeVisible();
  await form.bringToFront();
  await popup.getByRole('button', { name: 'Autofill this application' }).click({ noWaitAfter: true });
  // The panel switches to Autofill and fills the tab on its own.
  await expect(panel.getByRole('heading', { name: 'Autofill' })).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByRole('status').filter({ hasText: 'Filled' })).toContainText('Filled', { timeout: 15_000 });
  await expect(form.locator('#email')).toHaveValue('sam@example.com');
  expect(errors).toEqual([]);
  await form.close();
  await panel.close();
});

test('right-click “Autofill with Job Copilot” makes the panel fill that tab on its own', async ({ ctx, extensionId, sw, baseUrl }) => {
  const form = await ctx.newPage();
  await form.goto(`${baseUrl}/apply-form.html`);
  const panel = await ctx.newPage();
  await panel.goto(ext(extensionId, 'sidepanel.html'));
  await form.bringToFront();
  // What the menu click / shortcut handler stores (Playwright can't open a native context menu).
  await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.storage.session.set({ 'request:autofill': { tabId: tab!.id, at: Date.now() } });
  }, `${baseUrl}/apply-form.html`);
  await expect(panel.getByRole('status').filter({ hasText: 'Filled' })).toContainText(/Filled \d+ fields|Nothing new was filled/, { timeout: 15_000 });
  await expect(form.locator('#email')).toHaveValue('sam@example.com');
  // The request is used once.
  expect(await storage(panel, 'session', 'request:autofill')).toBeUndefined();
  await form.close();
  await panel.close();
});

test('goes through a multi-step application from the job page and stops before the final submit', async ({ ctx, extensionId, baseUrl }) => {
  // Screening answers come only from what the user saved.
  const settings = await ctx.newPage();
  await settings.goto(ext(extensionId, 'dashboard.html#settings'));
  await settings.getByRole('tab', { name: 'Applications' }).click();
  for (const [label, value] of [
    ['Are you legally authorized to work? (used for every country)', 'Yes'],
    ['Will you now or in the future require sponsorship?', 'No'],
    ['How did you hear about us?', 'Company website'],
    ['Gender', 'Decline to self-identify'],
  ] as const) {
    await settings.getByLabel(label, { exact: true }).fill(value);
    await settings.getByLabel(label, { exact: true }).press('Enter');
  }
  await expect.poll(async () => (await storage<{ autofill: { standardAnswers: Record<string, string> } }>(settings, 'local', 'settings')).autofill.standardAnswers).toMatchObject({ gender: 'Decline to self-identify', hearAbout: 'Company website' });
  await settings.close();

  const job = await ctx.newPage();
  await job.goto(`${baseUrl}/careers-job.html`);
  const panel = await ctx.newPage();
  await panel.goto(ext(extensionId, 'sidepanel.html'));
  await job.bringToFront();

  // Pressing Apply opens the form on another page; the panel follows it through two steps.
  await openTab(panel, 'Autofill');
  await panel.getByRole('button', AUTOFILL_BUTTON).click();
  await expect(panel.getByLabel('Answer: Have you previously worked for Contoso?')).toBeVisible({ timeout: 20_000 });
  expect(job.url()).toBe(`${baseUrl}/careers-apply.html`);
  await expect(job.locator('#s3')).toBeVisible();
  await expect(panel.getByRole('status')).toContainText('the questions below need your answer');

  // A choice question offers the page's own options.
  await panel.getByLabel('Answer: Have you previously worked for Contoso?').selectOption('No');
  await panel.getByRole('button', { name: 'Fill in' }).click();
  await expect(job.locator('#prev')).toHaveValue('No');
  await panel.getByRole('button', AUTOFILL_BUTTON).click();
  await expect(panel.getByRole('status')).toContainText(/press “submit application” yourself/i, { timeout: 10_000 });
  // Autofill never submits: the user presses the page's own button.
  expect(await job.evaluate(() => (window as unknown as { submitted: unknown }).submitted)).toBeNull();
  await job.getByRole('button', { name: /submit application/i }).click();

  const sent = await job.evaluate(() => (window as unknown as { submitted: Record<string, string> }).submitted);
  expect(sent).toEqual({ fn: 'Sam', auth: 'yes', spons: 'n', gender: "I don't wish to answer", prev: 'No', hear: 'Company website', cv: 'resume.pdf' });
  const all = await storage<Record<string, unknown>>(panel, 'local', null);
  // The answer typed in the panel was remembered for next time.
  expect((all.settings as { autofill: { savedAnswers: Array<{ question: string; answer: string }> } }).autofill.savedAnswers).toEqual([expect.objectContaining({ question: 'Have you previously worked for Contoso?', answer: 'No' })]);
  // Each run is logged locally (counts only, no values) and shown on Home.
  const log = all.autofillLog as Array<Record<string, unknown>>;
  expect(log.length).toBeGreaterThan(0);
  expect(Object.keys(log[0]!).sort()).toEqual(['at', 'company', 'filled', 'host', 'jobTitle', 'stop']);
  await openTab(panel, 'Home');
  await expect(panel.getByRole('region', { name: 'Autofill activity' })).toBeVisible();
  await job.close();
  await panel.close();
});

test('fills repeatable work-experience entries, pressing Add for each role, then stops before Submit', async ({ ctx, extensionId, baseUrl }) => {
  const form = await ctx.newPage();
  await form.goto(`${baseUrl}/workday-apply.html`);
  const panel = await ctx.newPage();
  await panel.goto(ext(extensionId, 'sidepanel.html'));
  await form.bringToFront();
  await openTab(panel, 'Autofill');
  await panel.getByRole('button', AUTOFILL_BUTTON).click();
  await expect(panel.getByRole('status')).toContainText(/press “submit” yourself/i, { timeout: 20_000 });
  await expect(panel.getByRole('status')).toContainText('across 2 steps');
  await expect(form.locator('.entry')).toHaveCount(2);
  // Newest role first, exactly as on the résumé; the current role ticks "I currently work here" instead of an end date.
  expect(await form.locator('#w1-title').inputValue()).toBe('Senior Frontend Engineer');
  expect(await form.locator('#w1-company').inputValue()).toBe('Initech');
  expect(await form.locator('#w1-fm').inputValue()).toBe('07');
  expect(await form.locator('#w1-fy').inputValue()).toBe('2021');
  expect(await form.locator('#w1-current').isChecked()).toBe(true);
  expect(await form.locator('#w1-ty').inputValue()).toBe('');
  expect(await form.locator('#w1-desc').inputValue()).toContain('design system used by 6 product teams');
  expect(await form.locator('#w2-title').inputValue()).toBe('Frontend Developer');
  expect(await form.locator('#w2-company').inputValue()).toBe('Globex');
  expect([await form.locator('#w2-fm').inputValue(), await form.locator('#w2-fy').inputValue()]).toEqual(['01', '2018']);
  expect([await form.locator('#w2-tm').inputValue(), await form.locator('#w2-ty').inputValue()]).toEqual(['06', '2021']);
  expect(await form.locator('#w2-current').isChecked()).toBe(false);
  expect(await form.evaluate(() => (window as unknown as { submitted: unknown }).submitted)).toBeNull();
  await form.close();
  await panel.close();
});

test('auto-detects a job on an enabled site, scores it and shows the badge', async ({ ctx, sw, baseUrl }) => {
  // Equivalent to adding the site in Settings (the E2E build already holds the host permission).
  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings as object), customSites: ['http://127.0.0.1/*'] } });
  });
  await expect.poll(() => sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.matches)), { timeout: 10_000 }).toEqual([['http://127.0.0.1/*']]);

  const job = await ctx.newPage();
  await job.goto(`${baseUrl}/lever-jsonld.html`);
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${baseUrl}/lever-jsonld.html`);
  expect(tabId).toBeTruthy();
  await expect
    .poll(async () => sw.evaluate(async (id) => ((await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`] as { outcome?: { status: string } } | undefined)?.outcome?.status, tabId), { timeout: 10_000 })
    .toBe('ok');
  await expect.poll(() => sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId!), { timeout: 10_000 }).toMatch(/^\d+$/);
  // The unobtrusive on-page button is rendered in a closed shadow root.
  await expect(job.locator('job-copilot-root')).toHaveCount(1);
  expect(await job.evaluate(() => document.querySelector('job-copilot-root')!.shadowRoot)).toBeNull();
  // The injected script must not run anything from the job description.
  expect(await job.evaluate(() => document.querySelectorAll('img[src="x"]').length)).toBe(0);
});

test('saves the detected job from the on-page button and tracks it in the dashboard', async ({ ctx, extensionId, baseUrl }) => {
  const job = ctx.pages().find((p) => p.url().startsWith(`${baseUrl}/lever-jsonld.html`))!;
  await clickInClosedShadow(job, 'job-copilot-root', 'save');
  const ui = await ctx.newPage();
  await ui.goto(ext(extensionId, 'dashboard.html#saved'));
  await ui.getByRole('button', { name: /Frontend Engineer/ }).first().click();
  await expect(ui.getByRole('heading', { name: 'Frontend Engineer' })).toBeVisible({ timeout: 10_000 });
  await expect(ui.getByText('Northwind Labs').first()).toBeVisible();
  await expect(ui.getByText(/not a prediction|not a hiring|isn't a prediction/i).first()).toBeVisible();
  // The description's <script> and onerror image were sanitized away.
  expect(await ui.evaluate(() => document.querySelectorAll('img[src="x"], .prose-job script').length)).toBe(0);

  await ui.goto(ext(extensionId, 'dashboard.html#applications'));
  await ui.getByRole('tab', { name: 'Table' }).click();
  const status = ui.getByRole('combobox', { name: 'Status', exact: true }).first();
  await expect(status).toHaveValue('saved');
  await status.selectOption('applied');
  const confirm = ui.getByRole('dialog');
  await expect(confirm).toContainText('never submits applications');
  // Cancelling leaves the status untouched.
  await confirm.getByRole('button', { name: 'Not yet' }).click();
  await expect(status).toHaveValue('saved');
  await status.selectOption('applied');
  await ui.getByRole('button', { name: 'Yes, I submitted it' }).click();
  await expect(status).toHaveValue('applied');
  const all = await storage<Record<string, unknown>>(ui, 'local', null);
  const lever = Object.entries(all).filter(([k]) => k.startsWith('job:')).map(([, v]) => v as { id: string; title: string }).find((j) => j.title === 'Frontend Engineer')!;
  const apps = Object.entries(all).filter(([k]) => k.startsWith('app:')).map(([, v]) => v as { jobId: string; status: string; submissionConfirmed: boolean });
  expect(apps.filter((a) => a.jobId === lever.id)).toEqual([expect.objectContaining({ status: 'applied', submissionConfirmed: true })]);
  await ui.close();
});

test('Job tab explains the match: reasons to apply and potential gaps', async ({ ctx, extensionId, baseUrl }) => {
  const job = ctx.pages().find((p) => p.url().startsWith(`${baseUrl}/lever-jsonld.html`))!;
  const panel = await ctx.newPage();
  await panel.goto(ext(extensionId, 'sidepanel.html'));
  await job.bringToFront();
  await openTab(panel, 'Job');
  const pane = panel.locator('#pane-job');
  await expect(pane.getByRole('heading', { name: 'Frontend Engineer' })).toBeVisible({ timeout: 10_000 });
  await expect(pane.getByText('Reasons to apply')).toBeVisible();
  await expect(pane).toContainText(/required skills/);
  await expect(pane.getByText('Potential gaps')).toBeVisible();
  await expect(pane).toContainText('Playwright');
  await expect(pane.getByText(/not a prediction|not a hiring|isn't a prediction/i).first()).toBeVisible();
  await panel.close();
});

test('drafts written answers from the résumé, tailored to the job; nothing is filled until the user presses Use', async ({ ctx, extensionId, baseUrl }) => {
  // Same tab as the analyzed job posting: Apply → form keeps the job as context.
  const tab = ctx.pages().find((p) => p.url().startsWith(`${baseUrl}/lever-jsonld.html`))!;
  await tab.goto(`${baseUrl}/apply-questions.html`);
  const panel = await ctx.newPage();
  await panel.goto(ext(extensionId, 'sidepanel.html'));
  await tab.bringToFront();
  await openTab(panel, 'Autofill');
  const pane = panel.locator('#pane-autofill');
  await expect(pane).toContainText('answers are tailored to this job');
  await pane.getByRole('button', AUTOFILL_BUTTON).click();
  await expect(pane.getByText(/Suggested answers \(3\)/)).toBeVisible({ timeout: 15_000 });
  // Nothing written has been put into the page yet.
  expect(await tab.locator('#ts').inputValue()).toBe('');
  expect(await tab.locator('#why').inputValue()).toBe('');

  const ts = pane.getByRole('article', { name: /TypeScript experience/ });
  const draft = ts.getByLabel(/^Answer: Tell us about your TypeScript experience/);
  await expect(draft).toHaveValue(/TypeScript/);
  await expect(draft).toHaveValue(/Initech/);
  await expect(ts).toContainText('Based on');
  const text = await draft.inputValue();
  expect(text.length).toBeLessThanOrEqual(600);
  await ts.getByRole('button', { name: 'Use this answer' }).click();
  await expect(tab.locator('#ts')).toHaveValue(text);
  await expect(ts).toHaveCount(0);

  // A motivation question has a part only the user can write; it can't be used until that's replaced.
  const why = pane.getByRole('article', { name: /Why do you want to work here/ });
  await expect(why.getByLabel(/^Answer: Why/)).toHaveValue(/\[add your personal reason/);
  await expect(why.getByRole('button', { name: 'Use this answer' })).toBeDisabled();
  await why.getByLabel(/^Answer: Why/).fill('I want to build accessible products at Northwind Labs.');
  await why.getByRole('button', { name: 'Use this answer' }).click();
  await expect(tab.locator('#why')).toHaveValue('I want to build accessible products at Northwind Labs.');

  // A skill the résumé doesn't mention gets no made-up draft.
  const rust = pane.getByRole('article', { name: /Rust/ });
  await expect(rust).toContainText("doesn't mention Rust");
  await expect(rust.getByLabel(/^Answer:/)).toHaveValue('');
  await rust.getByRole('button', { name: 'I’ll answer on the page' }).click();

  await pane.getByRole('button', AUTOFILL_BUTTON).click();
  await expect(pane.getByRole('status')).toContainText(/press “submit application” yourself/i, { timeout: 10_000 });
  expect(await tab.evaluate(() => (window as unknown as { submitted: boolean }).submitted)).toBe(false);
  // Applied is recorded only when the user says they submitted.
  await pane.getByRole('button', { name: 'I submitted it' }).click();
  await expect(panel.getByRole('dialog')).toContainText('Only confirm once');
  await panel.getByRole('button', { name: 'Not yet' }).click();
  await panel.close();
});

test('Tracker tab: stage chips, links and dates, and moving between stages', async ({ ctx, extensionId }) => {
  const panel = await ctx.newPage();
  await panel.goto(ext(extensionId, 'sidepanel.html'));
  await openTab(panel, 'Tracker');
  const pane = panel.locator('#pane-tracker');
  const row = pane.getByRole('listitem', { name: /Frontend Engineer at Northwind Labs/ });
  await expect(row).toContainText('Applied');
  await expect(row.getByRole('link')).toHaveAttribute('href', /lever-jsonld\.html/);
  await expect(row).toContainText(/Saved .* · Applied /);
  await row.getByLabel('Stage').selectOption('interview');
  await expect(row).toContainText('Interviewing');
  await pane.getByRole('button', { name: /^Interview/ }).click();
  await expect(pane.getByRole('listitem')).toHaveCount(1);
  await pane.getByRole('button', { name: /^Saved/ }).click();
  await expect(pane.getByRole('listitem', { name: /Frontend Engineer/ })).toHaveCount(0);
  await panel.close();
});

test('a non-job page is reported as such when analyzed', async ({ ctx, extensionId, sw, baseUrl }) => {
  const page = await ctx.newPage();
  await page.goto(`${baseUrl}/not-a-job.html`);
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]!.id!, `${baseUrl}/not-a-job.html`);
  const ui = await ctx.newPage();
  await ui.goto(ext(extensionId, 'dashboard.html#saved'));
  const res = await ui.evaluate((id) => chrome.runtime.sendMessage({ type: 'tab/analyze', tabId: id }), tabId);
  expect(res).toMatchObject({ ok: true, data: { outcome: { status: 'not_job' } } });
  // Unknown or malformed messages are rejected.
  expect(await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'nope' }))).toMatchObject({ ok: false });
  await page.close();
  await ui.close();
});

test('tailors a résumé and exports DOCX and PDF', async ({ ctx, extensionId }) => {
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(ext(extensionId, 'dashboard.html#studio'));
  await page.getByRole('tab', { name: 'Tailor' }).click();
  await page.getByLabel('Job', { exact: true }).selectOption({ label: 'Frontend Engineer — Northwind Labs' });
  await page.getByRole('button', { name: /Build draft|Rebuild draft/ }).click();
  await expect(page.getByText('Senior Frontend Engineer — Initech')).toBeVisible();
  await page.getByRole('tab', { name: 'Compare with original' }).click();
  await expect(page.getByText(/line\(s\) added or moved/)).toBeVisible();

  const [docx] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'DOCX' }).click()]);
  const docxBytes = readFileSync((await docx.path())!);
  expect(docxBytes.subarray(0, 2).toString()).toBe('PK');
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PDF' }).click()]);
  expect(readFileSync((await pdf.path())!).subarray(0, 5).toString()).toBe('%PDF-');

  await page.getByRole('button', { name: 'Save version' }).click();
  await expect.poll(async () => (await storage<Array<{ kind: string }>>(page, 'local', 'resumes')).map((r) => r.kind)).toEqual(['original', 'tailored']);
  expect(errors).toEqual([]);
  await page.close();
});

test('AI cover letter uses the local provider, fences job text and flags invented numbers', async ({ ctx, extensionId, baseUrl, aiLog }) => {
  const page = await ctx.newPage();
  await page.goto(ext(extensionId, 'dashboard.html#settings'));
  await page.getByRole('tab', { name: 'AI' }).click();
  await page.getByLabel('Cover letter drafts').selectOption('openai_compatible');
  const url = page.getByLabel('Server URL');
  await url.fill(baseUrl);
  await url.press('Enter');
  await expect(page.getByText(/Access to http:\/\/127\.0\.0\.1 granted/)).toBeVisible();

  await page.goto(ext(extensionId, 'dashboard.html#studio'));
  await page.getByRole('tab', { name: 'Cover letter' }).click();
  await page.getByLabel('Job', { exact: true }).selectOption({ label: 'Frontend Engineer — Northwind Labs' });
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByLabel('Cover letter')).toHaveValue(/Dear Northwind Labs team/);
  await expect(page.getByText('Not found in your profile')).toBeVisible();
  await expect(page.getByText(/Numbers: 45%/)).toBeVisible();

  expect(aiLog.bodies).toHaveLength(1);
  const [system, user] = aiLog.bodies[0]!.messages;
  expect(system!.content).toMatch(/untrusted DATA/);
  expect(user!.content).toMatch(/<job_posting>[\s\S]*Frontend Engineer[\s\S]*<\/job_posting>/);

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => Object.keys((await storage<Record<string, unknown>>(page, 'local', 'coverLetters')) ?? {}).length).toBe(1);

  const usage = await storage<{ dayRequests: number; monthTokens: number }>(page, 'local', 'aiUsage');
  expect(usage).toMatchObject({ dayRequests: 1, monthTokens: 360 });
  await page.close();
});

test('works with the self-hosted backend: AI drafts and backup sync', async ({ ctx, extensionId, backend }) => {
  test.skip(!backend, 'backend virtualenv not installed');
  const page = await ctx.newPage();
  await page.goto(ext(extensionId, 'dashboard.html#settings'));
  await page.getByRole('tab', { name: 'AI' }).click();
  await page.getByLabel('Cover letter drafts').selectOption('backend');
  await page.getByLabel('Backend URL').fill(backend!.url);
  await page.getByLabel('Backend URL').press('Enter');
  await page.getByLabel('Access token').fill(backend!.token);
  await page.getByLabel('Access token').press('Enter');
  // Without consent nothing is sent.
  await expect(page.getByRole('button', { name: 'Upload backup' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /I understand/ }).check();

  await page.getByRole('button', { name: 'Upload backup' }).click();
  await expect(page.getByText(/Backup uploaded/)).toBeVisible();
  const stored = await (await fetch(`${backend!.url}/v1/sync`, { headers: { Authorization: `Bearer ${backend!.token}` } })).json();
  expect(stored.format).toBe('job-copilot-backup');
  expect(JSON.stringify(stored)).not.toContain(backend!.token);

  await page.goto(ext(extensionId, 'dashboard.html#studio'));
  await page.getByRole('tab', { name: 'Cover letter' }).click();
  await page.getByLabel('Job', { exact: true }).selectOption({ label: 'Frontend Engineer — Northwind Labs' });
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByLabel('Cover letter')).toHaveValue(/Mock cover letter/);
  const usage = await (await fetch(`${backend!.url}/v1/usage`, { headers: { Authorization: `Bearer ${backend!.token}` } })).json();
  expect(usage.today.requests).toBe(1);

  // A wrong token is reported clearly.
  await page.evaluate(async () => {
    const { settings } = (await chrome.storage.local.get('settings')) as { settings: { ai: { backend: { token: string } } } };
    settings.ai.backend.token = 'wrong';
    await chrome.storage.local.set({ settings });
    await chrome.storage.local.remove('aiCache'); // otherwise the identical request is served from cache
  });
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByText(/check your backend token/)).toBeVisible();
  await page.close();
});

test('backup export excludes caches and secrets; delete-all needs typed confirmation', async ({ ctx, extensionId }) => {
  const page = await ctx.newPage();
  await page.goto(ext(extensionId, 'dashboard.html#settings'));
  await page.evaluate(async () => {
    const { settings } = (await chrome.storage.local.get('settings')) as { settings: { ai: { backend: { token: string } } } };
    settings.ai.backend.token = 'secret-token';
    await chrome.storage.local.set({ settings });
  });
  await page.getByRole('tab', { name: 'Data' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export backup' }).click()]);
  const backup = JSON.parse(readFileSync((await dl.path())!, 'utf8'));
  expect(backup.format).toBe('job-copilot-backup');
  expect(JSON.stringify(backup)).not.toContain('secret-token');
  expect(Object.keys(backup.data)).not.toContain('matchCache');
  const jobKeys = Object.keys(backup.data).filter((k) => k.startsWith('job:'));
  expect(jobKeys.length).toBeGreaterThan(0);
  // The uploaded résumé file (used by autofill) is part of the backup.
  expect(Object.keys(backup.data).some((k) => k.startsWith('file:'))).toBe(true);

  await page.getByRole('button', { name: 'Delete all data' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete everything?' });
  const confirm = dialog.getByRole('button', { name: 'Delete all data' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Type DELETE to confirm').fill('DELETE');
  await confirm.click();
  await expect.poll(async () => Object.keys(await storage<Record<string, unknown>>(page, 'local', null)).filter((k) => k !== 'meta' && k !== 'aiUsage' && k !== 'settings')).toEqual([]);

  // Restoring the backup brings the jobs back (the token is kept out of it).
  await page.reload();
  await page.getByRole('tab', { name: 'Data' }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: readFileSync((await dl.path())!) });
  await expect.poll(async () => Object.keys(await storage<Record<string, unknown>>(page, 'local', null)).filter((k) => k.startsWith('job:')).length).toBe(jobKeys.length);
  expect(Object.keys(await storage<Record<string, unknown>>(page, 'local', null)).some((k) => k.startsWith('file:'))).toBe(true);
  await page.close();
});

test('recovers after the service worker is stopped', async ({ ctx, extensionId, baseUrl }) => {
  const page = await ctx.newPage();
  await page.goto(ext(extensionId, 'dashboard.html#saved'));
  const cdp = await ctx.newCDPSession(page);
  const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: Array<{ targetId: string; type: string; url: string }> };
  const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extensionId));
  expect(worker).toBeTruthy();
  await cdp.send('Target.closeTarget', { targetId: worker!.targetId });

  // A new page load wakes the worker through the registered content script.
  const job = await ctx.newPage();
  await job.goto(`${baseUrl}/career-graph.html`);
  await expect
    .poll(
      () =>
        page.evaluate(async (url) => {
          const [tab] = await chrome.tabs.query({ url });
          const key = `tab:${tab?.id}`;
          return ((await chrome.storage.session.get(key))[key] as { outcome?: { status: string } } | undefined)?.outcome?.status;
        }, `${baseUrl}/career-graph.html`),
      { timeout: 15_000 },
    )
    .toBe('ok');
  await job.close();
  await page.close();
});

// Visual check, not an assertion: SCREENSHOTS=/some/dir npx playwright test
test('screenshots', async ({ ctx, extensionId, baseUrl }) => {
  test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=<dir> to capture');
  const dir = process.env.SCREENSHOTS!;
  const job = await ctx.newPage();
  await job.goto(`${baseUrl}/lever-jsonld.html`);
  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(ext(extensionId, 'sidepanel.html'));
  await job.bringToFront();
  for (const t of ['Home', 'Job', 'Profile', 'Tracker'] as const) {
    await openTab(panel, t);
    await panel.waitForTimeout(600);
    await panel.screenshot({ path: `${dir}/panel-${t.toLowerCase()}.png`, fullPage: true });
  }
  await job.goto(`${baseUrl}/apply-questions.html`);
  await job.bringToFront();
  await openTab(panel, 'Autofill');
  await panel.getByRole('button', AUTOFILL_BUTTON).click();
  await panel.waitForTimeout(2500);
  await panel.screenshot({ path: `${dir}/panel-autofill.png`, fullPage: true });
  const tabId = await panel.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]!.id!);
  const popup = await openPopupFor(ctx, extensionId, tabId);
  await popup.setViewportSize({ width: 360, height: 560 });
  await popup.waitForTimeout(600);
  await popup.screenshot({ path: `${dir}/popup.png`, fullPage: true });
  await job.screenshot({ path: `${dir}/page-filled.png` });
  const dash = await ctx.newPage();
  await dash.setViewportSize({ width: 1280, height: 900 });
  for (const view of ['saved', 'applications', 'studio', 'settings']) {
    await dash.goto(ext(extensionId, `dashboard.html#${view}`));
    await dash.waitForTimeout(400);
    await dash.screenshot({ path: `${dir}/dash-${view}.png`, fullPage: true });
  }
});
