import type { Express } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import { managerRoute, managerRouteParam, managerWorkspace } from './manager-http.js';
import { createWorkflow, listWorkflows, updateWorkflow } from './workflow-store.js';

export function registerManagerWorkflowRoutes(app: Express, db: Db): void {
  app.get('/api/linkedin/manager/workflows', managerRoute(async (req, res) => {
    res.json({ workflows: await listWorkflows(db, managerWorkspace(req)) });
  }));
  app.post('/api/linkedin/manager/workflows', managerRoute(async (req, res) => {
    const body = z.object({ name: z.string().min(1).max(160), definition: z.unknown() }).parse(req.body);
    const workflow = await createWorkflow(db, managerWorkspace(req), body.name, body.definition, new Date());
    res.status(201).json({ workflow });
  }));
  app.patch('/api/linkedin/manager/workflows/:workflowId', managerRoute(async (req, res) => {
    const body = z.object({
      name: z.string().min(1).max(160).optional(),
      definition: z.unknown().optional(),
      status: z.enum(['active', 'archived']).optional()
    }).parse(req.body);
    const workflow = await updateWorkflow(db, managerWorkspace(req), managerRouteParam(req, 'workflowId'), body, new Date());
    if (!workflow) { res.status(404).json({ error: 'Workflow not found' }); return; }
    res.json({ workflow });
  }));
}
