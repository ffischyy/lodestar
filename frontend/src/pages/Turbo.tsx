import { DollarSign, Play, RotateCcw, Square, Trash2, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import { useApi } from "../api/hooks";
import { LineChart } from "../components/charts/svg";
import { DataTable } from "../components/DataTable";
import { toast } from "../components/toast";
import { Confirm, Empty, Field, Notice, NumberInput, PageHead, Panel, Progress, Seg, Stat, Toggle, Tooltip } from "../components/ui";
import { dateTime, money, num, pct } from "../lib/format";

interface Cfg {
  mode: "monte_carlo" | "history"; strategy: "ai" | "momentum" | "reversal" | "random"; markets: number; symbols: number; years: number;
  pattern_strength: "none" | "weak" | "medium"; horizon_days: number; stop_atr: number; target_atr: number; min_prob_edge: number;
  max_positions: number; risk_per_trade_pct: number; max_position_pct: number; slippage_bps: number; spread_bps: number; allow_short: boolean;
  starting_cash: number; seed: number | null;
}
interface MarketRes { market: number; trades: number; total_return_pct: number; max_drawdown_pct: number; sharpe: number; win_rate_pct: number | null; avg_r: number | null; profit_factor: number | null;
  final_value?: number; profit?: number; start_cash?: number }
interface TapeRow { n: number; day: number; exit_day: number; symbol: string; side: "long" | "short"; shares: number; entry: number; exit: number; cost: number; pnl: number; balance: number; why_exit: string }
interface MoneySummary {
  start_cash: number; markets: number; median_final: number; median_profit: number; median_margin_pct: number; average_profit: number;
  best_final: number; worst_final: number; profitable_markets: number; total_profit_all_markets: number; avg_profit_per_trade: number | null;
  gross_profit: number; gross_loss: number; latest_market: number | null; latest_tape: TapeRow[]; median_market: number | null; median_tape: TapeRow[];
}
interface Result {
  partial: boolean; seed: number; markets_done: number; trades: number; candidates: number; bars_processed: number; engine_seconds: number; wall_seconds: number;
  trades_per_minute_engine: number; trades_per_minute_total: number; win_rate_pct: number | null; avg_r: number | null; profit_factor: number | null;
  median_return_pct: number | null; p05_return_pct: number | null; p95_return_pct: number | null; pct_markets_profitable: number | null;
  median_max_drawdown_pct: number | null; median_sharpe: number | null; r_histogram: { counts: number[]; edges: number[] };
  markets: MarketRes[]; curves: number[][]; median_curve: number[]; config: Cfg; money?: MoneySummary;
}
interface Run { id: number; created_at: string; status: string; progress: number; error: string | null; config: Cfg; result?: Result;
  summary: Partial<Result> }

const STRATS: Record<Cfg["strategy"], string> = {
  ai: "AI model (walk-forward)", momentum: "Momentum", reversal: "Short-term reversal", random: "Random entries (baseline)",
};
const PRESETS: { label: string; cfg: Partial<Cfg> }[] = [
  { label: "Quick: 5 markets", cfg: { markets: 5, symbols: 200, years: 6 } },
  { label: "Standard: 20 markets", cfg: { markets: 20, symbols: 200, years: 8 } },
  { label: "Big: 50 markets × 500 stocks", cfg: { markets: 50, symbols: 500, years: 8 } },
  { label: "Pure noise test", cfg: { pattern_strength: "none", markets: 20, symbols: 200, years: 8 } },
];
const fmtInt = (v: number | null | undefined) => (v == null ? "—" : Math.round(v).toLocaleString("en-US"));

export default function TurboPage() {
  const defaults = useApi<Cfg>(["turbo-defaults"], "/turbo/defaults", { staleTime: Infinity });
  const runs = useApi<{ running: boolean; runs: Run[] }>(["turbo-runs"], "/turbo/runs", { refetchInterval: (q) => (q.state.data?.running ? 1000 : false) });
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [del, setDel] = useState<Run | null>(null);
  const qc = useQueryClient();
  useEffect(() => { if (defaults.data && !cfg) setCfg(defaults.data); }, [defaults.data, cfg]);
  useEffect(() => { if (sel === null && runs.data?.runs.length) setSel(runs.data.runs[0].id); }, [runs.data, sel]);
  const set = <K extends keyof Cfg>(k: K, v: Cfg[K]) => cfg && setCfg({ ...cfg, [k]: v });

  const start = async (override?: Partial<Cfg>) => {
    if (!cfg) return;
    try {
      const r = await api.post<{ id: number }>("/turbo/run", { ...cfg, ...override });
      setSel(r.id);
      qc.invalidateQueries({ queryKey: ["turbo-runs"] });
    } catch (e) { toast("error", "Simulation not started", errMsg(e)); }
  };
  const size = cfg ? (cfg.mode === "history" ? 1 : cfg.markets) * cfg.symbols * cfg.years : 0;

  return (
    <div className="page">
      <PageHead title="Turbo simulator"
        sub="Runs a strategy across many markets at once, so you see the spread of outcomes instead of one lucky history"
        actions={runs.data?.running
          ? <button className="btn danger" onClick={() => api.post("/turbo/cancel").then(() => toast("info", "Stopping after the current market"))}><Square size={16} /> Stop</button>
          : <button className="btn primary" onClick={() => start()} disabled={!cfg}><Play size={16} /> Run simulation</button>} />
      <div className="grid g-12">
        <div className="span-4 stack lg">
          {cfg && (
            <Panel title="Setup">
              <div className="stack lg">
                <div className="preset-row">{PRESETS.map((p) => <button key={p.label} className="btn sm" onClick={() => setCfg({ ...cfg, mode: "monte_carlo", ...p.cfg })}>{p.label}</button>)}</div>
                <Field label="Starting money (each simulated market starts with this)" help="Play money only. You'll watch it change as the AI buys and sells.">
                  <div className="row" style={{ gap: 8 }}>
                    <NumberInput value={cfg.starting_cash ?? 100000} onChange={(v) => set("starting_cash", Math.max(100, v ?? 100000))} step={1000} />
                    {[10_000, 100_000, 1_000_000].map((v) => <button key={v} type="button" className="btn sm" onClick={() => set("starting_cash", v)}>{money(v).replace(".00", "")}</button>)}
                  </div>
                </Field>
                <Field label="Market data">
                  <Seg label="Market data" value={cfg.mode} onChange={(v) => set("mode", v)} options={[{ value: "monte_carlo", label: "Fresh simulated markets" }, { value: "history", label: "My universe's history" }]} />
                </Field>
                <Field label="Strategy">
                  <select className="select" value={cfg.strategy} onChange={(e) => set("strategy", e.target.value as Cfg["strategy"])}>
                    {Object.entries(STRATS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </Field>
                {cfg.mode === "monte_carlo" && (
                  <>
                    <div className="form-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
                      <Field label="Markets"><NumberInput value={cfg.markets} onChange={(v) => set("markets", Math.max(1, Math.round(v ?? 1)))} /></Field>
                      <Field label="Stocks each"><NumberInput value={cfg.symbols} onChange={(v) => set("symbols", Math.max(10, Math.round(v ?? 10)))} /></Field>
                      <Field label="Years each"><NumberInput value={cfg.years} onChange={(v) => set("years", v ?? 8)} /></Field>
                    </div>
                    <Field label="Hidden patterns in the simulated markets" help="'None' is pure noise: no strategy should make money there after costs">
                      <Seg label="Pattern strength" value={cfg.pattern_strength} onChange={(v) => set("pattern_strength", v)}
                        options={[{ value: "none", label: "None" }, { value: "weak", label: "Weak" }, { value: "medium", label: "Medium" }]} />
                    </Field>
                  </>
                )}
                <div className="form-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                  <Field label="Hold up to (days)"><NumberInput value={cfg.horizon_days} onChange={(v) => set("horizon_days", Math.round(v ?? 10))} /></Field>
                  <Field label="Max positions"><NumberInput value={cfg.max_positions} onChange={(v) => set("max_positions", Math.round(v ?? 20))} /></Field>
                  <Field label="Stop (× ATR)"><NumberInput value={cfg.stop_atr} onChange={(v) => set("stop_atr", v ?? 1.5)} step={0.1} /></Field>
                  <Field label="Target (× ATR)"><NumberInput value={cfg.target_atr} onChange={(v) => set("target_atr", v ?? 2)} step={0.1} /></Field>
                  <Field label="Risk per trade (%)"><NumberInput value={cfg.risk_per_trade_pct} onChange={(v) => set("risk_per_trade_pct", v ?? 0.5)} step={0.1} /></Field>
                  {cfg.strategy === "ai" && <Field label="Min probability edge"><NumberInput value={cfg.min_prob_edge} onChange={(v) => set("min_prob_edge", v ?? 0.03)} step={0.01} /></Field>}
                  <Field label="Slippage (bps/side)"><NumberInput value={cfg.slippage_bps} onChange={(v) => set("slippage_bps", v ?? 5)} /></Field>
                  <Field label="Spread (bps)"><NumberInput value={cfg.spread_bps} onChange={(v) => set("spread_bps", v ?? 3)} /></Field>
                </div>
                <Toggle checked={cfg.allow_short} onChange={(v) => set("allow_short", v)} label="Allow shorts" />
                <p className="xs faint">Size: {fmtInt(size)} stock-years{size > 400_000 ? " — too large, reduce markets or stocks" : ""}. Bigger runs give more reliable statistics.</p>
                <button className="btn primary" onClick={() => start()} disabled={runs.data?.running || size > 400_000}><Zap size={16} /> Run simulation</button>
              </div>
            </Panel>
          )}
          <Panel title="Past runs" flush>
            <DataTable<Run> label="Turbo runs" rows={runs.data?.runs ?? []} rowKey={(r) => r.id} selectedKey={sel} onRowClick={(r) => setSel(r.id)} maxHeight={320}
              empty={<Empty title="No runs yet">Pick a preset and press Run.</Empty>}
              columns={[
                { key: "n", header: "Run", cell: (r) => <span><span className="faint num">#{r.id}</span> {STRATS[r.config.strategy]?.split(" (")[0]}</span> },
                { key: "t", header: "Trades", num: true, cell: (r) => fmtInt(r.summary.trades) },
                { key: "m", header: "Median", num: true, cell: (r) => (r.summary.median_return_pct != null ? <span className={r.summary.median_return_pct >= 0 ? "up" : "down"}>{pct(r.summary.median_return_pct, 0)}</span> : r.status) },
                { key: "x", header: "", cell: (r) => <button className="btn ghost sm icon" aria-label={`Delete run ${r.id}`} onClick={(e) => { e.stopPropagation(); setDel(r); }}><Trash2 size={16} /></button> },
              ]} />
          </Panel>
        </div>
        <div className="span-8">{sel !== null ? <RunView id={sel} onBaseline={(c) => start({ ...c, strategy: "random" })} /> : <Panel><Empty title="Run a simulation to see results here" /></Panel>}</div>
      </div>
      {del && <Confirm title={`Delete run #${del.id}?`} danger confirmLabel="Delete" body="Its results are removed permanently." onCancel={() => setDel(null)}
        onConfirm={async () => { await api.del(`/turbo/runs/${del.id}`); if (sel === del.id) setSel(null); setDel(null); qc.invalidateQueries({ queryKey: ["turbo-runs"] }); }} />}
    </div>
  );
}

function RunView({ id, onBaseline }: { id: number; onBaseline: (c: Cfg) => void }) {
  const q = useApi<Run>(["turbo-run", id], `/turbo/runs/${id}`, { refetchInterval: (x) => (x.state.data?.status === "running" ? 500 : false) });
  const r = q.data;
  if (!r) return (
    <div className="stack lg">
      <div className="counter-row">{["Trades simulated", "Engine speed", "End-to-end speed", "Markets"].map((l) => (
        <div key={l} className="counter"><div className="label">{l}</div><div className="value num faint">0</div><div className="note">Starting…</div></div>))}</div>
    </div>
  );
  const res = r.result;
  const running = r.status === "running";
  if (r.status === "failed") return <Panel title={`Run #${r.id}`}><Notice kind="error"><strong>Simulation failed.</strong> {r.error}</Notice></Panel>;
  const markets = r.config.mode === "history" ? 1 : r.config.markets;
  return (
    <div className="stack lg">
      <div className="counter-row" aria-live="polite">
        <div className="counter"><div className="label">Trades simulated</div><div className="value num accent">{fmtInt(res?.trades ?? 0)}</div>
          <div className="note">{fmtInt(res?.candidates)} signals evaluated</div></div>
        <div className="counter"><div className="label"><Tooltip text="Trades per minute of pure simulation time (exit search, portfolio rules, accounting)."><span>Engine speed</span></Tooltip></div>
          <div className="value num">{fmtInt(res?.trades_per_minute_engine)}</div><div className="note">trades per minute</div></div>
        <div className="counter"><div className="label"><Tooltip text="Including generating each market, computing features and retraining the AI every quarter."><span>End-to-end speed</span></Tooltip></div>
          <div className="value num">{fmtInt(res?.trades_per_minute_total)}</div><div className="note">trades per minute, all steps</div></div>
        <div className="counter"><div className="label">Markets</div><div className="value num">{res?.markets_done ?? 0} / {markets}</div>
          <div className="note">{fmtInt(res?.bars_processed)} price bars in {num(res?.wall_seconds ?? 0, 1)} s</div></div>
      </div>
      {running && <Progress value={r.progress} />}
      {res?.money && (res.trades > 0 || running) && <MoneyView m={res.money} running={running} />}
      {res && res.trades > 0 && (
        <>
          {r.config.mode === "monte_carlo" && (
            <Notice kind="sim">These are <strong>simulated</strong> markets with {r.config.pattern_strength === "none" ? "no hidden patterns (pure noise)" : `${r.config.pattern_strength} hidden patterns`}.
              They show how the strategy behaves across many possible worlds, not how it will do in the real market.</Notice>
          )}
          <Panel title={`Results: ${STRATS[r.config.strategy]}`} hint={`Run #${r.id}, seed ${res.seed}, ${dateTime(r.created_at)}`}
            actions={r.config.strategy !== "random" && !running ? <button className="btn sm" onClick={() => onBaseline({ ...r.config, seed: res.seed })}>Compare with random entries</button> : null}>
            <div className="stack lg">
              <div className="stats">
                <Stat label="Median return" value={<span className={(res.median_return_pct ?? 0) >= 0 ? "up" : "down"}>{pct(res.median_return_pct, 1)}</span>} note={`Middle market of ${res.markets_done}`} />
                <Stat label="Range (5th–95th)" value={<span className="num">{pct(res.p05_return_pct, 0)} to {pct(res.p95_return_pct, 0)}</span>} note="Bad luck to good luck" />
                <Stat label="Markets profitable" value={pct(res.pct_markets_profitable, 0, false)} />
                <Stat label="Win rate" value={pct(res.win_rate_pct, 1, false)} />
                <Stat label="Average trade" value={`${(res.avg_r ?? 0) >= 0 ? "+" : ""}${num(res.avg_r, 3)} R`} note="R = the amount risked" />
                <Stat label="Profit factor" value={num(res.profit_factor)} note="Gains ÷ losses" />
                <Stat label="Median worst drop" value={<span className="down">{pct(res.median_max_drawdown_pct, 1, false)}</span>} />
                <Stat label="Median Sharpe" value={num(res.median_sharpe)} />
              </div>
              <div>
                <div className="section-title">Account value in each market (start = 1.0)</div>
                <LineChart labels={res.median_curve.map((_, i) => `${Math.round((i / Math.max(1, res.median_curve.length - 1)) * 100)}%`)} height={260} format={(v) => v.toFixed(2)}
                  series={[
                    ...res.curves.slice(0, 10).map((c, i) => ({ name: `Market ${i + 1}`, values: c, color: "var(--text-3)", legend: i === 0 })),
                    { name: "Median market", values: res.median_curve, color: "var(--chart-1)" },
                  ]} />
              </div>
              <div>
                <div className="section-title">How trades turned out (in R: multiples of the amount risked)</div>
                <Histogram counts={res.r_histogram.counts} edges={res.r_histogram.edges} />
              </div>
            </div>
          </Panel>
          <Panel title="Every market" flush>
            <DataTable<MarketRes> label="Results per market" rows={res.markets} rowKey={(m) => m.market} maxHeight={320} initialSort={{ key: "r", desc: true }}
              columns={[
                { key: "m", header: "Market", cell: (m) => <span className="num">#{m.market}</span> },
                { key: "t", header: "Trades", num: true, sort: (m) => m.trades, cell: (m) => fmtInt(m.trades) },
                { key: "fv", header: "Money at the end", num: true, sort: (m) => m.final_value ?? 0, cell: (m) => (m.final_value != null ? money(m.final_value) : "—") },
                { key: "pr", header: "Profit", num: true, sort: (m) => m.profit ?? 0, cell: (m) => (m.profit != null ? <span className={m.profit >= 0 ? "up" : "down"}>{money(m.profit, true)}</span> : "—") },
                { key: "r", header: "Return", num: true, sort: (m) => m.total_return_pct, cell: (m) => <span className={m.total_return_pct >= 0 ? "up" : "down"}>{pct(m.total_return_pct, 1)}</span> },
                { key: "d", header: "Worst drop", num: true, sort: (m) => m.max_drawdown_pct, cell: (m) => <span className="down">{pct(m.max_drawdown_pct, 1, false)}</span> },
                { key: "s", header: "Sharpe", num: true, sort: (m) => m.sharpe, cell: (m) => num(m.sharpe) },
                { key: "w", header: "Win rate", num: true, cell: (m) => pct(m.win_rate_pct, 1, false) },
                { key: "pf", header: "Profit factor", num: true, cell: (m) => num(m.profit_factor) },
              ]} />
          </Panel>
        </>
      )}
      {res && res.trades === 0 && !running && <Panel><Empty title="No trades were taken">The strategy found no signals that passed its threshold. Lower the minimum probability edge or use more stocks.</Empty></Panel>}
    </div>
  );
}

function Histogram({ counts, edges }: { counts: number[]; edges: number[] }) {
  const max = Math.max(1, ...counts);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 120 }} role="img" aria-label="Histogram of trade outcomes in R multiples">
        {counts.map((c, i) => {
          const mid = (edges[i] + edges[i + 1]) / 2;
          return (
            <span key={i} title={`${edges[i]} to ${edges[i + 1]} R: ${c.toLocaleString()} trades`} style={{ flex: 1, display: "block", height: `${(c / max) * 100}%`,
              minHeight: c ? 2 : 0, background: mid >= 0 ? "var(--up)" : "var(--down)", opacity: 0.8, borderRadius: "2px 2px 0 0" }} />
          );
        })}
      </div>
      <div className="xs faint num" style={{ position: "relative", height: 16, marginTop: 4 }}>
        <span style={{ position: "absolute", left: 0 }}>−3 R</span>
        <span style={{ position: "absolute", left: `${(3 / 8) * 100}%`, transform: "translateX(-50%)" }}>0 (break-even)</span>
        <span style={{ position: "absolute", right: 0 }}>+5 R</span>
      </div>
    </div>
  );
}


/** Live money view: replays a market's trades so you can watch the balance move, then sums up the profit. */
function MoneyView({ m, running }: { m: MoneySummary; running: boolean }) {
  const [which, setWhich] = useState<"latest" | "median">("latest");
  useEffect(() => { if (!running) setWhich("median"); }, [running]);
  const tape = which === "median" && m.median_tape.length ? m.median_tape : m.latest_tape;
  const marketNo = which === "median" && m.median_tape.length ? m.median_market : m.latest_market;
  const [speed, setSpeed] = useState<"normal" | "fast" | "instant">("normal");
  const [pos, setPos] = useState(0);
  const key = `${marketNo}-${tape.length}-${which}`;
  const lastKey = useRef("");
  useEffect(() => {                                     // restart playback whenever a new market's trades arrive
    if (lastKey.current !== key) { lastKey.current = key; setPos(0); }
  }, [key]);
  useEffect(() => {
    if (speed === "instant") { setPos(tape.length); return; }
    if (pos >= tape.length) return;
    const total = speed === "fast" ? 2500 : 9000;          // ms to play one market
    const step = Math.max(1, Math.ceil(tape.length / (total / 40)));
    const t = window.setTimeout(() => setPos((p) => Math.min(tape.length, p + step)), 40);
    return () => window.clearTimeout(t);
  }, [pos, tape.length, speed]);
  const shown = tape.slice(0, pos);
  const cur = shown.length ? shown[shown.length - 1].balance : m.start_cash;
  const pnl = cur - m.start_cash;
  const recent = shown.slice(-7).reverse();
  const curve = useMemo(() => [m.start_cash, ...shown.map((t) => t.balance)], [shown, m.start_cash]);
  const done = pos >= tape.length;
  return (
    <Panel title={<span className="row"><DollarSign size={16} /> Money</span>}
      hint={`Each market starts with ${money(m.start_cash)} of play money`}
      actions={<>
        {m.median_tape.length > 0 && !running && (
          <Seg label="Which market" value={which} onChange={setWhich} options={[{ value: "median", label: `Typical (#${m.median_market})` }, { value: "latest", label: `Last (#${m.latest_market})` }]} />
        )}
        <Seg label="Playback speed" value={speed} onChange={setSpeed} options={[{ value: "normal", label: "Watch" }, { value: "fast", label: "Fast" }, { value: "instant", label: "Skip" }]} />
        <button className="btn ghost sm" onClick={() => { setSpeed("normal"); setPos(0); }} title="Watch again"><RotateCcw size={16} /></button>
      </>}>
      <div className="money-live">
        <div className="money-live-main">
          <div className="xs faint">{running && which === "latest" ? `Market #${marketNo}: live` : `Market #${marketNo}`} · trade {fmtInt(shown.length ? shown[shown.length - 1].n : 0)} of {fmtInt(tape.length ? tape[tape.length - 1].n : 0)}</div>
          <div className={`money-live-balance num ${pnl > 0 ? "up" : pnl < 0 ? "down" : ""}`}>{money(cur)}</div>
          <div className="small num"><span className={pnl >= 0 ? "up" : "down"}>{money(pnl, true)} ({pct(pnl / m.start_cash * 100, 2)})</span> <span className="faint">from {money(m.start_cash)}</span></div>
          <div style={{ marginTop: 8 }}><LineChart labels={curve.map((_, i) => String(i))} height={120} format={(v) => money(v).replace(/\.\d\d$/, "")}
            series={[{ name: "Balance", values: curve, color: pnl >= 0 ? "var(--up)" : "var(--down)", area: true }]} /></div>
        </div>
        <ul className="money-tape" aria-live="off">
          {recent.length === 0 && <li className="xs faint">Waiting for the first trades…</li>}
          {recent.map((t) => (
            <li key={t.n} className="money-tape-row small">
              <span className={t.side === "long" ? "up" : "down"}><b>{t.side === "long" ? "Bought" : "Shorted"}</b> {t.shares.toLocaleString()} {t.symbol}</span>
              <span className="num faint">@ {t.entry.toFixed(2)} → {t.exit.toFixed(2)} ({t.why_exit})</span>
              <span className={`num ${t.pnl >= 0 ? "up" : "down"}`} style={{ marginLeft: "auto" }}>{money(t.pnl, true)}</span>
              <span className="num faint" style={{ minWidth: 92, textAlign: "right" }}>{money(t.balance)}</span>
            </li>
          ))}
        </ul>
      </div>
      {!running && done && m.markets > 0 && (
        <div className="stack" style={{ marginTop: 16 }}>
          <div className="section-title">Profit summary across {m.markets} market{m.markets === 1 ? "" : "s"}</div>
          <div className="stats">
            <Stat label="Started with" value={money(m.start_cash)} note="In every market" />
            <Stat label="Typical ending money" value={money(m.median_final)} note="Median market" />
            <Stat label="Typical profit" value={<span className={m.median_profit >= 0 ? "up" : "down"}>{money(m.median_profit, true)}</span>} />
            <Stat label="Profit margin" value={<span className={m.median_margin_pct >= 0 ? "up" : "down"}>{pct(m.median_margin_pct, 1)}</span>} note="Typical profit ÷ starting money" />
            <Stat label="Best market" value={money(m.best_final)} note={money(m.best_final - m.start_cash, true)} />
            <Stat label="Worst market" value={money(m.worst_final)} note={money(m.worst_final - m.start_cash, true)} />
            <Stat label="Markets in profit" value={`${m.profitable_markets} / ${m.markets}`} />
            <Stat label="Average profit per trade" value={m.avg_profit_per_trade != null ? <span className={m.avg_profit_per_trade >= 0 ? "up" : "down"}>{money(m.avg_profit_per_trade, true)}</span> : "—"} />
            <Stat label="Money won on winners" value={<span className="up">{money(m.gross_profit)}</span>} note="All markets" />
            <Stat label="Money lost on losers" value={<span className="down">{money(m.gross_loss)}</span>} note="All markets, after costs" />
          </div>
        </div>
      )}
      <p className="xs faint" style={{ marginTop: 12 }}>The engine finishes each market in milliseconds; this replays its trades so you can watch the money move. Simulated markets, play money: results don't predict real profits.</p>
    </Panel>
  );
}
