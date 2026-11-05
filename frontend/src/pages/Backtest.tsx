import { Play, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import { useApi } from "../api/hooks";
import { LineChart } from "../components/charts/svg";
import { DataTable } from "../components/DataTable";
import { SymbolLink } from "../components/domain";
import { toast } from "../components/toast";
import { Confirm, Delta, Empty, ErrorState, Field, Notice, NumberInput, PageHead, Panel, Progress, Skeleton, Stat, Tabs, Toggle } from "../components/ui";
import { dateTime, isNum, money, num, pct } from "../lib/format";

interface BtRow { id: number; name: string; created_at: string; status: string; source: string; progress: number; error: string | null; config: Record<string, unknown>;
  summary: Record<string, number | null>; benchmark_return_pct: number | null }
type M = Record<string, number | string | null>;
interface BtFull extends BtRow {
  results: { metrics: M; benchmark: M; in_sample?: M; out_of_sample?: M; split_date?: string; by_year: { year: number; return_pct: number; max_drawdown_pct: number; trades: number; win_rate_pct: number | null }[]; params: Record<string, number> };
  equity: { date: string; equity: number; benchmark: number; drawdown: number }[];
  trades: { symbol: string; side: string; entry_date: string; exit_date: string; entry: number; exit: number; qty: number; pnl: number; return_pct: number; r_multiple: number | null; bars: number; exit_reason: string }[];
}

const STRATS = [["momentum", "Cross-sectional momentum"], ["mean_reversion", "Short-term mean reversion"], ["trend", "Trend following"], ["breakout", "Channel breakout"], ["ml_forecast", "ML forecast (walk-forward)"]];

export default function BacktestPage() {
  const [params] = useSearchParams();
  const list = useApi<BtRow[]>(["backtests"], "/backtests", { refetchInterval: (q) => (q.state.data?.some((r) => r.status === "running") ? 1500 : false) });
  const [sel, setSel] = useState<number | null>(null);
  const [del, setDel] = useState<BtRow | null>(null);
  const qc = useQueryClient();
  const [cfg, setCfg] = useState({
    strategy: params.get("strategy") ?? "momentum", start: "", end: "", initial_capital: 100000, risk_per_trade_pct: 0.75, max_position_pct: 15, max_positions: 10,
    stop_atr: 1.5, target_atr: 2, max_hold_days: 10, slippage_bps: 5, spread_bps: 3, commission_per_share: 0, allow_short: false, oos_fraction: 0.3,
  });
  useEffect(() => { if (sel === null && list.data?.length) setSel(list.data[0].id); }, [list.data, sel]);
  const set = <K extends keyof typeof cfg>(k: K, v: (typeof cfg)[K]) => setCfg({ ...cfg, [k]: v });
  const run = async () => {
    try {
      const r = await api.post<{ id: number }>("/backtests", { ...cfg, start: cfg.start || null, end: cfg.end || null });
      setSel(r.id);
      toast("info", "Backtest started");
      qc.invalidateQueries({ queryKey: ["backtests"] });
    } catch (e) { toast("error", "Backtest not started", errMsg(e)); }
  };

  return (
    <div className="page">
      <PageHead title="Backtesting"
        sub="Replays a strategy with realistic costs and stops. Past results do not predict future returns" />
      <div className="grid g-12">
        <Panel className="span-4" title="New backtest">
          <div className="stack lg">
            <Field label="Strategy">
              <select className="select" value={cfg.strategy} onChange={(e) => set("strategy", e.target.value)}>{STRATS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
            </Field>
            <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
              <Field label="Start date" help="Blank = 1 year after data begins"><input className="input num" type="date" value={cfg.start} onChange={(e) => set("start", e.target.value)} /></Field>
              <Field label="End date" help="Blank = latest"><input className="input num" type="date" value={cfg.end} onChange={(e) => set("end", e.target.value)} /></Field>
              <Field label="Starting capital ($)"><NumberInput value={cfg.initial_capital} onChange={(v) => set("initial_capital", v ?? 0)} /></Field>
              <Field label="Risk per trade (%)"><NumberInput value={cfg.risk_per_trade_pct} onChange={(v) => set("risk_per_trade_pct", v ?? 0)} step={0.05} /></Field>
              <Field label="Max position (%)"><NumberInput value={cfg.max_position_pct} onChange={(v) => set("max_position_pct", v ?? 0)} /></Field>
              <Field label="Max positions"><NumberInput value={cfg.max_positions} onChange={(v) => set("max_positions", Math.round(v ?? 1))} /></Field>
              <Field label="Stop (× ATR)"><NumberInput value={cfg.stop_atr} onChange={(v) => set("stop_atr", v ?? 0)} step={0.1} /></Field>
              <Field label="Target (× ATR)"><NumberInput value={cfg.target_atr} onChange={(v) => set("target_atr", v ?? 0)} step={0.1} /></Field>
              <Field label="Max hold (days)"><NumberInput value={cfg.max_hold_days} onChange={(v) => set("max_hold_days", Math.round(v ?? 1))} /></Field>
              <Field label="Slippage (bps/side)"><NumberInput value={cfg.slippage_bps} onChange={(v) => set("slippage_bps", v ?? 0)} /></Field>
              <Field label="Spread (bps)"><NumberInput value={cfg.spread_bps} onChange={(v) => set("spread_bps", v ?? 0)} /></Field>
              <Field label="Commission ($/share)"><NumberInput value={cfg.commission_per_share} onChange={(v) => set("commission_per_share", v ?? 0)} step={0.001} /></Field>
              <Field label="Out-of-sample share" help="Last part of the period, reported separately"><NumberInput value={cfg.oos_fraction} onChange={(v) => set("oos_fraction", v ?? 0)} step={0.05} /></Field>
            </div>
            <Toggle checked={cfg.allow_short} onChange={(v) => set("allow_short", v)} label="Allow short positions" />
            <button className="btn primary" onClick={run}><Play size={16} /> Run backtest</button>
          </div>
        </Panel>
        <div className="span-8 stack lg">
          <Panel title="Runs" flush>
            {list.isLoading ? <div style={{ padding: 16 }}><Skeleton /></div> : list.error ? <ErrorState error={list.error} retry={() => list.refetch()} /> : (
              <DataTable<BtRow> label="Backtest runs" rows={list.data!} rowKey={(r) => r.id} selectedKey={sel} onRowClick={(r) => setSel(r.id)} maxHeight={240}
                empty={<Empty title="No backtests yet">Choose a strategy and press Run backtest.</Empty>}
                columns={[
                  { key: "n", header: "Run", cell: (r) => <span><span className="num faint">#{r.id}</span> {r.name}</span> },
                  { key: "t", header: "Started", cell: (r) => <span className="muted num">{dateTime(r.created_at)}</span> },
                  { key: "s", header: "Status", cell: (r) => r.status === "running" ? <span style={{ display: "inline-block", width: 100 }}><Progress value={r.progress} /></span> : <span className={`badge ${r.status === "failed" ? "error" : ""}`}>{r.status}</span> },
                  { key: "ret", header: "Return", num: true, cell: (r) => <Delta value={r.summary.total_return_pct} /> },
                  { key: "b", header: "Benchmark", num: true, cell: (r) => <Delta value={r.benchmark_return_pct} bare /> },
                  { key: "sh", header: "Sharpe", num: true, cell: (r) => num(r.summary.sharpe) },
                  { key: "dd", header: "Max DD", num: true, cell: (r) => <span className="down">{pct(r.summary.max_drawdown_pct, 1, false)}</span> },
                  { key: "tr", header: "Trades", num: true, cell: (r) => r.summary.trades ?? "—" },
                  { key: "x", header: "", cell: (r) => <button className="btn ghost sm icon" aria-label={`Delete run ${r.id}`} onClick={(e) => { e.stopPropagation(); setDel(r); }}><Trash2 size={16} /></button> },
                ]} />
            )}
          </Panel>
          {sel !== null && <BtDetail id={sel} />}
        </div>
      </div>
      {del && <Confirm title={`Delete backtest #${del.id}?`} danger confirmLabel="Delete" body="Its results and trade list are removed permanently."
        onCancel={() => setDel(null)} onConfirm={async () => { await api.del(`/backtests/${del.id}`); if (sel === del.id) setSel(null); setDel(null); qc.invalidateQueries({ queryKey: ["backtests"] }); }} />}
    </div>
  );
}

function MetricStats({ m, b }: { m: M; b?: M }) {
  const n = (k: string) => m[k] as number | null;
  return (
    <div className="stats">
      <Stat label="Total return" value={<Delta value={n("total_return_pct")} />} note={b ? `Benchmark ${pct(b.total_return_pct as number)}` : undefined} />
      <Stat label="CAGR" value={pct(n("cagr_pct"))} />
      <Stat label="Max drawdown" value={<span className="down">{pct(n("max_drawdown_pct"), 1, false)}</span>} note={b ? `Benchmark ${pct(b.max_drawdown_pct as number, 1, false)}` : undefined} />
      <Stat label="Sharpe" value={num(n("sharpe"))} note={b ? `Benchmark ${num(b.sharpe as number)}` : undefined} />
      <Stat label="Sortino" value={num(n("sortino"))} />
      <Stat label="Trades" value={n("trades") ?? "—"} />
      <Stat label="Win rate" value={pct(n("win_rate_pct"), 1, false)} />
      <Stat label="Profit factor" value={num(n("profit_factor"))} />
      <Stat label="Expectancy" value={money(n("expectancy"), true)} note={isNum(n("expectancy_r")) ? `${num(n("expectancy_r"))} R per trade` : undefined} />
      <Stat label="Average win" value={<span className="up">{money(n("avg_win"))}</span>} />
      <Stat label="Average loss" value={<span className="down">{money(n("avg_loss"))}</span>} />
      {isNum(n("costs_paid")) && <Stat label="Costs paid" value={money(n("costs_paid"))} note={`Gross before costs ${money(n("gross_profit_before_costs"), true)}`} />}
      {isNum(n("avg_exposure_pct")) && <Stat label="Avg exposure" value={pct(n("avg_exposure_pct"), 0, false)} />}
    </div>
  );
}

function BtDetail({ id }: { id: number }) {
  const q = useApi<BtFull>(["backtest", id], `/backtests/${id}`, { refetchInterval: (x) => (x.state.data?.status === "running" ? 1500 : false) });
  const [tab, setTab] = useState<"overview" | "trades" | "periods">("overview");
  if (q.isLoading) return <Skeleton rows={6} />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const r = q.data!;
  if (r.status === "running") return <Panel title={r.name}><Progress value={r.progress} /><p className="small muted" style={{ marginTop: 8 }}>Running… the ML strategy retrains every quarter, so it takes longer.</p></Panel>;
  if (r.status === "failed") return <Panel title={r.name}><Notice kind="error"><strong>Backtest failed.</strong> {r.error?.split("\n")[0]}</Notice></Panel>;
  const res = r.results;
  const eq = r.equity;
  return (
    <Panel title={`#${r.id} ${r.name}`} hint={`${res.metrics.start} to ${res.metrics.end}, ${r.source} data`}
      actions={<Tabs value={tab} onChange={setTab} tabs={[{ value: "overview", label: "Overview" }, { value: "trades", label: `Trades (${r.trades.length})` }, { value: "periods", label: "By year" }]} />}>
      {tab === "overview" && (
        <div className="stack lg">
          {r.source === "simulation" && <Notice kind="sim">Results come from <strong>simulated</strong> prices. The simulator deliberately contains patterns for the models to find, so strong results here show the pipeline works; they say nothing about real markets.</Notice>}
          <MetricStats m={res.metrics} b={res.benchmark} />
          <LineChart labels={eq.map((e) => e.date)} height={260} format={(v) => money(v).replace(".00", "")}
            series={[{ name: "Strategy", values: eq.map((e) => e.equity), color: "var(--chart-1)" }, { name: "Buy and hold SPY", values: eq.map((e) => e.benchmark), color: "var(--chart-2)", dashed: true }]} />
          <div>
            <div className="section-title">Drawdown</div>
            <LineChart labels={eq.map((e) => e.date)} height={130} format={(v) => `${(v * 100).toFixed(0)}%`}
              series={[{ name: "Drawdown", values: eq.map((e) => e.drawdown), color: "var(--down)", area: true }]} />
          </div>
          {res.in_sample && res.out_of_sample && (
            <div>
              <div className="section-title">In-sample vs out-of-sample (split {res.split_date})</div>
              <DataTable label="In vs out of sample" rows={[["In-sample", res.in_sample], ["Out-of-sample", res.out_of_sample]] as [string, M][]} rowKey={(x) => x[0]}
                columns={[
                  { key: "p", header: "Period", cell: (x) => x[0] },
                  { key: "r", header: "Return", num: true, cell: (x) => <Delta value={x[1].total_return_pct as number} /> },
                  { key: "s", header: "Sharpe", num: true, cell: (x) => num(x[1].sharpe as number) },
                  { key: "d", header: "Max DD", num: true, cell: (x) => pct(x[1].max_drawdown_pct as number, 1, false) },
                  { key: "t", header: "Trades", num: true, cell: (x) => x[1].trades ?? "—" },
                  { key: "w", header: "Win rate", num: true, cell: (x) => pct(x[1].win_rate_pct as number, 1, false) },
                ]} />
              <p className="xs faint" style={{ marginTop: 8 }}>Parameters were not fitted on this data, but if you tune them by looking at these results, the out-of-sample period stops being out-of-sample.</p>
            </div>
          )}
          {r.config.strategy === "ml_forecast" && <Notice>Every ML trade comes from a model trained only on data before that quarter, so the whole run is out-of-sample.</Notice>}
        </div>
      )}
      {tab === "trades" && (
        <DataTable label="Trades" rows={r.trades} rowKey={(t) => `${t.symbol}${t.entry_date}${t.side}`} maxHeight={520} initialSort={{ key: "ed", desc: true }}
          empty={<Empty title="No trades were taken" />}
          columns={[
            { key: "s", header: "Symbol", sticky: true, sort: (t) => t.symbol, cell: (t) => <SymbolLink symbol={t.symbol} /> },
            { key: "side", header: "Side", cell: (t) => <span className={`badge ${t.side === "long" ? "up" : "down"}`}>{t.side}</span> },
            { key: "ed", header: "Entry", sort: (t) => t.entry_date, cell: (t) => <span className="num">{t.entry_date}</span> },
            { key: "xd", header: "Exit", cell: (t) => <span className="num">{t.exit_date}</span> },
            { key: "q", header: "Qty", num: true, cell: (t) => t.qty },
            { key: "ep", header: "Entry px", num: true, cell: (t) => num(t.entry) },
            { key: "xp", header: "Exit px", num: true, cell: (t) => num(t.exit) },
            { key: "pnl", header: "P&L", num: true, sort: (t) => t.pnl, cell: (t) => <span className={t.pnl >= 0 ? "up" : "down"}>{money(t.pnl, true)}</span> },
            { key: "ret", header: "Return", num: true, sort: (t) => t.return_pct, cell: (t) => <Delta value={t.return_pct} bare /> },
            { key: "r", header: "R", num: true, sort: (t) => t.r_multiple, cell: (t) => num(t.r_multiple) },
            { key: "b", header: "Days", num: true, cell: (t) => t.bars },
            { key: "why", header: "Exit reason", cell: (t) => <span className="muted">{t.exit_reason}</span> },
          ]} />
      )}
      {tab === "periods" && (
        <DataTable label="Results by year" rows={res.by_year} rowKey={(y) => y.year}
          columns={[
            { key: "y", header: "Year", cell: (y) => <span className="num">{y.year}</span> },
            { key: "r", header: "Return", num: true, cell: (y) => <Delta value={y.return_pct} /> },
            { key: "d", header: "Max drawdown", num: true, cell: (y) => <span className="down">{pct(y.max_drawdown_pct, 1, false)}</span> },
            { key: "t", header: "Trades", num: true, cell: (y) => y.trades },
            { key: "w", header: "Win rate", num: true, cell: (y) => pct(y.win_rate_pct, 1, false) },
          ]} />
      )}
    </Panel>
  );
}
