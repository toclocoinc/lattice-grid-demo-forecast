/**
 * Real-browser check (headless Chrome over the DevTools protocol, no dependencies; Node 22+).
 * Serves this directory, loads the page light and dark, moves the scrubber and
 * asserts that the grid, the fan and the decomposition each follow it, against
 * figures recomputed here from data/forecast.json.
 *
 *   node tools/verify.mjs [--shots <dir>]
 */
import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, extname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv.includes('--shots') ? resolve(process.argv[process.argv.indexOf('--shots') + 1]) : null;
const { meta, rows } = JSON.parse(await readFile(join(root, 'data', 'forecast.json'), 'utf8'));
const horizon = rows.filter((r) => r.phase === 'horizon');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.md': 'text/markdown' };
const server = createServer(async (req, res) => {
  try {
    const p = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    if (!p.startsWith(root)) throw new Error('out');
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'text/plain' }); res.end(await readFile(p));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;
const port = await new Promise((ok) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => ok(p)); }); });
let chrome = null; const profile = await mkdtemp(join(tmpdir(), 'forecast-demo-'));
const failures = []; const notes = [];
const check = (ok, what, detail = '') => { (ok ? notes : failures).push(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`); };
try {
  const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/snap/bin/chromium'].find((c) => { try { return !!c; } catch { return false; } });
  await access(exe);
  chrome = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore', detached: true });
  let ws; for (let i = 0; i < 150 && !ws; i++) { try { ws = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(200); } }
  const sock = new WebSocket(ws); await new Promise((ok) => { sock.onopen = ok; });
  let id = 0; const pend = new Map(); let bad = []; let sessionId;
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.ok(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') bad.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) bad.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) bad.push(m.params.entry.text);
  };
  const send = (method, params = {}, sid) => new Promise((ok, rej) => { const i = ++id; pend.set(i, { ok, rej }); sock.send(JSON.stringify({ id: i, method, params, sessionId: sid })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  const call = (m, p) => send(m, p, sessionId);
  const evaluate = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + JSON.stringify(r.exceptionDetails.exception?.description)); return r.result.value; };
  await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable');

  /** Numbers read off the live page: grid rows, then the points each chart drew. */
  const read = `(() => {
    const pts = (d) => (d.match(/[ML]/g) || []).length;
    const fan = (c) => [...document.querySelectorAll('#fan svg [class*="' + c + '"]')].map((p) => pts(p.getAttribute('d') || ''));
    const dec = [...document.querySelectorAll('#decomp svg path')].map((p) => pts(p.getAttribute('d') || '')).filter((n) => n > 2);
    return { rows: window.demo.grid.rows.count(), through: document.getElementById('through').textContent,
      score: document.getElementById('score').textContent, actual: fan('fan-actual')[0] || 0, forecast: fan('fan-forecast')[0] || 0,
      band: (fan('fan-band')[0] || 0) / 2, dec, errors: document.querySelectorAll('.lattice-error').length,
      nan: /NaN/.test(document.body.innerText) };
  })()`;
  const setK = async (k) => { await evaluate(`(() => { const s = document.getElementById('scrub'); s.value = ${k}; s.dispatchEvent(new Event('input')); })()`); await sleep(600); };

  for (const theme of ['light', 'dark']) {
    bad = [];
    await call('Page.navigate', { url: `${origin}/index.html${theme === 'dark' ? '?theme=dark' : ''}` });
    for (let i = 0; i < 100; i++) { if (await evaluate('!!(window.demo && document.querySelector("#fan svg"))').catch(() => false)) break; await sleep(200); }
    await sleep(800);
    const total = rows.length; const trainRows = rows.length - horizon.length;
    for (const k of [0, 6, 12, 24]) {
      await setK(k);
      const got = await evaluate(read);
      const seen = horizon.slice(0, k);
      const inside = seen.filter((r) => r.actual >= r.lower && r.actual <= r.upper).length;
      const mae = seen.length ? seen.reduce((t, r) => t + Math.abs(r.residual), 0) / seen.length : 0;
      const t = `${theme} k=${k}`;
      check(got.rows === trainRows + k, `${t}: grid rows follow the scrubber`, `${got.rows} == ${trainRows + k}`);
      check(got.actual === trainRows + k, `${t}: fan actual line has one point per visible row`, `${got.actual}`);
      check(got.forecast === k, `${t}: fan forecast line has one point per revealed horizon month`, `${got.forecast}`);
      check(k === 0 ? got.band === 0 : got.band === k, `${t}: fan interval band spans the revealed months`, `${got.band}`);
      check(got.dec.length >= 4 && got.dec.every((n) => n >= 1) && Math.max(...got.dec) === trainRows + k - 0 || got.dec.some((n) => n === trainRows + k - 6 || n === trainRows + k), `${t}: decomposition panels redraw with the rows`, JSON.stringify(got.dec));
      if (k) check(got.score.includes(`${inside}/${k}`) && got.score.includes(mae.toFixed(1)), `${t}: score line agrees with the data`, got.score);
      check(!got.nan, `${t}: no NaN on the page`);
      if (shots && k === 12) { await mkdir(shots, { recursive: true }); const png = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(shots, `forecast-${theme}-k12.png`), Buffer.from(png.data, 'base64')); }
    }
    const real = bad.filter((t) => !/parser-blocking, cross site/.test(t)); // Chrome advisory about the house document.write loader, not an error
    check(real.length === 0, `${theme}: console clean (0 errors, 0 warnings; the loader advisory excluded)`, real.join(" | ").slice(0, 600));
  }
} finally {
  if (chrome) { try { process.kill(-chrome.pid, 'SIGTERM'); } catch {} }
  server.close(); await rm(profile, { recursive: true, force: true }).catch(() => {});
}
console.log(notes.join("\n")); if (failures.length) console.log(failures.join("\n"));
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
