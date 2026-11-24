import { emptyReport, mergeInto, type FillReport } from './engine/report';

/**
 * The application loop, shared by the in-page driver (tests, single
 * documents) and the tab driver (the extension: frames, page loads, new
 * tabs). It fills a step, then decides: stop for the user (CAPTCHA, log-in,
 * a required question without an answer, invalid fields), press Next, open
 * the form behind "Apply", or stop at the final submit button, which only
 * the user presses.
 */

export interface StepFacts {
  /** The step has application questions. */
  form: boolean;
  next?: string;
  submit?: string;
  /** An "Apply" button that opens the form (only looked for when there is no form). */
  open?: string;
  captcha: boolean;
  login: boolean;
  /** Required questions left empty after filling. */
  missing: number;
  /** Invalid fields or validation messages after filling. */
  invalid: string[];
}

export interface StepResult {
  report: FillReport;
  facts: StepFacts;
}

export type AdvanceOutcome =
  /** The same document now shows another step. */
  | { outcome: 'moved' }
  /** A new page loaded and can be filled. */
  | { outcome: 'navigated' }
  /** A new page is loading where this driver can't follow (the in-page driver). */
  | { outcome: 'leaving' }
  /** The application continues in another tab that can be filled. */
  | { outcome: 'new_tab'; tabId: number }
  /** Nothing changed: the page refused the step. */
  | { outcome: 'unchanged'; errors: string[] }
  /** The page moved somewhere Job Copilot has no access to (yet). */
  | { outcome: 'no_access'; host: string; origin: string; url?: string; newTab?: number };

export interface StepDriver {
  fill(): Promise<StepResult>;
  advance(how: 'next' | 'open'): Promise<AdvanceOutcome>;
}

export interface LoopOptions {
  advance: boolean;
  maxSteps?: number;
}

const MAX_OPENS = 2;

export async function runSteps(driver: StepDriver, opts: LoopOptions): Promise<FillReport> {
  let report: FillReport | null = null;
  const maxSteps = opts.maxSteps ?? 12;
  let opens = 0;
  for (let round = 0; round < maxSteps + MAX_OPENS + 1; round++) {
    const { report: step, facts } = await driver.fill();
    report = report ? mergeInto(report, step, true) : step;
    // Named in the report whatever the outcome; "ready to submit" is decided separately (see gate).
    if (facts.submit) report.submitLabel = facts.submit;
    report.steps = Math.max(report.steps, step.steps);
    const finish = (stop: FillReport['stop']) => {
      report!.stop = stop;
      return report!;
    };
    if (facts.captcha) return finish('captcha');
    if (!facts.form) {
      if (facts.login) return finish('login');
      // The application sits in a frame (or page) Job Copilot may not open yet.
      if (step.needsAccess && !facts.open) return finish('needs_access');
      // A job page whose form opens behind an "Apply" button (sometimes followed by a chooser: "Apply Manually").
      if (opts.advance && facts.open && opens < MAX_OPENS && report.steps === 0) {
        opens++;
        const moved = await driver.advance('open');
        const stop = afterAdvance(report, moved);
        if (stop) return finish(stop);
        continue;
      }
      if (report.steps > 0 && facts.submit) return finish(gate(report, facts));
      return finish(report.steps === 0 && !report.filled.length ? 'no_form' : 'done');
    }
    if (facts.login && !report.filled.length && !step.unanswered.length) return finish('login');
    if (facts.missing > 0) return finish('needs_answers');
    // The page already flags fields as invalid: pressing Next would only bounce back.
    if (facts.invalid.length) {
      report.errors = [...new Set([...report.errors, ...facts.invalid])];
      return finish('errors');
    }
    if (facts.next && facts.next !== facts.submit) {
      if (!opts.advance) {
        report.moreSteps = true;
        return finish(facts.invalid.length ? 'errors' : 'done');
      }
      if (report.steps + 1 >= maxSteps) return finish('max_steps');
      const moved = await driver.advance('next');
      const stop = afterAdvance(report, moved);
      if (stop) return finish(stop);
      report.steps++;
      continue;
    }
    if (facts.submit) return finish(gate(report, facts));
    return finish(facts.invalid.length ? 'errors' : 'done');
  }
  return { ...(report ?? emptyReport('')), stop: 'max_steps' };
}

/** "Ready to submit" only when nothing required is empty and nothing is invalid. */
function gate(report: FillReport, facts: StepFacts): FillReport['stop'] {
  if (facts.missing > 0) return 'needs_answers';
  if (facts.invalid.length) {
    report.errors = [...new Set([...report.errors, ...facts.invalid])];
    return 'errors';
  }
  return 'submit_ready';
}

/** Applies an advance outcome to the report; returns a stop reason when the loop must end. */
function afterAdvance(report: FillReport, moved: AdvanceOutcome): FillReport['stop'] | null {
  switch (moved.outcome) {
    case 'moved':
    case 'navigated':
      return null;
    case 'new_tab':
      report.newTab = { tabId: moved.tabId, accessible: true };
      report.tabId = moved.tabId;
      return null;
    case 'leaving':
      return 'navigating';
    case 'unchanged':
      report.errors = [...new Set([...report.errors, ...moved.errors])];
      return 'errors';
    case 'no_access':
      report.needsAccess = { host: moved.host, origin: moved.origin, url: moved.url };
      if (moved.newTab !== undefined) {
        report.newTab = { tabId: moved.newTab, accessible: false };
        report.tabId = moved.newTab;
      }
      return 'needs_access';
  }
}
