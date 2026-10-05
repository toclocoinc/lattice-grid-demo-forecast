# Forecast versus actual

A [Lattice Grid](https://www.latticegrid.dev) demo. US electricity output, month by month: a forecast made from data up to
Aug 2024 is set beside what actually happened over the next 24 months. A **scrubber** moves through that horizon; the
**grid** (date, actual, forecast, lower/upper 95% interval, residual), the **fan** chart (`type: 'fan'`: history, forecast,
widening interval) and the **decomposition** chart (`type: 'decomposition'`: observed, trend, seasonal, residual) are all
bound to the one grid and follow it. Grid 1.86.7 from the jsDelivr CDN; no API keys, no analytics.

## Run it

    python3 -m http.server      # then open http://localhost:8000/ (add ?theme=dark for dark)

## Data

[IPG2211N](https://fred.stlouisfed.org/series/IPG2211N), Industrial Production: Utilities: Electric Power Generation,
Transmission and Distribution (index 2017=100, not seasonally adjusted), Board of Governors of the Federal Reserve
System (US), retrieved from FRED, Federal Reserve Bank of St. Louis. FRED tags it **Public Domain: Citation Requested**;
the citation is on the page. FRED sends no CORS headers, so the page cannot read FRED itself: the raw monthly CSV
(656 rows, 12.6 KB) is committed as `data/IPG2211N.csv`.

## What is precomputed, and how to reproduce it

`data/forecast.json` (38 KB, rows from 2008) is written by `tools/forecast.mjs`: no dependencies, no randomness.

    node tools/forecast.mjs            # reads data/IPG2211N.csv, rewrites data/forecast.json (byte-identical every run)
    node tools/forecast.mjs --fetch    # first re-downloads the CSV from FRED (Node only)

Method (classical additive decomposition, stated in the script header): train on everything before the last 24 months;
trend = centred 12-month moving average; seasonal = mean detrended value per calendar month; forecast = linear
extrapolation of the trend plus the seasonal; interval = forecast +- 1.96 x a standard error that widens with the
extrapolation distance. The interval is a stated heuristic, not a calibrated model: over the 24 held-out months the
actual fell inside it 21 times (87.5%, nominal 95%), mean absolute error 4.5 index points (3.9%). The residual column is
actual minus forecast on the horizon, and actual minus trend minus seasonal in the training years.

## Check it

    node tools/verify.mjs [--shots dir]     # Node 22+, real headless Chrome over DevTools, no dependencies


## Licence

MIT, see `LICENSE`.

The page carries the Lattice Grid public-demo licence for `toclocoinc.github.io`, so no watermark shows there.
