import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { closeAuthDatabase, migrateAuthDatabase } from './auth-service.js';
import { validateEnvironment } from './config.js';
import { registerManagerAccountRoutes } from './linkedin/manager-account-routes.js';
import { requireManagerSession } from './linkedin/manager-auth.js';
import { registerManagerCampaignRoutes } from './linkedin/manager-campaign-routes.js';
import { registerManagerListReadRoutes } from './linkedin/manager-list-read-routes.js';
import { registerManagerReportingRoutes } from './linkedin/manager-reporting-routes.js';
import { registerManagerWorkflowRoutes } from './linkedin/manager-workflow-routes.js';
import { getSiteConfig, renderAppIndex, renderNotFoundPage } from './public-site.js';

const runtime = validateEnvironment();
const port = runtime.port;
await migrateAuthDatabase();
const db = await openDatabase();
const core = createApp(db);
const app = express();
app.disable('x-powered-by');

function managerOriginGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
  const origin = req.header('origin');
  if (!origin) { next(); return; }
  const allowed = new Set([
    ...(process.env.APP_ORIGIN ?? 'http://localhost:43173').split(',').map((item) => item.trim()),
    'http://localhost:43173',
    'http://localhost:43887'
  ]);
  if (!allowed.has(origin)) { res.status(403).json({ error: 'Origin not allowed' }); return; }
  next();
}

app.use('/api/linkedin/manager',
  helmet({ contentSecurityPolicy: false }),
  cookieParser(),
  express.json({ limit: '10mb' }),
  managerOriginGuard,
  rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }),
  requireManagerSession(db),
  (_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Cache-Control', 'no-store');
    next();
  }
);
registerManagerAccountRoutes(app, db);
registerManagerListReadRoutes(app, db);
registerManagerWorkflowRoutes(app, db);
registerManagerCampaignRoutes(app, db);
registerManagerReportingRoutes(app, db);
app.use(core);

if (process.env.NODE_ENV === 'production') {
  const clientDir = resolve('dist');
  const indexTemplate = await readFile(resolve(clientDir, 'index.html'), 'utf8');
  const siteConfig = getSiteConfig();
  app.get('/', (_req, res) => {
    res.type('html').set({
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Content-Language': 'en',
      Link: `<${siteConfig.origin}/>; rel="canonical"`
    });
    res.send(renderAppIndex(indexTemplate, String(res.locals.cspNonce ?? '')));
  });
  app.get('/index.html', (_req, res) => res.redirect(308, '/'));
  app.use((req, _res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && req.path !== '/' && !req.path.endsWith('/') && !extname(req.path)) {
      req.url = `${req.path}/index.html${req.url.slice(req.path.length)}`;
    }
    next();
  });
  app.use(express.static(clientDir, {
    index: 'index.html',
    maxAge: '1h',
    etag: true,
    setHeaders: (res, path) => {
      if (/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/i.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else if (/[\\/](?:icons|og)[\\/]|favicon\.svg$/i.test(path)) res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=2592000');
    }
  }));
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found' });
    res.status(404).type('html').send(renderNotFoundPage(String(res.locals.cspNonce ?? '')));
  });
}

const server = app.listen(port, () => console.log(`Trevra API listening on http://localhost:${port}`));
async function shutdown(signal: string) {
  console.log(`${signal} received; shutting down`);
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await Promise.all([db.close(), closeAuthDatabase()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
