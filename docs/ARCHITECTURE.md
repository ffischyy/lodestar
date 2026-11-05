# Architecture

## Technology choices

| Layer | Choice | Why |
|---|---|---|
| Engine | **Python 3.11–3.13, FastAPI, Uvicorn** | The quant and ML ecosystem (pandas, NumPy, scikit-learn) is in Python. FastAPI provides typed REST and WebSockets in one small process. |
| ML | **scikit-learn** (logistic, HistGradientBoosting, isotonic/Platt) | Fast, deterministic, no GPU, no extra native libraries on Windows. Gradient boosting is built in, so there is no LightGBM/XGBoost compile risk. |
| Storage | **SQLite + SQLAlchemy 2** (WAL mode) | Zero-install, a single file, enough for one user. The schema is created automatically. |
| UI | **React 19 + TypeScript + Vite** | Typed components; prebuilt to static files the engine serves, so users never install Node. |
| Charts | **TradingView Lightweight Charts v5** (candles, panes) + small custom SVG charts | Purpose-built financial canvas charts; SVG for equity, calibration and bars, so everything follows theme tokens. Lightweight Charts is Apache-2.0 and shows its required attribution logo. |
| State | **TanStack Query** (server data) + **Zustand** (live quotes, theme) | Caching, refetch and error states for free; a tiny store for streaming data. |
| Layout | **react-grid-layout** | Drag/resize dashboard builder. |

The site chooses its engine once at boot (`frontend/src/api/client.ts`): a saved or build-time address, then same-origin, then the browser engine in `frontend/src/engine/`. That engine answers the same `/api` paths from a deterministic simulated market or the Alpaca REST API, and keeps paper state in localStorage and model results in IndexedDB. `engine/lab.ts` is the model pipeline, backtester and turbo simulator rewritten as pure functions, and `engine/worker.ts` runs them in a Web Worker. A route added to the Python API that browser mode should have must be added to `engine/index.ts` too.

Deliberately not used: Docker, Postgres, Redis, Celery, deep learning. Each would add installation risk on a beginner's Windows PC without changing results at this scale.

## Process model

```
 Browser (React UI) ──HTTP /api──►  FastAPI app (one process, 127.0.0.1:8765)
        ▲                │                │
        └──WebSocket /ws─┘                ├─ background loops (asyncio):
                                          │    quotes (5s)  → paper order matching, price alerts, WS broadcast
                                          │    scanner (15m) → predictions log, scan alerts
                                          │    news (10m)   → ingest + sentiment
                                          │    maintenance (30m) → resolve predictions, auto-retrain
                                          ├─ worker threads: model training, backtests, manual scans
                                          └─ SQLite file  data/lodestar.db   + models in data/models/
```

Blocking work (provider calls, pandas, scikit-learn) runs in threads via `asyncio.to_thread` or dedicated threads. The event loop only coordinates.

## Backend modules (`backend/lodestar/`)

| Module | Responsibility |
|---|---|
| `config.py` | Paths, `.env` secrets (read/write/mask), default user settings |
| `settings_store.py` | User settings in SQLite merged over defaults; bounds validation; refuses enabling live trading |
| `db.py` | SQLAlchemy models and session helpers |
| `universe.py` | Default 40-stock universe, index/sector ETFs, sector map |
| `market_hours.py` | NYSE session clock with 2025–2027 holidays |
| `providers/base.py` | `MarketDataProvider` interface, `Quote`/`Profile`/`NewsArticle`, `DataStatus`, bar validation |
| `providers/alpaca.py`, `yahoo.py`, `simulated.py` | Adapters |
| `providers/manager.py` | Provider selection, token-bucket rate limiter, retries with backoff, SQLite bar cache, quote cache, staleness labelling, health stats |
| `analytics/indicators.py` | Causal technical indicators |
| `analytics/signals.py` | Nine signal modules |
| `analytics/sentiment.py` | Finance lexicon scorer |
| `ml/features.py` | Features, triple-barrier labels, panel builder |
| `ml/models.py` | Model families + calibration |
| `ml/evaluation.py` | AUC, Brier skill, ECE, reliability bins, IC, coverage |
| `ml/engine.py` | Walk-forward training, gates, artifact persistence, `Predictor` |
| `analysis.py` | Market context, per-symbol research bundle, evidence, risks, rule-based narrative |
| `scanner.py` | Candidate evaluation, rejection rules, scoring, prediction logging and resolution |
| `risk.py` | Trade plans, sizing, cost estimates, pre-trade checks |
| `backtest/strategies.py`, `engine.py` | Strategy interface, five strategies, event-driven engine, metrics |
| `paper/engine.py` | Paper broker |
| `news.py`, `alerts.py`, `llm.py` | News store, alert rules and notifications, optional Claude narratives |
| `live.py` | Background loops and WebSocket hub |
| `api/market.py`, `trading.py`, `user.py` | REST endpoints |
| `main.py` | App factory, lifespan, static UI hosting, launcher |

## Interfaces you extend

**Add a data provider:** subclass `MarketDataProvider`:

```python
class MyProvider(MarketDataProvider):
    name = "myfeed"; label = "My Feed"; rate_limit_per_min = 60; quote_status = DataStatus.DELAYED
    def get_bars(self, symbol, timeframe, start, end) -> pd.DataFrame: ...   # UTC index, open/high/low/close/volume
    def get_quotes(self, symbols) -> dict[str, Quote]: ...
    def get_news(self, symbols, limit=50) -> list[NewsArticle]: ...          # optional
    def get_profile(self, symbol) -> Profile | None: ...                       # optional
```

Then register it in `DataManager._build`, `settings_store.validate_patch` and `api/user.py::PROVIDERS`. Raise `ProviderError(msg, retryable=...)` on failures; the manager handles retries, caching and health.

**Add a strategy:** add a `StrategyInfo` to `STRATEGIES` and a branch in `_rule_signals` returning, per symbol, a DataFrame indexed like the bars with boolean `long`, `short`, a float `score`, and optional `exit_long` / `exit_short`. Signals must only use data up to each row.

## Database schema (SQLite)

| Table | Key columns |
|---|---|
| `settings` | key (`user`), value JSON |
| `bars` | symbol, timeframe, ts, OHLCV, source; unique (symbol, timeframe, ts, source) |
| `watchlists` | name, symbols JSON |
| `model_runs` | status, source, config JSON, metrics JSON, champion, passed_validation, is_active, artifact_path, progress |
| `predictions` | symbol, asof, horizon, model_run_id, p_up, p_target_first, exp_return, q10, q90, target/stop, resolved, realized_return, hit |
| `backtests` | config JSON, metrics JSON, equity JSON, trades JSON, status |
| `paper_accounts` | cash, realized_pnl, peak_equity, day_start_equity, halted_reason |
| `paper_orders` | client_order_id (unique), symbol, side, qty, type, limit/stop, status, fill, parent_id, oco_group, bracket_stop/target |
| `paper_positions` | symbol, signed qty, avg_price |
| `paper_fills`, `equity_snapshots` | execution and equity history |
| `alerts`, `alert_events` | rules and notifications |
| `dashboards` | name, layout JSON, is_default |
| `themes` | custom theme tokens JSON |
| `news` | source, ext_id (unique), ts, headline, symbols, sentiment, terms |

## REST API (all under `/api`)

| Area | Endpoints |
|---|---|
| Market | `GET market/quotes?symbols=`, `GET market/bars/{sym}?tf=&days=&indicators=`, `GET market/search?q=`, `GET market/overview` |
| Research | `GET research/{sym}`, `POST research/{sym}/narrative?direction=&use_llm=` |
| Scanner | `GET scanner`, `POST scanner/run` |
| News | `GET news?symbol=&sentiment=&days=`, `GET news/summary`, `POST news/refresh` |
| Predictions | `GET predictions?symbol=&resolved=`, `GET predictions/calibration` |
| Paper | `GET paper/account`, `POST paper/preview`, `POST paper/orders`, `DELETE paper/orders/{id}`, `POST paper/positions/{sym}/close`, `POST paper/kill?flatten=`, `POST paper/enable`, `POST paper/clear-halt`, `POST paper/reset` |
| Portfolio | `GET portfolio/analytics` |
| Strategies | `GET strategies`, `PUT strategies/{key}` |
| Backtests | `GET backtests`, `GET backtests/{id}`, `POST backtests`, `DELETE backtests/{id}` |
| Models | `GET models`, `GET models/{id}`, `POST models/train`, `POST models/{id}/activate` |
| Watchlists | `GET/POST watchlists`, `PUT/DELETE watchlists/{id}` |
| Alerts | `GET/POST alerts`, `PUT/DELETE alerts/{id}`, `GET alerts/events`, `POST alerts/events/read` |
| Dashboards | `GET/POST dashboards`, `PUT/DELETE dashboards/{id}`, `POST dashboards/{id}/duplicate`, `.../default`, `.../restore` |
| Themes | `GET/POST themes`, `PUT/DELETE themes/{id}` |
| Settings | `GET settings`, `PATCH settings`, `POST settings/reset?section=` |
| Providers | `GET providers`, `PUT providers/keys`, `POST providers/test?name=` |
| System | `GET status`, `GET health` |

Errors return `{"detail": "message"}`, or for orders `{"detail": {"message": ..., "violations": [...]}}`, with 400 (validation), 404, 409 (training already running), 502 (provider error) or 500.

Example `POST /api/paper/orders`:

```json
{ "symbol": "MSFT", "side": "buy", "qty": 25, "type": "market",
  "stop_loss": 312.40, "take_profit": 341.10, "client_order_id": "ui-1730000000-ab12" }
```

## WebSocket `/ws`

Server → client messages are `{"type": ..., "data": ..., "ts": ...}`.

| type | data |
|---|---|
| `quotes` | `{SYMBOL: Quote}` for all tracked symbols, every poll |
| `paper_fill` | order id, symbol, side, qty, price, type |
| `alert` | notification event |
| `scan` | `{scanned_at, candidates}` |
| `news` | `{new: n}` |
| `predictions_resolved` | `{count}` |
| `provider_error` | `{message}` |

The client sends `ping` every 25 seconds and reconnects with exponential backoff (1 s to 20 s).

## Frontend (`frontend/src/`)

| Path | Contents |
|---|---|
| `theme/` | Token definitions for 5 themes, the token resolver (theme + custom + user preferences), WCAG contrast checker |
| `styles/global.css` | Every rule reads CSS custom properties; responsive breakpoints at 1200 / 900 / 520 px |
| `api/` | Fetch client with typed errors, query hooks, live socket store |
| `components/` | Shell, command palette, UI kit (panel, pills, delta, states, modal, tooltip, context menu, toasts), data table, charts, domain components (order ticket, evidence, forecast), dashboard widgets |
| `pages/` | 20 screens, lazy-loaded |

## Security

- The server binds to 127.0.0.1 only. CORS allows only the local dev server.
- Secrets live in `.env`. They are never stored in SQLite or logged, and they are masked in API responses. Key input is validated against a strict character set before being written.
- All symbols are validated by regex. Theme tokens are validated to block CSS injection. Dashboard layouts are validated against a widget whitelist.
- No real-money execution code exists. `live_trading.enabled` cannot be set to true. Paper trading has a kill switch, halts and duplicate-order protection.
- The optional LLM call sends only the structured analysis, never keys, account data or positions.
