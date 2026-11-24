import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { detectScope, scopedQuestions } from '../lib/autofill/engine/detect';
import { isTopFrame, isVisible } from '../lib/autofill/engine/dom';
import { buttonText, errorsOnPage, findNext, findOpenForm, mayOpenForm, stepSignature } from '../lib/autofill/engine/steps';
import { answerQuestionDetailed, fillOnce, leavingHref, press, revealQuestion, type AnswerOutcome, type FillRequest, type StepOptions } from '../lib/autofill/fill';
import type { StepResult } from '../lib/autofill/progress';
import { FILLER_VERSION } from '../lib/autofill/version';
import { restrictedSiteLabel } from '../lib/extraction/sites';

/**
 * Injected with scripting.executeScript only when the user presses Autofill
 * (never registered as a content script). The extension calls these
 * functions in each frame; the page can't see the values or call them
 * (isolated world). One step is filled per call, and Next / Apply are
 * pressed just after a call returns, so a page that reloads can't lose the
 * report of the step that was filled. There is no submit function: the final
 * submit is always the user's own click.
 */

export interface FrameProbe {
  url: string;
  top: boolean;
  questions: number;
  restricted?: string;
  /** Visible iframes of the top frame, to report the ones the extension can't reach. */
  iframes: Array<{ src: string; width: number; height: number }>;
}

export interface FrameState {
  url: string;
  signature: string;
  questions: number;
  errors: string[];
  /** A URL the page tried to open in a new window during the last press, and whether the popup was blocked. */
  opened?: string;
  blocked?: boolean;
}

export interface AdvanceTicket {
  pressed: string | null;
  href?: string;
}

export interface FillerApi {
  version: string;
  probe(): FrameProbe;
  fillStep(req: FillRequest, opts: StepOptions): Promise<StepResult | { restricted: string }>;
  advance(how: 'next' | 'open'): AdvanceTicket;
  state(): FrameState;
  answer(idOrLabel: string, value: string): Promise<AnswerOutcome>;
  reveal(idOrLabel: string): boolean;
  toast(text: string): void;
}

type G = typeof globalThis & { __jobCopilotFiller?: FillerApi };

const OPENED = 'data-job-copilot-opened';
const BLOCKED = 'data-job-copilot-blocked';

export default defineUnlistedScript(() => {
  const g = globalThis as G;
  // A filler from this build is already here; one from an earlier build is replaced.
  if (g.__jobCopilotFiller?.version === FILLER_VERSION) return;

  g.__jobCopilotFiller = {
    version: FILLER_VERSION,
    probe() {
      const restricted = restrictedSiteLabel(location.href) ?? undefined;
      const top = isTopFrame(document);
      const iframes = top
        ? Array.from(document.querySelectorAll('iframe'))
            .filter((f) => isVisible(f) && /^https?:/i.test(f.src))
            .map((f) => {
              const r = f.getBoundingClientRect();
              return { src: f.src, width: Math.round(r.width), height: Math.round(r.height) };
            })
        : [];
      return { url: location.href, top, questions: restricted ? 0 : scopedQuestions(document).length, restricted, iframes };
    },
    async fillStep(req, opts) {
      const restricted = restrictedSiteLabel(location.href);
      if (restricted) return { restricted };
      return fillOnce(document, req, opts);
    },
    advance(how) {
      document.documentElement.removeAttribute(OPENED);
      document.documentElement.removeAttribute(BLOCKED);
      const scope = detectScope(document);
      if (how === 'open') {
        const open = mayOpenForm(document) ? findOpenForm(document, scope) : null;
        if (!open) return { pressed: null };
        const href = leavingHref(document, open);
        // After this call returns, so the extension gets the answer before the page unloads.
        if (href) setTimeout(() => location.assign(href), 30);
        else setTimeout(() => press(open), 30);
        return { pressed: buttonText(open) || 'Apply', href: href ?? undefined };
      }
      const next = findNext(document, scope);
      if (!next) return { pressed: null };
      setTimeout(() => press(next), 30);
      return { pressed: buttonText(next) || 'Next' };
    },
    state() {
      const root = document.documentElement;
      return {
        url: location.href,
        signature: stepSignature(document),
        questions: scopedQuestions(document).length,
        errors: errorsOnPage(document),
        opened: root.getAttribute(OPENED) ?? undefined,
        blocked: root.hasAttribute(BLOCKED) || undefined,
      };
    },
    async answer(idOrLabel, value) {
      if (restrictedSiteLabel(location.href)) return { ok: false, reason: 'not_found', message: 'Autofill is off on this site.' };
      return answerQuestionDetailed(document, idOrLabel, value);
    },
    reveal(idOrLabel) {
      return revealQuestion(document, idOrLabel);
    },
    toast(text) {
      if (!isTopFrame(document)) return;
      document.querySelectorAll('job-copilot-toast').forEach((n) => n.remove());
      const host = document.createElement('job-copilot-toast');
      host.style.cssText = 'all: initial; position: fixed; z-index: 2147483646; right: 16px; bottom: 72px;';
      const root = host.attachShadow({ mode: 'closed' });
      const box = document.createElement('div');
      box.setAttribute('role', 'status');
      box.style.cssText =
        'font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0f172a; color: #fff; padding: 8px 12px; border-radius: 8px; box-shadow: 0 4px 16px rgba(15,23,42,.2); max-width: 320px;';
      box.textContent = text;
      root.append(box);
      document.documentElement.appendChild(host);
      setTimeout(() => host.remove(), 9000);
    },
  };
});
