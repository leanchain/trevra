import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { interpretMeasurements } from './measurements.js';

const WORKSPACE_ID = 'ws_observation_measurements_test';
const T0 = new Date('2026-09-12T08:00:00.000Z');
let db: Db;

function at(hours: number): Date {
  return new Date(T0.getTime() + hours * 60 * 60 * 1_000);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE_ID, 'Observation measurements', T0.toISOString());
  await db.prepare('DELETE FROM research_snapshots WHERE workspace_id=?').run(WORKSPACE_ID);
});

afterEach(async () => {
  await db?.close();
});

function measurement(metric: string, value: number, observedAt: Date, scope: string | null = null) {
  return {
    metric,
    scope,
    value,
    evidenceUrl: `https://evidence.example/${encodeURIComponent(metric)}`,
    observedAt: observedAt.toISOString()
  };
}

describe('external measurement interpretation', () => {
  it('treats the first read as a baseline and meaningful newer movement as signal', async () => {
    expect(
      (
        await interpretMeasurements({
          db,
          workspaceId: WORKSPACE_ID,
          providerKey: 'test',
          domain: 'acme.test',
          measurements: [measurement('meta.active_ads', 2, T0)],
          now: T0
        })
      ).observations
    ).toEqual([]);

    const next = await interpretMeasurements({
      db,
      workspaceId: WORKSPACE_ID,
      providerKey: 'test',
      domain: 'acme.test',
      measurements: [measurement('meta.active_ads', 5, at(24))],
      now: at(24)
    });
    expect(next.observations.map((row) => row.kind)).toEqual(['meta-ads-rising']);
  });

  it('does not roll a baseline backwards when a provider replays stale data', async () => {
    await interpretMeasurements({
      db,
      workspaceId: WORKSPACE_ID,
      providerKey: 'test',
      domain: 'acme.test',
      measurements: [measurement('social.followers', 1_000, at(24), 'instagram:acme')],
      now: at(24)
    });
    expect(
      (
        await interpretMeasurements({
          db,
          workspaceId: WORKSPACE_ID,
          providerKey: 'test',
          domain: 'acme.test',
          measurements: [measurement('social.followers', 900, T0, 'instagram:acme')],
          now: at(25)
        })
      ).observations
    ).toEqual([]);

    const fresh = await interpretMeasurements({
      db,
      workspaceId: WORKSPACE_ID,
      providerKey: 'test',
      domain: 'acme.test',
      measurements: [measurement('social.followers', 1_050, at(48), 'instagram:acme')],
      now: at(48)
    });
    expect(fresh.observations[0]?.previous).toBe('1000');
    expect(fresh.observations[0]?.current).toBe('1050');
  });

  it('treats an omitted metric as not measured instead of zero or removal', async () => {
    await interpretMeasurements({
      db,
      workspaceId: WORKSPACE_ID,
      providerKey: 'test',
      domain: 'acme.test',
      measurements: [
        measurement('newsletter.posts_30d', 4, T0, 'substack:acme'),
        measurement('social.posts_30d', 5, T0, 'instagram:acme')
      ],
      now: T0
    });

    expect(
      (
        await interpretMeasurements({
          db,
          workspaceId: WORKSPACE_ID,
          providerKey: 'test',
          domain: 'acme.test',
          measurements: [measurement('social.posts_30d', 6, at(24), 'instagram:acme')],
          now: at(24)
        })
      ).observations
    ).toEqual([]);

    const newsletter = await interpretMeasurements({
      db,
      workspaceId: WORKSPACE_ID,
      providerKey: 'test',
      domain: 'acme.test',
      measurements: [measurement('newsletter.posts_30d', 0, at(48), 'substack:acme')],
      now: at(48)
    });
    expect(newsletter.observations.map((row) => row.kind)).toEqual(['newsletter-silent']);
    expect(newsletter.observations[0].previous).toBe('4');
  });

  it('rejects unknown, negative and future measurements without poisoning stored state', async () => {
    const result = await interpretMeasurements({
      db,
      workspaceId: WORKSPACE_ID,
      providerKey: 'test',
      domain: 'acme.test',
      measurements: [
        measurement('unknown.metric', 1, T0),
        measurement('meta.active_ads', -1, T0),
        measurement('social.followers', 100, at(2), 'instagram:acme')
      ],
      now: T0
    });
    expect(result.observations).toEqual([]);
    expect(result.warnings).toHaveLength(3);
    const stored = await db
      .prepare(
        "SELECT COUNT(*)::int AS count FROM research_snapshots WHERE workspace_id=? AND domain LIKE 'observation:%'"
      )
      .get<{ count: number }>(WORKSPACE_ID);
    expect(stored?.count).toBe(0);
  });
});
