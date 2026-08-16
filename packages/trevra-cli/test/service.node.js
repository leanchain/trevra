import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  renderLaunchAgent,
  renderSystemdUnit,
  renderWindowsRegistration,
  servicePaths
} from '../lib/service.js';

test('service paths stay under the user home and never use the project checkout', () => {
  const home = mkdtempSync(join(tmpdir(), 'trevra-service-test-'));
  try {
    const linux = servicePaths(home, 'linux');
    assert.equal(linux.definition, join(home, '.config', 'systemd', 'user', 'trevra-linkedin.service'));
    assert.equal(linux.cliPath, join(home, '.trevra', 'service', 'node_modules', 'trevra', 'bin', 'trevra.js'));

    const mac = servicePaths(home, 'darwin');
    assert.equal(mac.definition, join(home, 'Library', 'LaunchAgents', 'com.trevra.linkedin.plist'));

    const windows = servicePaths(home, 'win32');
    assert.equal(windows.manager, 'Task Scheduler');
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
