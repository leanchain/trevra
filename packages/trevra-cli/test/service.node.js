import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { isNewerVersion, officialCompanionPackage, parseVersion } from '../lib/update.js';
import { chromeLaunchArgs } from '../lib/browser.js';
import {
  installStablePackage,
  installUserCommand,
  renderLaunchAgent,
  renderSystemdUnit,
  renderWindowsRegistration,
  servicePaths
} from '../lib/service.js';

test('background browser launch is headless while manual mode stays visible', () => {
  const background = chromeLaunchArgs({ profileDir: '/tmp/trevra-profile', headless: true, startUrl: 'https://www.linkedin.com/feed/' });
  assert.ok(background.includes('--headless'));
  assert.ok(background.includes('--window-size=1365,900'));
  assert.ok(background.includes('--user-data-dir=/tmp/trevra-profile'));
  assert.ok(!background.includes('--start-maximized'));

  const visible = chromeLaunchArgs({ profileDir: '/tmp/trevra-profile', headless: false, startUrl: 'https://www.linkedin.com/feed/' });
  assert.ok(!visible.includes('--headless'));
  assert.ok(visible.includes('--start-maximized'));
});

test('service paths stay under the user home and never use the project checkout', () => {
  const home = mkdtempSync(join(tmpdir(), 'trevra-service-test-'));
  try {
    const linux = servicePaths(home, 'linux');
    assert.equal(linux.definition, join(home, '.config', 'systemd', 'user', 'trevra-linkedin.service'));
    assert.equal(linux.cliPath, join(home, '.trevra', 'service', 'node_modules', 'trevra', 'bin', 'trevra.js'));
    assert.equal(linux.userCommand, join(home, '.local', 'bin', 'trevra'));

    const mac = servicePaths(home, 'darwin');
    assert.equal(mac.definition, join(home, 'Library', 'LaunchAgents', 'com.trevra.linkedin.plist'));

    const windows = servicePaths(home, 'win32');
    assert.equal(windows.manager, 'Task Scheduler');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('auto-update accepts only newer plain semver releases from the official package path', () => {
  assert.deepEqual(parseVersion('0.2.0'), [0, 2, 0]);
  assert.equal(parseVersion('v0.2.0'), null);
  assert.equal(isNewerVersion('0.2.0', '0.2.1'), true);
  assert.equal(isNewerVersion('0.2.0', '0.3.0'), true);
  assert.equal(isNewerVersion('0.2.0', '0.2.0'), false);
  assert.equal(isNewerVersion('0.2.0', '0.1.9'), false);
  assert.equal(isNewerVersion('0.2.0', 'latest'), false);
  assert.equal(
    officialCompanionPackage('1.4.2'),
    'https://github.com/leanchain/trevra/releases/download/companion-v1.4.2/trevra-1.4.2.tgz'
  );
  assert.throws(() => officialCompanionPackage('../../evil'));
});

test('background companion auto-updates before accepting relay work', async () => {
  const home = mkdtempSync(join(tmpdir(), 'trevra-auto-update-test-'));
  const updatePackage = mkdtempSync(join(tmpdir(), 'trevra-update-package-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  try {
    mkdirSync(join(updatePackage, 'bin'), { recursive: true });
    writeFileSync(join(updatePackage, 'package.json'), JSON.stringify({
      name: 'trevra', version: '0.2.3', type: 'module', bin: { trevra: 'bin/trevra.js' }, files: ['bin']
    }));
    writeFileSync(join(updatePackage, 'bin', 'trevra.js'), '#!/usr/bin/env node\nconsole.log("0.2.3")\n');

    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'hello', companionVersion: '0.2.3' }));
    });

    mkdirSync(join(home, '.trevra'), { recursive: true });
    writeFileSync(join(home, '.trevra', 'companion.json'), JSON.stringify({
      url: `http://127.0.0.1:${address.port}`,
      token: 'trv_cmp_test_token_for_update',
      workspaceId: 'ws_update_test',
      deviceId: 'dev_update_test',
      label: 'Update test'
    }));

    const cli = fileURLToPath(new URL('../bin/trevra.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'linkedin', 'run'], {
      env: { ...process.env, HOME: home, TREVRA_COMPANION_UPDATE_SPEC: updatePackage },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const exit = await Promise.race([
      new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('auto-update child did not exit')), 15_000);
        timer.unref();
      })
    ]);
    assert.deepEqual(exit, { code: 75, signal: null });

    const installed = JSON.parse(readFileSync(join(home, '.trevra', 'service', 'node_modules', 'trevra', 'package.json'), 'utf8'));
    assert.equal(installed.version, '0.2.3');
    const log = readFileSync(join(home, '.trevra', 'logs', 'linkedin-companion.log'), 'utf8');
    assert.match(log, /update_available from=0\.2\.2 to=0\.2\.3/);
    assert.match(log, /update_installed version=0\.2\.3/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(updatePackage, { recursive: true, force: true });
  }
});

test('failed update leaves the currently installed companion untouched', () => {
  const home = mkdtempSync(join(tmpdir(), 'trevra-update-failure-test-'));
  const brokenPackage = mkdtempSync(join(tmpdir(), 'trevra-broken-package-'));
  try {
    const paths = servicePaths(home, 'linux');
    mkdirSync(join(paths.serviceRoot, 'node_modules', 'trevra', 'bin'), { recursive: true });
    writeFileSync(paths.cliPath, '#!/usr/bin/env node\nconsole.log("working")\n');
    writeFileSync(join(brokenPackage, 'package.json'), JSON.stringify({ name: 'trevra', version: '9.9.9' }));
    assert.throws(() => installStablePackage({
      version: '9.9.9',
      installSpec: brokenPackage,
      home,
      platform: 'linux'
    }), /service executable is missing/);
    assert.match(readFileSync(paths.cliPath, 'utf8'), /working/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(brokenPackage, { recursive: true, force: true });
  }
});

test('installed service exposes a stable user command without depending on npx', () => {
  const home = mkdtempSync(join(tmpdir(), 'trevra-command-test-'));
  try {
    const paths = servicePaths(home, 'linux');
    mkdirSync(join(paths.serviceRoot, 'node_modules', 'trevra', 'bin'), { recursive: true });
    writeFileSync(paths.cliPath, '#!/usr/bin/env node\n');
    const command = installUserCommand({ home, platform: 'linux' });
    assert.equal(command, join(home, '.local', 'bin', 'trevra'));
    assert.equal(readlinkSync(command), paths.cliPath);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('systemd service starts the stable CLI, restarts crashes, and contains no credential material', () => {
  const unit = renderSystemdUnit({
    nodePath: '/usr/bin/node',
    cliPath: '/home/alice/.trevra/service/node_modules/trevra/bin/trevra.js'
  });
  assert.match(unit, /linkedin run/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.doesNotMatch(unit, /trv_cmp_|--pair|_authToken|password/i);
});

test('LaunchAgent restarts only unsuccessful exits and runs at login', () => {
  const plist = renderLaunchAgent({
    nodePath: '/usr/local/bin/node',
    cliPath: '/Users/alice/.trevra/service/node_modules/trevra/bin/trevra.js',
    stdoutPath: '/Users/alice/.trevra/logs/linkedin.log',
    stderrPath: '/Users/alice/.trevra/logs/linkedin-error.log'
  });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(plist, /<string>linkedin<\/string>/);
  assert.match(plist, /<string>run<\/string>/);
  assert.doesNotMatch(plist, /trv_cmp_|--pair|password/i);
});

test('logs command is available without pairing and never needs the service manager', () => {
  const home = mkdtempSync(join(tmpdir(), 'trevra-logs-test-'));
  try {
    mkdirSync(join(home, '.trevra'), { recursive: true });
    const cli = fileURLToPath(new URL('../bin/trevra.js', import.meta.url));
    const output = execFileSync(process.execPath, [cli, 'linkedin', 'logs', '--lines', '20'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home }
    });
    assert.match(output, /No companion activity has been logged yet/);

    const help = execFileSync(process.execPath, [cli, 'linkedin', '--help'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.match(help, /linkedin logs \[--follow\]/);
    assert.match(help, /linkedin reconnect/);
    assert.match(help, /--seat KEY/);
    assert.match(help, /--lines N/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Windows task uses interactive logon and restart-on-failure settings', () => {
  const script = renderWindowsRegistration({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliPath: 'C:\\Users\\Alice\\.trevra\\service\\node_modules\\trevra\\bin\\trevra.js',
    username: 'Alice'
  });
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(script, /-LogonType Interactive/);
  assert.match(script, /-RestartCount 999/);
  assert.match(script, /linkedin run/);
  assert.doesNotMatch(script, /trv_cmp_|--pair|password/i);
});
