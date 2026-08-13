import type { Express } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import { getManagerAnalytics } from './manager-analytics.js';
import { managerQueryParam, managerRoute, managerWorkspace } from './manager-http.js';

function optionalQuery(req: Parameters<typeof managerQueryParam>[0], key: string): string | undefined {
  const value = managerQueryParam(req, key);
  return value && value.trim() ? value.trim() : undefined;
}

export function registerManagerReportingRoutes(app: Express, db: Db): void {
  app.get('/api/linkedin/manager/campaigns', managerRoute(async (req, res) => {
    const workspaceId = managerWorkspace(req);
    const limit = Math.max(1, Math.min(250, Number(managerQueryParam(req, 'limit') ?? 100)));
    const rows = await db.prepare(`
      SELECT c.id,c.name,c.status,c.seat_key,c.workflow_id,c.lead_list_id,
             TO_CHAR(c.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
             TO_CHAR(c.paused_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS paused_at,
             TO_CHAR(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
             COUNT(m.id)::int AS members,
             COUNT(m.id) FILTER (WHERE m.state='replied')::int AS replied,
             COUNT(m.id) FILTER (WHERE m.state='completed')::int AS completed
      FROM linkedin_campaigns c
      LEFT JOIN linkedin_campaign_members m ON m.workspace_id=c.workspace_id AND m.campaign_id=c.id
      WHERE c.workspace_id=? AND c.workflow_id IS NOT NULL
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT ?
    `).all<Record<string, unknown>>(workspaceId, limit);
    res.json({
      campaigns: rows.map((row) => ({
        id: String(row.id), name: String(row.name), status: String(row.status), seatKey: String(row.seat_key),
        workflowId: row.workflow_id == null ? null : String(row.workflow_id),
        listId: row.lead_list_id == null ? null : String(row.lead_list_id),
        startedAt: row.started_at == null ? null : String(row.started_at),
        pausedAt: row.paused_at == null ? null : String(row.paused_at),
        createdAt: String(row.created_at), members: Number(row.members), replied: Number(row.replied), completed: Number(row.completed)
      }))
    });
  }));

  app.get('/api/linkedin/manager/tasks', managerRoute(async (req, res) => {
    const workspaceId = managerWorkspace(req);
    const status = z.enum(['pending', 'completed', 'cancelled']).optional().parse(optionalQuery(req, 'status'));
    const campaignId = optionalQuery(req, 'campaignId');
    const seatKey = optionalQuery(req, 'seatKey');
    const limit = Math.max(1, Math.min(500, Number(managerQueryParam(req, 'limit') ?? 100)));
    const rows = await db.prepare(`
      SELECT t.id,t.campaign_id,t.campaign_member_id,t.workflow_step_id,t.status,t.body,
             TO_CHAR(t.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS due_at,
             TO_CHAR(t.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS completed_at,
             c.first_name,c.last_name,c.company,c.linkedin_url,m.seat_key
      FROM linkedin_manual_tasks t
      JOIN linkedin_campaign_members m ON m.id=t.campaign_member_id AND m.workspace_id=t.workspace_id
      JOIN linkedin_contacts c ON c.id=m.contact_id AND c.workspace_id=t.workspace_id
      WHERE t.workspace_id=?
        AND (?::text IS NULL OR t.status=?)
        AND (?::text IS NULL OR t.campaign_id=?)
        AND (?::text IS NULL OR m.seat_key=?)
      ORDER BY CASE WHEN t.status='pending' THEN 0 ELSE 1 END, t.due_at ASC NULLS LAST, t.created_at DESC
      LIMIT ?
    `).all<Record<string, unknown>>(
      workspaceId, status ?? null, status ?? null, campaignId ?? null, campaignId ?? null,
      seatKey ?? null, seatKey ?? null, limit
    );
    res.json({
      tasks: rows.map((row) => ({
        id: String(row.id), campaignId: String(row.campaign_id), memberId: String(row.campaign_member_id),
        workflowStepId: String(row.workflow_step_id), status: String(row.status), body: row.body == null ? null : String(row.body),
        dueAt: row.due_at == null ? null : String(row.due_at), completedAt: row.completed_at == null ? null : String(row.completed_at),
        seatKey: String(row.seat_key), firstName: row.first_name == null ? null : String(row.first_name),
        lastName: row.last_name == null ? null : String(row.last_name), company: row.company == null ? null : String(row.company),
        linkedinUrl: row.linkedin_url == null ? null : String(row.linkedin_url)
      }))
    });
  }));

  app.get('/api/linkedin/manager/analytics', managerRoute(async (req, res) => {
    const daysRaw = managerQueryParam(req, 'days');
    const days = daysRaw == null ? undefined : z.coerce.number().int().min(1).max(365).parse(daysRaw);
    res.json(await getManagerAnalytics(db, managerWorkspace(req), {
      ...(optionalQuery(req, 'seatKey') ? { seatKey: optionalQuery(req, 'seatKey') } : {}),
      ...(optionalQuery(req, 'campaignId') ? { campaignId: optionalQuery(req, 'campaignId') } : {}),
      ...(days === undefined ? {} : { days })
    }));
  }));
}
