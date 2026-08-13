import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Db } from '../db.js';
import { resolveBetterAuthIdentity } from '../auth-service.js';

const SESSION_COOKIE = 'trevra_session';
type ManagerRequest = Request & { auth?: { userId: string; workspaceId: string; email: string } };
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

async function resolveSession(db: Db, req: Request) {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (token) {
    const row = await db.prepare(`
      SELECT s.user_id, u.workspace_id, u.email
      FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>?
    `).get<{ user_id: string; workspace_id: string; email: string }>(hash(token), new Date().toISOString());
    if (row) return { userId: row.user_id, workspaceId: row.workspace_id, email: row.email };
  }
  return resolveBetterAuthIdentity(db, req.headers);
}

export function requireManagerSession(db: Db) {
  return async (req: ManagerRequest, res: Response, next: NextFunction) => {
    try {
      const identity = await resolveSession(db, req);
      if (!identity) { res.status(401).json({ error: 'Session expired' }); return; }
      req.auth = identity;
      next();
    } catch (error) { next(error); }
  };
}
