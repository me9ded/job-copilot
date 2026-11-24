import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { answerQuestion, runApplication, submitApplication, type FillReport, type FillRequest, type SubmitOutcome } from '../lib/autofill/fill';
import { restrictedSiteLabel } from '../lib/extraction/sites';

/**
 * Injected with scripting.executeScript only when the user presses a Fill
 * button (never registered as a content script). It exposes three functions
 * the extension calls; the page can't see the values or call them (isolated
 * world). `submit` only works in a frame whose last fill ended at the submit
 * button, and the extension calls it only after the user confirms.
 */

export interface FillerApi {
  fill(req: FillRequest): Promise<FillReport | { restricted: string }>;
  answer(label: string, value: string): Promise<boolean>;
  submit(): Promise<SubmitOutcome | null>;
}

type G = typeof globalThis & { __jobCopilotFiller?: FillerApi };

export default defineUnlistedScript(() => {
  const g = globalThis as G;
  if (g.__jobCopilotFiller) return;
  let readyToSubmit = false;

  g.__jobCopilotFiller = {
    async fill(req) {
      const restricted = restrictedSiteLabel(location.href);
      if (restricted) return { restricted };
      const report = await runApplication(document, req);
      readyToSubmit = report.stop === 'submit_ready';
      if (report.filled.length && window === window.top) toast(report);
      return report;
    },
    async answer(label, value) {
      if (restrictedSiteLabel(location.href)) return false;
      return answerQuestion(document, label, value);
    },
    async submit() {
      if (!readyToSubmit || restrictedSiteLabel(location.href)) return null;
      readyToSubmit = false;
      return submitApplication(document);
    },
  };

  function toast(report: FillReport) {
    const n = report.filled.length;
    const host = document.createElement('job-copilot-toast');
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483646; right: 16px; bottom: 72px;';
    const root = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.style.cssText =
      'font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0f172a; color: #fff; padding: 8px 12px; border-radius: 8px; box-shadow: 0 4px 16px rgba(15,23,42,.2); max-width: 300px;';
    box.textContent =
      report.stop === 'submit_ready'
        ? `Job Copilot filled ${n} field${n === 1 ? '' : 's'} (outlined in green). Review them, then submit from the side panel or press the outlined button yourself.`
        : `Job Copilot filled ${n} field${n === 1 ? '' : 's'} (outlined in green). Some questions still need you; see the side panel.`;
    root.append(box);
    document.documentElement.appendChild(host);
    setTimeout(() => host.remove(), 8000);
  }
});
