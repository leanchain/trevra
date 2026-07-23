import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import express from 'express';
import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { runAllAutomationCycles } from './automation-service.js';
import { closeAuthDatabase, migrateAuthDatabase } from './auth-service.js';
import { validateEnvironment } from './config.js';
import { getSiteConfig, renderAppIndex, renderNotFoundPage } from './public-site.js';

const runtime = validateEnvironment();
const port = runtime.port;
await migrateAuthDatabase();
const db = await openDatabase();
const app = createApp(db);

if (process.env.NODE_ENV === 'production') {
  const clientDir = resolve('dist');
  const indexTemplate = await readFile(resolve(clientDir, 'index.html'), 'utf8');
  const siteConfig = getSiteConfig();
  app.use(express.static(clientDir, {
    index: false,
    maxAge: '1h',
    etag: true,
    setHeaders: (res, path) => {
      if (/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/i.test(path)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (/[\\/](?:icons|og)[\\/]|favicon\.svg$/i.test(path)) {
        res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=2592000');
      }
    }
  }));
  app.get('/', (_req, res) => {
    res.type('html').set({
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Content-Language': 'en',
      Link: `<${siteConfig.origin}/>; rel="canonical"`
    });
    res.send(renderAppIndex(indexTemplate, String(res.locals.cspNonce ?? '')));
  });
  app.get('/index.html', (_req, res) => res.redirect(308, '/'));
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found' });
    res.status(404).type('html').send(renderNotFoundPage(String(res.locals.cspNonce ?? '')));
  });
}

const server = app.listen(port, () => {
  console.log(`Trevra API listening on http://localhost:${port}`);
});

const automationIntervalMs = runtime.automationIntervalMs;
const automationTimer = setInterval(() => {
  void runAllAutomationCycles(db).catch((error) => console.error('Automation cycle failed', error));
}, automationIntervalMs);
automationTimer.unref();
async function shutdown(signal: string) {
  console.log(`${signal} received; shutting down`);
  clearInterval(automationTimer);
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await Promise.all([db.close(), closeAuthDatabase()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
