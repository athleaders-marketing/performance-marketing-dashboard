// ============================================================================
// ATHLEADERS DASHBOARD CONFIG
// ----------------------------------------------------------------------------
// Edit values here and commit. No logic lives in this file.
// ============================================================================

window.CONFIG = {
  // -----------------------------------------------------------------
  // GOOGLE SHEET SOURCE
  // -----------------------------------------------------------------
  // Pulled from your published URL:
  // https://docs.google.com/spreadsheets/d/e/<PUBLISH_ID>/pubhtml
  PUBLISH_ID: '2PACX-1vSuoh1oGdTTBnwkGxj8zZoVijqyDe_os0ZEo3klZ10NTfT2OpzzDH7XcmonUMC9aPo69cG_kyz7r-ae',

  // gid of the "Perf Marketing Tracker" tab.
  // HOW TO FIND IT (30 seconds):
  //   1. Open your published sheet URL in a browser
  //   2. Click the "Perf Marketing Tracker" tab at the bottom
  //   3. Look at the URL bar, copy the number after "gid="
  //   4. Paste it below
  // If left as null, the dashboard will try to auto-discover it.
  PERF_MARKETING_GID: '577055534',

  // -----------------------------------------------------------------
  // BENCHMARKS (extracted from your sheet's formulas)
  // -----------------------------------------------------------------
  // Format: BENCHMARKS[country][channel] = { cpl, cac, spendTarget }
  BENCHMARKS: {
    Singapore: {
      Meta:             { cpl: 18, cac: 265.49, spendTarget: 38.41 },
      Search:           { cpl: 40, cac: 237.81, spendTarget: 47.69 },
      'Performance Max':{ cpl: 31, cac: 208.89, spendTarget: 48.24 },
    },
    Dubai: {
      Meta:             { cpl: 25, cac: 312.50, spendTarget: 27.52 },
      Search:           { cpl: 52, cac: 371.43, spendTarget: 32.71 },
      'Performance Max':{ cpl: 42, cac: 350.00, spendTarget: 41.11 },
    },
  },

  // Currency for display
  CURRENCY: 'SGD',
  CURRENCY_SYMBOL: 'S$',

  // Target ROAS for the line overlay on ROAS chart
  ROAS_TARGET: 3.0,

  // Thresholds for heatmap cell colouring (CPL vs Benchmark, as decimal)
  //   green  if variance <= GOOD_THRESHOLD (at or below benchmark)
  //   amber  if variance between GOOD and BAD
  //   red    if variance >  BAD_THRESHOLD (well above benchmark)
  HEATMAP_THRESHOLDS: {
    good: 0.0,   // at benchmark or better
    bad:  0.20,  // 20% above benchmark
  },

  // Anomaly detection thresholds
  ANOMALY_THRESHOLDS: {
    cplVsBenchmarkRed: 0.5,  // CPL > 150% of benchmark
    minRoas: 1.0,            // ROAS < 1 means losing money
    zeroLeadSpendMin: 10,    // flag if spent >S$10 and got 0 leads
  },

  // Refresh the sheet data every N minutes (0 = off)
  AUTO_REFRESH_MINUTES: 15,
};
