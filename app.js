// Wiring for the forecast-versus-actual demo. The forecast is precomputed by tools/forecast.mjs.
(async () => {
  const el = (id) => document.getElementById(id);
  const { createGrid, createChart } = LatticeGrid;
  const { meta, rows } = await (await fetch('data/forecast.json?v=20261003a-1632')).json();
  const horizon = rows.filter((r) => r.phase === 'horizon');
  const month = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  el('origin').textContent = month(meta.originDate);

  const num = (decimals, extra = {}) => ({ type: 'number', decimals, ...extra });
  const grid = createGrid(el('grid'), {
    rowKey: 'date', density: 'compact', selection: 'none', statusBar: true, columnMenu: false,
    columns: [
      { id: 'date', field: 'date', title: 'Month', type: 'date', format: { type: 'date', pattern: 'MMM yyyy' } },
      { id: 'actual', field: 'actual', title: 'Actual', type: 'number', format: num(1) },
      { id: 'forecast', field: 'forecast', title: 'Forecast', type: 'number', format: num(1) },
      { id: 'lower', field: 'lower', title: 'Lower 95%', type: 'number', format: num(1) },
      { id: 'upper', field: 'upper', title: 'Upper 95%', type: 'number', format: num(1) },
      { id: 'residual', field: 'residual', title: 'Residual', type: 'number', format: num(1, { signed: true }) },
      { id: 'trend', field: 'trend', title: 'Trend', type: 'number' },
      { id: 'seasonal', field: 'seasonal', title: 'Seasonal', type: 'number' },
      { id: 'noise', field: 'noise', title: 'Remainder', type: 'number' },
    ],
  });
  grid.rows.load(rows);
  grid.columns.hide(['trend', 'seasonal', 'noise']); // the decomposition reads them; the table need not show them
  grid.sort.set([{ col: 'date', dir: 'desc' }]);   // newest first, so the horizon is on screen

  createChart({ grid, container: el('fan'), type: 'fan', x: 'date', y: 'actual', forecast: 'forecast', lower: 'lower', upper: 'upper' });
  createChart({ grid, container: el('decomp'), type: 'decomposition', x: 'date',
    observed: 'actual', trend: 'trend', seasonal: 'seasonal', residual: 'noise' });

  // The scrubber: k = how many of the held-out months have been revealed (0 = only what the forecast was built from).
  const scrub = el('scrub');
  scrub.max = String(horizon.length);
  const show = (k) => {
    const last = k === 0 ? meta.originDate : horizon[k - 1].date;
    grid.filters.where('scrub', (row) => row.date <= last);
    const seen = horizon.slice(0, k);
    const inside = seen.filter((r) => r.actual >= r.lower && r.actual <= r.upper).length;
    const mae = seen.length ? seen.reduce((t, r) => t + Math.abs(r.residual), 0) / seen.length : 0;
    el('through').textContent = month(last);
    el('score').textContent = k ? `${k} of ${horizon.length} horizon months · mean absolute error ${mae.toFixed(1)} · actual inside the interval ${inside}/${k}`
      : 'history only; the forecast starts at the next month';
    scrub.value = String(k);
    scrub.setAttribute('aria-valuetext', `${month(last)}, ${k} of ${horizon.length} horizon months`);
  };
  scrub.addEventListener('input', () => show(Number(scrub.value)));
  let timer = null;
  const stop = () => { clearInterval(timer); timer = null; el('play').textContent = 'Play'; };
  el('play').addEventListener('click', () => {
    if (timer) return stop();
    if (Number(scrub.value) >= horizon.length) show(0);
    el('play').textContent = 'Pause';
    timer = setInterval(() => { show(Number(scrub.value) + 1); if (Number(scrub.value) >= horizon.length) stop(); }, 450);
  });
  show(0);
  window.demo = { grid, show };
})();
