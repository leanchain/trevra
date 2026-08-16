import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import express from 'express';
import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { backfillWorkspaceOrganizations, closeAuthDatabase, migrateAuthDatabase } from './auth-service.js';
import { validateEnvironment } from './config.js';
import { assertHostedDataReady } from './hosted-readiness.js';
import { getSiteConfig, renderAppIndex, renderNotFoundPage } from './public-site.js';

const runtime = validateEnvironment();
const port = runtime.port;
const hosted = process.env.TREVRA_DEPLOYMENT_MODE === 'hosted';
// Hosted schema/data changes belong to migrate-job.ts. Local keeps the
// convenient single-node boot migration behavior.
if (!hosted) await migrateAuthDatabase();
const db = await openDatabase();
if (hosted) {
  await assertHostedDataReady(db);
} else {
  // Hosted runs this in the release migration job to avoid replica boot races.
  await backfillWorkspaceOrganizations(db);
}
const app = createApp(db);

if (process.env.NODE_ENV === 'production') {
  const clientDir = resolve('dist');
  const indexTemplate = await readFile(resolve(clientDir, 'index.html'), 'utf8');
  const siteConfig = getSiteConfig();
  // Registered before express.static, because the static mount now serves
  // directory index.html files and would otherwise hand out dist/index.html
  // raw -- without the JSON-LD, verification tags and hosted-CTA rewrite.
  app.get('/', (_req, res) => {
    res.type('html').set({
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Content-Language': 'en',
      Link: `<${siteConfig.origin}/>; rel="canonical"`
    });
    res.send(renderAppIndex(indexTemplate, String(res.locals.cspNonce ?? '')));
  });
  app.get('/index.html', (_req, res) => res.redirect(308, '/'));

  /**
   * THE APP'S OWN PATHS ANSWER WITH THE APP.
   *
   * The shell routes on `location.pathname` (src/client/ui/route.ts), so
   * `/outreach/inbox` is a real URL that a reload, a bookmark, a pasted link
   * and a crawler all request from this server directly. Without this it fell
   * through the static mount to the 404 page, and the only way to reach a
   * screen would have been to land on `/` and click.
   *
   * AN ALLOW-LIST, NOT A CATCH-ALL, and the difference is the whole design.
   * `app.get('*')` would serve the SPA for `/pricing`, `/blog/post`, and every
   * typo -- a soft 404 that returns 200, which is the one thing a 404 page
   * must never do. Only the segments the shell actually claims are answered
   * here; `/privacy`, `/terms`, `/security` keep their shipped documents
   * below, and anything else still 404s honestly.
   *
   * THE LIST IS DUPLICATED FROM `isAppPath`, deliberately and with this note:
   * this file cannot import client code (it is not in the server's tsconfig
   * graph and would drag React in), so the two copies are kept adjacent in
   * meaning by naming each other. A path one side claims and the other does
   * not is a broken reload, so they change together.
   */
  const APP_PATH_HEADS = new Set([
    'loop', 'outreach', 'money', 'ledger', 'setup', // SECTIONS in ui/route.ts
    'leads', 'login'                                // SHELL_PATHS in ui/route.ts
  ]);
  app.get(/^\/[^.]*$/, (req, res, next) => {
    const head = req.path.replace(/^\//, '').split('/')[0] ?? '';
    if (!APP_PATH_HEADS.has(head)) return next();
    res.type('html').set({
      // Never cached: these URLs are the app, and a stale index names asset
      // hashes that no longer exist.
      'Cache-Control': 'no-store',
      'Content-Language': 'en',
      // NOINDEX, because these are screens behind a sign-in. A crawler that
      // reaches one gets the shell and no content, and a shell indexed under
      // seven URLs is seven near-duplicate empty pages.
      'X-Robots-Tag': 'noindex, nofollow'
    });
    res.send(renderAppIndex(indexTemplate, String(res.locals.cspNonce ?? '')));
  });

  /**
   * Serve `dist/<page>/index.html` at `/<page>`, not at `/<page>/`.
   *
   * The shipped documents -- /privacy, /terms, /security -- set their canonical
   * URL without a trailing slash, and that is the URL the sitemap, the footer
   * and RFC 9116 `Policy:` all point at. serve-static on its own answers the
   * extensionless form with a 301 to the slash form, so the canonical URL would
   * never return the document itself. Rewriting first means it does.
   *
   * Anything with no matching file falls through the static mount untouched and
   * lands on the 404 below, exactly as it did before.
   */
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
      if (/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/i.test(path)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (/[\\/](?:icons|og)[\\/]|favicon\.svg$/i.test(path)) {
        res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=2592000');
      }
    }
  }));
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found' });
    res.status(404).type('html').send(renderNotFoundPage(String(res.locals.cspNonce ?? '')));
  });
}

const server = app.listen(port, () => {
  console.log(`Trevra API listening on http://localhost:${port}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received; shutting down`);
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await Promise.all([db.close(), closeAuthDatabase()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
