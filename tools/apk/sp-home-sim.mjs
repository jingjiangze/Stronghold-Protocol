#!/usr/bin/env node
// sp-home-sim.mjs — drive the built shell home in a real Chromium and record the art-prefetch chip.
//
//   node tools/apk/sp-home-sim.mjs --port 8774 --out out/b4-art [--url http://127.0.0.1:8774/]
//                                  [--root <webroot copy>] [--unblock 2000]
//                                  [--wait1-ms 600000] [--sample-ms 300]
//
// --unblock <n>: between the two loads, materialise 64-byte stand-ins for the first n refs that the
// root is currently missing -- the served tree "catches up", so the reload's run has real work to do
// and its chip has to climb past the stored X (a run that restarted would show a tiny X instead).
//
// Start the page first (the preview harness serves the built webroot + the /__sp/ shell chain):
//   node tools/apk/preview.mjs --port 8774 --root <webroot copy>
//
// Two loads in ONE browser profile, because that is the acceptance case:
//   1) the first load runs the prefetch and persists its progress (localStorage);
//   2) page.reload() must CONTINUE from that progress -- the chip's first paint is the stored X
//      (not 0/total), and the still-owed paths must be the only work left.
// Every shot is written next to the numbers it claims: window.__SP_ART.state(), failed() and the
// raw localStorage record go into the same report.json, so the PNG is checkable, not decorative.
// Google Chrome is discovered from SP_CHROME / CHROME_PATH, then the usual system locations and the
// Playwright tree; a machine without one gets a clear message and exit 2 (dev tool, not a test).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const PORT = Number(arg('--port', 8774));
const OUT = path.resolve(arg('--out', path.join(here, '..', '..', 'out', 'sp-home-sim')));
const URL_ = arg('--url', 'http://127.0.0.1:' + PORT + '/');
const WAIT1_MS = Number(arg('--wait1-ms', 600000));
const SAMPLE_MS = Number(arg('--sample-ms', 300));
const ROOT = arg('--root', null);
const UNBLOCK = Number(arg('--unblock', 0));

/** Chrome candidates: an explicit env var first, then the per-machine installs this repo has used. */
function findChrome() {
  const explicit = process.env.SP_CHROME || process.env.CHROME_PATH;
  const candidates = explicit ? [explicit] : [];
  const local = process.env.LOCALAPPDATA || '';
  const prog = process.env.PROGRAMFILES || 'C:/Program Files';
  const progX86 = process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)';
  candidates.push(
    path.join(prog, 'Google/Chrome/Application/chrome.exe'),
    path.join(progX86, 'Google/Chrome/Application/chrome.exe'),
    path.join(local, 'Google/Chrome/Application/chrome.exe'),
    path.join(prog, 'Microsoft/Edge/Application/msedge.exe'),
    path.join(progX86, 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  );
  const pw = path.join(local, 'ms-playwright'); // the browser-use plugin's Playwright tree
  try {
    for (const d of fs.readdirSync(pw).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      candidates.push(path.join(pw, d, 'chrome-win', 'chrome.exe'));
      candidates.push(path.join(pw, d, 'chrome-linux', 'chrome'));
    }
  } catch { /* no playwright tree on this machine */ }
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* unreadable */ }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every /assets/** the served manifest names, in manifest order (same walk the module does). */
function manifestRefs(root) {
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'data', 'assets.json'), 'utf8'));
  const out = [];
  const seen = new Set();
  (function collect(n) {
    if (n == null) return;
    if (typeof n === 'string') {
      const i = n.indexOf('/assets/');
      const j = n.indexOf('/assets-re/');
      const p = i >= 0 ? n.slice(i) : (j >= 0 ? '/assets/' + n.slice(j + 11) : null);
      if (p && !seen.has(p)) { seen.add(p); out.push(p); }
      return;
    }
    if (typeof n !== 'object') return;
    for (const k of Array.isArray(n) ? n.keys() : Object.keys(n)) collect(n[k]);
  })(doc);
  return out;
}

/** Serves up to count refs the root is missing, starting at fromIndex (the cursor the previous
 *  load stopped at -- the entries behind it are already resolved and are never re-walked), so the
 *  reload has real work to do. Stand-ins: this is a dev tree, only the 200 matters. */
function unblock(root, count, fromIndex) {
  const refs = manifestRefs(root);
  let made = 0;
  for (let i = Math.max(0, fromIndex | 0); i < refs.length && made < count; i++) {
    const dst = path.join(root, refs[i].slice(1));
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, Buffer.alloc(64, 0x20));
    made++;
  }
  return made;
}

/** The chip text plus the module's own diagnostics, in one round trip of plain JSON. */
const PROBE = `(() => {
  const a = window.__SP_ART;
  if (!a) return { missing: true, hasLoader: !!window.__SP_SHELL, scripts: [].map.call(document.scripts, function (s) { return s.src; }) };
  const chip = document.querySelector('[data-sp-art]');
  const skip = chip ? chip.querySelector('button') : null;
  let rec = null, last = null, flag = null;
  try {
    rec = JSON.parse(window.localStorage.getItem('sp.art.v1') || 'null');
    last = window.localStorage.getItem('sp.art.last');
    flag = window.sessionStorage.getItem('sp.art.skip.v1');
  } catch (e) { /* storage disabled */ }
  const r = chip ? chip.getBoundingClientRect() : null;
  return {
    chip: chip ? chip.textContent : null,
    geometry: r ? { right: r.right, bottom: r.bottom, width: Math.round(r.width), bottomFromViewport: Math.round(r.bottom) } : null,
    chipPointerEvents: chip ? getComputedStyle(chip).pointerEvents : null,
    skipPointerEvents: skip ? getComputedStyle(skip).pointerEvents : null,
    inlineBottom: chip ? chip.style.bottom : null,
    state: a.state(),
    failed: a.failed().slice(0, 10),
    failedShown: a.failed().length,
    record: last && rec ? rec[last] : null,
    recordKeys: last && rec && rec[last] ? Object.keys(rec[last]) : null,
    skipFlag: flag,
  };
})()`;

async function main() {
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer-core')).default;
  } catch (e) {
    console.error('sp-home-sim: puppeteer-core is not installed (npm ci) - ' + e.message);
    process.exit(2);
  }
  const chrome = findChrome();
  if (!chrome) {
    console.error('sp-home-sim: no Chrome/Chromium found - set SP_CHROME=<path to chrome.exe>');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--no-first-run', '--disable-background-timer-throttling', '--mute-audio'],
  });
  const report = { url: URL_, chrome, load1: null, shots: [], samples: [], errors: [] };
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => report.errors.push(String((e && e.message) || e)));

    const shot = async (name, note) => {
      const probe = await page.evaluate(PROBE);
      const file = path.join(OUT, name + '.png');
      await page.screenshot({ path: file });
      report.shots.push({ name, note, file, probe });
      console.log(name + ' -> chip=' + JSON.stringify(probe && probe.chip) + ' phase=' + (probe && probe.state && probe.state.state));
      return probe;
    };

    // ---- load 1: the real run (whatever the served tree can satisfy), then its persisted record
    await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction('!!window.__SP_ART', { timeout: 20000, polling: 100 });
    const deadline = Date.now() + WAIT1_MS;
    const firstPaint1 = await page.evaluate(PROBE);
    report.load1 = { firstPaint: firstPaint1.chip, firstState: firstPaint1.state };
    while (Date.now() < deadline) {
      const probe = await page.evaluate(PROBE);
      if (probe.state.state !== 'running') break;
      await sleep(SAMPLE_MS);
    }
    report.load1.settled = (await page.evaluate(PROBE));
    await shot('01-load1-settled', 'the first load settled: its record is what the reload must continue from');

    // ---- unblock: let the served tree catch up, so the reload has real work (a climbing X)
    if (UNBLOCK > 0) {
      if (!ROOT) throw new Error('--unblock needs --root <webroot copy>');
      // from the stored cursor: the entries before it are resolved, so they are never re-walked
      const cursor = (report.load1.settled && report.load1.settled.state && report.load1.settled.state.cursor) | 0;
      report.unblocked = unblock(path.resolve(ROOT), UNBLOCK, cursor);
      report.unblockFrom = cursor;
      report.load1.recordBeforeUnblock = report.load1.settled.record
        ? { done: report.load1.settled.record.done, failed: report.load1.settled.record.failedTotal, cursor: report.load1.settled.record.cursor }
        : null;
      console.log('unblocked ' + report.unblocked + ' refs in ' + ROOT);
    }

    // ---- load 2: reload in the same profile -> the chip must paint the STORED numbers
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction('!!window.__SP_ART', { timeout: 20000, polling: 100 });
    await sleep(SAMPLE_MS); // the module paints its chip on the auto-start tick, just after the load
    const resumed = await shot('02-reload-first-paint', 'the reload continues from the stored progress (the acceptance shot)');
    report.resumedFrom = resumed.state ? { done: resumed.state.done, total: resumed.state.total, failed: resumed.state.failed, resumed: resumed.state.resumed, cursor: resumed.state.cursor } : null;

    // ---- sample the continuation: X must climb past the stored value, never restart at 0
    let mid = 0;
    for (let i = 0; i < 60; i++) {
      const probe = await page.evaluate(PROBE);
      report.samples.push({ i, chip: probe.chip, state: probe.state.state, done: probe.state.done, failed: probe.state.failed, pending: probe.state.pending, cursor: probe.state.cursor });
      if (probe.state.state !== 'running') break;
      if (mid < 2 && i >= 1) { await shot('0' + (3 + mid) + '-reload-progress-' + mid, 'still running: the continuation'); mid++; }
      await sleep(SAMPLE_MS);
    }
    await shot('0' + (3 + mid) + '-reload-settled', 'the reload settled');
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log('report: ' + path.join(OUT, 'report.json'));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('sp-home-sim failed: ' + ((e && e.stack) || e));
  process.exit(1);
});
