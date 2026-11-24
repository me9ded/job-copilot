import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { routeMessage } from '../../src/background/router';
import { getDetection } from '../../src/lib/detection';
import { saveProfile, listJobs } from '../../src/lib/storage/repo';
import { makeJob, makeProfile } from '../helpers';

const pageSender = () => ({ id: fakeBrowser.runtime.id, url: fakeBrowser.runtime.getURL('/sidepanel.html') });
const contentSender = (url = 'https://jobs.lever.co/acme/1f2e3d4c-aaaa-bbbb-cccc-1234567890ab') => ({
  id: fakeBrowser.runtime.id,
  url,
  frameId: 0,
  tab: { id: 7, windowId: 1, index: 0, pinned: false, highlighted: false, active: true, incognito: false, selected: true, discarded: false, autoDiscardable: true, groupId: -1 },
});
const okOutcome = (url: string) => ({ status: 'ok', job: makeJob({ url }) });

function stubBadge() {
  fakeBrowser.action.setBadgeText = vi.fn(async () => undefined) as never;
  fakeBrowser.action.setBadgeBackgroundColor = vi.fn(async () => undefined) as never;
}

describe('message validation', () => {
  it('rejects messages from other extensions', async () => {
    expect(await routeMessage({ type: 'sites/sync' }, { id: 'someone-else' } as never)).toEqual({ ok: false, error: 'Unknown sender' });
  });

  it('rejects malformed and unknown messages', async () => {
    expect(await routeMessage({ type: 'nope' }, pageSender() as never)).toEqual({ ok: false, error: 'Invalid message' });
    expect(await routeMessage('string', pageSender() as never)).toEqual({ ok: false, error: 'Invalid message' });
    expect(await routeMessage({ type: 'tab/analyze', tabId: -1 }, pageSender() as never)).toEqual({ ok: false, error: 'Invalid message' });
  });

  it('does not let content scripts send privileged page messages', async () => {
    expect(await routeMessage({ type: 'discovery/run' }, contentSender() as never)).toEqual({ ok: false, error: 'Invalid message' });
    expect(await routeMessage({ type: 'tab/analyze', tabId: 1 }, contentSender() as never)).toEqual({ ok: false, error: 'Invalid message' });
  });

  it('rejects content-script messages from subframes', async () => {
    const sender = { ...contentSender(), frameId: 3 };
    expect(await routeMessage({ type: 'detector/save' }, sender as never)).toEqual({ ok: false, error: 'Unknown sender' });
  });

  it('rejects oversized or schema-violating payloads', async () => {
    const url = contentSender().url;
    const huge = { status: 'ok', job: makeJob({ url, title: 'x'.repeat(5000) }) };
    expect(await routeMessage({ type: 'detector/result', url, outcome: huge }, contentSender() as never)).toEqual({ ok: false, error: 'Invalid message' });
  });

  it('rejects detections reported for another origin', async () => {
    stubBadge();
    const res = await routeMessage({ type: 'detector/result', url: 'https://bank.example/', outcome: okOutcome('https://bank.example/') }, contentSender() as never);
    expect(res).toEqual({ ok: false, error: 'URL mismatch' });
  });
});

describe('detector flow', () => {
  it('stores a detection, summarises the match and saves the job', async () => {
    stubBadge();
    await saveProfile(makeProfile());
    const url = contentSender().url;
    expect(await routeMessage({ type: 'detector/result', url, outcome: okOutcome(url) }, contentSender() as never)).toEqual({ ok: true, data: null });
    expect((await getDetection(7))?.outcome.status).toBe('ok');
    expect(fakeBrowser.action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: expect.stringMatching(/^\d+$/) });

    const summary = await routeMessage({ type: 'detector/summary' }, contentSender() as never);
    expect(summary).toMatchObject({ ok: true, data: { hasProfile: true, savedJobId: null } });
    expect((summary as { data: { score: number } }).data.score).toBeGreaterThan(50);

    const saved = await routeMessage({ type: 'detector/save' }, contentSender() as never);
    expect(saved.ok).toBe(true);
    const jobs = await listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.saved).toBe(true);
  });

  it('fails clearly when saving with nothing detected', async () => {
    expect(await routeMessage({ type: 'detector/save' }, contentSender() as never)).toEqual({ ok: false, error: 'No job detected on this page' });
  });
});

describe('service worker suspension', () => {
  it('recovers per-tab state from session storage after the worker restarts', async () => {
    stubBadge();
    const url = contentSender().url;
    await routeMessage({ type: 'detector/result', url, outcome: okOutcome(url) }, contentSender() as never);

    // Simulate the worker being terminated: drop every module and its in-memory state.
    vi.resetModules();
    const fresh = await import('../../src/background/router');
    const res = await fresh.routeMessage({ type: 'detector/save' }, contentSender() as never);
    expect(res.ok).toBe(true);
    expect(await listJobs()).toHaveLength(1);
  });
});
