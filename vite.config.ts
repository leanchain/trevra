import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Serve `public/<page>/index.html` at `/<page>` in dev, the way the production
 * server does (src/server/index.ts).
 *
 * /privacy and /terms are shipped documents rather than Express routes, and
 * their canonical URL has no trailing slash. Without this the dev server hands
 * the SPA fallback to `/privacy` and a developer reviews the wrong page.
 * Gated on the file actually existing, so /@vite/client, /src/... and every
 * other extensionless internal URL is left alone, and skipped for anything the
 * dev proxy already owns -- these middlewares run ahead of the proxy, and a
 * rewritten URL still matches its prefix.
 */
function staticDocuments(proxied: string[]): Plugin {
  return {
    name: 'trevra-static-documents',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = req.url?.split('?')[0] ?? '';
        const owned = proxied.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
        if (!owned && /^\/[a-z0-9-]+$/i.test(path) && existsSync(resolve('public', path.slice(1), 'index.html'))) {
          req.url = `${path}/index.html${req.url!.slice(path.length)}`;
        }
        next();
      });
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const webPort = Number(env.TREVRA_WEB_PORT ?? env.VITE_PORT ?? 43173);
  const apiPort = Number(env.TREVRA_API_PORT ?? env.PORT ?? 43887);
  const apiTarget = `http://localhost:${apiPort}`;
  const proxy = {
    '/api': apiTarget,
    '/robots.txt': apiTarget,
    '/sitemap.xml': apiTarget,
    '/llms.txt': apiTarget,
    '/llms-full.txt': apiTarget,
    '/agents.md': apiTarget,
    '/humans.txt': apiTarget,
    '/security.txt': apiTarget,
    '/.well-known': apiTarget,
    '/how-it-works': apiTarget,
    '/security': apiTarget
  };

  return {
    plugins: [react(), staticDocuments(Object.keys(proxy))],
    server: {
      host: '0.0.0.0',
      allowedHosts: ['.trycloudflare.com'],
      port: webPort,
      strictPort: true,
      // Editors and codegen replace files rather than rewriting them in place,
      // which changes the inode. Across a Docker bind mount chokidar's inotify
      // watch follows the OLD inode, so the change is never delivered and Vite
      // keeps serving a stale transform at HTTP 200 -- the file on disk is new,
      // the browser is not, and nothing in the log says so. Polling watches the
      // path instead of the inode. Only inside a container, where the cost is
      // paid for a reason; a host-run `npm run dev` keeps native inotify.
      ...(existsSync('/.dockerenv') ? { watch: { usePolling: true, interval: 300 } } : {}),
      proxy
    }
  };
});
