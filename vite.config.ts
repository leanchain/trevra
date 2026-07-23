import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const webPort = Number(env.TREVRA_WEB_PORT ?? env.VITE_PORT ?? 43173);
  const apiPort = Number(env.TREVRA_API_PORT ?? env.PORT ?? 43887);
  const apiTarget = `http://localhost:${apiPort}`;

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: webPort,
      strictPort: true,
      proxy: {
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
        '/security': apiTarget,
        '/privacy': apiTarget,
        '/terms': apiTarget
      }
    }
  };
});
