/**
 * Drive the running dev server from a headless Chromium — the stand-in for the preview
 * pane when there is no preview pane (cloud sessions, CI, a bare terminal).
 *
 *   npm run dev &                                   # the app on :5173
 *   node tools/pw-drive.mjs --js "window.__doc.features.length"
 *   node tools/pw-drive.mjs --js-file probe.js --shot out.png
 *   node tools/pw-drive.mjs --smoke                 # tools/browser-smoke.js, every check
 *   node tools/pw-drive.mjs --smoke --csp "default-src 'self'; ..."
 *
 * `--js` is evaluated as the body of an async function in the page, so it may `await`
 * and must `return` what it wants printed (a bare expression is returned for you).
 * `window.confirm` is stubbed to true first, as the harness expects. `--csp` injects the
 * policy as a <meta> tag on the document, to try the desktop CSP against the dev server.
 *
 * Exit code is non-zero if the snippet throws, the page logs an uncaught error, or any
 * smoke check fails.
 */
/* global window */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(name);

const url = opt('--url') ?? 'http://localhost:5173/?fresh=1';
const settle = Number(opt('--wait') ?? 4000);
const shot = opt('--shot');
const csp = opt('--csp');
let js = opt('--js') ?? (opt('--js-file') ? readFileSync(opt('--js-file'), 'utf8') : undefined);

// Playwright is not a dependency of the repo: the cloud image installs it globally with
// its browsers under /opt/pw-browsers. Prefer a local copy if someone added one.
function loadPlaywright() {
  const req = createRequire(import.meta.url);
  try {
    return req('playwright');
  } catch {
    const root = execSync('npm root -g').toString().trim();
    return req(join(root, 'playwright'));
  }
}
const { chromium } = loadPlaywright();

// Software GL: headless Chromium has no GPU, and three.js needs a WebGL context.
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

if (csp) {
  await page.route((u) => u.origin === new URL(url).origin && (u.pathname === '/' || u.pathname.endsWith('.html')), async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}">`);
    await route.fulfill({ response: res, body });
  });
}

let failed = false;
try {
  await page.goto(url);
  await page.waitForTimeout(settle);
  await page.evaluate(() => { window.confirm = () => true; });

  if (flag('--smoke')) {
    await page.addScriptTag({ content: readFileSync(new URL('./browser-smoke.js', import.meta.url), 'utf8') });
    const r = await page.evaluate(() => window.__smoke());
    for (const name of r.failures ?? []) console.log('FAIL', name, JSON.stringify(r.results[name]));
    console.log(`smoke: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed) failed = true;
  }
  if (js) {
    if (!/\breturn\b/.test(js)) js = `return (${js});`;
    const out = await page.evaluate(`(async () => { ${js} })()`);
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  }
  if (shot) {
    await page.screenshot({ path: shot });
    console.log(`screenshot: ${shot}`);
  }
} catch (e) {
  console.error(String(e));
  failed = true;
}
for (const e of errors) console.error('page error:', e);
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
