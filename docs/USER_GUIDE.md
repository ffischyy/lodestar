# User guide

## The screens

| Group | Screen | Use it to |
|---|---|---|
| Markets | **Overview** | Read the market regime, index moves, sector heat map, breadth, top scanner ideas and headlines at a glance |
| | **Market map** | See the whole universe at once, sized by market cap and coloured by return over today, 1W, 1M, 3M or 1Y. Click a tile for research |
| | **Live monitor** | Watch streaming quotes for everything tracked; filter by sector or scope; right-click (or Shift+F10) a row for research, chart, order or add-to-watchlist |
| | **Chart workspace** | Lay out 1, 2 or 4 charts with independent symbols, timeframes (1D / 1H / 15m / 5m) and indicators (SMA, EMA, Bollinger, VWAP, RSI, MACD). The layout is remembered. |
| | **News** | Filter headlines by symbol, sentiment and period; see average sentiment by stock and the words behind each score |
| | **Calendar** | See upcoming earnings, Fed decisions, options expiry and holidays, for all stocks or only your holdings and watchlists |
| Research | **Screener** | Filter the universe on price, trend, volume and fundamentals; use presets, save your own screens, export CSV |
| | **Opportunity scanner** | See ranked candidates, and every rejected stock with its reasons. Tune filters and weights. Open a candidate's full evidence and trade it. |
| | **Stock research** | One stock in depth: chart with the plan drawn on it, forecast, long or short plan, evidence for and against, signals, risks, company data, news, past predictions |
| | **AI explanations** | Read a plain-English explanation of a stock's evidence; rule-based, or Claude-written if enabled |
| | **Watchlists** | Create lists, add or remove symbols, see live quotes |
| Models & strategies | **Strategies** | Enable or disable strategies and change their parameters |
| | **Model evaluation** | Train models; inspect validation gates, the baseline comparison, calibration, stability across folds and feature importance; choose the active model |
| | **Backtesting** | Run strategies over history with costs; compare to buy-and-hold; see trades, yearly results, and in-sample vs out-of-sample |
| | **Prediction history** | See every logged forecast, its outcome, and how calibrated live predictions have been |
| Trade | **Trade desk** | Account summary, order ticket, deposits/withdrawals (Sandbox only), positions, orders, fills; reset the account |
| Trade | **Trade journal** | Review closed round trips: P&L, R multiple, win rate, profit factor, expectancy, daily calendar. Tag setups, grade execution, take notes, export CSV |
| Trade | **Practice trading** | Fake trades priced from real data: real live prices now, or real past prices sped up 1x–100x (own account) |
| Trade | **AI autopilot** | Let the AI trade by itself within your schedule and limits, or approve each proposal |
| AI lab | **Turbo simulator** | Simulate millions of trades a minute across many markets to see the range of outcomes |
| AI lab | **Models and methods** | Compare the six prediction methods, choose which ones train and which one drives decisions |
| | **Portfolio analytics** | Equity and drawdown, exposure vs limits, sector exposure, correlation of holdings, beta, trade statistics |
| | **Alerts** | Create price, move, scanner and probability alerts; read notifications |
| Workspace | **Dashboards** | Build your own screens from widgets |
| | **Theme studio** | Switch themes, create custom colours, adjust typography, density and motion |
| System | **Settings** | Risk limits, trading costs, the stock universe, model horizon and barriers, shorting |
| | **Data providers** | Keys, connection tests, the active data source, AI narrative setup |
| | **Diagnostics** | Background job status, provider health, storage, versions and the log |

## Reading the provenance pills

| Pill | Meaning |
|---|---|
| **Live** | Real-time. On Alpaca's free plan this is the IEX exchange only. |
| **Delayed** | Real market data that may be delayed (Yahoo) |
| **Close** | The last close; markets are closed or no quote exists |
| **Cached** | The provider is unreachable, so this is the last stored value |
| **Stale** | Too old to trust; market orders are refused |
| **Simulated** | Synthetic data, drawn with a dashed border |

## Backtesting, step by step

1. Open **Backtesting** and choose a strategy, or click **Backtest** on a card in **Strategies**.
2. Leave the dates blank for the full history, or set a period. The first year of data is always reserved for indicator warm-up.
3. Check the costs: slippage per side, spread, and commission per share. Realistic costs are the single biggest reason backtests disappoint in live trading.
4. Click **Run backtest**. Rule strategies take seconds. The ML strategy retrains every quarter and takes longer.
5. Read the **Overview** tab:
   - Compare to the buy-and-hold line.
   - Check the drawdown chart.
   - Look at **Costs paid** versus **Gross profit before costs**.
   - Most importantly, compare **in-sample vs out-of-sample** results.
6. The **Trades** tab lists every trade with its exit reason (stop, gap, target, signal or time). **By year** shows whether results depend on one lucky period.

Avoid tuning parameters repeatedly until a backtest looks good. That fits noise, and the out-of-sample section stops protecting you.

## Paper trading, step by step

1. From **Stock research**, a scanner candidate, or **Trade desk**, open the order ticket.
2. Choose **Buy** or **Sell / short** (shorts must be enabled in Settings) and the order type:
   - **Market:** fills now.
   - **Limit:** fills at your price or better.
   - **Stop:** triggers when the price crosses.
3. Enter a **stop-loss** (and optionally a **take-profit**). The ticket then suggests a **risk-based size** and shows the loss if the stop fills, the gain at target, round-trip costs, and any limit violations.
4. Submit. Bracket exits are created automatically once the entry fills; when one exit fills, the other is cancelled.
5. Manage positions under **Trade desk**: close one, close all, or cancel orders.
6. The **Trading** switch in the top bar turns all new trading off and on. While it is off, stop-loss and take-profit exits still work and you can close positions. Its menu can also cancel every waiting order.
7. **Reset account** wipes paper history and starts again with new virtual cash.

Daily-loss and drawdown halts (set in **Settings → Risk**) block new entries automatically. Exits are always allowed.

## Alerts

| Kind | Fires when |
|---|---|
| Price rises above / falls below | The quote crosses your price |
| Daily move exceeds ±% | The absolute move from the prior close reaches your threshold |
| Appears in scanner (score ≥) | A qualified candidate scores at least this much (optionally for one symbol) |
| Target-first probability ≥ | A qualified candidate's probability is at least this value (0–1) |

Each rule waits for its cool-down before firing again. Notifications appear as toasts, in the bell menu, and on the Alerts screen.

## Dashboards

1. Open **Dashboards** and click **Edit**.
2. **Add widget** to place new panels. Drag them by their title bar; resize from the bottom-right corner.
3. Chart and Quote widgets have a symbol box while you are editing.
4. Click **Save layout**. Layouts are stored in the database and survive restarts.
5. Use the toolbar to **rename**, **duplicate**, **set as default**, **restore the original layout**, **delete**, or create a **New** dashboard.

On narrow screens, panels stack into one column.

## Themes

Pick **Meridian**, **Daylight**, **Graphite**, **Aurora** or **Ticker**.

To make your own theme:

1. Click **Customise colours of the current theme**.
2. Edit any colour. Changes preview live across the whole app.
3. Watch the **Readability check**: it flags text, gains, losses or accents that fall below WCAG contrast minimums.
4. Click **Save theme**. Your themes appear next to the built-ins and can be deleted.

**Typography, density and motion** apply on top of any theme:

- font family and text size;
- corner radius and compact or comfortable density;
- animation (full, reduced or off);
- borders and shadows;
- your own gain and loss colours.

These preferences are remembered on this computer.

## Changing the universe

Under **Settings → Universe**, paste the tickers you want, separated by commas or spaces. Then go to **Model evaluation** and train a new model, because the model is trained on the universe.

Fifty to two hundred liquid US stocks works well. On Alpaca's free plan, each symbol costs about one request per refresh, and the built-in limiter keeps you under 200 per minute.


## Sandbox mode and money

The purple **Sandbox** chip in the top bar switches a no-stakes practice mode on or off.

- **Sandbox on:** the Funds panel on the Trade desk lets you deposit any amount of play money (up to $1 billion at a time). Withdrawals are allowed up to your available cash.
- **Sandbox off:** deposits are blocked. You can only trade with what you have: orders that cost more than your available cash are rejected, and cash already committed to working orders is reserved.

Profit and return are always measured against what you put in (starting cash plus deposits minus withdrawals), so depositing more never looks like a gain.

## AI autopilot

1. Train a model that passes validation (Models and methods). The autopilot refuses to trade without one.
2. Open **Trade → AI autopilot** and set the rules: when it may trade, how often it checks, minimum scanner score, max positions, position size, trades per day, daily-loss pause, stop/target brackets, and whether shorts are allowed.
3. Pick a mode. **Approve** puts each trade in the Proposals list for you to accept or reject; proposals expire after the time you set. **Automatic** places trades itself.
4. Flip the big switch on. The Activity log shows every buy, sell, skip and error with its reason.

It exits a position when its bracket stop or target is hit, when the model's view flips against it (optional), or after the maximum holding time. It only manages positions it opened. Switching **Trading** off in the top bar makes the autopilot wait until trading is switched back on.

If it never trades, the scanner's filters are probably rejecting everything; that is the honest outcome. For practice, the autopilot page offers "Use practice filters", which loosens them, and a button to restore the defaults.

## Turbo simulator

Pick fresh simulated markets (with no, weak or medium hidden patterns) or your universe's real history, a strategy (AI model, or random entries as a baseline), and the size. The counters show trades simulated and speed: **engine speed** is the core simulation, **end-to-end** includes data generation and model training. Results show the median and 5th–95th percentile return across markets, the share of markets that were profitable, win rate, profit factor, drawdown, an equity curve per market and a histogram of trade outcomes in R (multiples of the amount risked). Use "Compare with random entries" to check whether the AI beats chance.


## Seeing what is being traded

Open the **Live trades** drawer (⇄ in the top bar), or look at **Live trade activity** on the Trade desk. Each line shows:

- who placed it: **You**, **AI**, or an automatic **Stop-loss** / **Take-profit** exit;
- what happened, e.g. "Bought 29 LIN at 337.15 = $9,777", plus the profit or loss when a position is closed;
- why: your order note, the AI's reasoning (score, expected return after costs, probability of hitting the target first), or which stop or target was hit;
- where: your normal **Paper account** or a **Replay account**.

Orders that are waiting to fill (limit orders, and the stop-loss and take-profit attached to each position) are listed above the fills with their trigger prices. On Stock research and Charts, arrows mark each buy and sell.

## Controlling AI trading

The **AI trading** menu in the top bar is the quick control:

- **Start / Stop AI trading** at any time.
- **Full auto** (it buys and sells by itself) or **Ask me first** (it proposes; nothing happens until you approve).
- **Take a break**: pause for 15 minutes, 1 hour, 4 hours or 1 day. The switch stays on and it resumes by itself. In a replay these are replayed market minutes.
- **Switch off automatically at** a date and time you choose.

The AI autopilot screen has the full rules, including the schedule (market hours, any time, or your own window and days), limits, and **Picking the best trades**: ideas are taken best score first, ideas without a positive expected result after costs are never traded, and when all slots are full it can swap its weakest position (held at least one trading day) for an idea that scores clearly higher.

## Practice trading on real data (live, or sped up 10x to 100x)

Two ways to practise with play money on real prices: **Real live market, right now** switches the app to real current prices (Yahoo free, or Alpaca with keys); trades still use your paper account and real time cannot be sped up. **Real past market, sped up** works as below.

1. Switch **Sandbox** on.
2. Open **Trade → Practice trading** (or click **Practice** in the top bar).
3. Pick a start date, a speed (1x, 10x, 25x, 50x, 75x or 100x), the replay account's starting cash and the price history source (**Real** downloads about ten years of daily prices once from Yahoo, or Alpaca if your keys are set).
4. Click **Start replay**. The first model trains on the years before your start date (the clock waits), then the market starts moving.

While it runs, the top bar shows the replayed date and time. Click it to pause, change speed or stop. Trade by hand on the Trade desk or let the AI trade; everything goes to the separate replay account. The replay screen compares your result with simply holding SPY over the same days. Stop the replay (or switch Sandbox off) to return to your normal paper account exactly as you left it.

What is real and what is not: each day's open, high, low and close are real history; the path between them inside the day is synthetic (it starts at the real open, touches the real high and low and ends at the real close). Nothing can see past the replay clock. If real history cannot be downloaded, the replay falls back to the simulated market and says so on every screen.


## Why the AI does or doesn't trade

The AI only acts on ideas the scanner has scored, filtered by **How picky** (AI menu in the top bar, or AI autopilot → Your rules). **Strict** needs ideas that pass every scanner threshold, which often means no trades for days. **Balanced** (the default) and **Active** also accept ideas that miss the stricter thresholds but still have a positive expected result after costs. The status line at the top of the Live trades panel always says what it found on its last check and why it did or didn't trade.

## Saving your own theme

Theme studio → **Create new theme** → name it and pick a starting point → change colours, font, text size, spacing, corners, borders, shadows and animation (everything previews live) → **Save theme**. Saved themes are listed under **Your themes**. Switching to one brings back all of its settings. You can also edit, duplicate, export to a file (to share or back up), import or delete themes.

## Money in the Turbo simulator

Set **Starting money** in the setup. Every simulated market starts with that amount. While it runs, the Money panel replays each market's trades so you can watch the balance move (Watch, Fast or Skip). When it finishes, the profit summary shows the typical ending money, profit and profit margin, the best and worst markets, how many made money, the average profit per trade, and money won on winners vs lost on losers. The engine itself finishes the trades in milliseconds; the playback is for watching.
