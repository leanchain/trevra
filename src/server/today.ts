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

  const [seatRows, replyRows, unknownRows, approvalRows, demandRows, inboundRows, hotRows] =
    await Promise.all([
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
          `SELECT r.id,r.type,r.person_id,r.account_id,r.title,r.summary,r.recommended_action,r.updated_at,
                p.name AS person_name,p.email AS person_email,a.name AS account_name,
                EXISTS (
                  SELECT 1 FROM recommendation_evidence re
                  WHERE re.recommendation_id=r.id AND re.source_type='inbound_submission'
                ) AS has_inbound,
                (
                  SELECT re.source_id FROM recommendation_evidence re
                  WHERE re.recommendation_id=r.id AND re.source_type='discovery_plan'
                  ORDER BY re.created_at,re.id LIMIT 1
                ) AS discovery_source_id,
                (
                  SELECT re.external_url FROM recommendation_evidence re
                  WHERE re.recommendation_id=r.id AND re.source_type='discovery_plan'
                  ORDER BY re.created_at,re.id LIMIT 1
                ) AS discovery_url
         FROM recommendations r
         LEFT JOIN contacts p ON p.workspace_id=r.workspace_id AND p.id=r.person_id
         LEFT JOIN accounts a ON a.workspace_id=r.workspace_id AND a.id=r.account_id
         WHERE r.workspace_id=? AND r.type IN ('qualified_demand','person_discovery')
           AND r.status NOT IN ('dismissed','completed')
           AND (r.snoozed_until IS NULL OR r.snoozed_until<=CURRENT_TIMESTAMP)
           AND r.updated_at>=?::timestamptz
         ORDER BY r.updated_at ASC,r.id ASC LIMIT 50`
        )
        .all<Record<string, unknown>>(workspaceId, recentSince),
      db
        .prepare(
          `SELECT i.id,i.contact_id,i.account_id,i.kind,i.person_name,i.person_email,i.person_phone,i.message,i.received_at
         FROM inbound_submissions i
         WHERE i.workspace_id=? AND i.received_at>=?::timestamptz
           AND NOT EXISTS (
             SELECT 1
             FROM recommendation_evidence re
             JOIN recommendations r ON r.id=re.recommendation_id
             WHERE r.workspace_id=i.workspace_id
               AND r.type IN ('qualified_demand','person_discovery')
               AND r.status NOT IN ('dismissed','completed')
               AND r.updated_at>=?::timestamptz
               AND re.source_type='inbound_submission'
               AND re.source_id=i.id
           )
         ORDER BY i.received_at ASC,i.id ASC LIMIT 50`
        )
        .all<Record<string, unknown>>(workspaceId, recentSince, recentSince),
      db
        .prepare(
          `SELECT a.id,a.name,a.domain,s.score,s.newest_signal_at,s.computed_at
         FROM account_scores s
         JOIN accounts a ON a.id=s.account_id AND a.workspace_id=s.workspace_id
         WHERE s.workspace_id=? AND s.tier='hot'
           AND COALESCE(s.newest_signal_at,s.computed_at)>=?::timestamptz
           AND NOT EXISTS (
             SELECT 1 FROM recommendations r
             WHERE r.workspace_id=s.workspace_id
               AND r.account_id=s.account_id
               AND r.type IN ('qualified_demand','person_discovery')
               AND r.status NOT IN ('dismissed','completed')
               AND r.updated_at>=?::timestamptz
           )
         ORDER BY COALESCE(s.newest_signal_at,s.computed_at) ASC,a.id ASC LIMIT 50`
        )
        .all<Record<string, unknown>>(workspaceId, recentSince, recentSince)
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
      href: '/setup/workspace',
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

  for (const row of demandRows) {
    const personName =
      row.person_name || row.person_email ? String(row.person_name ?? row.person_email) : null;
    const accountName = String(row.account_name ?? 'Account');
    const recommendationType = String(row.type ?? 'qualified_demand');
    const discoverySourceId = row.discovery_source_id ? String(row.discovery_source_id) : '';
    const discoveryKind = discoverySourceId.includes(':') ? discoverySourceId.split(':', 1)[0] : '';
    const discoveryUrl = row.discovery_url ? String(row.discovery_url) : '';
    const discoveryHref =
      recommendationType === 'person_discovery' &&
      discoveryUrl &&
      ['company_employees', 'search'].includes(discoveryKind)
        ? `/outreach?focus=leads&kind=${encodeURIComponent(discoveryKind)}&url=${encodeURIComponent(discoveryUrl)}`
        : '/outreach';
    items.push({
      id: `demand:${String(row.id)}`,
      kind: 'qualification_decision',
      priority: 45,
      title: String(
        row.title ??
          (personName
            ? `Talk to ${personName} at ${accountName}`
            : `Find the right person at ${accountName}`)
      ),
      detail: String(row.summary ?? 'Several independent commercial signals line up now.'),
      href:
        recommendationType === 'person_discovery'
          ? discoveryHref
          : String(row.recommended_action ?? '') === 'reply'
            ? '/outreach/inbox'
            : Boolean(row.has_inbound)
              ? '/outreach/inbound'
              : '/outreach',
      observedAt: iso(row.updated_at, now),
      reference: { type: 'recommendation', id: String(row.id) },
      metadata: {
        personId: row.person_id ? String(row.person_id) : null,
        accountId: row.account_id ? String(row.account_id) : null,
        recommendationType,
        demandOrigin:
          recommendationType === 'person_discovery'
            ? 'person_discovery'
            : Boolean(row.has_inbound)
              ? 'first_party'
              : 'known_contact',
        recommendedAction: String(row.recommended_action ?? ''),
        discoveryKind: discoveryKind || null,
        discoveryUrl: discoveryUrl || null
      }
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
