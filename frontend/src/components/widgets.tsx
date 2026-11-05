import { Link } from "react-router-dom";
import { useApi, useAccount, useBars, useScan } from "../api/hooks";
import { useLive } from "../api/live";
import { useSnapshot } from "../api/snapshot";
import type { AlertEvent, Candidate, ModelInfo, NewsItem, Quote, Signal } from "../api/types";
import { ago, frac, isNum, money, num, pct, price, prob } from "../lib/format";
import { LineChart, Sparkline, heatColor } from "./charts/svg";
import { PriceChart } from "./charts/PriceChart";
import { DataTable } from "./DataTable";
import { LivePrice, NewsList, SymbolLink } from "./domain";
import { Delta, Empty, Loadable, Notice, ScoreBar, Skeleton, StatusPill } from "./ui";

export interface Overview {
  indexes: { symbol: string; name: string; quote: Quote | null; spark: number[] }[];
  sectors: { symbol: string; sector: string; change_pct: number | null; ret_1m: number | null; ret_3m: number | null; status: string }[];
  gainers: Row[]; losers: Row[];
  breadth: { advancers: number; decliners: number; unchanged: number; above_50d: number | null };
  regime: Signal; top_opportunities: Candidate[]; scanned_at: string | null; news: NewsItem[];
  model: ModelInfo | null;
}
interface Row { symbol: string; name: string; sector: string; price: number; change_pct: number; volume: number | null; status: string }

export const useOverview = () => useApi<Overview>(["overview"], "/market/overview", { refetchInterval: 30_000 });

export function IndicesWidget() {
  const q = useOverview();
  const live = useLive((s) => s.quotes);
  return (
    <Loadable q={q} rows={2}>
      {(d) => (
        <div className="grid cols-4">
          {d.indexes.map((ix) => {
            const qq = live[ix.symbol] ?? ix.quote;
            return (
              <Link key={ix.symbol} to={`/research/${ix.symbol}`} className="stack" style={{ gap: 2, minWidth: 0 }}>
                <span className="row between"><span className="sym">{ix.symbol}</span><span className="faint xs truncate">{ix.name}</span></span>
                <span className="row between" style={{ alignItems: "flex-end" }}>
                  <span className="stack" style={{ gap: 0 }}>
                    <span className="num" style={{ fontSize: "var(--fs-xl)" }}><LivePrice symbol={ix.symbol} fallback={qq?.price} /></span>
                    <Delta value={qq?.change_pct} />
                  </span>
                  <Sparkline values={ix.spark} />
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </Loadable>
  );
}

export function SectorsWidget() {
  const q = useOverview();
  return (
    <Loadable q={q}>
      {(d) => (
        <div className="heat" role="list" aria-label="Sector performance today">
          {[...d.sectors].sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0)).map((s) => (
            <Link to={`/research/${s.symbol}`} key={s.symbol} className="heat-cell" role="listitem" style={{ background: heatColor(s.change_pct, 2) }}
              title={`${s.sector}: today ${pct(s.change_pct)}, 1 month ${frac(s.ret_1m, 1)}, 3 months ${frac(s.ret_3m, 1)}`}>
              <span className="small truncate" style={{ color: "var(--text)" }}>{s.sector}</span>
              <span className="row between wrap" style={{ gap: 4 }}><Delta value={s.change_pct} /><span className="faint xs num">1m {frac(s.ret_1m, 1)}</span></span>
            </Link>
          ))}
        </div>
      )}
    </Loadable>
  );
}

export function MoversWidget() {
  const q = useOverview();
  const cols = [
    { key: "s", header: "Symbol", cell: (r: Row) => <SymbolLink symbol={r.symbol} />, sticky: true },
    { key: "n", header: "Name", cell: (r: Row) => <span className="muted truncate" style={{ maxWidth: 160, display: "inline-block" }}>{r.name}</span> },
    { key: "p", header: "Price", num: true, cell: (r: Row) => <LivePrice symbol={r.symbol} fallback={r.price} /> },
    { key: "c", header: "Change", num: true, cell: (r: Row) => <Delta value={r.change_pct} /> },
  ];
  return (
    <Loadable q={q}>
      {(d) => (
        <div className="grid cols-2">
          <div><div className="section-title">Leaders</div><DataTable label="Top gainers" rows={d.gainers} columns={cols} rowKey={(r) => r.symbol} /></div>
          <div><div className="section-title">Laggards</div><DataTable label="Top losers" rows={d.losers} columns={cols} rowKey={(r) => r.symbol} /></div>
        </div>
      )}
    </Loadable>
  );
}

export const REGIME_TONE: Record<string, string> = {
  risk_on_trend: "up", range_bound: "muted", high_volatility: "warn", downtrend: "down", risk_off: "down", unknown: "muted",
};

export function RegimeWidget() {
  const q = useOverview();
  return (
    <Loadable q={q}>
      {(d) => {
        const v = d.regime.values as Record<string, number | string | null>;
        const label = String(v.label ?? "unknown");
        return (
          <div className="stack lg">
            <div>
              <div className={`${REGIME_TONE[label] ?? ""}`} style={{ fontSize: "var(--fs-xl)", fontWeight: 500, color: REGIME_TONE[label] === "warn" ? "var(--warn)" : undefined }}>
                {String(v.label_name ?? "Unknown")}
              </div>
              <p className="small muted" style={{ marginTop: 4 }}>{d.regime.summary}</p>
            </div>
            <dl className="kv small">
              <dt>S&amp;P 500 proxy vs 200-day</dt><dd><Delta value={v.spy_vs_200d as number} kind="frac" /></dd>
              <dt>Volatility percentile (2y)</dt><dd className="num">{prob(v.vol_percentile_2y as number)}</dd>
              <dt>From 1-year high</dt><dd><Delta value={v.drawdown_1y as number} kind="frac" bare /></dd>
              <dt>Universe above 50-day</dt><dd className="num">{prob(v.breadth_above_50d as number)}</dd>
            </dl>
          </div>
        );
      }}
    </Loadable>
  );
}

export function BreadthWidget() {
  const q = useOverview();
  return (
    <Loadable q={q} rows={2}>
      {(d) => {
        const b = d.breadth;
        const tot = b.advancers + b.decliners + b.unchanged || 1;
        return (
          <div className="stack">
            <div className="row" style={{ height: 10, borderRadius: 5, overflow: "hidden", gap: 0 }} aria-hidden>
              <i style={{ width: `${(b.advancers / tot) * 100}%`, height: "100%", background: "var(--up)" }} />
              <i style={{ width: `${(b.unchanged / tot) * 100}%`, height: "100%", background: "var(--border-strong)" }} />
              <i style={{ width: `${(b.decliners / tot) * 100}%`, height: "100%", background: "var(--down)" }} />
            </div>
            <div className="row between small">
              <span className="up num">▲ {b.advancers} advancing</span><span className="faint num">{b.unchanged} flat</span><span className="down num">▼ {b.decliners} declining</span>
            </div>
          </div>
        );
      }}
    </Loadable>
  );
}

/** The browser engine has no trained model to rank ideas, so it shows plain relative strength instead. */
export function StrongestWidget({ limit = 6 }: { limit?: number }) {
  const q = useSnapshot();
  return (
    <Loadable q={q}>
      {(rows) => (
        <DataTable label="Strongest stocks this month" rows={[...rows].sort((a, b) => (b.ret_1m ?? 0) - (a.ret_1m ?? 0)).slice(0, limit)} rowKey={(r) => r.symbol}
          columns={[
            { key: "s", header: "Symbol", sticky: true, cell: (r) => <SymbolLink symbol={r.symbol} /> },
            { key: "n", header: "Name", cell: (r) => <span className="muted">{r.name}</span> },
            { key: "p", header: "Price", num: true, cell: (r) => <LivePrice symbol={r.symbol} fallback={r.price} /> },
            { key: "d", header: "Today", num: true, cell: (r) => <Delta value={r.change_pct} bare /> },
            { key: "m", header: "1M", num: true, cell: (r) => <Delta value={r.ret_1m} kind="frac" digits={1} bare /> },
          ]} />
      )}
    </Loadable>
  );
}

export function OpportunitiesWidget({ limit = 6 }: { limit?: number }) {
  const scan = useScan();
  if (scan.isLoading) return <Skeleton />;
  const r = scan.data?.result;
  if (!r) return <Empty title={scan.data?.has_model ? "First scan is running" : "Waiting for a trained model"}>The scanner runs automatically once a model is available.</Empty>;
  if (!r.candidates.length)
    return (
      <Empty title="No trade qualifies right now">
        {r.universe_size} stocks checked {ago(r.scanned_at)}. The most common reason: {r.reason_counts[0]?.reason.toLowerCase() ?? "—"}.{" "}
        <Link to="/scanner" className="sym-link">See every rejection</Link>
      </Empty>
    );
  return (
    <DataTable label="Top opportunities" rows={r.candidates.slice(0, limit)} rowKey={(c) => `${c.symbol}${c.direction}`}
      columns={[
        { key: "s", header: "Symbol", sticky: true, cell: (c) => <SymbolLink symbol={c.symbol} /> },
        { key: "d", header: "Side", cell: (c) => <span className={`badge ${c.direction === "long" ? "up" : "down"}`}>{c.direction === "long" ? "▲ Long" : "▼ Short"}</span> },
        { key: "st", header: "Setup", cell: (c) => <span className="muted truncate" style={{ maxWidth: 200, display: "inline-block" }}>{c.strategy}</span> },
        { key: "e", header: "Net exp.", num: true, cell: (c) => <Delta value={c.net_exp_return} kind="frac" /> },
        { key: "p", header: "P(target)", num: true, cell: (c) => prob(c.p_target_first) },
        { key: "sc", header: "Score", num: true, cell: (c) => <span className="row" style={{ justifyContent: "flex-end" }}><ScoreBar value={c.score} max={100} /> {num(c.score, 0)}</span> },
      ]} />
  );
}

export function NewsWidget({ symbol, limit = 8 }: { symbol?: string; limit?: number }) {
  const q = useApi<NewsItem[]>(["news", symbol ?? "all", limit], `/news?limit=${limit}${symbol ? `&symbol=${symbol}` : ""}`, { refetchInterval: 60_000 });
  return <Loadable q={q}>{(d) => <NewsList items={d} compactView />}</Loadable>;
}

export function WatchlistWidget({ id }: { id?: number }) {
  const lists = useApi<{ id: number; name: string; symbols: string[] }[]>(["watchlists"], "/watchlists");
  const live = useLive((s) => s.quotes);
  return (
    <Loadable q={lists} empty={(d) => (d.length ? null : <Empty title="No watchlists yet"><Link to="/watchlists" className="sym-link">Create one</Link></Empty>)}>
      {(d) => {
        const wl = d.find((w) => w.id === id) ?? d[0];
        return (
          <DataTable label={wl.name} rows={wl.symbols} rowKey={(s) => s}
            empty={<Empty title="This list is empty">Add symbols on the Watchlists screen.</Empty>}
            columns={[
              { key: "s", header: wl.name, sticky: true, cell: (s) => <SymbolLink symbol={s} /> },
              { key: "p", header: "Price", num: true, cell: (s) => <LivePrice symbol={s} /> },
              { key: "c", header: "Change", num: true, cell: (s) => <Delta value={live[s]?.change_pct} /> },
            ]} />
        );
      }}
    </Loadable>
  );
}

export function PositionsWidget() {
  const q = useAccount();
  return (
    <Loadable q={q} empty={(d) => (d.positions.length ? null : <Empty title="No open paper positions"><Link to="/scanner" className="sym-link">Find an idea in the scanner</Link></Empty>)}>
      {(d) => (
        <DataTable label="Open positions" rows={d.positions} rowKey={(p) => p.symbol}
          columns={[
            { key: "s", header: "Symbol", sticky: true, cell: (p) => <SymbolLink symbol={p.symbol} /> },
            { key: "q", header: "Qty", num: true, cell: (p) => <span className={p.qty < 0 ? "down" : ""}>{p.qty}</span> },
            { key: "m", header: "Mark", num: true, cell: (p) => <LivePrice symbol={p.symbol} fallback={p.mark} /> },
            { key: "u", header: "Unrealized", num: true, cell: (p) => <span className={p.unrealized >= 0 ? "up" : "down"}>{money(p.unrealized, true)}</span> },
          ]} />
      )}
    </Loadable>
  );
}

export function ChartWidget({ symbol = "SPY", height = 262 }: { symbol?: string; height?: number }) {
  const q = useBars(symbol, "1D", ["sma50", "sma200"]);
  const lp = useLive((s) => s.quotes[symbol]?.price);
  return (
    <Loadable q={q} rows={8}>
      {(d) => (
        <div className="stack" style={{ height: "100%" }}>
          <div className="row small"><SymbolLink symbol={symbol} /><span className="faint">daily, SMA 50 / 200</span></div>
          <PriceChart data={d} height={height} livePrice={lp} />
        </div>
      )}
    </Loadable>
  );
}

export function EquityWidget() {
  const q = useApi<{ equity_history: { ts: string; equity: number }[] }>(["portfolio"], "/portfolio/analytics", { refetchInterval: 30_000 });
  return (
    <Loadable q={q} empty={(d) => (new Set(d.equity_history.map((h) => h.equity)).size > 1 ? null : <Empty title="Equity curve starts with your first trade" />)}>
      {(d) => (
        <LineChart labels={d.equity_history.map((h) => h.ts.slice(5, 16).replace("T", " "))} height={200} format={(v) => money(v).replace(".00", "")}
          series={[{ name: "Equity", values: d.equity_history.map((h) => h.equity), color: "var(--chart-1)", area: true }]} />
      )}
    </Loadable>
  );
}

export function AlertsWidget() {
  const q = useApi<{ unread: number; events: AlertEvent[] }>(["alerts-events"], "/alerts/events?limit=12", { refetchInterval: 30_000 });
  return (
    <Loadable q={q} empty={(d) => (d.events.length ? null : <Empty title="No notifications yet"><Link to="/alerts" className="sym-link">Create an alert</Link></Empty>)}>
      {(d) => (
        <ul className="stack small" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {d.events.map((e) => (
            <li key={e.id} className="row" style={{ alignItems: "flex-start" }}>
              <span className={`badge ${e.level === "error" ? "error" : e.level === "warn" ? "warn" : "info"}`}>{e.level}</span>
              <span className="grow"><b style={{ fontWeight: 500 }}>{e.title}</b><span className="muted"> {e.body}</span></span>
              <span className="faint xs">{ago(e.ts)}</span>
            </li>
          ))}
        </ul>
      )}
    </Loadable>
  );
}

export function ModelWidget() {
  const q = useOverview();
  return (
    <Loadable q={q} rows={3}>
      {(d) =>
        d.model ? (
          <dl className="kv small">
            <dt>Model</dt><dd>{d.model.champion} #{d.model.run_id}</dd>
            <dt>Validation</dt><dd className={d.model.passed ? "up" : "down"}>{d.model.passed ? "Passed" : "Failed"}</dd>
            <dt>Reliability</dt><dd className="num">{num(d.model.reliability)}</dd>
            <dt>Trained through</dt><dd className="num">{d.model.trained_through}</dd>
            <dt>Horizon</dt><dd className="num">{d.model.horizon_days} trading days</dd>
          </dl>
        ) : <Notice>No model for this data source yet. Training starts automatically.</Notice>
      }
    </Loadable>
  );
}

export function QuoteWidget({ symbol = "SPY" }: { symbol?: string }) {
  const qq = useLive((s) => s.quotes[symbol]);
  return (
    <div className="stack">
      <span className="row between"><SymbolLink symbol={symbol} /><StatusPill status={qq?.status} /></span>
      <span className="num" style={{ fontSize: "var(--fs-2xl)", fontWeight: 500 }}><LivePrice symbol={symbol} /></span>
      <span className="row"><Delta value={qq?.change} kind="abs" /><Delta value={qq?.change_pct} /></span>
      <dl className="kv xs">
        <dt>Bid / ask</dt><dd className="num">{price(qq?.bid)} / {price(qq?.ask)}</dd>
        <dt>Day range</dt><dd className="num">{price(qq?.low)} – {price(qq?.high)}</dd>
        <dt>Spread</dt><dd className="num">{isNum(qq?.spread_bps) ? `${qq!.spread_bps!.toFixed(1)} bps` : "—"}</dd>
      </dl>
    </div>
  );
}

export function AccountWidget() {
  const q = useAccount();
  return (
    <Loadable q={q} rows={4}>
      {(a) => (
        <div className="stack">
          <div className="row between"><span className="muted small">Account value</span><Link to="/trade" className="sym-link small">Trade desk</Link></div>
          <span className="num" style={{ fontSize: "var(--fs-2xl)", fontWeight: 500 }}>{money(a.equity)}</span>
          <span className="row small" style={{ gap: 8 }}><Delta value={a.money.profit} kind="abs" /><Delta value={a.money.return_pct} bare /><span className="faint">all time</span></span>
          <dl className="kv small">
            <dt>Cash available</dt><dd className="num">{money(a.money.available_to_trade)}</dd>
            <dt>Invested (paid)</dt><dd className="num">{money(a.money.invested_cost)}</dd>
            <dt>Worth now</dt><dd className="num">{money(a.money.long_market_value)}</dd>
            <dt>Today</dt><dd><Delta value={a.day_pnl} kind="abs" /></dd>
            <dt>Mode</dt><dd>{a.sandbox ? "Sandbox (play money)" : "Funded"}</dd>
          </dl>
        </div>
      )}
    </Loadable>
  );
}

export function AutopilotWidget() {
  const q = useApi<{ enabled: boolean; mode: string; last_summary: string; trades_today: number; max_trades_per_day: number; open_positions: number; unrealized: number; schedule_note: string }>(["autopilot"], "/autopilot", { refetchInterval: 10_000 });
  return (
    <Loadable q={q} rows={3}>
      {(s) => (
        <div className="stack">
          <span className={s.enabled ? "up" : "muted"} style={{ fontWeight: 500, fontSize: "var(--fs-lg)" }}>{s.enabled ? (s.mode === "approve" ? "On (asks first)" : "On") : "Off"}</span>
          <dl className="kv small">
            <dt>Trades today</dt><dd className="num">{s.trades_today} / {s.max_trades_per_day}</dd>
            <dt>Positions</dt><dd className="num">{s.open_positions}</dd>
            <dt>Open profit</dt><dd className={s.unrealized >= 0 ? "num up" : "num down"}>{money(s.unrealized, true)}</dd>
          </dl>
          <p className="xs faint">{s.last_summary || s.schedule_note}</p>
          <Link to="/autopilot" className="btn sm" style={{ alignSelf: "flex-start" }}>Manage autopilot</Link>
        </div>
      )}
    </Loadable>
  );
}

export const WIDGETS: Record<string, { title: string; render: (cfg: Record<string, unknown>) => React.ReactNode; defaults: { w: number; h: number }; configurable?: "symbol" }> = {
  account: { title: "Your account", render: () => <AccountWidget />, defaults: { w: 4, h: 7 } },
  autopilot: { title: "AI autopilot", render: () => <AutopilotWidget />, defaults: { w: 4, h: 6 } },
  indices: { title: "Market indices", render: () => <IndicesWidget />, defaults: { w: 12, h: 4 } },
  sectors: { title: "Sectors today", render: () => <SectorsWidget />, defaults: { w: 4, h: 9 } },
  movers: { title: "Leaders and laggards", render: () => <MoversWidget />, defaults: { w: 6, h: 7 } },
  regime: { title: "Market regime", render: () => <RegimeWidget />, defaults: { w: 4, h: 6 } },
  breadth: { title: "Breadth", render: () => <BreadthWidget />, defaults: { w: 4, h: 3 } },
  opportunities: { title: "Top opportunities", render: () => <OpportunitiesWidget />, defaults: { w: 8, h: 6 } },
  news: { title: "Headlines", render: () => <NewsWidget />, defaults: { w: 6, h: 7 } },
  watchlist: { title: "Watchlist", render: () => <WatchlistWidget />, defaults: { w: 4, h: 7 } },
  positions: { title: "Paper positions", render: () => <PositionsWidget />, defaults: { w: 6, h: 6 } },
  chart: { title: "Chart", render: (c) => <ChartWidget symbol={(c.symbol as string) || "SPY"} />, defaults: { w: 8, h: 9 }, configurable: "symbol" },
  equity: { title: "Paper equity", render: () => <EquityWidget />, defaults: { w: 6, h: 6 } },
  alerts: { title: "Notifications", render: () => <AlertsWidget />, defaults: { w: 4, h: 6 } },
  model: { title: "Active model", render: () => <ModelWidget />, defaults: { w: 4, h: 5 } },
  quote: { title: "Quote", render: (c) => <QuoteWidget symbol={(c.symbol as string) || "SPY"} />, defaults: { w: 3, h: 5 }, configurable: "symbol" },
};
