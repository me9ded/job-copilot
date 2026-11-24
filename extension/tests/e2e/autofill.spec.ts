import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { Page } from '@playwright/test';
import type { Browser } from '@wxt-dev/browser';
import { expect, test } from './fixtures';

// Code inside evaluate() runs in extension contexts, where `chrome` exists.
declare const chrome: typeof Browser;

/**
 * The autofill engine end to end, on pages built like an unfamiliar ATS:
 * résumé upload → review → save → autofill across custom controls, frames,
 * a page reload and a new tab, never submitting.
 */
test.describe.configure({ mode: 'serial' });

/** A fictional applicant. */
const RESUME_LINES = [
  'Jordan Avery',
  'Ottawa, ON | jordan@example.com | +1 613 555 0142',
  'linkedin.com/in/jordan-avery | https://jordan-avery.dev',
  'Summary',
  'Platform engineer building reliable cloud infrastructure with Go and Kubernetes.',
  'Experience',
  'Platform Engineer - Northwind Systems',
  'Mar 2022 - Present',
  '- Built a Kubernetes deployment platform used by 14 teams',
  '- Cut cloud costs by 30% with autoscaling',
  'Software Developer, Contoso Analytics',
  'Jun 2019 - Feb 2022',
  '- Built Go services for event ingestion',
  'Education',
  'Carleton University',
  'Bachelor of Science in Computer Science, 2019',
  'Skills',
  'Go, Kubernetes, Terraform, Python, PostgreSQL, Linux',
];

async function resumePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  RESUME_LINES.forEach((line, i) => page.drawText(line, { x: 50, y: 740 - i * 18, size: 11, font }));
  return Buffer.from(await doc.save());
}

const ext = (id: string, path: string) => `chrome-extension://${id}/${path}`;
const AUTOFILL_BUTTON = { name: /^(Autofill this page|Continue autofill)$/ };

async function openTab(panel: Page, name: 'Home' | 'Autofill' | 'Profile'): Promise<void> {
  await panel.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name, exact: true }).click();
}

type PageState = { seen: Record<string, string>; model: { email: string }; submitted: unknown; step1: { email: string; why: string } | null };
const pageState = (p: Page) => p.evaluate(() => {
  const w = window as unknown as PageState;
  return { seen: w.seen, model: w.model, submitted: w.submitted, step1: w.step1 };
});

// Other spec files may share this browser profile: start clean and leave it as found.
let before: Record<string, unknown> = {};
test.beforeAll(async ({ sw }) => {
  before = await sw.evaluate(() => chrome.storage.local.get(null));
  await sw.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
  });
});
test.afterAll(async ({ sw }) => {
  await sw.evaluate(async (s) => {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    await chrome.storage.local.set(s);
  }, before);
});

test('upload → review → save, then autofill an unfamiliar multi-step application without submitting', async ({ ctx, extensionId, sw, baseUrl }) => {
  const panel = await ctx.newPage();
  const errors: string[] = [];
  panel.on('pageerror', (e) => errors.push(e.message));
  await panel.goto(ext(extensionId, 'sidepanel.html'));

  // 1. The résumé is read on this device, reviewed, and saved only on confirmation.
  await openTab(panel, 'Profile');
  await panel.locator('#resume-file').setInputFiles({ name: 'jordan-avery.pdf', mimeType: 'application/pdf', buffer: await resumePdf() });
  const profile = panel.locator('#pane-profile');
  await expect(profile.getByRole('heading', { name: 'Check what was found' })).toBeVisible({ timeout: 15_000 });
  await expect(profile.getByLabel('Name')).toHaveValue('Jordan Avery');
  await profile.getByRole('button', { name: 'Save to profile' }).click();
  await expect(profile).toContainText('Northwind Systems', { timeout: 15_000 });

  // Screening answers come only from what the user saved.
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    const s = (settings ?? {}) as { autofill?: Record<string, unknown> };
    await chrome.storage.local.set({
      settings: { ...s, autofill: { ...(s.autofill ?? {}), standardAnswers: { workAuthorized: 'Yes', sponsorship: 'Yes' }, savedAnswers: [{ id: 'visa', question: 'Which visa do you hold?', answer: 'Post-graduation work permit' }] } },
    });
  });

  // 2. Autofill an application the extension has no site rules for.
  const form = await ctx.newPage();
  await form.goto(`${baseUrl}/generic-apply.html`);
  await form.bringToFront(); // the panel follows the active tab
  await openTab(panel, 'Autofill');
  await panel.getByRole('button', AUTOFILL_BUTTON).click();
  const status = panel.getByRole('status');
  await expect(status).toContainText('the questions below need your answer', { timeout: 30_000 });
  await expect(status).toContainText('attached your résumé');

  // Values reached the page and the page's own state.
  await expect(form.locator('#fname')).toHaveValue('Jordan');
  await expect(form.locator('#lname')).toHaveValue('Avery'); // autocomplete="family-name" only
  await expect(form.locator('#email')).toHaveValue('jordan@example.com'); // controlled input kept it
  await expect(form.locator('#phone')).toHaveValue('(613) 555-0142'); // the mask's own format
  await expect(form.locator('#country')).toHaveText('Canada'); // portal dropdown
  await expect(form.locator('#prov')).toHaveValue('Ontario'); // type-ahead kept after blur
  await expect(form.locator('city-field input')).toHaveValue('Ottawa'); // open shadow root
  await expect(form.locator('.yn button[data-v=yes]')).toHaveAttribute('aria-pressed', 'true');
  await expect(form.locator('#spons')).toHaveValue('Yes');
  await expect(form.locator('#visa')).toHaveValue('Post-graduation work permit'); // follow-up revealed by the answer
  await expect(form.locator('#title')).toHaveValue('Platform Engineer'); // section added after the email
  await expect(form.locator('#org')).toHaveValue('Northwind Systems');
  await expect(form.frameLocator('#more').locator('#li')).toHaveValue(/linkedin\.com\/in\/jordan-avery/); // same-origin frame
  await expect(form.locator('#cv-name')).toHaveText('jordan-avery.pdf'); // hidden file input
  const s1 = await pageState(form);
  expect(s1.model.email).toBe('jordan@example.com');
  expect(s1.seen).toMatchObject({ phone: '(613) 555-0142', country: 'Canada', province: 'Ontario', city: 'Ottawa', auth: 'yes', cv: 'jordan-avery.pdf' });

  // Left alone: site search, newsletter, demographics, unanswered questions, consent; the broken field isn't claimed.
  for (const id of ['#q', '#alert', '#why', '#site']) await expect(form.locator(id)).toHaveValue('');
  await expect(form.locator('#gender')).toHaveValue('');
  await expect(form.locator('input[name^=onsite]:checked')).toHaveCount(0);
  await expect(form.locator('#privacy')).not.toBeChecked();
  await expect(form.locator('#site')).toHaveAttribute('data-job-copilot', 'failed');
  expect(form.url()).toBe(`${baseUrl}/generic-apply.html`);

  // The report: what failed, a frame it couldn't reach, and questions grouped and told apart.
  const pane = panel.locator('#pane-autofill');
  await expect(pane.getByRole('region', { name: 'Couldn’t fill' })).toContainText('Portfolio website');
  await expect(pane.getByRole('button', { name: 'Allow access to localhost' })).toBeVisible();
  await expect(pane.getByRole('article', { name: /^Gender/ })).toBeVisible();
  await expect(pane.getByRole('article', { name: /^Why do you want to work at Acme Robotics\?/ })).toBeVisible();
  await expect(pane.getByRole('button', { name: /submit/i })).toHaveCount(0);

  // 3. Two questions with the same wording: answering one leaves the other alone.
  const montreal = pane.getByRole('article', { name: 'Willing to work on-site 3 days a week? (Office: Montréal)' });
  await montreal.getByLabel('Answer: Willing to work on-site 3 days a week?').selectOption('No');
  await montreal.getByRole('button', { name: 'Fill in' }).click();
  await expect(form.locator('input[name=onsite-mtl][value=no]')).toBeChecked();
  await expect(form.locator('input[name=onsite-tor]:checked')).toHaveCount(0);

  // 4. The user answers the required question on the page; Autofill continues through a full page load.
  await form.locator('#why').fill('I want to build the platform your robots ship on.');
  await form.bringToFront();
  await panel.getByRole('button', AUTOFILL_BUTTON).click();
  await expect(status).toContainText(/press “submit application” yourself/i, { timeout: 30_000 });
  expect(form.url()).toBe(`${baseUrl}/generic-apply-2.html`);
  await expect(form.locator('#jt')).toHaveValue('Platform Engineer');
  await expect(form.locator('#co')).toHaveValue('Northwind Systems');
  await expect(form.locator('#school')).toHaveValue('Carleton University');
  await expect(form.locator('#deg')).toHaveValue("Bachelor's Degree");
  await expect(form.locator('#major')).toHaveValue('Computer Science');
  const s2 = await pageState(form);
  expect(s2.step1).toMatchObject({ email: 'jordan@example.com', why: 'I want to build the platform your robots ship on.' });
  // Nothing was submitted: that stays the user's click.
  expect(s2.submitted).toBeNull();
  await expect(pane.getByRole('heading', { name: 'Last step is yours' })).toBeVisible();
  expect(errors).toEqual([]);
  await form.close();
  await panel.close();
});

test('continues when “Apply” opens the application in a new tab', async ({ ctx, extensionId, baseUrl }) => {
  const job = await ctx.newPage();
  await job.goto(`${baseUrl}/careers-newtab.html`);
  const panel = await ctx.newPage();
  await panel.goto(ext(extensionId, 'sidepanel.html'));
  await job.bringToFront();
  await openTab(panel, 'Autofill');
  const opened = ctx.waitForEvent('page', { predicate: (p) => p.url().includes('generic-apply.html') });
  await panel.getByRole('button', AUTOFILL_BUTTON).click();
  const form = await opened;
  await expect(panel.getByRole('status')).toContainText('the questions below need your answer', { timeout: 30_000 });
  await expect(panel.getByRole('status')).toContainText('The application opened in a new tab; Autofill continued there.');
  await expect(form.locator('#fname')).toHaveValue('Jordan');
  await expect(form.locator('#email')).toHaveValue('jordan@example.com');
  // The job page itself was left as it was.
  expect(job.url()).toBe(`${baseUrl}/careers-newtab.html`);
  expect((await pageState(form)).submitted).toBeNull();
  await form.close();
  await job.close();
  await panel.close();
});
