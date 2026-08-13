import type { Express } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import { managerRoute, managerRouteParam, managerWorkspace } from './manager-http.js';
import { createManagedCampaign, listCampaignMembers, setCampaignMemberState, setManagedCampaignState } from './managed-campaigns.js';

export function registerManagerCampaignRoutes(app: Express, db: Db): void {
  app.post('/api/linkedin/manager/campaigns', managerRoute(async (req, res) => {
    const body = z.object({
      name: z.string().min(1).max(160),
      seatKey: z.string().min(1).max(64),
      listId: z.string().min(1),
      workflowId: z.string().min(1),
      start: z.boolean().optional()
    }).parse(req.body);
    res.status(201).json(await createManagedCampaign(db, { workspaceId: managerWorkspace(req), ...body }, new Date()));
  }));

  app.post('/api/linkedin/manager/campaigns/:campaignId/state', managerRoute(async (req, res) => {
    const body = z.object({ state: z.enum(['running', 'paused', 'stopped']) }).parse(req.body);
    const changed = await setManagedCampaignState(db, managerWorkspace(req), managerRouteParam(req, 'campaignId'), body.state, new Date());
    if (!changed) { res.status(404).json({ error: 'Campaign not found or state transition not allowed' }); return; }
    res.json({ ok: true, state: body.state });
  }));

  app.get('/api/linkedin/manager/campaigns/:campaignId/members', managerRoute(async (req, res) => {
    res.json({ members: await listCampaignMembers(db, managerWorkspace(req), managerRouteParam(req, 'campaignId')) });
  }));

  app.post('/api/linkedin/manager/members/:memberId/state', managerRoute(async (req, res) => {
    const body = z.object({ action: z.enum(['pause', 'resume', 'remove']) }).parse(req.body);
    const changed = await setCampaignMemberState(db, managerWorkspace(req), managerRouteParam(req, 'memberId'), body.action, new Date());
    if (!changed) { res.status(404).json({ error: 'Campaign member not found' }); return; }
    res.json({ ok: true });
  }));
}
