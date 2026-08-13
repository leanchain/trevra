import type { Express } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import { listSeats, upsertSeat } from './seats.js';
import { managerRoute, managerRouteParam, managerWorkspace } from './manager-http.js';

export function registerManagerAccountRoutes(app: Express, db: Db): void {
  app.get('/api/linkedin/manager/accounts', managerRoute(async (req, res) => {
    res.json({ accounts: await listSeats(db, managerWorkspace(req)) });
  }));

  app.post('/api/linkedin/manager/accounts', managerRoute(async (req, res) => {
    const body = z.object({
      seatKey: z.string().min(1).max(64),
      label: z.string().min(1).max(120),
      timezone: z.string().min(1),
      profileUrl: z.string().url().nullish()
    }).parse(req.body);
    const account = await upsertSeat(db, managerWorkspace(req), {
      label: body.label,
      timezone: body.timezone,
      profileUrl: body.profileUrl ?? null
    }, new Date(), body.seatKey);
    res.status(201).json({ account });
  }));

  app.patch('/api/linkedin/manager/accounts/:seatKey', managerRoute(async (req, res) => {
    const body = z.object({
      label: z.string().min(1).max(120).optional(),
      timezone: z.string().min(1).optional(),
      workingDays: z.array(z.number().int().min(0).max(6)).min(1).optional(),
      workingStart: z.string().optional(),
      workingEnd: z.string().optional(),
      operatorLimits: z.object({
        invite: z.number().int().optional(),
        message: z.number().int().optional(),
        profile_view: z.number().int().optional(),
        follow: z.number().int().optional()
      }).optional()
    }).parse(req.body);
    const account = await upsertSeat(db, managerWorkspace(req), body, new Date(), managerRouteParam(req, 'seatKey'));
    res.json({ account });
  }));
}
