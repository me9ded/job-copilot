import { nowIso } from '../util';
import { KEYS, SCHEMA_VERSION, type Meta } from './schema';

export type Snapshot = Record<string, unknown>;

export interface Migration {
  to: number;
  description: string;
  /** Receives a full snapshot of storage and returns the new snapshot. Must be idempotent. */
  up(data: Snapshot): Snapshot;
}

export const MIGRATIONS: Migration[] = [
  {
    to: 1,
    description: 'Initial schema',
    up: (d) => d,
  },
  {
    to: 2,
    description: 'Split a single "jobs" map into per-record "job:<id>" keys',
    up: (d) => {
      const out = { ...d };
      const legacy = out.jobs;
      if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
        for (const [id, job] of Object.entries(legacy as Record<string, unknown>)) {
          if (!out[`job:${id}`]) out[`job:${id}`] = job;
        }
      }
      delete out.jobs;
      return out;
    },
  },
];

/** Applies migrations to an in-memory snapshot (used when importing an older backup). */
export function migrateSnapshot(data: Snapshot, from: number, migrations: Migration[] = MIGRATIONS, target: number = SCHEMA_VERSION): Snapshot {
  let out = { ...data };
  for (const m of [...migrations].sort((a, b) => a.to - b.to)) if (m.to > from && m.to <= target) out = m.up(out);
  return out;
}

export interface StorageAreaLike {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface MigrationReport {
  from: number;
  to: number;
  applied: string[];
  skipped?: string;
}

/**
 * Brings stored data up to `target`. Migrations run on an in-memory snapshot;
 * only changed and removed keys are written, then the version is bumped. Newer
 * data written by a later build is never downgraded.
 */
export async function runMigrations(
  area: StorageAreaLike,
  migrations: Migration[] = MIGRATIONS,
  target: number = SCHEMA_VERSION,
): Promise<MigrationReport> {
  // Fast path: the service worker calls this on every wake, so avoid reading everything.
  const meta = ((await area.get(KEYS.meta))[KEYS.meta] as Meta | undefined) ?? undefined;
  const from = meta?.schemaVersion ?? 0;
  if (from > target) return { from, to: from, applied: [], skipped: `Stored schema v${from} is newer than this build (v${target}).` };
  if (from === target) return { from, to: target, applied: [] };

  const before = await area.get(null);

  let data: Snapshot = { ...before };
  const applied: string[] = [];
  for (const m of [...migrations].sort((a, b) => a.to - b.to)) {
    if (m.to <= from || m.to > target) continue;
    data = m.up(data);
    applied.push(`v${m.to}: ${m.description}`);
  }

  const removed = Object.keys(before).filter((k) => !(k in data));
  const changed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (before[k] !== v) changed[k] = v;
  changed[KEYS.meta] = {
    schemaVersion: target,
    installedAt: meta?.installedAt ?? nowIso(),
    lastMigratedAt: nowIso(),
  } satisfies Meta;

  if (removed.length) await area.remove(removed);
  await area.set(changed);
  return { from, to: target, applied };
}
