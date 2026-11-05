# Prediction and analysis methodology

This document explains exactly how Lodestar turns prices into signals, forecasts, rankings and trade plans, and what those numbers can and cannot tell you.

Lodestar keeps four kinds of output strictly separate, and the interface labels them:

| Kind | What it is | Where it appears |
|---|---|---|
| **Technical indicators** | Deterministic formulas (SMA, RSI, ATR …) | Charts, signal summaries |
| **Statistical signals** | Rules over indicators that describe the current state (e.g. "2.1σ below its 20-day mean") | Research → Signals, scanner evidence |
| **ML forecasts** | Calibrated probabilities and return distributions from models validated out-of-sample | Forecast panels, scanner ranking |
| **Narratives** | Wording generated from the three above: a rule template, or optionally an LLM that may only restate them | AI explanations |

Signals describe; forecasts estimate; narratives explain. A narrative never adds information.

---

## 1. Data

- **Daily OHLCV bars**, about five years per symbol, split- and dividend-adjusted by the provider. They are cached in SQLite and refreshed incrementally; the last five days are always re-pulled to pick up revisions.
- **Validation of every bar set** (`providers/base.py::validate_bars`):
  - duplicate timestamps are removed;
  - bars with missing or non-positive prices are dropped (never invented);
  - inconsistent high/low envelopes are repaired;
  - negative volume is clipped.
  Every repair is reported in the data notes.
- **The in-progress session bar is excluded** from every feature and forecast (`ml.engine.completed_bars`). Models only ever see complete days.
- **Quotes** carry a provenance status:
  - **Live**: an exchange feed; on Alpaca's free plan, IEX only.
  - **Delayed**: Yahoo.
  - **Cached**: the provider is down and the last value is shown.
  - **Stale**: older than the freshness threshold during market hours.
  - **Historical**: a closing value.
  - **Simulated**: from the built-in simulator.

  Market orders on stale or cached quotes are refused.

## 2. Signal modules (`analytics/signals.py`)

Each module is independent, testable, and returns a score from −1 (bearish) to +1 (bullish) plus a plain-English summary.

| Module | Inputs | Logic |
|---|---|---|
| Momentum | 6-month return excluding the last week, 3-month return, 63-day volatility | Volatility-adjusted strength, squashed with tanh |
| Mean reversion | 20-day z-score, RSI(14), RSI(2), Bollinger %b | Fades extremes; half weight when fading against the 200-day trend |
| Trend following | EMA20 / EMA50 / SMA200 alignment, ADX(14) | Alignment (−1..1) scaled by trend strength |
| Breakout | Prior 20- and 55-day Donchian channels, volume ratio, Bollinger width percentile | Close beyond the channel; more weight with volume; flags squeezes and low-volume breakouts |
| Relative strength | 21- and 63-day return vs SPY and the sector ETF | tanh of the outperformance |
| Volatility | ATR, 20-day realised volatility, its 1-year percentile | Not directional; flags high-volatility regimes |
| Market regime | SPY vs its 50- and 200-day averages, 2-year volatility percentile, drawdown, breadth | Five labels: risk-on uptrend, range-bound, high volatility, downtrend, risk-off |
| Event-driven | Earnings date, recent gaps over 3% with volume | Earnings inside the blackout window block a trade; gaps add a weak drift tilt |
| News sentiment | Headlines from the last 7 days | Recency-weighted (48-hour half-life) lexicon score |

**News sentiment** (`analytics/sentiment.py`) matches finance terms such as "beats", "raises guidance", "downgraded" and "probe". It handles negation ("did not beat") and intensifiers. It returns the score and the matched terms so you can audit it. It is not a language model.

## 3. Machine-learning forecasts (`ml/`)

### What is predicted

For every stock, at the close of day *t*, over horizon *h* (default 10 trading days):

| Output | Definition |
|---|---|
| `p_up` | P(close at *t+h* > close at *t*) |
| `p_target_first_long` | P(price touches entry + 2×ATR **before** touching entry − 1.5×ATR, within *h* days); the "triple-barrier" label |
| `p_target_first_short` | The mirror for a short |
| `exp_return` | Mean forecast return over *h* |
| `q10`, `q90` | 10th / 90th percentile of the forecast return; `uncertainty` = q90 − q10 |
| `exp_volatility` | Realised volatility scaled to the horizon |
| `exp_favorable_excursion` / `exp_adverse_excursion` | Expected best and worst point reached during the horizon |

The barrier multiples come from the model configuration and are also used to draw the trade plan. The probability you see therefore refers to the exact stop and target on the chart.

### Features (29, all causal)

1. **Returns:** 1, 5, 21, 63 and 126 days (skipping the last week).
2. **Volatility:** 20- and 60-day volatility and their ratio, plus ATR as a share of price.
3. **Oscillators:** RSI(14), RSI(2), 20-day z-score, Bollinger %b.
4. **Trend position:** distance to EMA20, SMA50 and SMA200, ADX, normalised MACD histogram.
5. **Volume and range:** volume ratio, position within the 20-day channel.
6. **Relative strength:** 21- and 63-day return vs SPY.
7. **Market:** SPY's 21-day return, volatility and distance to its 200-day average.
8. **Cross-section:** ranks across the universe of 21- and 63-day return and volatility, plus breadth.

Tests verify that altering any future bar leaves every past feature unchanged (`tests/test_ml.py::test_features_do_not_use_future_data`).

### Labels

Labels use bars *t+1…t+h* only. The last *h* rows have no label and are never trained on.

When a single bar touches both barriers, the label counts the **stop** as hit first. A timeout counts as "target not reached first". Both choices are conservative.

### Models compared

| Family | Classifier | Return model |
|---|---|---|
| **Base rate (baseline)** | Training-set frequency | Training-set quantiles |
| **Logistic** | Standardised L2 logistic regression | Ridge regression |
| **Gradient boosting** | scikit-learn HistGradientBoosting (depth 3, 150 trees, min leaf 200) | Same, with quantile loss for q10 / q90 |

Return targets are volatility-normalised (`fwd_ret / (vol20 × √(h/252))`) so one panel model can serve stocks of different volatility, then rescaled for each stock.

### Purged walk-forward validation (`ml/engine.py`)

```
|---------- fit ----------|--gap h--|--- calibration (126d) ---|--gap h--|-- test (63d) --|
                                                                         then roll forward 63 days
```

- Each test window is strictly later than everything used to fit and calibrate it.
- Gaps of *h* days remove label overlap (purging).
- Every test date is used exactly once.
- The first fit window is 2 years.

### Calibration

Raw classifier scores are mapped to probabilities by **Platt scaling**: a 2-parameter logistic fitted on the calibration window, which is disjoint from and later than the fit window. Tests check calibration error below 5 points on held-out data.

### Validation gates and reliability

The champion (logistic or gradient boosting, whichever has the better out-of-sample Brier skill on the target-first label) must pass **all** of these gates:

| Gate | Threshold |
|---|---|
| Brier skill vs baseline | > 0 |
| AUC | > 0.52 |
| Expected calibration error | < 5 percentage points |
| Out-of-sample cases | ≥ 1,000 |

The reliability score (0–1) combines them:

```
0.5 · clip(BrierSkill / 0.03) + 0.3 · clip((AUC − 0.5) / 0.08) + 0.2 · clip(1 − ECE / 0.05)
```

It is capped at 0.2 when any gate fails.

A model that fails is still shown, with a warning. The scanner rejects every trade that depends on it. **Gradient boosting is not assumed to be better.** On the bundled simulator it usually loses to logistic regression, and the Models screen shows that comparison.

### Live track record

Every scan logs one forecast per stock per day, together with the model that produced it. After *h* trading days the realised return and outcome (target, stop or timeout) are filled in. **Prediction history** shows the calibration of these live forecasts, an honest check that is independent of the training validation.

## 4. Opportunity scanner (`scanner.py`)

For each stock, and each direction that is allowed (shorts are off by default):

1. Build the trade plan from current price and ATR:
   - stop = entry ∓ stop×ATR
   - T1 = entry ± target×ATR
   - T2 = entry ± 2.5R
2. Estimate round-trip costs:
   - per side = half the spread (from the quote, or the default) + slippage;
   - plus commissions.
3. **Hard rejection rules.** Any one of these rejects the idea, and every reason is shown:
   - quote stale or cached; forecast older than the latest bar;
   - price below the minimum ($5); 20-day dollar volume below the minimum ($20M); spread above the maximum (25 bps);
   - expected return **after costs** below the minimum (0.25%);
   - probability edge below 3 points, where edge = P(target first) − historical base rate;
   - forecast interval wider than 20%;
   - model reliability below 0.35, or model failed validation;
   - earnings within 2 days;
   - technical signals strongly contradict the direction (agreement < −0.4);
   - risk sizing rounds to zero.
4. **Score** the survivors from 0 to 100 as a weighted average of components each clipped to 0–1. Weights are editable under **Filters and weights**.

   | Component | Default weight | Scaling |
   |---|---|---|
   | Expected net return | 0.20 | net / 3% |
   | Probability edge | 0.20 | edge / 10 pts |
   | Reward / risk | 0.10 | expected favourable / adverse excursion ÷ 2 |
   | Model reliability | 0.15 | as above |
   | Signal agreement | 0.15 | (agreement + 1) / 2 |
   | Liquidity | 0.08 | (log₁₀ dollar volume − 7) / 2 |
   | Regime fit | 0.07 | (regime score × direction + 1) / 2 |
   | Data quality | 0.05 | 1, reduced for cached data or repaired bars |

Nothing is ever added to fill the list.

## 5. Risk management (`risk.py`)

```
risk budget        = equity × risk_per_trade%          (default 0.75%)
per-share risk     = |entry − stop| + estimated per-share costs
shares             = floor( min( risk budget / per-share risk,
                                 (equity × max_position% − value already held) / entry,
                                 buying power / entry ) )
```

Pre-trade checks block an order that would breach:

- buying power;
- maximum position (15%);
- gross exposure (100%);
- sector exposure (35%);
- shorting disabled;
- an active halt.

A correlation above 0.8 with an existing same-direction position produces a warning. Exits are always allowed, except while the kill switch is on.

Halts:

- **Daily loss** (−2% from the day's starting equity) blocks entries until the next session.
- **Drawdown** (−15% from peak) blocks entries until you clear it.

**Stops are not guaranteed.** A gap through the stop fills at the market price, both in the backtester and in paper trading.

## 6. Backtesting (`backtest/`)

### Execution

- Signals are evaluated at the close of day *t*; entries fill at the open of *t+1* plus half the spread and slippage. Stops and targets are set from ATR at *t* relative to the actual fill.
- Exit checks run on every bar:
  - **Gap through stop:** fills at the open.
  - **Stop touched:** fills at the stop.
  - **Gap through target:** fills at the open.
  - **Target touched:** fills at the target.
  - **Both touched on one bar:** the stop is assumed first.
  - **Signal exits:** decided at the close, executed at the next open.
  - **Time exit:** at the close after the maximum holding period.

### Portfolio constraints

- Risk-based sizing.
- Maximum position %, maximum number of positions.
- No leverage; short proceeds are not reused.

### Reported metrics

| Group | Metrics |
|---|---|
| Returns | Total return, CAGR, maximum drawdown, Sharpe, Sortino, volatility |
| Trades | Number of trades, win rate, profit factor, expectancy ($ and R), average win / loss, average holding period |
| Costs and exposure | Costs paid, gross profit before costs, average exposure |
| Comparisons | Results by calendar year; buy-and-hold SPY benchmark |
| Validation | In-sample vs out-of-sample split (rule strategies) |

### Strategies

| Strategy | Entry rule | Exit |
|---|---|---|
| Cross-sectional momentum | Top 20% of the universe by 6-month return (ex last week) and above the 200-day average; shorts the mirror | ATR stop / target or time |
| Short-term mean reversion | RSI(2) < 10 while above the 200-day average; shorts RSI(2) > 90 below it | RSI(2) recovers past 70, or stop / target / time |
| Trend following | EMA20 > EMA50 > SMA200 newly aligned with ADX > 25 | ATR stop / target or time |
| Channel breakout | Close beyond the prior 20-day high or low on ≥ 1.5× average volume | ATR stop / target or time |
| ML forecast (walk-forward) | Quarterly retrained calibrated logistic model; trades when P(target first) exceeds its training base rate by ≥ 3 points | Barrier stop / target or time |

Every trade from the ML strategy is out-of-sample by construction.

## 7. Paper trading (`paper/engine.py`)

- **Order types:** market, limit and stop, plus bracket exits (stop-loss and take-profit as an OCO pair, created when the entry fills).
- **Market fills:** the ask (buys) or bid (sells), plus slippage. Limit orders fill at the limit or better. Stop orders fill at the quote when triggered, so a gap fills worse than the stop.
- **Positions:** long and short, with average cost, realised P&L (after commission) and unrealised P&L.
- **Protections:**
  - duplicate submissions with the same client order ID are ignored;
  - rejected orders are recorded with their reasons;
  - equity is snapshotted every minute for the portfolio curve.

## 8. What these numbers cannot establish

- A probability of 45% for "target before stop" means that, historically, similar setups reached the target first about 45% of the time. **It does not mean this trade will work.**
- Validation was on past data. Markets change regime, and a model that worked in one period can stop working.
- Backtests can be over-fitted if you tune parameters while looking at the results. The out-of-sample portion stops being out-of-sample once you use it to choose.
- Free data (IEX-only quotes, unofficial Yahoo) is incomplete compared with professional feeds.
- Simulated results demonstrate the software, not any market edge.
