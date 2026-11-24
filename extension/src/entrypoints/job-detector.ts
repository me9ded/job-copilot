import { browser } from 'wxt/browser';
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { extractJobFromDocument, type ExtractionOutcome } from '../lib/extraction/extract';
import type { DetectorSummary } from '../lib/messages';

/**
 * Job detector. Runs only on sites the user enabled (dynamic registration) or
 * on a tab where the user invoked the extension (activeTab). It reads the
 * page, never modifies it apart from one optional button in a closed shadow
 * root, and sends the extraction to the service worker.
 */

type G = typeof globalThis & {
  __jobCopilot?: { run(): { url: string; outcome: ExtractionOutcome } };
  __jobCopilotManual?: boolean;
};

export default defineUnlistedScript(() => {
  const g = globalThis as G;
  const run = () => ({ url: location.href, outcome: extractJobFromDocument(document, location.href) });
  if (g.__jobCopilot) return; // already initialised in this isolated world
  g.__jobCopilot = { run };
  const manual = g.__jobCopilotManual === true;

  let lastUrl = location.href;
  let host: HTMLElement | null = null;

  const report = async (): Promise<ExtractionOutcome> => {
    const { url, outcome } = run();
    try {
      await browser.runtime.sendMessage({ type: 'detector/result', url, outcome });
    } catch {
      /* extension reloaded or service worker unavailable; nothing to do */
    }
    return outcome;
  };

  const detect = async (attempt = 0) => {
    const outcome = await report();
    if (outcome.status === 'not_job' && attempt < 2) {
      // Some boards render the description after load; retry briefly.
      setTimeout(() => void detect(attempt + 1), attempt === 0 ? 1500 : 4000);
      return;
    }
    removeButton();
    if (outcome.status === 'ok' && !manual) await showButton();
  };

  void detect();

  // Single-page boards change the URL without reloading.
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    removeButton();
    setTimeout(() => void detect(), 1200);
  }, 1500);

  function removeButton() {
    host?.remove();
    host = null;
  }

  async function ask<T>(type: string): Promise<T> {
    const res = (await browser.runtime.sendMessage({ type })) as { ok: boolean; data?: T; error?: string } | undefined;
    if (!res?.ok) throw new Error(res?.error ?? 'No response');
    return res.data as T;
  }

  async function showButton() {
    let summary: (DetectorSummary & { showButton: boolean }) | null = null;
    try {
      summary = await ask('detector/summary');
    } catch {
      return;
    }
    if (!summary?.showButton) return;

    host = document.createElement('job-copilot-root');
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483646; right: 16px; bottom: 16px;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .pill { font: 500 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; display: flex; align-items: center; gap: 8px;
          background: #fcfbf8; color: #33383d; border: 1px solid #d2cdc1; border-radius: 999px; padding: 6px 6px 6px 10px;
          box-shadow: 0 4px 16px rgba(51, 56, 61, .10); }
        .logo { width: 18px; height: 18px; border-radius: 5px; background: #3b7282; display: grid; place-items: center; flex: none; }
        .score { font-weight: 700; font-variant-numeric: tabular-nums; }
        .muted { color: #666c72; font-weight: 400; }
        button { font: inherit; cursor: pointer; border-radius: 999px; border: 1px solid transparent; padding: 4px 10px; }
        button:focus-visible { outline: 2px solid #3b7282; outline-offset: 2px; }
        .primary { background: #3b7282; color: #fff; }
        .primary:hover { background: #30606e; }
        .primary[disabled] { background: #3b7553; cursor: default; }
        .ghost { background: transparent; color: #33383d; border-color: #d2cdc1; }
        .ghost:hover { background: #efede6; }
        .close { background: transparent; color: #666c72; padding: 4px 7px; }
        .hint { font: 400 12px/1.4 system-ui, sans-serif; margin: 0 0 6px; background: #33383d; color: #fcfbf8; padding: 6px 10px; border-radius: 8px; max-width: 280px; }
      </style>
      <div class="hint" hidden role="status"></div>
      <div class="pill" role="region" aria-label="Job Copilot">
        <span class="logo" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span>
        <span class="label"></span>
        <button class="primary save" type="button"></button>
        <button class="ghost details" type="button">Autofill</button>
        <button class="close" type="button" aria-label="Hide Job Copilot on this page">✕</button>
      </div>`;

    const label = root.querySelector('.label') as HTMLElement;
    const save = root.querySelector('.save') as HTMLButtonElement;
    const hint = root.querySelector('.hint') as HTMLElement;

    if (summary.score !== null) {
      const top = summary.matched.slice(0, 2).join(', ');
      label.innerHTML = '';
      const score = document.createElement('span');
      score.className = 'score';
      score.textContent = `${summary.score}`;
      const rest = document.createElement('span');
      rest.className = 'muted';
      rest.textContent = top ? ` match · ${top}` : ' match';
      label.append(score, rest);
      label.title = `Match score ${summary.score}/100 (skill overlap, not a hiring prediction)`;
    } else {
      label.textContent = summary.hasProfile ? 'Job detected' : 'Job detected · add your profile to score';
    }

    const setSaved = () => {
      save.textContent = 'Saved ✓';
      save.disabled = true;
    };
    if (summary.savedJobId) setSaved();
    else save.textContent = 'Save';

    const showHint = (text: string) => {
      hint.textContent = text;
      hint.hidden = false;
      setTimeout(() => (hint.hidden = true), 6000);
    };

    save.addEventListener('click', async () => {
      try {
        await ask('detector/save');
        setSaved();
      } catch (e) {
        showHint(e instanceof Error ? e.message : 'Could not save this job');
      }
    });
    root.querySelector('.details')!.addEventListener('click', async () => {
      try {
        await ask('detector/openPanel');
      } catch {
        showHint('Click the Job Copilot icon in the toolbar, then press Autofill.');
      }
    });
    root.querySelector('.close')!.addEventListener('click', removeButton);
    document.documentElement.appendChild(host);
  }
});
