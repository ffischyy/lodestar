# Verification report — Lodestar 0.1.0

Date: 26 October 2026. Environment: Linux (Python 3.13, Node 22, Chromium 153 headless). This report states what was actually run, what the results were, and what could **not** be verified here.

## 1. Automated tests (executed)

### Backend — `pytest` — **65 passed, 0 failed** (≈30 s)

| File | Tests | Covers |
|---|---|---|
| `test_indicators_signals.py` | 15 | SMA/EMA/RSI/ATR known values; causality of 7 indicators (altering future bars leaves the past unchanged); Donchian excludes the current bar; signal direction and bounds; insufficient-history flags; breakout detection; sentiment lexicon incl. negation |
| `test_ml.py` | 7 | Features use no future data; labels are NaN for the final *h* rows; triple-barrier target-first and stop-precedence on the same bar; walk-forward windows ordered, purged by ≥ *h* days, each test date used once; metric sanity (perfect model, baseline = 0 skill); calibration error < 5 pts on held-out data; cross-sectional ranks |
| `test_risk_backtest.py` | 13 | Position sizing (risk-bound, position-cap-bound, buying-power-bound, costs, existing holdings); trade-plan geometry long/short; pre-trade checks (buying power, sector cap, halt, exits allowed when halted, shorts disabled); backtest engine stop exit, target exit, **gap through stop fills at the open**, time exit, costs reduce P&L; metrics on a known equity series |
| `test_paper_providers_api.py` | 22 | Paper: partial sell realised P&L, short and cover, bracket OCO (take-profit fills → stop cancelled), stop gap fills at market, duplicate client-order-id ignored, risk rejection recorded, kill switch, wrong-side stop rejected, daily-loss halt blocks entries but allows exits. Data: bar validation; Alpaca adapter against a mocked transport (pagination, SIP→IEX fallback on 403, snapshot parsing, 429 retryable); Yahoo news parsing in both API formats; simulation determinism and labelling; rate limiter. API: settings bounds and refusal to enable live trading; watchlist CRUD; dashboard validation/duplicate/default; theme CSS-injection rejected; alert validation; API keys masked and validated; market endpoints |
| `test_scanner_e2e.py` | 8 | Scanner accepts a good candidate and rejects: stale data, no model, unvalidated model, edge too small after costs, excess uncertainty, illiquidity. **End-to-end**: train → validate (3 model families incl. baseline) → predict → scan → predictions logged |

### Frontend — `vitest` — **17 passed, 0 failed**

Formatting (signs, units, missing values); `Delta` shows sign + arrow, not colour alone; simulated provenance pill; table sort cycle and empty state; **every built-in theme defines all tokens and passes WCAG contrast** for primary/secondary text, gains, losses, accent text and focus ring; contrast math; preference scaling.

### TypeScript — `tsc -b` strict mode — 0 errors. Production build — succeeds (largest chunk 298 kB / 95 kB gzip).

## 2. End-to-end browser workflows (executed with Playwright, real browser against the running app) — **16 / 16 passed**, no uncaught page errors

1. Ctrl+K palette → "NVDA" → research page loads with forecast
2. Order ticket pre-fills a risk-based quantity
3. Market buy fills and shows a toast
4. Position appears under Paper trading
5. Bracket stop + target legs are open
6. Daylight theme applies (body colour verified)
7. Theme persists after reload
8. Compact density applies (`--row-h` = 24px)
9. Contrast checker flags an unreadable custom colour
10. Custom theme saves
11. Dashboard: add widget, save, reload → widget persisted (7 → 8)
12. Kill switch stops trading
13. Paper screen shows the stopped state
14. Trading re-enabled
15. Phone-width navigation drawer navigates
16. No uncaught JavaScript errors throughout

During this pass a real defect was found and fixed: the suggested risk-based size ignored shares already held, so a second buy suggestion breached the 15 % position cap (the ticket correctly blocked it, but the suggestion was wrong). Sizing now subtracts existing exposure; a regression test was added.

## 3. Visual verification (executed)

All 20 screens were rendered and inspected as screenshots at **1440×900**, plus key screens at **1024×768** and **390×844** (phone), and in the **Daylight, Ticker and Aurora** themes. An automated check also measured page-level horizontal overflow and console errors on every render.

Issues found by inspection and fixed before packaging:

| Issue | Fix |
|---|---|
| Scanner table clipped its Edge / Score columns at 1440 px | Provenance pill shown only for abnormal statuses (page banner covers simulation); dollar volume moved to the detail panel; setup labels shortened |
| Rejection-reason labels truncated | Adaptive label width in bar lists |
| Sector tiles clipped the 1-month figure | Wider tiles, wrapping values |
| Model run showed "undefined×ATR" | Training runs started from the UI now persist their full configuration |
| Calibration chart axis title overlapped a tick label | Wider plot margin |
| Backtest "average win / loss" overflowed its cell | Split into two stats; two-column form |
| Dashboard chart widget overflowed its panel | Chart height fitted to the widget |
| Duplicate "Simulated" pill in chart panes | Removed |
| Live monitor listed 23 of 40 stocks | Symbol metadata request was capped at 25 results; limit raised |
| Live monitor table too wide in the monospace theme | Bid/ask merged; "as of" moved into the status tooltip |
| Phone width: 104 px horizontal page overflow from the top bar | Secondary status items hidden < 900 px; search shrinks; panel hints wrap |

Final pass: **0 page-overflow findings and 0 console errors** across all screens and sizes checked.

## 4. Clean-install test (executed)

The release ZIP was extracted into an empty folder and `start.sh` run: it created a new virtual environment, installed `backend/requirements.txt` from PyPI, created `.env` from the template, started the server, trained the first model and served the UI. Result: **passed**. The launcher picked Python 3.12 and resolved current package versions (pandas 3.1.0, NumPy 2.5.4, scikit-learn 1.9.1, FastAPI 0.162). The first model trained in 26 s and passed validation, the first scan returned 5 qualified and 35 rejected, the UI rendered with no console errors, and the full backend suite ran inside that fresh environment: **65 passed**.

## 5. Model behaviour observed (simulation data)

- Out-of-sample (24,920 predictions, May 2024 – Oct 2026): logistic regression AUC 0.586, Brier skill +2.1 % vs baseline, calibration error 2.1 pts → passed all gates; gradient boosting AUC 0.536, Brier skill −0.5 % → **lost to the simpler model**, as reported on the Models screen.
- 80 % forecast interval contained 73.6 % of outcomes (slightly too narrow — displayed in red on the Models screen).
- Scanner: 5 of 40 stocks qualified; 35 rejected (most often for an insufficient probability edge or edge after costs).
- With an earlier simulator seed the model **failed** its gates and the scanner correctly returned **zero** candidates — the "no trade qualifies" path works.
- Backtests on simulated data show strong ML results only because the simulator deliberately contains learnable structure; the app labels this explicitly.

## 6. Not verified here (and why)

| Item | Status | What to do |
|---|---|---|
| Alpaca live connection | Network to `data.alpaca.markets` is blocked in the build environment. The adapter is tested against recorded-format mock responses (bars, pagination, SIP fallback, snapshots, errors). | Add your keys → **Data providers → Test connection** |
| Yahoo Finance connection | Blocked here for the same reason; parsing is unit-tested for both news formats. | Switch provider → Test connection |
| Anthropic narrative call | No key available here; request format follows the Messages API. | Optional — add a key to try |
| `start.bat` on Windows | Written for Windows (Python launcher detection, venv, CRLF); the equivalent `start.sh` flow was run end-to-end. | Run `start.bat`; see README troubleshooting |
| Real-market model quality | Cannot be known in advance. The validation gates decide; a failed model is reported honestly and the scanner then rejects all trades. | See Model evaluation after switching to real data |

## 7. Outstanding known issues

- Holiday calendar ends in 2027.
- Lightweight Charts shows its (licence-required) attribution logo in the lower-left of each chart.
- Paper equity history is sampled once a minute while the app runs; it has gaps when the app is closed.

## 0.2.0 update (sandbox, trade desk, autopilot, turbo, prediction methods)

- Backend: 85 pytest tests pass, including 20 new ones covering sandbox deposits, refusing deposits and overspending outside sandbox, withdrawal limits, reserved cash, the money summary, autopilot buying with brackets, its position cap, off state, daily limit, approval mode, validated-model requirement and kill switch, custom schedules, turbo throughput and honesty (out-of-sample AI signals, gap fills), and all six prediction methods.
- Frontend: TypeScript build clean, 17 vitest tests pass, production build OK.
- Browser checks (Playwright): 12 new-feature flows passed with no page errors; no horizontal overflow at 1440, 1280, 1024 or 390 px on the new pages.
- Turbo throughput, measured in the build container: 20 simulated markets × 200 stocks × 8 years produced 80,932 trades; engine speed 5.67 million trades/min, end-to-end 186 thousand trades/min.
- Turbo results honesty: on weak-pattern markets the AI's median result varied between runs (one 20-market run had a median of −22.9% with 25% of markets profitable; smaller runs were positive). On pure-noise markets every strategy loses after costs, as it should.


## 0.3.0 update (trading switch, trade feed, AI controls, Sandbox replay)

- Backend: 121 pytest tests pass. The 36 new ones cover:
  - the replay's intraday bridge (hits the real open, high, low and close exactly);
  - replay rules: Sandbox-only, allowed speeds, switching the data source and clock;
  - no future bars: today's bar is "so far" and intraday bars stop at the replay clock;
  - speed maths (0.6 s at 100x = 1 market minute) and day rollover; pausing stops time;
  - replay account isolation: the normal account is untouched after a replay, and fills are stamped in replay time;
  - switching Sandbox off ends a replay;
  - the Trading switch: off blocks new orders, stop-losses still fire, closing is allowed, waiting entries are held until it is back on;
  - trade-source attribution (you, AI, stop-loss, take-profit) for entries and exits;
  - autopilot pause, stop-at, and waiting while trading is off;
  - practice mode is Sandbox-only.
- Frontend: TypeScript build clean, 17 vitest tests pass.
- End-to-end on a running server:
  - With no internet, the replay fell back to simulated history in about 6 seconds and labelled it on every screen.
  - It trained the replay model with the clock paused, then ran at about 100x (30 market minutes per 18 real seconds) and rolled over to the next trading day.
  - The AI autopilot (Full auto) placed 5 bracketed buys, each with its reasoning in the trade feed.
  - The scanner took about 3.3 s per run at 100x; no loop errors.
- Screens checked at 1440, 1024 and 390 px with no horizontal overflow and no page errors.
- Not verifiable here: downloading real Yahoo/Alpaca history (the build machine has no internet). On a normal internet connection the replay downloads it once and caches it.


## 0.4.0 update (AI trades, practice trading, trade panel, saved themes, Turbo money)

- **Root cause of "the AI does nothing":** the autopilot only accepted ideas that passed every strict scanner threshold, and it read only the qualified list (the scanner stores rejected ideas separately). On simulated data all 40 ideas missed the 3-point probability-edge threshold, so it never traded.
  - Fixed: the autopilot now reads every scored idea and applies the **How picky** level.
  - Check on a fresh server with default settings: 3 bracketed AI buys within about a minute of switching AI trading on.
- **Backend:** 125 pytest tests pass, including pickiness levels (a negative expected result is never traded and hard safety rules always apply), Turbo money adding up exactly to the equity curve, and saving a named theme with its look settings.
- **Browser checks (Playwright):**
  - Created a theme named "My Night Desk", changed a colour and the text size, saved it, reloaded: it is still listed and active, with the same colour and size.
  - Pinned the Live trades panel: it shows the AI trades and decisions tabs beside other pages, with no overflow.
  - Practice trading page renders.
  - Turbo run with $25,000 starting money showed the live balance, trade tape and profit summary.
  - No overflow at 1440, 1024 or 390 px, and no page errors.
