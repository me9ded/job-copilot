import { browser } from 'wxt/browser';
import { z } from 'zod';
import { ExtractedJob } from './types';

/**
 * Every runtime message is validated against this union. Content scripts may
 * only send the `detector/*` messages; everything else must come from an
 * extension page (popup, side panel, dashboard).
 */
export const ExtractionOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), job: ExtractedJob }),
  z.object({ status: z.literal('not_job'), reason: z.string().max(500) }),
  z.object({ status: z.literal('restricted'), site: z.string().max(100) }),
]);

/** Dashboard views, plus the side panel's tabs (home, job, autofill, tracker). */
export const ViewId = z.enum(['current', 'matches', 'saved', 'applications', 'studio', 'prep', 'settings', 'profile', 'home', 'job', 'autofill', 'tracker']);
export type ViewId = z.infer<typeof ViewId>;

export const ContentMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('detector/result'), url: z.string().max(2048), outcome: ExtractionOutcomeSchema }),
  z.object({ type: z.literal('detector/save') }),
  z.object({ type: z.literal('detector/summary') }),
  z.object({ type: z.literal('detector/openPanel') }),
]);
export type ContentMessage = z.infer<typeof ContentMessage>;

export const PageMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tab/analyze'), tabId: z.number().int().nonnegative() }),
  z.object({ type: z.literal('sites/sync') }),
  z.object({ type: z.literal('alarms/sync') }),
  z.object({ type: z.literal('discovery/run'), sourceId: z.string().max(100).optional() }),
  z.object({ type: z.literal('followups/check') }),
]);
export type PageMessage = z.infer<typeof PageMessage>;

export const AnyMessage = z.union([ContentMessage, PageMessage]);
export type AnyMessage = z.infer<typeof AnyMessage>;

export type Envelope<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export interface DetectorSummary {
  hasProfile: boolean;
  score: number | null;
  matched: string[];
  missing: string[];
  savedJobId: string | null;
}

export interface DiscoveryRunSummary {
  sources: number;
  fetched: number;
  created: number;
  updated: number;
  expired: number;
  errors: string[];
}

/** Sends a message and unwraps the envelope, throwing on error. */
export async function send<T = unknown>(message: AnyMessage): Promise<T> {
  const res = (await browser.runtime.sendMessage(message)) as Envelope<T> | undefined;
  if (!res) throw new Error('No response from the extension background. Try again.');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
