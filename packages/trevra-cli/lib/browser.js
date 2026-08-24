export function chromeLaunchArgs({ profileDir, headless = false, minimized = false, startUrl }) {
  const args = [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode'
  ];
  if (headless) {
    args.push('--headless', '--window-size=1365,900');
  } else if (minimized) {
    args.push('--start-minimized');
  } else {
    args.push('--start-maximized');
  }
  args.push(startUrl);
  return args;
}
