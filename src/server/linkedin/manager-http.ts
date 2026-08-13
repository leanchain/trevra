import type { Request, Response } from 'express';
import { z } from 'zod';

export interface ManagerRequest extends Request { auth?: { workspaceId: string; userId?: string } }

export function managerWorkspace(req: ManagerRequest): string {
  if (!req.auth?.workspaceId) throw new Error('Session expired');
  return req.auth.workspaceId;
}

export function managerRouteParam(req: ManagerRequest, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
}

export function managerQueryParam(req: ManagerRequest, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

export function managerRoute(handler: (req: ManagerRequest, res: Response) => Promise<void>) {
  return (req: ManagerRequest, res: Response) => {
    void handler(req, res).catch((error) => {
      const message = error instanceof Error ? error.message : 'Request failed';
      if (error instanceof z.ZodError) { res.status(400).json({ error: 'Invalid request', issues: error.issues }); return; }
      if (message.includes('duplicate key') || message.includes('unique constraint')) { res.status(409).json({ error: message }); return; }
      if (message.includes('required') || message.includes('must') || message.includes('does not exist') || message.includes('needs')) { res.status(400).json({ error: message }); return; }
      console.error('LinkedIn manager request failed', error);
      res.status(500).json({ error: 'LinkedIn manager request failed.' });
    });
  };
}
