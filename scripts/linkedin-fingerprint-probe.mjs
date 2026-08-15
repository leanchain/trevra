/**
 * WHAT LINKEDIN SEES, read out of the browser this process would actually use.
 *
 * Answers the only question that matters about running headless: does WebGL
 * report a real GPU, or SwiftShader/llvmpipe -- the software renderer a
 * GPU-less container falls back to, and one of the cheapest automation tells
 * there is.
 *
 *   node scripts/linkedin-fingerprint-probe.mjs           # headless
 *   HEADED=1 node scripts/linkedin-fingerprint-probe.mjs  # headed, needs a display
 *   CHANNEL=chrome node scripts/linkedin-fingerprint-probe.mjs
 *
 * Opens nothing but about:blank. It never touches LinkedIn.
 */

const headless = process.env.HEADED !== '1';
const channel = process.env.CHANNEL ?? undefined;

let chromium;
try {
  ({ chromium } = await import('patchright'));
} catch {
  ({ chromium } = await import('playwright'));
}

// Extra Chrome flags to try, space separated: ARGS='--use-gl=angle --use-angle=gl-egl'
const args = (process.env.ARGS ?? '').split(' ').map((flag) => flag.trim()).filter(Boolean);

const browser = await chromium.launch({ headless, ...(channel ? { channel } : {}), ...(args.length ? { args } : {}) });
const page = await browser.newPage();
const seen = await page.evaluate(() => {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  const debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return {
    webglVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : 'no webgl',
    webglRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'no webgl',
    userAgent: navigator.userAgent,
    // Absent in plain Chromium, present in real Chrome. A one-line check any
    // detection script can make.
    chromeRuntime: typeof (window.chrome && window.chrome.runtime),
    webdriver: navigator.webdriver,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    languages: navigator.languages
  };
});
console.log(JSON.stringify({ headless, channel: channel ?? 'bundled chromium', args, ...seen }, null, 2));
await browser.close();
