/**
 * Waiting for the page: MutationObserver-driven, so a change is seen as soon
 * as it happens instead of on the next poll. A slow fallback check covers
 * changes that mutate nothing (CSS transitions revealing a list).
 */

const FALLBACK_MS = 200;

/** Resolves with `check()`'s first truthy result, or null after `maxMs`. */
export function waitForDom<T>(doc: Document, check: () => T | null | undefined | false, maxMs = 2500): Promise<T | null> {
  const first = check();
  if (first) return Promise.resolve(first);
  return new Promise((resolve) => {
    let done = false;
    let queued = false;
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      obs.disconnect();
      clearInterval(fallback);
      clearTimeout(timeout);
      resolve(v);
    };
    const run = () => {
      queued = false;
      if (done) return;
      let v: T | null | undefined | false;
      try {
        v = check();
      } catch {
        v = null;
      }
      if (v) finish(v);
    };
    const obs = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(run);
    });
    obs.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const fallback = setInterval(run, FALLBACK_MS);
    const timeout = setTimeout(() => finish(null), maxMs);
  });
}

/** Resolves once the DOM has been quiet for `quietMs` (or after `maxMs`). */
export function settle(doc: Document, quietMs = 250, maxMs = 4000): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, quietMs);
    const hard = setTimeout(done, maxMs);
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    obs.observe(doc.documentElement, { subtree: true, childList: true, attributes: true });
    function done() {
      obs.disconnect();
      clearTimeout(timer);
      clearTimeout(hard);
      resolve();
    }
  });
}

/** Lets the page's own handlers (framework re-renders, state restores) run before reading a value back. */
export const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Polling wait, kept for callers without a document. Prefer `waitForDom`. */
export async function waitFor<T>(fn: () => T | null | undefined, maxMs = 2500, every = 80): Promise<T | null> {
  const end = Date.now() + maxMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}
