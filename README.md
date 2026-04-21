# Athleaders · Performance Marketing Dashboard

A zero-build, single-page dashboard that reads directly from your published Google Sheet and turns the **Perf Marketing Tracker** tab into a live analytical view.

Designed for daily review by the marketing team. Hosted as a static site (GitHub Pages / Netlify / Vercel / any static host).

---

## What it shows

- **Hero KPIs** — Spend (actual vs target), Leads, New Customers, Revenue Attributed, Blended ROAS, Blended CPL, Blended CAC, CTR/CPC, all with deltas vs prior period and vs benchmark
- **Time series** — Daily Spend vs Target, Leads & Customers, ROAS trajectory, CPL & CAC against their blended benchmarks
- **Segment performance** — Singapore vs Dubai scorecards, Channel spend mix (donut), In-house vs Ice Cube head-to-head
- **Benchmark heatmap** — Country × Channel × Advertiser matrix, coloured by CPL variance vs benchmark (green / amber / red)
- **Conversion funnel** — Impressions → Clicks → Leads → Customers with stage conversion rates
- **Anomaly flags** — Days with spend but zero leads, CPL more than 150% of benchmark, ROAS below 1
- **Day-of-week patterns** — ROAS by weekday, best day highlighted
- **Monthly pacing** — MTD actual vs target with projected month-end landing
- **Data explorer** — Sortable, searchable, paginated table of every row

All sections respect the global filters: date range (7D / 30D / MTD / All), Country, Channel, and Combined or Split advertiser view.

---

## One-time setup (2 minutes)

### 1. Find the gid for the Perf Marketing Tracker tab

1. Open your published sheet URL in a browser
2. Click the **Perf Marketing Tracker** tab at the bottom
3. Look at the URL bar, copy the number after `gid=`
4. Open `config.js` and paste it into `PERF_MARKETING_GID`

If you skip this step, the dashboard will try to auto-discover the gid by scraping the pubhtml index. That works most of the time but is slower and more fragile. Hardcoding is better.

### 2. (Optional) Adjust benchmarks

If your CPL / CAC / Spend targets change, edit `BENCHMARKS` in `config.js`. The values currently match what's in your sheet's formulas:

```
Singapore  Meta   CPL $18  CAC $265.49  Target $38.41/day
Singapore  Search CPL $40  CAC $237.81  Target $47.69/day
Singapore  PMax   CPL $31  CAC $208.89  Target $48.24/day
Dubai      Meta   CPL $25  CAC $312.50  Target $27.52/day
Dubai      Search CPL $52  CAC $371.43  Target $32.71/day
Dubai      PMax   CPL $42  CAC $350.00  Target $41.11/day
```

---

## Running locally

Because browsers block `file://` requests to external URLs, you need a tiny local server. Any of these work:

```bash
# Python
python3 -m http.server 8000

# Node
npx serve .

# PHP
php -S localhost:8000
```

Then open `http://localhost:8000`.

---

## Deploying

### GitHub Pages (simplest)

1. Push this folder to a new GitHub repo
2. Go to **Settings → Pages**
3. Source: `Deploy from a branch`, Branch: `main` (or `gh-pages`), folder: `/ (root)`
4. Done. Live at `https://<your-username>.github.io/<repo-name>/`

### Netlify / Vercel

Drag and drop the folder, or connect the repo. No build command, publish directory is the repo root.

---

## How the data flow works

```
Google Sheet (published to web)
        │
        ▼  CSV endpoint
   PapaParse (client-side parser)
        │
        ▼
  Row normalization + metric derivation
        │
        ▼
   Filter state (Date, Country, Channel, Advertiser)
        │
        ▼
   Aggregations per section
        │
        ▼
  Chart.js + HTML/CSS rendering
```

The dashboard refetches the CSV every `AUTO_REFRESH_MINUTES` (default 15). Users can also click **Refresh now** in the footer.

No backend, no database, no API key. The sheet being "Published to web" is enough.

---

## Files

```
index.html      # Entry point, loads fonts + deps + config + app
config.js       # Edit here: sheet ID, gid, benchmarks, thresholds
styles.css      # Full design system (can be customized without touching logic)
app.js          # Data fetching, normalization, filtering, rendering
README.md       # This file
```

---

## Customization cheat-sheet

| Want to…                                    | Edit                                                     |
| ------------------------------------------- | -------------------------------------------------------- |
| Change the sheet or tab                     | `config.js` → `PUBLISH_ID`, `PERF_MARKETING_GID`         |
| Update CPL / CAC benchmarks                 | `config.js` → `BENCHMARKS`                               |
| Change the ROAS target line                 | `config.js` → `ROAS_TARGET`                              |
| Change anomaly thresholds                   | `config.js` → `ANOMALY_THRESHOLDS`                       |
| Change heatmap green/amber/red cut-offs     | `config.js` → `HEATMAP_THRESHOLDS`                       |
| Change refresh interval                     | `config.js` → `AUTO_REFRESH_MINUTES`                     |
| Change colors / fonts                       | `styles.css` → `:root` variables                         |
| Add a new chart or section                  | `app.js` → `renderSections()` + new render function      |

---

## Troubleshooting

**Dashboard shows "Could not find the Perf Marketing Tracker tab"**
Open `config.js` and set `PERF_MARKETING_GID` to the gid of that tab. Step-by-step in the setup section above.

**Dashboard loads but everything says "—"**
Your sheet probably has target rows but no actual spend/leads yet. As soon as the team starts filling in `Spend Actual`, `Leads`, `New Cust.`, etc., the dashboard will populate.

**"Sheet fetch failed: HTTP 404"**
The sheet is not actually published to web, or the publish was revoked. Go to the sheet → File → Share → Publish to web.

**CORS errors in the browser console**
The published CSV endpoint has open CORS. If you're seeing errors, you're probably opening `index.html` as a file (`file://`) rather than through a server. Run a local server as shown above.
