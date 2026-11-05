# Lodestar

A stock-market research terminal with machine-learning forecasts, an opportunity scanner, backtesting, and paper trading. Run it on your own computer with the Python engine for everything, or host the website on its own: every feature then runs in the visitor's browser, including model training, the scanner, the autopilot, backtests and Practice trading.

> **Not financial advice.** Lodestar produces statistical estimates from past data. They can be wrong, and past performance (including backtests) does not predict future results. Real-money trading is not implemented; paper trading and the AI autopilot use virtual money only.

---

## Quick start (Windows)

1. **Install Python 3.12** (3.11 and 3.13 also work) from <https://www.python.org/downloads/windows/>.
   During setup, tick **"Add python.exe to PATH"**.
2. **Unzip** `lodestar-0.5.0.zip` somewhere permanent, for example `Documents\Lodestar`.
3. **Double-click `start.bat`.**
   - The first run creates a private Python environment and installs packages (2–5 minutes, needs internet).
   - Your browser opens at <http://127.0.0.1:8765> when it's ready.
   - Keep the black console window open while you use the app. Close it (or press Ctrl+C) to stop.
4. On first launch the app is in **Simulation mode** and trains its first model automatically (about 30–60 seconds). Watch the "Training" indicator in the top bar.

You do **not** need Node.js. The interface is prebuilt in `frontend/dist`.

macOS / Linux: run `./start.sh` instead.

## New in 0.5

- **A real standalone site.** `frontend/dist` runs on any static host with no server. See [Hosting the site](#hosting-the-site).
- **Market map** (Markets → Market map, and on the Overview): every stock sized by market cap, coloured by today, 1W, 1M, 3M or 1Y.
- **Screener** (Research → Screener): filter on price, change, relative volume, RSI, ATR, P/E, market cap, trend and earnings dates. Six presets, your own saved screens, CSV export.
- **Trade journal** (Trade → Trade journal): fills become round trips with P&L, return and R multiple, plus win rate, profit factor, expectancy, a daily P&L calendar and breakdowns by setup and weekday. Tag setups, grade execution, take notes, export CSV.
- **Calendar** (Markets → Calendar): earnings, Fed decisions, options expiry, jobs reports and market holidays, for everything or only your holdings and watchlists.
- **Size by risk**: in the order ticket, set a stop and pick 0.5%, 1% or 2% of equity. Lodestar works out the shares and shows the R to your target.
- **Better charts**: zoom and scroll survive data refreshes, charts of the same timeframe scroll together, and you can mark price levels, turn one into an alert, or compare against a second symbol.
- **Faster everywhere**: screens load ahead of the click, symbol and timeframe changes no longer flash a skeleton, and quote bursts render once per frame.
- **Quieter interface**: graphite surfaces, one brass accent, IBM Plex Mono figures, a status bar with index moves and the trading session, and `?` for keyboard shortcuts.
- Install it as an app from the browser menu. It opens offline once visited.

## New in 0.4

- **The AI actually trades now.** A new **How picky** setting (top-bar AI menu, or AI autopilot → Your rules) decides which ideas it may act on:
  - **Strict**: only ideas that pass every scanner threshold (the old behaviour; often nothing for days).
  - **Balanced** (default): ideas the model rates positive after costs (expected return above 0.1%, edge above 0.5 points).
  - **Active**: any idea with a positive expected result after costs.

  It never trades a negative expected result, and the safety rules (stale prices, thin trading, wide spreads, earnings days) always apply. Each AI trade says which level let it through.
- **Practice trading** (Trade → Practice trading; this was "Sandbox replay"): fake trades with play money, priced from real market data. Choose **real live prices right now** (Yahoo free, or Alpaca with keys) or **real past prices sped up 1x–100x**.
- **Live trades panel** (⇄ in the top bar):
  - Tabs for **All trades**, **AI trades** (every buy and sell the AI makes, plus its stop-loss and take-profit orders) and **AI decisions** (buys, sells, proposals and blocked trades with reasons).
  - A status line shows what the AI is doing right now.
  - **Pin** keeps the panel open beside every page.
- **Saved themes**: in Theme studio, **Create new theme**, give it any name, change colours, font, text size, spacing, corners and animation, and save. Your themes appear under **Your themes**, where you can switch, edit, duplicate, export to a file, import or delete them.
- **Money in the Turbo simulator**: choose the **starting money**, watch the balance change trade by trade as the AI buys and sells (Watch / Fast / Skip), then see a **profit summary**:
  - typical ending money, profit and profit margin;
  - best and worst market, and how many markets made money;
  - average profit per trade, and money won on winners vs lost on losers.

## New in 0.3

- **Trading on/off switch** (top right): replaces the old Stop trading button. **On** = you and the AI may trade. **Off** = no new orders are placed or filled; stop-loss and take-profit exits on positions you hold keep protecting you and you can still close positions. Switching back on resumes everything. "Also cancel waiting orders" is offered when switching off.
- **See every trade clearly**: a live trade feed (top-bar ⇄ button, the Trade desk and the AI autopilot screen) shows who traded (**You**, **AI**, **Stop-loss**, **Take-profit**), what, how many, the price and total, the profit or loss when closing, **why** (the AI's reasoning), and **where** (your paper account or a replay account). Orders waiting to fill are listed with their trigger prices. Buy/sell arrows appear on the price charts, and every fill pops up a notification.
- **AI trading control** (top bar): start or stop AI trading at any moment, choose **Full auto** or **Ask me first**, pause it for 15 minutes to a day (the switch stays on and it resumes by itself), or set a time for it to switch itself off. It ranks ideas best-first, never trades an idea whose expected result after costs is not positive, and can swap its weakest position for a clearly better idea when all slots are full. In Sandbox, an optional **Practice mode** lets it trade even when the model has not passed validation (clearly labelled).
- **Sandbox replay at 10x–100x** (now called Practice trading): replays real past market data on a fast clock: 1x, 10x, 25x, 50x, 75x or 100x (at 100x a trading day takes about 3.9 minutes). About ten years of real daily prices are downloaded once from Yahoo (or Alpaca with keys) and cached. Each day's real open, high, low and close are fixed; the minute-by-minute path between them is synthetic. Charts, quotes, the scanner and the model only ever see data up to the replay clock; the model is trained on the years before your start date and the clock pauses while it trains. Replays use their own account, compare your result with holding SPY, and leave your normal paper account untouched.

## New in 0.2

- **Trade desk** (Trade → Trade desk): one place to buy and sell. A clear order ticket (shares or dollars, market/limit/stop, quick "% of cash" buttons, "Suggest from AI plan") shows the estimated cost and the cash you'd have left before you submit. Above it, an account panel shows equity, cash, available to trade, cash reserved by working orders, invested, profit and return, deposits and withdrawals, total bought and sold, fees, win rate and an allocation bar.
- **Sandbox mode** (the purple switch in the top bar): a no-stakes practice mode. When it's **on** you can deposit any amount of play money. When it's **off**, deposits are blocked and you can never spend or withdraw more than you actually have. Turning it on can also switch the app to simulated prices.
- **AI autopilot** (Trade → AI autopilot): lets the AI buy and sell by itself using the scanner's qualified ideas and the trained model. You decide when it may act: off, market hours only, extended hours, always, or a custom time window and days. **Approve mode** makes it propose trades for you to accept or reject instead of placing them. Limits cover max positions, position size, trades per day, a daily-loss pause, shorts on/off and a watchlist-only option. Every decision (and every skipped idea, with the reason) is logged. Switching **Trading** off in the top bar makes it wait.
- **Turbo simulator** (AI lab → Turbo simulator): a vectorised engine that simulates millions of trades per minute (about 2–6 million/min in the core engine on a typical laptop) across many markets at once, so you see the range of outcomes rather than one lucky history. AI signals are always from a model trained only on earlier data. Compare against random entries to see whether the AI adds anything.
- **Several prediction methods** (AI lab → Models and methods): logistic regression, gradient boosting, random forest (extra trees), nearest neighbours, a simple four-factor model, and an ensemble. Each is validated walk-forward; you can let Lodestar pick the best-calibrated one or force a method. Stock research shows how each method sees a stock.

## What works without any API keys

Everything. Simulation mode generates a realistic synthetic market (40 stocks, ETFs, intraday bars, headlines, fundamentals), clearly labelled **Simulated** everywhere. Use it to learn the screens, train models, run backtests and practise paper trading safely.

The simulator deliberately contains patterns the models can learn, so you can see the whole pipeline working. **Good results on simulated data tell you nothing about real markets.**

## Connecting real market data

### Option A: Alpaca (recommended, free, real-time)

1. Create a free account at <https://alpaca.markets>.
2. In the Alpaca dashboard, switch to **Paper Trading** and generate an **API key ID** and **secret key**. Paper keys work for market data, and no money is involved.
3. In Lodestar open **Data providers**, paste both keys under Alpaca Market Data, click **Save keys**, then **Test connection**. You should see an SPY price.
4. Click **Use this source**. Lodestar downloads about five years of daily history for the universe and retrains a model for real data (a few minutes on the first run).

What the free plan gives you:

- Real-time quotes from the **IEX exchange only**, a single venue with a few percent of total volume. Prices are real; volume and bid/ask are partial. These quotes are labelled **Live**.
- Consolidated history delayed 15 minutes.
- 200 requests per minute; Lodestar's built-in rate limiter stays under this.
- News headlines.

Alpaca provides no fundamentals or earnings dates, so Lodestar fetches those from Yahoo when it can.

### Option B: Yahoo Finance (no key, delayed)

In **Data providers**, click **Use this source** on Yahoo Finance.

- This uses the unofficial `yfinance` library: Yahoo can throttle or change it without notice.
- Quotes are treated as **Delayed** and refreshed at most every 30 seconds.
- It is for personal research only; check Yahoo's terms.

### Optional: AI-written explanations

The **AI explanations** screen always offers a deterministic rule-based summary. To also get plain-English narratives written by Claude:

1. Add an Anthropic API key under **Data providers → AI narratives**.
2. Switch **Enable AI narratives** on.

Usage is billed by Anthropic to your key. The model receives only the computed analysis and is instructed not to add facts.

Keys are stored in the `.env` file in your Lodestar folder, never in the database, and are masked whenever the app displays them.

## Hosting the site

The site works in three ways, and picks by itself when it loads:

| How it is served | What runs | What you get |
|---|---|---|
| `start.bat` / `start.sh` | Python engine on your computer | Everything |
| Static host, engine address saved | The hosted site talks to your engine | Everything |
| Static host alone | A browser engine inside the page, with model jobs in a Web Worker | Everything. Models use lighter settings than the Python engine, so a run takes seconds and results differ somewhat. The AI explanations use the rule-based writer, Yahoo data is unavailable (it blocks websites), and the scanner and autopilot run only while the tab is open. Reloading ends a Practice session and keeps your normal account |

**Publishing the site.** Build it, then upload `frontend/dist`:

```bash
cd frontend && npm install && npm run build
```

Netlify and Cloudflare Pages use the included `_redirects`. Vercel uses the `vercel.json` in the same folder: from `frontend`, run `npx vercel deploy dist --prod --project your-project`. Any host works if it serves `index.html` for unknown paths.

**In browser mode** prices are simulated and labelled so. For real prices open **Data providers**, add free Alpaca keys and choose Alpaca: the browser calls Alpaca directly. Keys, paper trades, settings and trained models stay in that browser, so use it on a device you trust, and clearing site data erases them.

**Connecting a hosted site to your engine.** Open **Data providers → Python engine** and enter its address and token. On the engine, in `.env`:

```
LODESTAR_HOST=0.0.0.0
LODESTAR_CORS_ORIGINS=https://your-site.example
LODESTAR_API_TOKEN=a-long-random-string
```

Never expose the engine beyond your computer without a token, and put it behind HTTPS: the token and your keys travel over that connection. To build the site with a fixed engine address, set `VITE_API_URL` at build time.

## A typical session

1. **Overview** shows the market regime, sector moves and the scanner's current shortlist.
2. **Opportunity scanner** shows ranked ideas with their evidence, and every rejected idea with the reason. An empty list is a valid answer.
3. **Stock research** gives the chart with the trade plan drawn on it, the forecast with its uncertainty range, supporting versus contradicting evidence, risks and fundamentals.
4. From a research or scanner row, click **Paper trade**, or open the **Trade desk**. The ticket pre-fills a risk-based size and a bracket stop and target, and shows costs and any risk-limit violations before you submit.
5. Optionally switch on the **AI autopilot** (start in Approve mode) and let it work within your limits.
6. Track results under **Trade desk**, **Portfolio analytics** and **Prediction history**. The last of these compares what the model said with what actually happened.

Keyboard shortcuts:

- **Ctrl+K** or **/** opens search.
- **g** then **o**, **s**, **p**, **c**, **m**, **b**, **n** or **d** jumps to Overview, Scanner, Paper, Charts, Models, Backtest, News or Dashboards.
- **t** opens the Trade desk, **a** the AI autopilot, **z** the Turbo simulator (press **g** first).
- Right-click a row in Live monitor for actions.

More in [docs/USER_GUIDE.md](docs/USER_GUIDE.md). How the predictions work: [docs/METHODOLOGY.md](docs/METHODOLOGY.md). How the code is organised: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Where things are stored

| What | Where |
|---|---|
| Database (settings, cached prices, predictions, paper account, dashboards, themes) | `data/lodestar.db` (SQLite) |
| Trained models | `data/models/` |
| Logs | `data/logs/lodestar.log` (also visible under **Diagnostics**) |
| API keys | `.env` |
| Theme choice and display preferences | your browser's local storage |

**Back up:** copy the `data` folder and `.env`.

**Start completely fresh:** stop the app and delete the `data` folder.

## Running the tests

- Double-click `run_tests.bat` after the first `start.bat` run, or run `cd backend && ..\.venv\Scripts\python -m pytest -v`.
- Frontend tests need Node.js 20+: `cd frontend && npm install && npm test`.

## Troubleshooting

**"Lodestar needs Python 3.11, 3.12 or 3.13".** Install Python 3.12 from python.org and tick "Add to PATH". Newer versions (3.14+) may not have compatible scientific packages yet.

**Package install fails** (for example `error: Microsoft Visual C++ 14.0 is required`). You are probably on an unsupported Python version, or 32-bit Python. Install 64-bit Python 3.12 and delete the `.venv` folder so `start.bat` rebuilds it.

**"Port 8765 is already in use".** Lodestar is probably already running in another window, so open <http://127.0.0.1:8765>. Otherwise set `LODESTAR_PORT=8766` in `.env`.

**The browser shows "This site can't be reached".** The console window must stay open. Check it for errors, then refresh.

**Alpaca test fails with HTTP 401/403.** The keys are wrong, or are live-trading keys for a different account. Regenerate paper keys and paste both again. A 403 mentioning SIP means your plan lacks consolidated data: keep the feed on **IEX** (Data providers → Alpaca feed).

**Yahoo stops returning data.** Yahoo throttles unofficial access. Wait a while, or switch to Alpaca. Lodestar keeps serving cached daily bars (labelled **Cached**) while the provider is down.

**The scanner shows no candidates.** That is often correct. Open the **Rejected** tab to see why: a model that failed validation, an edge too small after costs, too much uncertainty, upcoming earnings, and so on. Thresholds are under **Filters and weights**.

**The model "failed validation".** It did not beat the simple baseline out-of-sample, so Lodestar refuses to rank trades with it. With real data this can happen, and it is honest. Try retraining later, changing the horizon or universe in Settings, or a larger universe.

**Everything looks broken after an update.** Delete `.venv` (packages reinstall) and `data/models` (models retrain).

For anything else, open **Diagnostics**: it shows background-job errors, provider errors and recent log lines.

## Known limitations

- **No real-money trading.** The setting exists only as a locked placeholder.
- **Free real-time data is single-venue.** Alpaca's free IEX feed covers one exchange; the consolidated tape (SIP) needs a paid plan, selectable under Data providers.
- **Market holidays** are listed explicitly for 2025–2027 (`backend/lodestar/market_hours.py`). Update the list for later years.
- **Not modelled:** borrow fees and dividends on shorts, partial fills, queue position, or trading halts. Paper fills use the quote plus configured spread and slippage.
- **Corporate actions** rely on the provider's split and dividend adjustment of history. Alpaca and Yahoo both provide adjusted bars.
- **News sentiment** is a transparent word lexicon, not a language model. It misses sarcasm and context.
- **Fundamentals** are limited to what Yahoo exposes, and some fields can be missing.
- **The universe** defaults to 40 large US stocks; add up to a few hundred in Settings. Larger universes make scans and training slower and use more API calls.
- **The bundled models** are scikit-learn methods (logistic, gradient boosting, extra trees, nearest neighbours, a factor model, an ensemble). There is no deep learning: in walk-forward tests on noisy daily data, simpler models usually do as well, and in our own tests the simple factor model often won. Lodestar always reports a baseline comparison.
- **Replays are not forecasts.** Replay results show how a strategy would have done on one stretch of history. Intraday price paths inside each replayed day are synthetic, fundamentals and news are not replayed, and if the app is closed during a replay the replay ends (start a new one).
- **The autopilot is not a money machine.** It only acts on ideas that pass the scanner's filters, so with strict filters it may do nothing for days; that is intended. Turbo-simulator results vary a lot between markets, and on pure-noise markets every strategy loses after costs.
- **One machine, one user.** The server listens on 127.0.0.1 only and has no login.

## Project layout

```
start.bat / start.sh      one-click launchers
backend/                  Python engine (FastAPI)
  lodestar/
    providers/            Alpaca, Yahoo and Simulation adapters; caching, rate limits, health
    analytics/            indicators, nine signal modules, sentiment lexicon
    ml/                   features, labels, models, walk-forward training, calibration, inference
    backtest/             strategy interface + five strategies, event-driven engine, metrics
    paper/                paper broker (orders, brackets/OCO, fills, deposits, sandbox, kill switch)
    autopilot.py          AI autopilot (schedule, limits, approvals, decision log)
    turbo.py              vectorised high-speed multi-market trade simulator
    replay.py             Sandbox historical replay (sped-up clock over real past prices)
    clock.py              the app's notion of "now" (real time, or replay time)
    api/                  REST endpoints
    scanner.py risk.py analysis.py news.py alerts.py live.py ...
  tests/                  pytest suite (124 tests)
frontend/                 React + TypeScript interface (prebuilt in frontend/dist)
docs/                     user guide, methodology, architecture, verification report
```
