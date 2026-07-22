import { resolve } from 'node:path';
import express from 'express';
import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { runAllAutomationCycles } from './automation-service.js';
import { closeAuthDatabase, migrateAuthDatabase } from './auth-service.js';
import { validateEnvironment } from './config.js';

const runtime = validateEnvironment();
const port = runtime.port;
await migrateAuthDatabase();
const db = openDatabase();
const app = createApp(db);

if (process.env.NODE_ENV === 'production') {
  const clientDir = resolve('dist');
  app.use(express.static(clientDir, { maxAge: '1h', etag: true }));
  app.get('/{*splat}', (_req, res) => res.sendFile(resolve(clientDir, 'index.html')));
}

const server = app.listen(port, () => {
  console.log(`Trevra API listening on http://localhost:${port}`);
});

const automationIntervalMs = runtime.automationIntervalMs;
const automationTimer = setInterval(() => {
  void runAllAutomationCycles(db).catch((error) => console.error('Automation cycle failed', error));
}, automationIntervalMs);
automationTimer.unref();

function shutdown(signal: string) {
  console.log(`${signal} received; shutting down`);
  clearInterval(automationTimer);
  server.close(() => {
    db.close();
    closeAuthDatabase();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
