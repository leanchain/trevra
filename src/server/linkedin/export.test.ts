import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_WORKSPACE_ID, id, openDatabase, resetDemoData, type Db } from '../db.js';
import { logCrmActivity, resolveLocalContact } from '../crm/activity.js';
import type { CrmProxy } from '../crm/types.js';
import type { PacingPlan } from './pacing.js';
import { upsertSeat } from './seats.js';
import { buildSequence, type LinkedInSequence, type SequenceInput } from './sequence.js';
import {
  HEADER_OWNERSHIP,
  csvDocument,
  csvField,
  exportCampaign,
  linkedinExportPayloadSchema,
  scheduleOf,
  type ExportContact
} from './export.js';

let db: Db;
const NOW = new Date('2026-08-04T09:00:00.000Z');

/**
 * The seat's FIRST WRITE is the ramp clock, so an established seat is one
 * written back in January rather than one declaring a January opening date.
 */
const ACTIVATED = new Date('2026-01-05T09:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
  await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(DEMO_WORKSPACE_ID);
  await upsertSeat(
    db,
    DEMO_WORKSPACE_ID,
    { label: 'Pankaj (founder)', timezone: 'Europe/Berlin', accountOpenedOn: '2026-01-05', connectionsCount: 900 },
    ACTIVATED
  );
});

afterEach(async () => {
  await db?.close();
});

/**
 * A company name that breaks every naive CSV writer: it has a comma AND a
 * double quote. Both appear in real LinkedIn company names, and getting either
 * wrong shifts every column to the right of it on import -- silently, so the
 * first symptom is a message addressed to the wrong person.
 */
const HOSTILE_COMPANY = 'Acme, "Rocket" Inc.';

function sequence(): LinkedInSequence {
  const input: SequenceInput = {
    icp: {
      role: 'Head of RevOps',
      segment: 'Series A B2B SaaS',
      pain: 'lead routing breaks every time the territory map changes'
    },
    offer: {
      name: 'Trevra',
      summary: 'a go-to-market runtime that keeps routing rules in one reviewable file',
      mechanism: 'routing lives in version control, so a territory change is a diff instead of a migration',
      proof: [{ label: 'routing errors', value: 'down 71%' }],
      url: 'https://trevra.dev'
    },
    targets: ['https://linkedin.com/in/one', 'https://linkedin.com/in/two'],
    tone: 'consultative'
  };
  return buildSequence(input);
}

function plan(overrides: Partial<PacingPlan> = {}): PacingPlan {
  return {
    seatKey: 'owner',
    slots: [
      { plannedFor: '2026-08-04T09:31:00.000Z', kind: 'invite', targetRef: 'https://linkedin.com/in/one' },
      { plannedFor: '2026-08-04T13:02:00.000Z', kind: 'invite', targetRef: 'https://linkedin.com/in/two' },
      { plannedFor: '2026-08-06T08:14:00.000Z', kind: 'invite', targetRef: 'https://linkedin.com/in/three' }
    ],
    reasons: ['Volume is ramped rather than started at 18/day.'],
    ceilingsApplied: ['day-over-day-delta', 'weekend'],
    ...overrides
  };
}

function contacts(): ExportContact[] {
  return [
    {
      targetRef: 'https://linkedin.com/in/one',
      firstName: 'Maya',
      lastName: 'Chen',
      company: HOSTILE_COMPANY,
      profileUrl: 'https://linkedin.com/in/maya-chen'
    },
    { targetRef: 'https://linkedin.com/in/two', firstName: 'Jo', lastName: 'Park', company: 'Northwind' }
  ];
}

/** Minimal RFC4180 reader, so the assertions read the file the way an importer would. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r' && text[index + 1] === '\n') {
      row.push(field); field = ''; rows.push(row); row = []; index += 1; continue;
    }
    if (char === '\n') { row.push(field); field = ''; rows.push(row); row = []; continue; }
    field += char;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

describe('RFC4180 quoting', () => {
  it('quotes and doubles a company name containing both a comma and a double quote', () => {
    expect(csvField(HOSTILE_COMPANY)).toBe('"Acme, ""Rocket"" Inc."');
    expect(csvField('Northwind')).toBe('Northwind');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField('has "quotes" only')).toBe('"has ""quotes"" only"');
  });

  it('separates records with CRLF and round-trips through a reader', () => {
    const document = csvDocument([['a', 'b'], [HOSTILE_COMPANY, 'plain']]);
    expect(document.endsWith('\r\n')).toBe(true);
    expect(parseCsv(document)).toEqual([['a', 'b'], [HOSTILE_COMPANY, 'plain']]);
  });

  it('keeps a hostile company name in its own column through a real dripify export', async () => {
    const result = await exportCampaign(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, plan: plan(), sequence: sequence(), format: 'dripify', contacts: contacts() },
      NOW
    );

    // The raw bytes carry the escape, not a stripped or mangled name.
    expect(result.body).toContain('"Acme, ""Rocket"" Inc."');

    const rows = parseCsv(result.body);
    const header = rows[0];
    expect(header.slice(0, 5)).toEqual(['profile_url', 'first_name', 'last_name', 'company', 'note']);
    expect(header.slice(5).every((column) => /^day_\d+_message$/.test(column))).toBe(true);

    const maya = rows.find((row) => row[1] === 'Maya')!;
    expect(maya).toBeDefined();
    expect(maya[3]).toBe(HOSTILE_COMPANY);
    // Every data row has exactly as many columns as the header. This is the
    // assertion a broken writer fails.
    for (const row of rows.slice(1)) expect(row.length).toBe(header.length);
  });
});

describe('header block', () => {
  it('states the schedule, the ceilings, the warm-up week and who owns the ToS relationship', async () => {
    const result = await exportCampaign(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, plan: plan(), sequence: sequence(), format: 'dripify', contacts: contacts() },
      NOW
    );

    expect(result.headerBlock).toContain(HEADER_OWNERSHIP);
    expect(result.headerBlock).toContain('Pacing schedule');
    expect(result.headerBlock).toContain('Ceilings applied: day-over-day-delta, weekend');
    expect(result.headerBlock).toMatch(/Warm-up week \d+/);
    expect(result.headerBlock).toContain('Europe/Berlin');
    // Provenance, per limits.ts discipline: these are reported numbers.
    expect(result.headerBlock).toContain('REPORTED');
    // Every scheduled day and its count is spelled out.
    expect(result.headerBlock).toContain('2026-08-04');
    expect(result.headerBlock).toContain('2026-08-06');

    // And it is embedded in what the operator downloads, commented so the CSV
    // body still parses.
    expect(result.content).toContain(HEADER_OWNERSHIP);
    expect(result.content.startsWith('# Trevra LinkedIn campaign export')).toBe(true);
  });

  it('embeds the block in every format', async () => {
    for (const format of ['dripify', 'heyreach', 'expandi', 'generic'] as const) {
      const result = await exportCampaign(
        db,
        { workspaceId: DEMO_WORKSPACE_ID, plan: plan(), sequence: sequence(), format, contacts: contacts(), campaignId: `c-${format}` },
        NOW
      );
      expect(result.content, format).toContain(HEADER_OWNERSHIP);
      expect(result.headerBlock, format).toContain('Pacing schedule');
      expect(result.filename, format).toContain(format);
    }
  });

  it('leaves the heyreach JSON parseable, with the block in a field', async () => {
    const result = await exportCampaign(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, plan: plan(), sequence: sequence(), format: 'heyreach', contacts: contacts() },
      NOW
    );
    const parsed = JSON.parse(result.content) as { trevra: { headerBlock: string; notice: string }; leads: Array<{ companyName: string }> };
    expect(parsed.trevra.notice).toBe(HEADER_OWNERSHIP);
    expect(parsed.trevra.headerBlock).toContain('Pacing schedule');
    expect(parsed.leads[0].companyName).toBe(HOSTILE_COMPANY);
  });

  it('reports the warm-up week from the seat, not from the plan', async () => {
    // The ramp clock is the seat's first write and no edit resets it, so week 1
    // is what a freshly created seat looks like -- there is no date to declare.
    await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(DEMO_WORKSPACE_ID);
    await upsertSeat(db, DEMO_WORKSPACE_ID, { label: 'Pankaj (founder)', timezone: 'Europe/Berlin' }, NOW);
    const result = await exportCampaign(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, plan: plan(), sequence: sequence(), format: 'generic' },
      NOW
    );
    expect(result.warmupWeek).toBe(1);
    expect(result.headerBlock).toContain('Warm-up week 1');
  });
});

describe('the ledger write', () => {
  it("writes one linkedin_actions row per slot as status='exported', source='export'", async () => {
    const result = await exportCampaign(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, plan: plan(), sequence: sequence(), format: 'dripify', contacts: contacts(), campaignId: 'camp-1', payloadHash: 'ph_1' },
      NOW
    );

    expect(result.recorded).toEqual({ attempted: 3, written: 3, duplicate: 0 });

    const rows = await db.prepare(`
      SELECT kind, target_ref, status, source, campaign_id, payload_hash,
             TO_CHAR(planned_for AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS planned_for,
             TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS recorded_at
      FROM linkedin_actions WHERE workspace_id=? ORDER BY planned_for
    `).all<Record<string, string>>(DEMO_WORKSPACE_ID);

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe('exported');
      expect(row.source).toBe('export');
      expect(row.kind).toBe('invite');
      expect(row.campaign_id).toBe('camp-1');
      expect(row.payload_hash).toBe('ph_1');
    }
    expect(rows.map((row) => row.target_ref)).toEqual([
      'https://linkedin.com/in/one',
      'https://linkedin.com/in/two',
      'https://linkedin.com/in/three'
    ]);
  });

  it('dates each row at its slot, not at the export instant', async () => {
    // The whole reason the ledger exists: `dailyCountsForLastNDays` reads
    // recorded_at, so stamping a 3-day plan with `now` would tell the next plan
    // the seat did everything this morning and freeze it.
    await exportCampaign(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, plan: plan(), sequence: sequence(), format: 'generic' },
      NOW
    );
    const rows = await db.prepare(
      `SELECT recorded_at = planned_for AS aligned FROM linkedin_actions WHERE workspace_id=?`
    ).all<{ aligned: boolean }>(DEMO_WORKSPACE_ID);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.aligned)).toBe(true);
  });

  it('re-exporting the same campaign does not double-count a target', async () => {
    const input = { workspaceId: DEMO_WORKSPACE_ID, plan: plan(), sequence: sequence(), format: 'dripify' as const };
    await exportCampaign(db, input, NOW);
    const second = await exportCampaign(db, input, NOW);

    expect(second.recorded).toEqual({ attempted: 3, written: 0, duplicate: 3 });
    const row = await db.prepare('SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=?')
      .get<{ total: number }>(DEMO_WORKSPACE_ID);
    expect(row?.total).toBe(3);
  });

  it('fails closed when the seat is gone rather than exporting a schedule in the wrong hours', async () => {
    await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(DEMO_WORKSPACE_ID);
    await expect(
      exportCampaign(db, { workspaceId: DEMO_WORKSPACE_ID, plan: plan(), sequence: sequence(), format: 'dripify' }, NOW)
      // Names the seat the PLAN asked for, because that is the one that was
      // looked up: `getSeat` defaults to the owner seat and this call used to
      // omit the argument, so the refusal quoted a key it had never checked.
    ).rejects.toThrow(/No LinkedIn seat 'owner' is configured/);
  });
});

describe('schedule and merge fields', () => {
  it('groups slots into seat-local days', () => {
    // 2026-08-04T22:40Z is already the 5th in Berlin. Grouping in UTC would
    // put it on the wrong day and mis-state the send counts.
    const schedule = scheduleOf(
      plan({
        slots: [
          { plannedFor: '2026-08-04T09:31:00.000Z', kind: 'invite', targetRef: 'a' },
          { plannedFor: '2026-08-04T22:40:00.000Z', kind: 'invite', targetRef: 'b' }
        ]
      }),
      'Europe/Berlin'
    );
    expect(schedule).toEqual([
      { date: '2026-08-04', count: 1, kinds: ['invite'] },
      { date: '2026-08-05', count: 1, kinds: ['invite'] }
    ]);
  });

  it("rewrites placeholders into the destination tool's vocabulary", async () => {
    const dripify = await exportCampaign(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, plan: plan(), sequence: sequence(), format: 'dripify', contacts: contacts() },
      NOW
    );
    expect(dripify.body).toContain('{{first_name}}');
    expect(dripify.body).not.toContain('{{firstName}}');

    const generic = await exportCampaign(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, plan: plan(), sequence: sequence(), format: 'generic' },
      NOW
    );
    expect(generic.body).toContain('{{firstName}}');
  });
});

describe('a LinkedIn touch reaches the CRM (migration 023)', () => {
  /**
   * The claim migration 023 makes: with a `linkedin` identity in
   * `contact_identities`, `resolveLocalContact()` and `logCrmActivity()` need
   * NO code change to attribute a LinkedIn action. Both are already
   * provider-agnostic; what was missing was the identity row and the index the
   * lookup can use. This test is the proof.
   */
  const TARGET_REF = 'https://linkedin.com/in/Maya-Chen';

  async function linkContact(): Promise<string> {
    const clientId = id('cl');
    await db.prepare(`
      INSERT INTO clients (id,workspace_id,name,contact_name,email,status,active_value,currency,last_interaction_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(clientId, DEMO_WORKSPACE_ID, 'Acme', 'Maya Chen', 'maya@acme.test', 'active', 0, 'EUR', NOW.toISOString(), NOW.toISOString());
    await db.prepare(`
      INSERT INTO contact_identities (id,workspace_id,client_id,provider,identity_type,identity_value,created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(id('ident'), DEMO_WORKSPACE_ID, clientId, 'linkedin', 'linkedin', TARGET_REF, NOW.toISOString());
    return clientId;
  }

  it("resolves linkedin_actions.target_ref to a client, case-insensitively", async () => {
    const clientId = await linkContact();
    const resolved = await resolveLocalContact(db, DEMO_WORKSPACE_ID, {
      handle: TARGET_REF.toLowerCase(),
      handleProvider: 'linkedin',
      email: null,
      domain: null
    });
    expect(resolved.clientId).toBe(clientId);
    expect(resolved.email).toBe('maya@acme.test');
  });

  it("logs activity_type='linkedin_touch' / source_type='linkedin_action' through the unchanged helper", async () => {
    await linkContact();
    await db.prepare(`
      INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(id('conn'), DEMO_WORKSPACE_ID, 'hubspot', 'trevra-hubspot', 'ext-hubspot', 'Sales CRM', 'connected', 0, NOW.toISOString(), NOW.toISOString());

    const proxy: CrmProxy = {
      async post<T>(endpoint: string): Promise<T> {
        if (endpoint.includes('search')) return { results: [{ id: '551', properties: { email: 'maya@acme.test' } }] } as T;
        return { id: 'note-1' } as T;
      },
      async get<T>(): Promise<T> { throw new Error('not used'); }
    };

    const result = await logCrmActivity(
      db,
      DEMO_WORKSPACE_ID,
      {
        contact: { handle: TARGET_REF, handleProvider: 'linkedin', email: null, domain: null },
        activityType: 'linkedin_touch',
        subject: 'Invite sent on LinkedIn: Maya Chen',
        body: 'Connection request queued by the paced campaign.',
        url: TARGET_REF,
        occurredAt: NOW.toISOString(),
        sourceType: 'linkedin_action',
        sourceId: 'lact_1'
      },
      NOW,
      { proxyFor: () => proxy }
    );

    expect(result.status).toBe('written');
    const row = await db.prepare(
      `SELECT activity_type, source_type, source_id, status FROM crm_activities WHERE workspace_id=?`
    ).get<Record<string, string>>(DEMO_WORKSPACE_ID);
    expect(row).toMatchObject({
      activity_type: 'linkedin_touch',
      source_type: 'linkedin_action',
      source_id: 'lact_1',
      status: 'written'
    });
  });
});

describe('branches an export cannot resolve', () => {
  /**
   * AN EXPORT IS WRITTEN BEFORE THE FIRST INVITE GOES OUT, so every branch in
   * it is undecidable by construction -- the step it waits on has not been
   * sent, let alone answered, and there is no instant at which the exporter
   * could ask the evaluator and get anything but `pending`.
   *
   * The two wrong answers are therefore emitting the row unconditionally (which
   * sends "thanks for connecting" to somebody who never connected) and dropping
   * it (which silently deletes an arm the operator approved). It hands the
   * condition to the person who CAN resolve it instead, attached to the row it
   * governs, in every format.
   */
  function branched(): LinkedInSequence {
    const base = sequence();
    return {
      ...base,
      steps: base.steps.map((step) =>
        step.id === 'message-1' ? { ...step, condition: { on: 'accepted' as const, ofStepId: 'invite' } } : step
      )
    };
  }

  it('names the branch in the header block, and says why it could not resolve it', async () => {
    const rendered = await exportCampaign(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, plan: plan(), sequence: branched(), format: 'generic' },
      NOW
    );
    expect(rendered.headerBlock).toContain('CONDITIONAL STEPS');
    expect(rendered.headerBlock).toContain("ONLY IF step 'invite' was accepted");
    expect(rendered.headerBlock).toContain('no branch in it has an answer yet');
  });

  it('attaches the instruction to the CSV cell the condition governs', async () => {
    const rendered = await exportCampaign(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, plan: plan(), sequence: branched(), format: 'dripify' },
      NOW
    );
    const rows = parseCsv(rendered.body);
    const column = rows[0].indexOf('day_3_message');
    expect(column).toBeGreaterThan(-1);
    expect(rows[1][column]).toContain("[ONLY IF step 'invite' was accepted");
    // The copy itself is untouched behind the instruction -- an export renders
    // approved bytes and does not rewrite them.
    expect(rows[1][column]).toContain('{{first_name}}');

    // And an unconditional step carries no instruction at all.
    const noteColumn = rows[0].indexOf('note');
    expect(rows[1][noteColumn]).not.toContain('ONLY IF');
  });

  it('gives a JSON format both the machine-readable branch and the sentence', async () => {
    const rendered = await exportCampaign(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, plan: plan(), sequence: branched(), format: 'heyreach' },
      NOW
    );
    const parsed = JSON.parse(rendered.body) as {
      campaign: { steps: Array<{ condition: { on: string; ofStepId: string } | null; conditionInstruction: string | null }> };
    };
    const conditional = parsed.campaign.steps.filter((step) => step.condition !== null);
    expect(conditional).toHaveLength(1);
    expect(conditional[0].condition).toEqual({ on: 'accepted', ofStepId: 'invite' });
    expect(conditional[0].conditionInstruction).toContain("ONLY IF step 'invite' was accepted");
  });

  it('carries the condition through the approved-action payload', () => {
    // Without this the payload schema would strip every branch on the way into
    // the approval, and the export would render an unconditional campaign from
    // a sequence a human approved with branches in it.
    const parsed = linkedinExportPayloadSchema.parse({
      format: 'dripify',
      plan: plan(),
      sequence: branched()
    });
    expect(parsed.sequence.steps.find((step) => step.id === 'message-1')?.condition).toEqual({
      on: 'accepted',
      ofStepId: 'invite'
    });
  });
});

describe('the approved-action payload', () => {
  it('accepts what the playbook approval carries', () => {
    const parsed = linkedinExportPayloadSchema.parse({
      format: 'dripify',
      campaignId: 'camp-1',
      plan: plan(),
      sequence: sequence(),
      contacts: contacts(),
      metadata: { safetyAllowed: true }
    });
    expect(parsed.plan.slots).toHaveLength(3);
    expect(parsed.sequence.steps.length).toBeGreaterThan(0);
  });

  it('refuses a kind that has no published pacing band', () => {
    expect(() =>
      linkedinExportPayloadSchema.parse({
        format: 'dripify',
        plan: plan({ slots: [{ plannedFor: '2026-08-04T09:31:00.000Z', kind: 'comment' as never, targetRef: 'a' }] }),
        sequence: sequence()
      })
    ).toThrow();
  });
});

/**
 * WHOSE TIMEZONE AND WHOSE RAMP THE FILE IS RENDERED IN.
 *
 * `exportCampaign` computes `seatKey` from the plan and then read the OWNER
 * seat, because `getSeat` defaults its third argument. In a single-seat
 * workspace those are the same row and nothing was visibly wrong. In a
 * multi-account one the export was printed in another account's hours and
 * quoted another account's warm-up week -- on every schedule line, in the
 * header block, and in the `DAILY SEND COUNTS` section a human reads before
 * pasting the file into their own tool.
 */
describe('the seat an export is rendered for', () => {
  /** A second account in the same workspace: a different zone, and a brand-new ramp. */
  async function salesSeat(): Promise<void> {
    await upsertSeat(
      db,
      DEMO_WORKSPACE_ID,
      { label: 'Sales (SDR)', timezone: 'Pacific/Auckland' },
      // Activated today, so it is warm-up week 1 where the owner seat is past
      // its ramp. The two numbers cannot be confused for one another.
      NOW,
      'sales'
    );
  }

  it('renders in the named seat\'s timezone, not the owner seat\'s', async () => {
    await salesSeat();
    const exported = await exportCampaign(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, plan: plan({ seatKey: 'sales' }), sequence: sequence(), format: 'generic' },
      NOW
    );
    expect(exported.timezone).toBe('Pacific/Auckland');
    expect(exported.content).toContain('Pacific/Auckland');
    expect(exported.content).not.toContain('Europe/Berlin');
  });

  it('quotes the named seat\'s warm-up week, not the owner seat\'s', async () => {
    await salesSeat();
    const owner = await exportCampaign(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, plan: plan(), sequence: sequence(), format: 'generic' },
      NOW
    );
    const sales = await exportCampaign(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, plan: plan({ seatKey: 'sales' }), sequence: sequence(), format: 'generic' },
      NOW
    );
    // The owner seat was activated in January and is past the ramp; the sales
    // seat was activated at NOW and is in week 1 of it.
    expect(owner.content).toContain('past the');
    expect(sales.content).toContain('Warm-up week 1');
  });

  it('groups the schedule into the named seat\'s local days', async () => {
    await salesSeat();
    // 2026-08-06T08:14Z is the 6th in Berlin and already the 6th at 20:14 in
    // Auckland; 2026-08-04T13:02Z is the 4th in Berlin and the 5th in
    // Auckland. Grouping against the wrong seat puts a slot on the wrong day.
    const sales = await exportCampaign(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, plan: plan({ seatKey: 'sales' }), sequence: sequence(), format: 'generic' },
      NOW
    );
    expect(sales.schedule.map((day) => day.date)).toEqual(['2026-08-04', '2026-08-05', '2026-08-06']);
  });

  it('refuses by name when the plan\'s seat is the missing one, even though the owner seat exists', async () => {
    await expect(
      exportCampaign(
        db,
        { workspaceId: DEMO_WORKSPACE_ID, plan: plan({ seatKey: 'sales' }), sequence: sequence(), format: 'dripify' },
        NOW
      )
      // The old code found the owner seat, exported happily, and printed the
      // whole file in the wrong account's hours.
    ).rejects.toThrow(/No LinkedIn seat 'sales' is configured/);
  });
});
