import type { Express } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import { listLeadListContacts, listLeadLists, updateContact } from './contact-lists.js';
import { managerQueryParam, managerRoute, managerRouteParam, managerWorkspace } from './manager-http.js';

export function registerManagerListReadRoutes(app: Express, db: Db): void {
  app.get('/api/linkedin/manager/lists', managerRoute(async (req, res) => {
    res.json({ lists: await listLeadLists(db, managerWorkspace(req)) });
  }));

  app.get('/api/linkedin/manager/lists/:listId/contacts', managerRoute(async (req, res) => {
    const limit = Number(managerQueryParam(req, 'limit') ?? 5000);
    res.json({ contacts: await listLeadListContacts(db, managerWorkspace(req), managerRouteParam(req, 'listId'), limit) });
  }));

  app.patch('/api/linkedin/manager/contacts/:contactId', managerRoute(async (req, res) => {
    const body = z.object({
      firstName: z.string().optional(), lastName: z.string().optional(), company: z.string().optional(),
      email: z.string().email().nullish(), phone: z.string().nullish(), country: z.string().nullish(), linkedinUrl: z.string().url().nullish()
    }).parse(req.body);
    const contact = await updateContact(db, managerWorkspace(req), managerRouteParam(req, 'contactId'), body, new Date());
    if (!contact) { res.status(404).json({ error: 'Contact not found' }); return; }
    res.json({ contact });
  }));
}
