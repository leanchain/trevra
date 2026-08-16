import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform as currentPlatform, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

export const SERVICE_ID = 'trevra-linkedin';
export const WINDOWS_TASK_NAME = 'Trevra LinkedIn Companion';

function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* Windows ACLs do not use POSIX modes. */ }
}

function writePrivate(path, body, mode = 0o600) {
  privateDir(dirname(path));
  writeFileSync(path, body, { mode });
  try { chmodSync(path, mode); } catch { /* Windows */ }
}

function commandPath(name, platform = currentPlatform()) {
  const finder = platform === 'win32' ? 'where' : 'which';
  try {
    return execFileSync(finder, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

function npmCommand(platform = currentPlatform()) {
  // Prefer npm's JavaScript entrypoint so Windows never has to exec a `.cmd`
  // file directly (Node's execFile does not use a shell). `npm_execpath` is
  // present for npx/npm-launched installs; the sibling path covers the normal
  // official Node.js Windows installation when this CLI was invoked directly.
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { file: process.execPath, prefixArgs: [candidate] };
  }

  const npm = commandPath('npm', platform);
  if (!npm) throw new Error('npm was not found. Install Node.js 20 or newer, then run this command again.');
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(npm)) {
    throw new Error('npm was found only as a Windows command shim, but npm-cli.js could not be located. Reinstall Node.js 20 or newer, then run this command again.');
  }
  return { file: npm, prefixArgs: [] };
}

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...options
  });
}

function tryRun(file, args, options = {}) {
  try {
    return { ok: true, output: String(run(file, args, { ...options, capture: true }) ?? '').trim() };
  } catch (error) {
    return {
      ok: false,
      output: String(error?.stdout ?? '').trim(),
      error: String(error?.stderr ?? error?.message ?? '').trim()
    };
  }
}

function systemdQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function xml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function servicePaths(home = homedir(), platform = currentPlatform()) {
  const serviceRoot = join(home, '.trevra', 'service');
  const cliPath = join(serviceRoot, 'node_modules', 'trevra', 'bin', 'trevra.js');
  const logs = join(home, '.trevra', 'logs');
  if (platform === 'darwin') {
    return {
      serviceRoot,
      cliPath,
      logs,
      definition: join(home, 'Library', 'LaunchAgents', 'com.trevra.linkedin.plist'),
      manager: 'launchd'
    };
  }
  if (platform === 'win32') {
    return {
      serviceRoot,
      cliPath,
      logs,
      definition: join(serviceRoot, 'trevra-linkedin-task.ps1'),
      manager: 'Task Scheduler'
    };
  }
  return {
    serviceRoot,
    cliPath,
    logs,
    definition: join(home, '.config', 'systemd', 'user', `${SERVICE_ID}.service`),
    manager: 'systemd --user'
  };
}

export function renderSystemdUnit({ nodePath, cliPath }) {
  return `[Unit]\nDescription=Trevra LinkedIn Companion\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${systemdQuote(nodePath)} ${systemdQuote(cliPath)} linkedin run\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=15\n\n[Install]\nWantedBy=default.target\n`;
}

export function renderLaunchAgent({ nodePath, cliPath, stdoutPath, stderrPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>com.trevra.linkedin</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${xml(nodePath)}</string>\n    <string>${xml(cliPath)}</string>\n    <string>linkedin</string>\n    <string>run</string>\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key>\n  <dict><key>SuccessfulExit</key><false/></dict>\n  <key>ProcessType</key><string>Interactive</string>\n  <key>StandardOutPath</key><string>${xml(stdoutPath)}</string>\n  <key>StandardErrorPath</key><string>${xml(stderrPath)}</string>\n</dict>\n</plist>\n`;
}

export function renderWindowsRegistration({ nodePath, cliPath, username }) {
  const argument = `"${cliPath.replace(/"/g, '\\"')}" linkedin run`;
  return [
    `$action = New-ScheduledTaskAction -Execute ${psQuote(nodePath)} -Argument ${psQuote(argument)}`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User ${psQuote(username)}`,
    `$principal = New-ScheduledTaskPrincipal -UserId ${psQuote(username)} -LogonType Interactive -RunLevel Limited`,
    '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew',
    `Register-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`
  ].join('; ');
}

function ensureSystemd() {
  const systemctl = commandPath('systemctl', 'linux');
  if (!systemctl) throw new Error('This Linux installation has no systemctl. Trevra background mode currently requires a systemd user session.');
  const check = tryRun(systemctl, ['--user', 'show-environment']);
  if (!check.ok) throw new Error('A systemd user session is not available. Sign into the graphical desktop, then run the install command again.');
  return systemctl;
}

function importLinuxDesktopEnvironment(systemctl) {
  const names = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS'];
  const present = names.filter((name) => process.env[name]);
  if (present.length) tryRun(systemctl, ['--user', 'import-environment', ...present]);
}

function launchdTarget() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
  return `gui/${uid}/com.trevra.linkedin`;
}

function launchdDomain() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
  return `gui/${uid}`;
}

function powershell() {
  return commandPath('powershell.exe', 'win32') ?? commandPath('powershell', 'win32') ?? 'powershell.exe';
}

function windowsTaskState() {
  const script = `(Get-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)} -ErrorAction SilentlyContinue).State`;
  const result = tryRun(powershell(), ['-NoProfile', '-NonInteractive', '-Command', script]);
  return result.ok ? result.output.trim() : '';
}

export function installedServiceStatus({ home = homedir(), platform = currentPlatform() } = {}) {
  const paths = servicePaths(home, platform);
  const installed = existsSync(paths.definition) && existsSync(paths.cliPath);
  let running = false;
  let detail = '';

  if (installed && platform === 'linux') {
    const systemctl = commandPath('systemctl', 'linux');
    if (systemctl) {
      running = tryRun(systemctl, ['--user', 'is-active', '--quiet', `${SERVICE_ID}.service`]).ok;
      detail = tryRun(systemctl, ['--user', 'is-enabled', `${SERVICE_ID}.service`]).output;
    }
  } else if (installed && platform === 'darwin') {
    const result = tryRun('/bin/launchctl', ['print', launchdTarget()]);
    running = result.ok && /state = running/.test(result.output);
    detail = result.ok ? 'loaded' : 'not loaded';
  } else if (installed && platform === 'win32') {
    const state = windowsTaskState();
    running = /^Running$/i.test(state);
    detail = state || 'not registered';
  }

  return { installed, running, detail, manager: paths.manager, ...paths };
}

export function installStablePackage({ version, installSpec, home = homedir(), platform = currentPlatform() }) {
  const paths = servicePaths(home, platform);
  privateDir(join(home, '.trevra'));
  rmSync(paths.serviceRoot, { recursive: true, force: true });
  privateDir(paths.serviceRoot);

  const npm = npmCommand(platform);
  const spec = installSpec || `trevra@${version}`;
  run(npm.file, [...npm.prefixArgs, 'install', '--prefix', paths.serviceRoot, '--omit=dev', '--no-audit', '--no-fund', spec]);
  if (!existsSync(paths.cliPath)) throw new Error(`Trevra installed, but its service executable is missing at ${paths.cliPath}.`);
  return paths;
}

export function registerBackgroundService({ home = homedir(), platform = currentPlatform(), nodePath = process.execPath } = {}) {
  const paths = servicePaths(home, platform);
  if (!existsSync(paths.cliPath)) throw new Error('The Trevra background package is not installed yet. Run `trevra linkedin install`.');
  privateDir(paths.logs);

  if (platform === 'linux') {
    const systemctl = ensureSystemd();
    writePrivate(paths.definition, renderSystemdUnit({ nodePath, cliPath: paths.cliPath }), 0o600);
    run(systemctl, ['--user', 'daemon-reload']);
    run(systemctl, ['--user', 'enable', `${SERVICE_ID}.service`]);
    importLinuxDesktopEnvironment(systemctl);
    return paths;
  }

  if (platform === 'darwin') {
    writePrivate(paths.definition, renderLaunchAgent({
      nodePath,
      cliPath: paths.cliPath,
      stdoutPath: join(paths.logs, 'linkedin-companion.log'),
      stderrPath: join(paths.logs, 'linkedin-companion-error.log')
    }), 0o600);
    return paths;
  }

  if (platform === 'win32') {
    const username = process.env.USERNAME || userInfo().username;
    const script = renderWindowsRegistration({ nodePath, cliPath: paths.cliPath, username });
    writePrivate(paths.definition, `${script}\r\n`, 0o600);
    run(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    return paths;
  }

  throw new Error(`Background service installation is not supported on ${platform}.`);
}

export function startBackgroundService({ home = homedir(), platform = currentPlatform() } = {}) {
  const paths = servicePaths(home, platform);
  if (!existsSync(paths.definition) || !existsSync(paths.cliPath)) throw new Error('Trevra LinkedIn is not installed as a background service. Run `trevra linkedin install` first.');

  if (platform === 'linux') {
    const systemctl = ensureSystemd();
    importLinuxDesktopEnvironment(systemctl);
    run(systemctl, ['--user', 'start', `${SERVICE_ID}.service`]);
    return;
  }
  if (platform === 'darwin') {
    const target = launchdTarget();
    if (!tryRun('/bin/launchctl', ['print', target]).ok) {
      run('/bin/launchctl', ['bootstrap', launchdDomain(), paths.definition]);
    }
    run('/bin/launchctl', ['kickstart', '-k', target]);
    return;
  }
  if (platform === 'win32') {
    run(powershell(), ['-NoProfile', '-NonInteractive', '-Command', `Start-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)}`]);
    return;
  }
  throw new Error(`Background service control is not supported on ${platform}.`);
}

export function stopBackgroundService({ home = homedir(), platform = currentPlatform() } = {}) {
  const paths = servicePaths(home, platform);
  if (!existsSync(paths.definition)) return;

  if (platform === 'linux') {
    const systemctl = ensureSystemd();
    tryRun(systemctl, ['--user', 'stop', `${SERVICE_ID}.service`]);
    return;
  }
  if (platform === 'darwin') {
    tryRun('/bin/launchctl', ['kill', 'SIGTERM', launchdTarget()]);
    return;
  }
  if (platform === 'win32') {
    tryRun(powershell(), ['-NoProfile', '-NonInteractive', '-Command', `Stop-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)} -ErrorAction SilentlyContinue`]);
    return;
  }
}

export function restartBackgroundService(options = {}) {
  const { platform = currentPlatform() } = options;
  if (platform === 'linux') {
    const systemctl = ensureSystemd();
    importLinuxDesktopEnvironment(systemctl);
    run(systemctl, ['--user', 'restart', `${SERVICE_ID}.service`]);
    return;
  }
  stopBackgroundService(options);
  startBackgroundService(options);
}

export function uninstallBackgroundService({ home = homedir(), platform = currentPlatform() } = {}) {
  const paths = servicePaths(home, platform);
  stopBackgroundService({ home, platform });

  if (platform === 'linux') {
    const systemctl = commandPath('systemctl', 'linux');
    if (systemctl) {
      tryRun(systemctl, ['--user', 'disable', `${SERVICE_ID}.service`]);
      rmSync(paths.definition, { force: true });
      tryRun(systemctl, ['--user', 'daemon-reload']);
      tryRun(systemctl, ['--user', 'reset-failed', `${SERVICE_ID}.service`]);
    }
  } else if (platform === 'darwin') {
    tryRun('/bin/launchctl', ['bootout', launchdDomain(), paths.definition]);
    rmSync(paths.definition, { force: true });
  } else if (platform === 'win32') {
    tryRun(powershell(), ['-NoProfile', '-NonInteractive', '-Command', `Unregister-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`]);
  }

  rmSync(paths.serviceRoot, { recursive: true, force: true });
  return paths;
}
