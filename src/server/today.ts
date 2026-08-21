import type { Db } from './db.js';

export type TodayItemKind =
  | 'safety_block'
  | 'verified_reply'
  | 'delivery_unknown'
  | 'approval_waiting'
  | 'inbound_submission'
  | 'qualification_decision'
  | 'high_priority_account'
  | 'capacity_block';

export interface TodayItem {
  id: string;
  kind: TodayItemKind;
  priority: number;
  title: string;
  detail: string;
  href: string;
  observedAt: string;
  reference: { type: string; id: string };
  metadata: Record<string, unknown>;
}

export interface TodayPayload {
  needsAttention: TodayItem[];
  working: TodayItem[];
  recentResults: TodayItem[];
}

function iso(value: unknown, fallback: Date): string {
  const parsed = value ? new Date(String(value)) : fallback;
  return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
}

function sortAttention(items: TodayItem[]): TodayItem[] {
  return [...items].sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    const time = left.observedAt.localeCompare(right.observedAt);
    return time || left.id.localeCompare(right.id);
  });
}

/**
 * Deterministic human-attention projection for the GTM OS.
 *
 * This is deliberately a read model over existing durable GTM state. It is not
 * a new job/task table and it does not let a model decide what is urgent. Each
 * class has an explicit priority and a canonical destination.
 */
export async function getToday(
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<TodayPayload> {
  const recentSince = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  const [seatRows, replyRows, unknownRows, approvalRows, inboundRows, hotRows] = await Promise.all([
    db
      .prepare(
        `SELECT seat_key,label,posture,paused_reason,updated_at
         FROM linkedin_seats
         WHERE workspace_id=? AND posture IN ('paused','cooldown')
         ORDER BY updated_at ASC LIMIT 20`
      )
      .all<Record<string, unknown>>(workspaceId),
    db
      .prepare(
        `SELECT t.id,t.name,t.snippet,t.last_message_at,t.synced_at,t.campaign_id
         FROM linkedin_threads t
         WHERE t.workspace_id=? AND t.unread=TRUE
           AND EXISTS (
             SELECT 1 FROM linkedin_messages m
             WHERE m.workspace_id=t.workspace_id AND m.thread_id=t.id AND m.direction='in'
           )
         ORDER BY COALESCE(t.last_message_at,t.synced_at) ASC NULLS LAST,t.id ASC
         LIMIT 50`
      )
      .all<Record<string, unknown>>(workspaceId),
    db
      .prepare(
        `SELECT id,campaign_id,member_id,kind,status,outcome_known,last_error,updated_at
         FROM linkedin_campaign_channel_actions
         WHERE workspace_id=? AND (status='unknown' OR outcome_known=FALSE)
         ORDER BY updated_at ASC,id ASC LIMIT 50`
      )
      .all<Record<string, unknown>>(workspaceId),
    db
      .prepare(
        `SELECT s.id,s.step_id,s.updated_at,r.id AS run_id,r.playbook_key
         FROM playbook_step_runs s
         JOIN playbook_runs r ON r.id=s.playbook_run_id
         WHERE r.workspace_id=? AND s.status='waiting_approval'
         ORDER BY s.updated_at ASC,s.id ASC LIMIT 50`
      )
      .all<Record<string, unknown>>(workspaceId),
    db
      .prepare(
        `SELECT id,contact_id,account_id,kind,person_name,person_email,person_phone,message,received_at
         FROM inbound_submissions
         WHERE workspace_id=? AND received_at>=?::timestamptz
         ORDER BY received_at ASC,id ASC LIMIT 50`
      )
      .all<Record<string, unknown>>(workspaceId, recentSince),
    db
      .prepare(
        `SELECT a.id,a.name,a.domain,s.score,s.newest_signal_at,s.computed_at
         FROM account_scores s
         JOIN accounts a ON a.id=s.account_id AND a.workspace_id=s.workspace_id
         WHERE s.workspace_id=? AND s.tier='hot'
           AND COALESCE(s.newest_signal_at,s.computed_at)>=?::timestamptz
         ORDER BY COALESCE(s.newest_signal_at,s.computed_at) ASC,a.id ASC LIMIT 50`
      )
      .all<Record<string, unknown>>(workspaceId, recentSince)
  ]);

  const items: TodayItem[] = [];

  for (const row of seatRows) {
    const label = String(row.label ?? row.seat_key ?? 'LinkedIn account');
    const posture = String(row.posture ?? 'paused');
    const reason = String(row.paused_reason ?? '').trim();
    items.push({
      id: `safety:${String(row.seat_key ?? 'owner')}`,
      kind: 'safety_block',
      priority: 10,
      title: `${label} needs attention`,
      detail: reason || `LinkedIn sending is ${posture}.`,
      href: '/outreach/settings',
      observedAt: iso(row.updated_at, now),
      reference: { type: 'linkedin_seat', id: String(row.seat_key ?? 'owner') },
      metadata: { posture }
    });
  }

  for (const row of replyRows) {
    const name = String(row.name ?? '').trim() || 'LinkedIn reply';
    const snippet = String(row.snippet ?? '').trim();
    items.push({
      id: `reply:${String(row.id)}`,
      kind: 'verified_reply',
      priority: 20,
      title: `Reply from ${name}`,
      detail: snippet || 'An inbound LinkedIn message needs review.',
      href: '/outreach/inbox',
      observedAt: iso(row.last_message_at ?? row.synced_at, now),
      reference: { type: 'linkedin_thread', id: String(row.id) },
      metadata: {
        campaignId: row.campaign_id ? String(row.campaign_id) : null,
        channel: 'linkedin'
      }
    });
  }

  for (const row of unknownRows) {
    items.push({
      id: `delivery:${String(row.id)}`,
      kind: 'delivery_unknown',
      priority: 30,
      title: 'Delivery outcome is unknown',
      detail:
        String(row.last_error ?? '').trim() ||
        `Trevra cannot safely tell whether this ${String(row.kind ?? 'channel')} action completed.`,
      href: '/outreach',
      observedAt: iso(row.updated_at, now),
      reference: { type: 'campaign_channel_action', id: String(row.id) },
      metadata: {
        campaignId: String(row.campaign_id ?? ''),
        memberId: String(row.member_id ?? ''),
        channel: String(row.kind ?? '')
      }
    });
  }

  for (const row of approvalRows) {
    items.push({
      id: `approval:${String(row.id)}`,
      kind: 'approval_waiting',
      priority: 40,
      title: 'Approval waiting',
      detail: `${String(row.playbook_key ?? 'GTM playbook')} is waiting at ${String(row.step_id ?? 'an approval step')}.`,
      href: '/loop',
      observedAt: iso(row.updated_at, now),
      reference: { type: 'playbook_step_run', id: String(row.id) },
      metadata: { playbookRunId: String(row.run_id ?? '') }
    });
  }

  for (const row of inboundRows) {
    const who =
      String(row.person_name ?? '').trim() ||
      String(row.person_email ?? '').trim() ||
      String(row.person_phone ?? '').trim() ||
      'New inbound person';
    items.push({
      id: `inbound:${String(row.id)}`,
      kind: 'inbound_submission',
      priority: 50,
      title: who,
      detail:
        String(row.message ?? '').trim() ||
        `New ${String(row.kind ?? 'inbound')} submission needs qualification.`,
      href: '/outreach/inbound',
      observedAt: iso(row.received_at, now),
      reference: { type: 'inbound_submission', id: String(row.id) },
      metadata: {
        contactId: String(row.contact_id ?? ''),
        accountId: row.account_id ? String(row.account_id) : null,
        submissionKind: String(row.kind ?? '')
      }
    });
  }

  for (const row of hotRows) {
    const name = String(row.name ?? row.domain ?? 'Account');
    items.push({
      id: `account:${String(row.id)}`,
      kind: 'high_priority_account',
      priority: 70,
      title: `${name} became high priority`,
      detail: `Current GTM score: ${Number(row.score ?? 0)}. Review the evidence before acting.`,
      href: '/research',
      observedAt: iso(row.newest_signal_at ?? row.computed_at, now),
      reference: { type: 'account', id: String(row.id) },
      metadata: { domain: String(row.domain ?? ''), score: Number(row.score ?? 0) }
    });
  }

  return {
    needsAttention: sortAttention(items),
    working: [],
    recentResults: []
  };
}
