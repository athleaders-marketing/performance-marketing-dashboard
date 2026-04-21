/* ============================================================================
   ATHLEADERS DASHBOARD · APP LOGIC
   - Fetches CSV from published Google Sheet
   - Normalizes, aggregates, renders all sections
   - Handles filter state and re-renders reactively
   ============================================================================ */

(function () {
  'use strict';

  const CFG = window.CONFIG;

  // =========================================================================
  // FORMATTERS & UTILS
  // =========================================================================
  const fmt = {
    money: (v, d = 0) => (v === null || v === undefined || isNaN(v))
      ? '—' : `${CFG.CURRENCY_SYMBOL}${Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`,
    num: (v, d = 0) => (v === null || v === undefined || isNaN(v))
      ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }),
    pct: (v, d = 1) => (v === null || v === undefined || isNaN(v))
      ? '—' : `${(Number(v) * 100).toFixed(d)}%`,
    roas: (v) => (v === null || v === undefined || isNaN(v) || !isFinite(v))
      ? '—' : `${Number(v).toFixed(2)}x`,
    date: (d) => d instanceof Date
      ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—',
    dateKey: (d) => d instanceof Date
      ? d.toISOString().slice(0, 10) : '',
  };

  const sum = (arr, key) => arr.reduce((a, r) => a + (Number(r[key]) || 0), 0);
  const safeDiv = (a, b) => {
    if (a === null || a === undefined || b === null || b === undefined || b === 0) return null;
    const n = Number(a) / Number(b);
    return isFinite(n) ? n : null;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Excel serial date to JS Date
  const excelDate = (n) => {
    if (typeof n !== 'number' || !isFinite(n)) return null;
    const ms = (n - 25569) * 86400 * 1000;
    return new Date(ms);
  };

  // Parse string like "4/1/2026" or "2026-04-01" or excel serial
  const parseDate = (raw) => {
    if (raw instanceof Date) return raw;
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'number' || /^\d+\.?\d*$/.test(String(raw))) {
      return excelDate(Number(raw));
    }
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  };

  const parseNum = (raw) => {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = parseFloat(String(raw).replace(/[, %$]/g, ''));
    return isNaN(n) ? null : n;
  };

  // =========================================================================
  // STATE
  // =========================================================================
  const state = {
    rows: [],
    filtered: [],
    lastFetch: null,
    loading: true,
    error: null,
    filters: {
      range: '30d',             // 7d | 30d | mtd | all
      customStart: null,
      customEnd: null,
      countries: new Set(['Singapore', 'Dubai']),
      channels:  new Set(['Meta', 'Search', 'Performance Max']),
      advertiserView: 'combined', // combined | split
    },
    table: {
      sortKey: 'date',
      sortDir: 'desc',
      search: '',
      page: 0,
      pageSize: 25,
    },
    charts: {},  // Chart.js instances keyed by id
  };

  // =========================================================================
  // DATA FETCH
  // =========================================================================
  const CSV_URL = (gid) =>
    `https://docs.google.com/spreadsheets/d/e/${CFG.PUBLISH_ID}/pub?gid=${gid}&single=true&output=csv`;

  const PUBHTML_URL = `https://docs.google.com/spreadsheets/d/e/${CFG.PUBLISH_ID}/pubhtml`;

  async function discoverGid() {
    // Try to auto-find the gid for "Perf Marketing Tracker" from the pubhtml index
    try {
      const resp = await fetch(PUBHTML_URL);
      const html = await resp.text();
      // Look for sheet menu items: <li id="sheet-button-<gid>"...>Perf Marketing Tracker</li>
      const re = /id="sheet-button-(\d+)"[^>]*>([^<]+)</g;
      let m;
      while ((m = re.exec(html)) !== null) {
        if (m[2].trim().toLowerCase().includes('perf marketing')) return m[1];
      }
      // Fallback: look for {name:"Perf Marketing Tracker", gid:"..."} style JSON
      const alt = /"gid":"(\d+)"[^}]*?"name":"([^"]*Perf Marketing[^"]*)"/i.exec(html);
      if (alt) return alt[1];
      const alt2 = /"name":"([^"]*Perf Marketing[^"]*)"[^}]*?"gid":"(\d+)"/i.exec(html);
      if (alt2) return alt2[2];
    } catch (e) {
      console.warn('Auto-discovery failed:', e);
    }
    return null;
  }

  async function loadData() {
    state.loading = true;
    state.error = null;
    renderShell();

    try {
      let gid = CFG.PERF_MARKETING_GID;
      if (!gid) gid = await discoverGid();
      if (!gid) {
        throw new Error(
          'Could not find the Perf Marketing Tracker tab. ' +
          'Open config.js and set PERF_MARKETING_GID to the gid number from the tab URL.'
        );
      }

      const resp = await fetch(CSV_URL(gid));
      if (!resp.ok) throw new Error(`Sheet fetch failed: HTTP ${resp.status}`);
      const csvText = await resp.text();

      const parsed = Papa.parse(csvText, { skipEmptyLines: true });
      state.rows = normalizeRows(parsed.data);
      state.lastFetch = new Date();
      state.loading = false;
      renderShell();   // rebuild DOM now that sections should replace the loader
      applyFilters();
      renderAll();
    } catch (e) {
      console.error(e);
      state.error = e.message || String(e);
      state.loading = false;
      renderShell();
    }
  }

  function normalizeRows(raw) {
    if (!raw || raw.length < 2) return [];

    // Find the actual header row (one that contains "Date" in col A or similar)
    let headerIdx = 0;
    for (let i = 0; i < Math.min(5, raw.length); i++) {
      const first = String(raw[i][0] || '').toLowerCase().trim();
      if (first === 'date') { headerIdx = i; break; }
    }
    const headers = raw[headerIdx].map(h => String(h || '').trim());
    const dataRows = raw.slice(headerIdx + 1);

    // Robust column lookup: accepts array of aliases, tries exact match first, then contains
    const idx = (aliases) => {
      const list = Array.isArray(aliases) ? aliases : [aliases];
      for (const p of list) {
        const i = headers.findIndex(h => h.toLowerCase() === p.toLowerCase());
        if (i !== -1) return i;
      }
      // Fallback: startsWith match (safer than contains, won't match "Spend Target" for "Spend")
      for (const p of list) {
        const i = headers.findIndex(h => h.toLowerCase().startsWith(p.toLowerCase()));
        if (i !== -1) return i;
      }
      return -1;
    };

    const I = {
      date:         idx(['Date']),
      day:          idx(['Day']),
      wk:           idx(['Wk#', 'Week', 'Wk']),
      country:      idx(['Country']),
      advertiser:   idx(['Advertiser']),
      channel:      idx(['Channel']),
      spendTarget:  idx(['Spend Target (SGD)', 'Spend Target', 'Target Spend']),
      spendActual:  idx(['Spend Actual (SGD)', 'Spend Actual', 'Actual Spend', 'Spend']),
      spendVar:     idx(['Spend Variance %', 'Spend Variance']),
      impr:         idx(['Impr.', 'Impressions', 'Impr']),
      clicks:       idx(['Clicks']),
      ctr:          idx(['CTR']),
      cpc:          idx(['CPC (SGD)', 'CPC']),
      leads:        idx(['Leads']),
      cplActual:    idx(['CPL Actual (SGD)', 'CPL Actual', 'CPL']),
      cplBench:     idx(['CPL vs Benchmark']),
      newCust:      idx(['New Cust.', 'New Customers', 'Customers', 'New Cust']),
      convRate:     idx(['Conv Rate', 'Conversion Rate']),
      cacActual:    idx(['CAC Actual (SGD)', 'CAC Actual', 'CAC']),
      cacBench:     idx(['CAC vs Benchmark']),
      revenue:      idx(['Revenue Attributed', 'Revenue']),
      roas:         idx(['ROAS']),
      campaign:     idx(['Campaign / Ad Set', 'Campaign']),
      notes:        idx(['Notes']),
    };

    // Diagnostic: log column mapping so you can see what's wired to what
    console.group('%cAthleaders Dashboard · column map', 'color:#0F3D2E;font-weight:500');
    console.log('Headers detected in sheet:', headers);
    console.table(Object.fromEntries(Object.entries(I).map(([k, i]) => [k, i === -1 ? 'NOT FOUND' : `col ${i} → "${headers[i]}"`])));
    console.groupEnd();

    const out = [];
    let sampleLogged = false;
    for (const r of dataRows) {
      const date = parseDate(r[I.date]);
      if (!date) continue;
      const country = String(r[I.country] || '').trim();
      const advertiser = String(r[I.advertiser] || '').trim();
      const channel = String(r[I.channel] || '').trim();
      if (!country || !channel) continue;

      const spendActual = parseNum(r[I.spendActual]);
      const spendTarget = parseNum(r[I.spendTarget]);
      const impr = parseNum(r[I.impr]);
      const clicks = parseNum(r[I.clicks]);
      const leads = parseNum(r[I.leads]);
      const newCust = parseNum(r[I.newCust]);
      const revenue = parseNum(r[I.revenue]);

      // Log a sample row so you can verify numbers are parsed correctly
      if (!sampleLogged && (spendActual || leads || impr)) {
        console.group('%cSample parsed row', 'color:#0F3D2E;font-weight:500');
        console.log({
          date: date.toISOString().slice(0,10),
          country, advertiser, channel,
          spendActual, spendTarget, impr, clicks, leads, newCust, revenue,
          rawRow: r,
        });
        console.groupEnd();
        sampleLogged = true;
      }

      // Derive metrics so we don't depend on sheet formulas resolving in CSV
      const ctr = safeDiv(clicks, impr);
      const cpc = safeDiv(spendActual, clicks);
      const cpl = safeDiv(spendActual, leads);
      const cac = safeDiv(spendActual, newCust);
      const convRate = safeDiv(newCust, leads);
      const roas = safeDiv(revenue, spendActual);

      const bench = (CFG.BENCHMARKS[country] || {})[channel] || {};
      const cplVsBench = (cpl !== null && bench.cpl) ? (cpl - bench.cpl) / bench.cpl : null;
      const cacVsBench = (cac !== null && bench.cac) ? (cac - bench.cac) / bench.cac : null;

      out.push({
        date,
        dateKey: fmt.dateKey(date),
        day: r[I.day] || date.toLocaleDateString('en-US', { weekday: 'short' }),
        weekNum: parseNum(r[I.wk]),
        country,
        advertiser,
        channel,
        spendTarget, spendActual,
        impr, clicks, ctr, cpc,
        leads, cpl, cplBench: bench.cpl, cplVsBench,
        newCust, convRate, cac, cacBench: bench.cac, cacVsBench,
        revenue, roas,
        campaign: r[I.campaign] || '',
        notes: r[I.notes] || '',
      });
    }

    // Summary diagnostic
    const withSpend = out.filter(r => r.spendActual !== null && r.spendActual > 0).length;
    const withLeads = out.filter(r => r.leads !== null && r.leads > 0).length;
    const withCust = out.filter(r => r.newCust !== null && r.newCust > 0).length;
    const withRev = out.filter(r => r.revenue !== null && r.revenue > 0).length;
    console.log(`%cAthleaders · ${out.length} rows parsed · spend on ${withSpend}, leads on ${withLeads}, customers on ${withCust}, revenue on ${withRev}`, 'color:#0F3D2E');

    return out;
  }

  // =========================================================================
  // FILTERING
  // =========================================================================
  function applyFilters() {
    const { range, customStart, customEnd, countries, channels } = state.filters;

    const now = new Date();
    let start, end = now;

    if (range === '7d') {
      start = new Date(now); start.setDate(start.getDate() - 7);
    } else if (range === '30d') {
      start = new Date(now); start.setDate(start.getDate() - 30);
    } else if (range === 'mtd') {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (range === 'custom' && customStart && customEnd) {
      start = customStart; end = customEnd;
    } else {
      start = null; // all
    }

    // Only keep rows that have at least *some* actual data, so charts aren't flat zeros
    const hasSignal = (r) => (r.spendActual !== null && r.spendActual > 0) ||
                             (r.leads !== null && r.leads > 0) ||
                             (r.impr !== null && r.impr > 0);

    state.filtered = state.rows.filter(r => {
      if (start && r.date < start) return false;
      if (end && r.date > end) return false;
      if (!countries.has(r.country)) return false;
      if (!channels.has(r.channel)) return false;
      return hasSignal(r);
    });

    // If there's no signal in the chosen window, fall back to showing all spend-target rows
    // so the shell still populates (date axis, filter UI) instead of going empty
    if (state.filtered.length === 0) {
      state.filtered = state.rows.filter(r => {
        if (start && r.date < start) return false;
        if (end && r.date > end) return false;
        if (!countries.has(r.country)) return false;
        if (!channels.has(r.channel)) return false;
        return true;
      });
    }
  }

  // =========================================================================
  // AGGREGATION HELPERS
  // =========================================================================
  function aggregate(rows) {
    const spend = sum(rows, 'spendActual');
    const target = sum(rows, 'spendTarget');
    const impr = sum(rows, 'impr');
    const clicks = sum(rows, 'clicks');
    const leads = sum(rows, 'leads');
    const cust = sum(rows, 'newCust');
    const rev = sum(rows, 'revenue');
    return {
      spend, target,
      spendVariance: safeDiv(spend - target, target),
      impr, clicks,
      ctr: safeDiv(clicks, impr),
      cpc: safeDiv(spend, clicks),
      leads,
      cpl: safeDiv(spend, leads),
      cust,
      convRate: safeDiv(cust, leads),
      cac: safeDiv(spend, cust),
      rev,
      roas: safeDiv(rev, spend),
      rows: rows.length,
    };
  }

  function groupBy(rows, keyFn) {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  }

  function blendedBenchmark(rows, kind /* 'cpl' | 'cac' */) {
    // Weighted by leads (for CPL) or customers (for CAC)
    let bnum = 0, w = 0;
    for (const r of rows) {
      const weight = kind === 'cpl' ? r.leads : r.newCust;
      const b = kind === 'cpl' ? r.cplBench : r.cacBench;
      if (weight && b) { bnum += b * weight; w += weight; }
    }
    return w ? bnum / w : null;
  }

  // =========================================================================
  // RENDER — shell (header, filters, section skeletons)
  // =========================================================================
  function renderShell() {
    const root = document.getElementById('app');
    root.innerHTML = `
      <header class="header">
        <div class="header-inner">
          <div class="brand">
            <div class="brand-logo-img" aria-label="Athleaders"></div>
            <div class="brand-text">
              <span class="brand-name">Athleaders</span>
              <span class="brand-sub">Performance Marketing · Live</span>
            </div>
          </div>
          <div class="status-strip" id="status-strip">
            ${renderStatus()}
          </div>
        </div>
        <div class="filter-bar" id="filter-bar">
          ${renderFilters()}
        </div>
      </header>
      ${state.error ? renderError(state.error) : ''}
      <main id="main">
        ${state.loading ? `<div class="loader"><div class="loader-ring"></div><div>Fetching your performance data…</div></div>` : renderSections()}
      </main>
      <footer class="site-footer">
        <span class="mark">Athleaders · ${new Date().getFullYear()}</span>
        <span>Auto-refresh every ${CFG.AUTO_REFRESH_MINUTES} min · <a href="#" id="refresh-now" style="color:inherit">Refresh now</a></span>
      </footer>
    `;
    wireEvents();
  }

  function renderStatus() {
    if (state.error) return `<span class="live-dot error"></span>Error loading`;
    if (state.loading) return `<span class="live-dot stale"></span>Loading…`;
    const t = state.lastFetch ? state.lastFetch.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—';
    return `<span class="live-dot"></span>Live · last sync ${t}`;
  }

  function renderError(msg) {
    return `<div class="error-box">
      <strong>Data issue:</strong> ${msg}<br>
      <span style="font-size:11px;opacity:0.8">Check <code>config.js</code> or reopen the published sheet URL.</span>
    </div>`;
  }

  function renderFilters() {
    const f = state.filters;
    const rangeBtn = (v, l) => `<button class="${f.range === v ? 'on' : ''}" data-range="${v}">${l}</button>`;
    const chipC = (c) => `<span class="pill ${f.countries.has(c) ? 'active' : ''}" data-country="${c}">${c}</span>`;
    const chipCh = (c) => `<span class="pill ${f.channels.has(c) ? 'active' : ''}" data-channel="${c}">${c}</span>`;
    const advBtn = (v, l) => `<button class="${f.advertiserView === v ? 'on' : ''}" data-adv="${v}">${l}</button>`;

    return `
      <span class="label">Range</span>
      <div class="segmented">
        ${rangeBtn('7d', '7D')}
        ${rangeBtn('30d', '30D')}
        ${rangeBtn('mtd', 'MTD')}
        ${rangeBtn('all', 'All')}
      </div>
      <span class="filter-divider"></span>
      <span class="label">Country</span>
      <div class="filter-group">${chipC('Singapore')}${chipC('Dubai')}</div>
      <span class="filter-divider"></span>
      <span class="label">Channel</span>
      <div class="filter-group">${chipCh('Meta')}${chipCh('Search')}${chipCh('Performance Max')}</div>
      <span class="filter-divider"></span>
      <span class="label">Advertiser</span>
      <div class="segmented">
        ${advBtn('combined', 'Combined')}
        ${advBtn('split', 'Split')}
      </div>
    `;
  }

  function renderSections() {
    return `
      <section class="section" id="sec-kpi">
        <div class="section-head">
          <span class="section-num">01</span>
          <h2 class="section-title">The state of spend today</h2>
          <span class="section-note" id="kpi-context"></span>
        </div>
        <div class="kpi-grid" id="kpi-grid"></div>
      </section>

      <section class="section" id="sec-trends">
        <div class="section-head">
          <span class="section-num">02</span>
          <h2 class="section-title">How performance moved over time</h2>
        </div>
        <div class="chart-grid">
          <div class="card"><div class="card-head"><h3 class="card-title">Daily spend vs target</h3><span class="card-sub">SGD</span></div><div class="chart-wrap"><canvas id="chart-spend"></canvas></div></div>
          <div class="card"><div class="card-head"><h3 class="card-title">Leads & new customers</h3><span class="card-sub">Daily</span></div><div class="chart-wrap"><canvas id="chart-leads"></canvas></div></div>
          <div class="card"><div class="card-head"><h3 class="card-title">ROAS trajectory</h3><span class="card-sub">Target ${CFG.ROAS_TARGET}x</span></div><div class="chart-wrap"><canvas id="chart-roas"></canvas></div></div>
          <div class="card"><div class="card-head"><h3 class="card-title">CPL & CAC vs benchmark</h3><span class="card-sub">Blended</span></div><div class="chart-wrap"><canvas id="chart-cpl"></canvas></div></div>
        </div>
      </section>

      <section class="section" id="sec-segment">
        <div class="section-head">
          <span class="section-num">03</span>
          <h2 class="section-title">Which market, channel, and partner earns the spend</h2>
        </div>
        <div class="segment-grid">
          <div class="card"><div class="card-head"><h3 class="card-title">Country performance</h3></div><div id="country-split"></div></div>
          <div class="card"><div class="card-head"><h3 class="card-title">Channel mix</h3><span class="card-sub">Share of spend</span></div><div class="chart-wrap" style="height:220px"><canvas id="chart-channel"></canvas></div></div>
          <div class="card advertiser-compare"><div class="card-head"><h3 class="card-title">In-house vs Ice Cube</h3><span class="card-sub">Same channels, same dates</span></div><div id="advertiser-compare"></div></div>
        </div>
      </section>

      <section class="section" id="sec-bench">
        <div class="section-head">
          <span class="section-num">04</span>
          <h2 class="section-title">Where we beat and miss the benchmark</h2>
          <span class="section-note">CPL variance vs benchmark · weighted by leads</span>
        </div>
        <div class="main-row">
          <div class="card">
            <div class="card-head"><h3 class="card-title">CPL heatmap</h3><span class="card-sub">Country × Channel × Advertiser</span></div>
            <div class="heatmap-wrap"><div class="heatmap" id="heatmap"></div></div>
            <div class="heatmap-legend">
              <span><i class="sw" style="background:var(--good-bg);border:1px solid var(--good)"></i>At or below benchmark</span>
              <span><i class="sw" style="background:var(--warn-bg);border:1px solid var(--warn)"></i>0–20% over</span>
              <span><i class="sw" style="background:var(--bad-bg);border:1px solid var(--bad)"></i>&gt;20% over</span>
              <span><i class="sw" style="background:var(--surface-alt);border:1px dashed var(--line)"></i>No data</span>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><h3 class="card-title">Conversion funnel</h3><span class="card-sub">Impressions → Customers</span></div>
            <div id="funnel"></div>
          </div>
        </div>
      </section>

      <section class="section" id="sec-tactical">
        <div class="section-head">
          <span class="section-num">05</span>
          <h2 class="section-title">What needs attention this week</h2>
        </div>
        <div class="main-row">
          <div class="card">
            <div class="card-head"><h3 class="card-title">Anomaly flags</h3><span class="card-sub" id="anomaly-count"></span></div>
            <ul class="anomaly-list" id="anomaly-list"></ul>
          </div>
          <div class="card">
            <div class="card-head"><h3 class="card-title">Day of week efficiency</h3><span class="card-sub">ROAS by weekday</span></div>
            <div class="dow-bars" id="dow-bars"></div>
          </div>
        </div>
        <div style="margin-top:16px">
          <div class="card">
            <div class="card-head"><h3 class="card-title">Monthly pacing</h3><span class="card-sub">MTD actual vs target, projected landing</span></div>
            <div class="pacing-wrap" id="pacing"></div>
          </div>
        </div>
      </section>

      <section class="section" id="sec-table">
        <div class="section-head">
          <span class="section-num">06</span>
          <h2 class="section-title">The underlying rows</h2>
          <span class="section-note" id="table-count"></span>
        </div>
        <div class="table-tools">
          <input type="text" class="table-search" id="table-search" placeholder="Search campaign, notes, date…">
        </div>
        <div class="data-table-wrap">
          <table class="data-table" id="data-table"></table>
          <div class="table-footer" id="table-foot"></div>
        </div>
      </section>
    `;
  }

  // =========================================================================
  // RENDER — components
  // =========================================================================
  function renderAll() {
    if (state.loading || state.error) return;
    renderKPIs();
    renderCharts();
    renderCountrySplit();
    renderChannelDonut();
    renderAdvertiserCompare();
    renderHeatmap();
    renderFunnel();
    renderAnomalies();
    renderDOW();
    renderPacing();
    renderTable();
    // Update status strip
    const s = document.getElementById('status-strip');
    if (s) s.innerHTML = renderStatus();
  }

  // -- KPIs ------------------------------------------------------------------
  function renderKPIs() {
    const a = aggregate(state.filtered);
    const prior = aggregate(getPriorPeriodRows());
    const ctx = document.getElementById('kpi-context');
    if (ctx) {
      const labels = { '7d': 'Last 7 days', '30d': 'Last 30 days', 'mtd': 'Month to date', 'all': 'All time' };
      ctx.textContent = labels[state.filters.range] || 'Custom range';
    }

    const cplBench = blendedBenchmark(state.filtered, 'cpl');
    const cacBench = blendedBenchmark(state.filtered, 'cac');
    const cplDelta = (cplBench && a.cpl) ? (a.cpl - cplBench) / cplBench : null;
    const cacDelta = (cacBench && a.cac) ? (a.cac - cacBench) / cacBench : null;

    const delta = (curr, prev, lowerIsBetter = false) => {
      if (!prev || prev === 0 || curr === null || curr === undefined) return { text: '—', cls: '' };
      const d = (curr - prev) / prev;
      const positive = d >= 0;
      const good = lowerIsBetter ? !positive : positive;
      return {
        text: `${positive ? '▲' : '▼'} ${(Math.abs(d) * 100).toFixed(0)}%`,
        cls: good ? 'good' : 'bad',
      };
    };

    const spendDelta = delta(a.spend, prior.spend);
    const leadsDelta = delta(a.leads, prior.leads);
    const custDelta  = delta(a.cust, prior.cust);
    const revDelta   = delta(a.rev, prior.rev);
    const roasStatus = a.roas === null ? {text:'—', cls:''} : {
      text: a.roas >= CFG.ROAS_TARGET ? `▲ above target` : `▼ below target`,
      cls: a.roas >= CFG.ROAS_TARGET ? 'good' : 'bad',
    };
    const cplStatus = cplDelta === null ? {text:'—', cls:''} : {
      text: `${cplDelta <= 0 ? '▼' : '▲'} ${(Math.abs(cplDelta)*100).toFixed(0)}% vs bench`,
      cls: cplDelta <= 0 ? 'good' : (cplDelta <= 0.2 ? 'warn' : 'bad'),
    };
    const cacStatus = cacDelta === null ? {text:'—', cls:''} : {
      text: `${cacDelta <= 0 ? '▼' : '▲'} ${(Math.abs(cacDelta)*100).toFixed(0)}% vs bench`,
      cls: cacDelta <= 0 ? 'good' : (cacDelta <= 0.2 ? 'warn' : 'bad'),
    };
    const pacePct = a.target ? (a.spend / a.target) : null;
    const paceStatus = pacePct === null ? {text:'', cls:''} : {
      text: `${(pacePct*100).toFixed(0)}% of target`,
      cls: pacePct >= 0.9 && pacePct <= 1.1 ? 'good' : (pacePct < 0.9 ? 'warn' : 'bad'),
    };

    const kpis = [
      { lbl: 'Spend (Actual)',   val: fmt.money(a.spend),      meta: paceStatus, sub: `Target ${fmt.money(a.target)}` },
      { lbl: 'Leads',            val: fmt.num(a.leads),        meta: leadsDelta, sub: `vs prior period` },
      { lbl: 'New customers',    val: fmt.num(a.cust),         meta: custDelta,  sub: `Conv ${fmt.pct(a.convRate)}` },
      { lbl: 'Revenue attributed', val: fmt.money(a.rev),      meta: revDelta,   sub: `vs prior period` },
      { lbl: 'Blended ROAS',     val: fmt.roas(a.roas),        meta: roasStatus, sub: `Target ${CFG.ROAS_TARGET}x` },
      { lbl: 'Blended CPL',      val: fmt.money(a.cpl, 2),     meta: cplStatus,  sub: `Bench ${fmt.money(cplBench, 2)}` },
      { lbl: 'Blended CAC',      val: fmt.money(a.cac, 0),     meta: cacStatus,  sub: `Bench ${fmt.money(cacBench, 0)}` },
      { lbl: 'CTR',              val: fmt.pct(a.ctr, 2),       meta: {text:`CPC ${fmt.money(a.cpc, 2)}`, cls:''}, sub: `${fmt.num(a.impr)} impr` },
    ];

    const grid = document.getElementById('kpi-grid');
    grid.innerHTML = kpis.map(k => `
      <div class="kpi">
        <div class="kpi-label">${k.lbl}</div>
        <div class="kpi-value">${k.val}</div>
        <div class="kpi-meta">
          ${k.meta.text ? `<span class="delta ${k.meta.cls || ''}">${k.meta.text}</span>` : ''}
          <span>${k.sub || ''}</span>
        </div>
      </div>
    `).join('');
  }

  function getPriorPeriodRows() {
    const { range } = state.filters;
    const now = new Date();
    let start, end;

    if (range === '7d') {
      end = new Date(now); end.setDate(end.getDate() - 7);
      start = new Date(end); start.setDate(start.getDate() - 7);
    } else if (range === '30d') {
      end = new Date(now); end.setDate(end.getDate() - 30);
      start = new Date(end); start.setDate(start.getDate() - 30);
    } else if (range === 'mtd') {
      const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end = new Date(thisMonthStart); end.setDate(end.getDate() - 1);
    } else {
      return [];
    }

    return state.rows.filter(r =>
      r.date >= start && r.date <= end &&
      state.filters.countries.has(r.country) &&
      state.filters.channels.has(r.channel)
    );
  }

  // -- Time series charts ---------------------------------------------------
  function renderCharts() {
    const byDate = groupBy(state.filtered, r => r.dateKey);
    const dates = [...byDate.keys()].sort();
    const agg = dates.map(d => ({ date: d, ...aggregate(byDate.get(d)) }));
    const labels = agg.map(a => {
      const d = new Date(a.date);
      return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    });

    // Common Chart.js options
    const baseOpts = (fmtFn) => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: {
            boxWidth: 8, boxHeight: 8, padding: 12,
            font: { size: 11, family: "Geist, 'Plus Jakarta Sans', sans-serif" },
            color: '#6F7872',
            usePointStyle: true,
          },
        },
        tooltip: {
          backgroundColor: '#0F1512',
          titleFont: { family: 'Fraunces, serif', weight: 500, size: 13 },
          bodyFont: { family: 'Geist, sans-serif', size: 12 },
          padding: 10,
          cornerRadius: 6,
          displayColors: true,
          boxPadding: 4,
          callbacks: fmtFn ? { label: (c) => `${c.dataset.label}: ${fmtFn(c.parsed.y)}` } : undefined,
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#6F7872', font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 },
        },
        y: {
          beginAtZero: true,
          grid: { color: '#EBE6D7', drawBorder: false },
          ticks: { color: '#6F7872', font: { size: 10 }, padding: 4 },
        },
      },
    });

    destroyChart('chart-spend');
    state.charts['chart-spend'] = new Chart(document.getElementById('chart-spend'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Actual', data: agg.map(a => a.spend),  borderColor: '#0F3D2E', backgroundColor: 'rgba(15,61,46,0.10)', fill: true, borderWidth: 2, tension: 0.3, pointRadius: 0 },
          { label: 'Target', data: agg.map(a => a.target), borderColor: '#A8ADA7', borderDash: [4,4], borderWidth: 1.5, fill: false, pointRadius: 0, tension: 0.3 },
        ],
      },
      options: baseOpts((v) => fmt.money(v, 0)),
    });

    destroyChart('chart-leads');
    state.charts['chart-leads'] = new Chart(document.getElementById('chart-leads'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Leads',         data: agg.map(a => a.leads), backgroundColor: 'rgba(15,61,46,0.75)', borderRadius: 3, maxBarThickness: 14 },
          { label: 'New customers', data: agg.map(a => a.cust),  backgroundColor: 'rgba(181,133,20,0.85)', borderRadius: 3, maxBarThickness: 14 },
        ],
      },
      options: baseOpts((v) => fmt.num(v)),
    });

    destroyChart('chart-roas');
    state.charts['chart-roas'] = new Chart(document.getElementById('chart-roas'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'ROAS',  data: agg.map(a => a.roas), borderColor: '#0F3D2E', backgroundColor: 'rgba(15,61,46,0.12)', fill: true, tension: 0.3, borderWidth: 2, pointRadius: 0 },
          { label: 'Target', data: agg.map(() => CFG.ROAS_TARGET), borderColor: '#A83030', borderDash: [4,4], borderWidth: 1.2, pointRadius: 0, fill: false },
        ],
      },
      options: baseOpts((v) => `${Number(v).toFixed(2)}x`),
    });

    destroyChart('chart-cpl');
    const cplBench = agg.map(a => blendedBenchmark(byDate.get(a.date) || [], 'cpl'));
    const cacBench = agg.map(a => blendedBenchmark(byDate.get(a.date) || [], 'cac'));
    state.charts['chart-cpl'] = new Chart(document.getElementById('chart-cpl'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'CPL',      data: agg.map(a => a.cpl), borderColor: '#0F3D2E', backgroundColor: 'transparent', tension: 0.3, borderWidth: 2, pointRadius: 0, yAxisID: 'y' },
          { label: 'CPL bench',data: cplBench,             borderColor: '#0F3D2E', borderDash:[3,3], borderWidth: 1, pointRadius: 0, yAxisID: 'y' },
          { label: 'CAC',      data: agg.map(a => a.cac), borderColor: '#B58514', backgroundColor: 'transparent', tension: 0.3, borderWidth: 2, pointRadius: 0, yAxisID: 'y1' },
          { label: 'CAC bench',data: cacBench,             borderColor: '#B58514', borderDash:[3,3], borderWidth: 1, pointRadius: 0, yAxisID: 'y1' },
        ],
      },
      options: {
        ...baseOpts((v) => fmt.money(v, 2)),
        scales: {
          x: { grid: { display: false }, ticks: { color: '#6F7872', font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 } },
          y:  { beginAtZero: true, position: 'left',  grid: { color: '#EBE6D7', drawBorder: false }, ticks: { color: '#0F3D2E', font: { size: 10 }, callback: v => fmt.money(v, 0) }, title: { display: true, text: 'CPL', color: '#0F3D2E', font: { size: 10 } } },
          y1: { beginAtZero: true, position: 'right', grid: { display: false },                      ticks: { color: '#B58514', font: { size: 10 }, callback: v => fmt.money(v, 0) }, title: { display: true, text: 'CAC', color: '#B58514', font: { size: 10 } } },
        },
      },
    });
  }

  function destroyChart(id) {
    if (state.charts[id]) {
      state.charts[id].destroy();
      delete state.charts[id];
    }
  }

  // -- Country split --------------------------------------------------------
  function renderCountrySplit() {
    const el = document.getElementById('country-split');
    const bySg = state.filtered.filter(r => r.country === 'Singapore');
    const bDxb = state.filtered.filter(r => r.country === 'Dubai');
    const panel = (label, flagColor, rows) => {
      const a = aggregate(rows);
      return `<div class="country-panel">
        <div class="country-name"><span class="country-flag" style="background:${flagColor}"></span>${label}</div>
        <div class="country-stat"><span class="country-stat-label">Spend</span><span class="country-stat-value">${fmt.money(a.spend)}</span></div>
        <div class="country-stat"><span class="country-stat-label">Leads</span><span class="country-stat-value">${fmt.num(a.leads)}</span></div>
        <div class="country-stat"><span class="country-stat-label">Customers</span><span class="country-stat-value">${fmt.num(a.cust)}</span></div>
        <div class="country-stat"><span class="country-stat-label">CPL</span><span class="country-stat-value">${fmt.money(a.cpl, 2)}</span></div>
        <div class="country-stat"><span class="country-stat-label">CAC</span><span class="country-stat-value">${fmt.money(a.cac, 0)}</span></div>
        <div class="country-stat"><span class="country-stat-label">ROAS</span><span class="country-stat-value">${fmt.roas(a.roas)}</span></div>
      </div>`;
    };
    el.innerHTML = `<div class="country-split">${panel('Singapore', '#D2202C', bySg)}${panel('Dubai', '#00853F', bDxb)}</div>`;
  }

  // -- Channel donut --------------------------------------------------------
  function renderChannelDonut() {
    const byCh = groupBy(state.filtered, r => r.channel);
    const channels = [...byCh.keys()];
    const spendArr = channels.map(c => sum(byCh.get(c), 'spendActual'));
    const totalSpend = spendArr.reduce((a,b)=>a+b,0);

    destroyChart('chart-channel');
    if (totalSpend === 0) {
      const ctx = document.getElementById('chart-channel');
      if (ctx) ctx.parentElement.innerHTML = `<div class="empty-state">No spend logged yet in this window</div>`;
      return;
    }

    state.charts['chart-channel'] = new Chart(document.getElementById('chart-channel'), {
      type: 'doughnut',
      data: {
        labels: channels,
        datasets: [{
          data: spendArr,
          backgroundColor: ['#0F3D2E', '#B58514', '#6F7872'],
          borderColor: '#FFFFFF',
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '70%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 8, padding: 10, font: { size: 11, family: "Geist, sans-serif" }, color: '#3B4540', usePointStyle: true },
          },
          tooltip: {
            callbacks: {
              label: (c) => {
                const pct = totalSpend ? (c.parsed / totalSpend * 100).toFixed(1) : 0;
                return `${c.label}: ${fmt.money(c.parsed)} (${pct}%)`;
              }
            },
            backgroundColor: '#0F1512',
          },
        },
      },
    });
  }

  // -- Advertiser compare ---------------------------------------------------
  function renderAdvertiserCompare() {
    const el = document.getElementById('advertiser-compare');
    const byAdv = groupBy(state.filtered, r => r.advertiser || 'Unassigned');
    const advs = [...byAdv.keys()];

    if (advs.length === 0) {
      el.innerHTML = '<div class="empty-state">No advertiser data</div>';
      return;
    }

    const rows = advs.map(a => ({ adv: a, ...aggregate(byAdv.get(a)) }));

    const maxSpend = Math.max(...rows.map(r => r.spend || 0), 1);
    const tr = (r) => `<tr>
      <td>${r.adv}</td>
      <td class="right">${fmt.money(r.spend)} <span class="bar" style="width:${(r.spend / maxSpend) * 30}px"></span></td>
      <td class="right">${fmt.num(r.leads)}</td>
      <td class="right">${fmt.num(r.cust)}</td>
      <td class="right">${fmt.money(r.cpl, 0)}</td>
      <td class="right">${fmt.money(r.cac, 0)}</td>
      <td class="right">${fmt.roas(r.roas)}</td>
    </tr>`;

    el.innerHTML = `<table>
      <thead><tr>
        <th>Advertiser</th><th>Spend</th><th>Leads</th><th>Cust.</th><th>CPL</th><th>CAC</th><th>ROAS</th>
      </tr></thead>
      <tbody>${rows.map(tr).join('')}</tbody>
    </table>`;
  }

  // -- Heatmap (CPL vs benchmark) -------------------------------------------
  function renderHeatmap() {
    const el = document.getElementById('heatmap');
    const countries = ['Singapore', 'Dubai'];
    const channels = ['Meta', 'Search', 'Performance Max'];
    const advs = state.filters.advertiserView === 'split'
      ? [...new Set(state.rows.map(r => r.advertiser).filter(Boolean))]
      : ['All advertisers'];

    const cell = (rows) => {
      const a = aggregate(rows);
      if (!a.spend || !a.leads) return `<div class="heat-cell empty"><span class="hv">—</span></div>`;
      const bench = blendedBenchmark(rows, 'cpl');
      const variance = (a.cpl && bench) ? (a.cpl - bench) / bench : null;
      let cls = 'warn';
      if (variance === null) cls = 'empty';
      else if (variance <= CFG.HEATMAP_THRESHOLDS.good) cls = 'good';
      else if (variance <= CFG.HEATMAP_THRESHOLDS.bad)  cls = 'warn';
      else                                               cls = 'bad';
      const delta = variance !== null ? `${variance >= 0 ? '+' : ''}${(variance*100).toFixed(0)}%` : '';
      return `<div class="heat-cell ${cls}" title="CPL ${fmt.money(a.cpl, 2)} vs bench ${fmt.money(bench, 2)}"><span class="hv">${fmt.money(a.cpl, 0)}</span><span class="hd">${delta}</span></div>`;
    };

    let html = '';
    // Header row 1 (country grouping)
    html += '<div></div>';
    for (const c of countries) {
      html += `<div class="heat-head country-hdr" style="grid-column: span 3">${c}</div>`;
    }
    // Header row 2 (channel)
    html += '<div></div>';
    for (const c of countries) for (const ch of channels) html += `<div class="heat-head">${ch}</div>`;

    // Data rows per advertiser
    for (const adv of advs) {
      html += `<div class="heat-row-label">${adv}</div>`;
      for (const country of countries) {
        for (const channel of channels) {
          const rows = state.rows.filter(r =>
            r.country === country &&
            r.channel === channel &&
            (adv === 'All advertisers' || r.advertiser === adv) &&
            state.filtered.some(fr => fr.dateKey === r.dateKey)
          );
          html += cell(rows);
        }
      }
    }
    el.innerHTML = html;
  }

  // -- Funnel ---------------------------------------------------------------
  function renderFunnel() {
    const el = document.getElementById('funnel');
    const a = aggregate(state.filtered);
    const max = Math.max(a.impr || 0, 1);
    const pct = (v) => max ? (v / max) * 100 : 0;
    const conv = (num, den) => (den && num) ? `${((num/den)*100).toFixed(2)}%` : '—';

    const stage = (lbl, val, pctW, sub) => `
      <div class="funnel-row">
        <span class="funnel-label">${lbl}</span>
        <div class="funnel-bar" style="width: ${Math.max(pctW, 4)}%">${fmt.num(val)}</div>
        <span class="funnel-conv">${sub}</span>
      </div>`;

    el.innerHTML = `<div class="funnel-wrap">
      ${stage('Impressions', a.impr, 100, '')}
      ${stage('Clicks',      a.clicks, pct(a.clicks), `CTR <strong>${conv(a.clicks, a.impr)}</strong>`)}
      ${stage('Leads',       a.leads,  pct(a.leads),  `CR <strong>${conv(a.leads, a.clicks)}</strong>`)}
      ${stage('Customers',   a.cust,   pct(a.cust),   `Close <strong>${conv(a.cust, a.leads)}</strong>`)}
    </div>`;
  }

  // -- Anomalies ------------------------------------------------------------
  function renderAnomalies() {
    const list = document.getElementById('anomaly-list');
    const flags = [];

    for (const r of state.filtered) {
      if (r.spendActual >= CFG.ANOMALY_THRESHOLDS.zeroLeadSpendMin && (!r.leads || r.leads === 0)) {
        flags.push({
          cls: 'bad', icon: '!',
          title: `${fmt.money(r.spendActual)} spent, 0 leads`,
          meta: `${r.country} · ${r.channel} · ${r.advertiser} · ${fmt.date(r.date)}`,
          sortKey: r.spendActual * 1000,
        });
      }
      if (r.cplVsBench !== null && r.cplVsBench > CFG.ANOMALY_THRESHOLDS.cplVsBenchmarkRed) {
        flags.push({
          cls: 'warn', icon: '△',
          title: `CPL ${fmt.money(r.cpl, 0)} is ${(r.cplVsBench*100).toFixed(0)}% over benchmark`,
          meta: `${r.country} · ${r.channel} · ${r.advertiser} · ${fmt.date(r.date)}`,
          sortKey: r.cplVsBench * 100,
        });
      }
      if (r.roas !== null && r.roas < CFG.ANOMALY_THRESHOLDS.minRoas && r.spendActual > 0) {
        flags.push({
          cls: 'bad', icon: '↓',
          title: `ROAS ${fmt.roas(r.roas)} below break-even`,
          meta: `${r.country} · ${r.channel} · ${r.advertiser} · ${fmt.date(r.date)}`,
          sortKey: (1 - r.roas) * 1000,
        });
      }
    }

    flags.sort((a, b) => b.sortKey - a.sortKey);
    const top = flags.slice(0, 30);

    document.getElementById('anomaly-count').textContent = flags.length
      ? `${flags.length} flag${flags.length !== 1 ? 's' : ''}`
      : '';

    if (top.length === 0) {
      list.innerHTML = '<li class="anomaly-empty">All clear. No red flags in this window.</li>';
      return;
    }

    list.innerHTML = top.map(f => `
      <li class="anomaly-item">
        <div class="anomaly-icon ${f.cls}">${f.icon}</div>
        <div class="anomaly-body">
          <div>${f.title}</div>
          <div class="anomaly-meta">${f.meta}</div>
        </div>
      </li>`).join('');
  }

  // -- Day of week ----------------------------------------------------------
  function renderDOW() {
    const el = document.getElementById('dow-bars');
    const dowOrder = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const byDow = {};
    for (const d of dowOrder) byDow[d] = [];
    for (const r of state.filtered) {
      const name = new Date(r.date).toLocaleDateString('en-US', { weekday: 'short' });
      if (byDow[name]) byDow[name].push(r);
    }
    const aggs = dowOrder.map(d => ({ day: d, ...aggregate(byDow[d]) }));
    const maxRoas = Math.max(...aggs.map(a => a.roas || 0), 1);
    const bestRoas = Math.max(...aggs.map(a => a.roas || 0));

    el.innerHTML = aggs.map(a => {
      const h = maxRoas ? Math.max((a.roas || 0) / maxRoas * 100, 2) : 2;
      const best = (a.roas && a.roas === bestRoas) ? 'best' : '';
      const tip = a.roas ? `${a.roas.toFixed(2)}x ROAS` : 'No data';
      return `<div class="dow-col">
        <div style="height:100%; display:flex; align-items:end; width:100%;">
          <div class="dow-bar ${best}" style="height:${h}%" data-tooltip="${tip}"></div>
        </div>
        <div class="dow-value">${a.roas ? a.roas.toFixed(1)+'x' : '—'}</div>
        <div class="dow-label">${a.day}</div>
      </div>`;
    }).join('');
  }

  // -- MTD pacing -----------------------------------------------------------
  function renderPacing() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth()+1, 0);
    const daysElapsed = Math.max(1, Math.ceil((now - monthStart) / 86400000));
    const daysTotal = monthEnd.getDate();

    const rows = state.rows.filter(r =>
      r.date >= monthStart && r.date <= now &&
      state.filters.countries.has(r.country) &&
      state.filters.channels.has(r.channel)
    );
    const a = aggregate(rows);

    const monthlyTarget = a.target * (daysTotal / daysElapsed); // extrapolate target
    const projected = a.spend * (daysTotal / daysElapsed);

    const metric = (lbl, val, sub, prog, target) => `
      <div class="pacing-metric">
        <div class="pacing-label">${lbl}</div>
        <div class="pacing-big">${val}</div>
        <div class="pacing-progress">
          <span style="width:${clamp(prog*100, 0, 100)}%"></span>
          ${target !== undefined ? `<div class="target" style="left:${clamp(target*100, 0, 100)}%"></div>` : ''}
        </div>
        <div class="pacing-foot">${sub}</div>
      </div>`;

    const spendProg = a.target ? a.spend / a.target : 0;
    const paceTarget = daysElapsed / daysTotal;
    const revProgMonth = 0; // we don't have monthly revenue target in perf sheet
    const custProg = a.cust > 0 ? 1 : 0;

    document.getElementById('pacing').innerHTML = `
      ${metric('Spend MTD',
        `${fmt.money(a.spend)} / ${fmt.money(a.target)}`,
        `${(spendProg*100).toFixed(0)}% of MTD target · projected month-end ${fmt.money(projected)}`,
        spendProg, paceTarget)}
      ${metric('Customers MTD',
        `${fmt.num(a.cust)}`,
        `Avg CAC ${fmt.money(a.cac, 0)} · conv rate ${fmt.pct(a.convRate)}`,
        custProg)}
      ${metric('Revenue MTD',
        `${fmt.money(a.rev)}`,
        `Blended ROAS ${fmt.roas(a.roas)} · projected ${fmt.money(a.rev * (daysTotal / daysElapsed))}`,
        Math.min(a.rev / Math.max(projected, 1), 1))}
    `;
  }

  // -- Data table -----------------------------------------------------------
  function renderTable() {
    const t = state.table;
    const q = t.search.toLowerCase();
    let rows = state.filtered.filter(r =>
      !q ||
      (r.campaign || '').toLowerCase().includes(q) ||
      (r.notes || '').toLowerCase().includes(q) ||
      r.country.toLowerCase().includes(q) ||
      r.channel.toLowerCase().includes(q) ||
      r.advertiser.toLowerCase().includes(q) ||
      fmt.date(r.date).toLowerCase().includes(q)
    );

    rows.sort((a, b) => {
      const A = a[t.sortKey], B = b[t.sortKey];
      if (A === null || A === undefined) return 1;
      if (B === null || B === undefined) return -1;
      if (A instanceof Date) return (t.sortDir === 'asc' ? 1 : -1) * (A - B);
      if (typeof A === 'number') return (t.sortDir === 'asc' ? 1 : -1) * (A - B);
      return (t.sortDir === 'asc' ? 1 : -1) * String(A).localeCompare(String(B));
    });

    const cols = [
      { key: 'date',        label: 'Date',     cls: 'left',  fmt: (v) => fmt.date(v) },
      { key: 'country',     label: 'Country',  cls: 'left',  fmt: (v) => v },
      { key: 'channel',     label: 'Channel',  cls: 'left',  fmt: (v) => v },
      { key: 'advertiser',  label: 'Adv.',     cls: 'left',  fmt: (v) => v },
      { key: 'spendActual', label: 'Spend',    cls: 'right', fmt: (v) => fmt.money(v, 2) },
      { key: 'impr',        label: 'Impr.',    cls: 'right', fmt: (v) => fmt.num(v) },
      { key: 'clicks',      label: 'Clicks',   cls: 'right', fmt: (v) => fmt.num(v) },
      { key: 'ctr',         label: 'CTR',      cls: 'right', fmt: (v) => fmt.pct(v, 2) },
      { key: 'leads',       label: 'Leads',    cls: 'right', fmt: (v) => fmt.num(v) },
      { key: 'cpl',         label: 'CPL',      cls: 'right', fmt: (v) => fmt.money(v, 2) },
      { key: 'newCust',     label: 'Cust.',    cls: 'right', fmt: (v) => fmt.num(v) },
      { key: 'cac',         label: 'CAC',      cls: 'right', fmt: (v) => fmt.money(v, 0) },
      { key: 'revenue',     label: 'Revenue',  cls: 'right', fmt: (v) => fmt.money(v, 0) },
      { key: 'roas',        label: 'ROAS',     cls: 'right', fmt: (v) => fmt.roas(v) },
    ];

    const pageRows = rows.slice(t.page * t.pageSize, (t.page + 1) * t.pageSize);

    const th = cols.map(c => `<th data-sort="${c.key}" class="${t.sortKey === c.key ? 'sorted ' + t.sortDir : ''}">${c.label}</th>`).join('');
    const trs = pageRows.map(r => `<tr>${cols.map(c => `<td class="${c.cls}">${c.fmt(r[c.key])}</td>`).join('')}</tr>`).join('');

    document.getElementById('data-table').innerHTML =
      `<thead><tr>${th}</tr></thead><tbody>${trs || `<tr><td colspan="${cols.length}" style="padding:30px;text-align:center;color:var(--ink-mute);font-style:italic">No rows match these filters</td></tr>`}</tbody>`;

    document.getElementById('table-count').textContent = `${rows.length} row${rows.length !== 1 ? 's' : ''}`;

    const totalPages = Math.max(1, Math.ceil(rows.length / t.pageSize));
    document.getElementById('table-foot').innerHTML = `
      <span>Showing ${Math.min(t.page * t.pageSize + 1, rows.length)}–${Math.min((t.page+1) * t.pageSize, rows.length)} of ${rows.length}</span>
      <span>
        <a href="#" class="pg-prev" style="color:inherit;margin-right:12px">← Prev</a>
        Page ${t.page+1} / ${totalPages}
        <a href="#" class="pg-next" style="color:inherit;margin-left:12px">Next →</a>
      </span>
    `;
  }

  // =========================================================================
  // EVENT WIRING
  // =========================================================================
  function wireEvents() {
    // Filter bar clicks
    const fb = document.getElementById('filter-bar');
    if (fb) {
      fb.addEventListener('click', (e) => {
        const t = e.target;
        if (t.matches('[data-range]')) {
          state.filters.range = t.dataset.range;
          refresh();
        } else if (t.matches('[data-country]')) {
          toggleSet(state.filters.countries, t.dataset.country);
          if (state.filters.countries.size === 0) state.filters.countries.add(t.dataset.country); // keep at least one
          refresh();
        } else if (t.matches('[data-channel]')) {
          toggleSet(state.filters.channels, t.dataset.channel);
          if (state.filters.channels.size === 0) state.filters.channels.add(t.dataset.channel);
          refresh();
        } else if (t.matches('[data-adv]')) {
          state.filters.advertiserView = t.dataset.adv;
          refresh();
        }
      });
    }

    // Refresh link
    const rn = document.getElementById('refresh-now');
    if (rn) rn.addEventListener('click', (e) => { e.preventDefault(); loadData(); });

    // Table
    const search = document.getElementById('table-search');
    if (search) search.addEventListener('input', (e) => {
      state.table.search = e.target.value;
      state.table.page = 0;
      renderTable();
    });

    const table = document.getElementById('data-table');
    if (table) table.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      const key = th.dataset.sort;
      if (state.table.sortKey === key) {
        state.table.sortDir = state.table.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.table.sortKey = key;
        state.table.sortDir = 'desc';
      }
      renderTable();
    });

    const foot = document.getElementById('table-foot');
    if (foot) foot.addEventListener('click', (e) => {
      if (e.target.classList.contains('pg-prev')) {
        e.preventDefault();
        state.table.page = Math.max(0, state.table.page - 1);
        renderTable();
      } else if (e.target.classList.contains('pg-next')) {
        e.preventDefault();
        state.table.page = state.table.page + 1;
        renderTable();
      }
    });
  }

  function toggleSet(set, v) {
    if (set.has(v)) set.delete(v);
    else set.add(v);
  }

  function refresh() {
    applyFilters();
    // Re-render filter chips without losing event binding
    document.getElementById('filter-bar').innerHTML = renderFilters();
    renderAll();
  }

  // =========================================================================
  // INIT
  // =========================================================================
  renderShell();
  loadData();

  if (CFG.AUTO_REFRESH_MINUTES > 0) {
    setInterval(loadData, CFG.AUTO_REFRESH_MINUTES * 60 * 1000);
  }

})();
