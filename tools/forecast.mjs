/**
 * Precompute the forecast this demo draws. Deterministic: no randomness, no
 * network, no dependencies. The same data/IPG2211N.csv always gives the same
 * data/forecast.json, byte for byte.
 *
 *   node tools/forecast.mjs            (reads data/IPG2211N.csv, writes data/forecast.json)
 *   node tools/forecast.mjs --fetch    (first re-downloads the CSV from FRED; Node only, FRED sends no CORS headers)
 *
 * Method (classical additive decomposition; deliberately simple and stated):
 *   1. Train on every month up to the origin; hold the last HORIZON months out.
 *   2. trend    = centred 12-month moving average (2x12). The last six training
 *                 months have no full window, so the trend there is extended
 *                 along the line fitted to the last 24 defined trend points.
 *   3. seasonal = for each calendar month, the mean of (actual - trend) over the
 *                 training years, re-centred to sum to zero over the year.
 *   4. residual (training) = actual - trend - seasonal.
 *   5. forecast(h) = trend line extrapolated h months past the origin (OLS on the
 *                 last 60 trend points) + the seasonal for that month.
 *   6. interval(h) = forecast +- 1.96 * se(h), se(h)^2 = s^2 + s_t^2 * (1/n + (x-xbar)^2/Sxx):
 *                 s is the training residual sd over the last 60 months, s_t the sd of
 *                 the trend about its OLS line, so the band widens as the trend is
 *                 extrapolated further. A stated heuristic, not a calibrated model:
 *                 the realised coverage over the horizon is written into the output.
 *   7. residual (horizon) = actual - forecast, the forecast error.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSV = join(root, 'data', 'IPG2211N.csv');
const OUT = join(root, 'data', 'forecast.json');
const SERIES = 'IPG2211N';
const HORIZON = 24;
const SHOW_FROM = '2008-01-01';
const Z = 1.96;
const r4 = (v) => (v === null ? null : Math.round(v * 1e4) / 1e4);

if (process.argv.includes('--fetch')) {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${SERIES}`);
  if (!res.ok) throw new Error(`FRED answered ${res.status}`);
  await writeFile(CSV, await res.text());
}

/** Ordinary least squares y = a + b x. @param {number[]} xs @param {number[]} ys */
function ols(xs, ys) {
  const n = xs.length;
  const xb = xs.reduce((a, v) => a + v, 0) / n;
  const yb = ys.reduce((a, v) => a + v, 0) / n;
  let sxx = 0; let sxy = 0;
  xs.forEach((x, i) => { sxx += (x - xb) ** 2; sxy += (x - xb) * (ys[i] - yb); });
  const b = sxy / sxx; const a = yb - b * xb;
  const sd = Math.sqrt(ys.reduce((t, y, i) => t + (y - a - b * xs[i]) ** 2, 0) / (n - 2));
  return { a, b, n, xb, sxx, sd };
}

const rows = (await readFile(CSV, 'utf8')).trim().split('\n').slice(1)
  .map((l) => l.split(',')).filter((p) => p[1] !== '' && p[1] !== '.')
  .map(([d, v]) => ({ date: d, v: Number(v) }));
const N = rows.length;
const origin = N - HORIZON;          // index of the first held-out month
const train = rows.slice(0, origin);

// 2. trend: 2x12 centred moving average
const trend = new Array(N).fill(null);
for (let i = 6; i < origin - 6; i++) {
  let s = 0.5 * train[i - 6].v + 0.5 * train[i + 6].v;
  for (let k = i - 5; k <= i + 5; k++) s += train[k].v;
  trend[i] = s / 12;
}
const lastDef = origin - 7;
const tail = ols(Array.from({ length: 24 }, (_, k) => lastDef - 23 + k), Array.from({ length: 24 }, (_, k) => trend[lastDef - 23 + k]));
for (let i = lastDef + 1; i < origin; i++) trend[i] = tail.a + tail.b * i;

// 3. seasonal indices by calendar month
const sums = Array(12).fill(0); const cnt = Array(12).fill(0);
for (let i = 0; i < origin; i++) if (trend[i] !== null) { const m = Number(rows[i].date.slice(5, 7)) - 1; sums[m] += train[i].v - trend[i]; cnt[m]++; }
let seas = sums.map((s, m) => s / cnt[m]);
const mean = seas.reduce((a, v) => a + v, 0) / 12;
seas = seas.map((v) => v - mean);
const seasonalAt = (i) => seas[Number(rows[i].date.slice(5, 7)) - 1];

// 4. training residuals
const resid = new Array(N).fill(null);
for (let i = 0; i < origin; i++) if (trend[i] !== null) resid[i] = rows[i].v - trend[i] - seasonalAt(i);
const last60 = [];
for (let i = Math.max(0, origin - 60); i < origin; i++) if (resid[i] !== null) last60.push(resid[i]);
const s = Math.sqrt(last60.reduce((t, v) => t + v * v, 0) / (last60.length - 1));

// 5-6. trend extrapolation and band
const fit = ols(Array.from({ length: 60 }, (_, k) => origin - 60 + k), Array.from({ length: 60 }, (_, k) => trend[origin - 60 + k]));
const out = [];
let inside = 0; let sumAbsErr = 0; let sumAbsPct = 0;
for (let i = 0; i < N; i++) {
  const o = { date: rows[i].date, actual: rows[i].v, phase: i < origin ? 'train' : 'horizon',
    forecast: null, lower: null, upper: null, residual: null, trend: null, seasonal: null, noise: null };
  if (i >= origin) {
    const tr = fit.a + fit.b * i;
    const se = Math.sqrt(s ** 2 + fit.sd ** 2 * (1 / fit.n + (i - fit.xb) ** 2 / fit.sxx));
    const f = tr + seasonalAt(i);
    o.forecast = r4(f); o.lower = r4(f - Z * se); o.upper = r4(f + Z * se);
    o.residual = r4(rows[i].v - f);
    o.trend = r4(tr); o.seasonal = r4(seasonalAt(i)); o.noise = o.residual;
    if (rows[i].v >= f - Z * se && rows[i].v <= f + Z * se) inside++;
    sumAbsErr += Math.abs(rows[i].v - f); sumAbsPct += Math.abs(rows[i].v - f) / rows[i].v;
  } else if (trend[i] !== null) {
    o.trend = r4(trend[i]); o.seasonal = r4(seasonalAt(i)); o.noise = r4(resid[i]); o.residual = null;
  }
  out.push(o);
}
const shown = out.filter((o) => o.date >= SHOW_FROM);
const meta = {
  series: SERIES, title: 'Industrial Production: Utilities: Electric Power Generation, Transmission, and Distribution (NAICS = 2211)',
  units: 'Index 2017=100, not seasonally adjusted', source: 'Board of Governors of the Federal Reserve System (US), via FRED, Federal Reserve Bank of St. Louis',
  url: 'https://fred.stlouisfed.org/series/IPG2211N', licence: 'Public domain, citation requested (FRED tag)',
  method: 'tools/forecast.mjs', horizon: HORIZON, originDate: rows[origin - 1].date, firstHorizonDate: rows[origin].date, lastDate: rows[N - 1].date,
  trainMonths: origin, residualSd: r4(s), z: Z,
  coverage: { inside, of: HORIZON, share: r4(inside / HORIZON) }, mae: r4(sumAbsErr / HORIZON), mape: r4(sumAbsPct / HORIZON),
  seasonal: seas.map(r4),
};
await writeFile(OUT, `${JSON.stringify({ meta, rows: shown })}\n`);
console.log(JSON.stringify(meta, null, 1));
