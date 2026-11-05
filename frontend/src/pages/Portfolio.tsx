import { useApi } from "../api/hooks";
import type { Position } from "../api/types";
import { BarList, LineChart, heatColor } from "../components/charts/svg";
import { DataTable } from "../components/DataTable";
import { SymbolLink } from "../components/domain";
import { Empty, Loadable, Notice, PageHead, Panel, Stat } from "../components/ui";
import { money, num, pct } from "../lib/format";

interface PA {
  account: { equity: number; cash: number; starting_cash: number; realized_pnl: number; unrealized_pnl: number; total_pnl: number; total_return_pct: number; day_pnl: number; day_pnl_pct: number; drawdown_pct: number; halted_reason: string | null };
  equity_history: { ts: string; equity: number; drawdown?: number }[];
  sectors: { sector: string; long: number; short: number; net_pct: number; gross_pct: number }[];
  exposure: { gross_pct: number; net_pct: number; long: number; short: number; positions: number };
  correlation: { symbols: string[]; matrix: number[][] } | null; beta: number | null;
  risk: { open_risk_to_stops: number; open_risk_pct: number; unprotected_positions: string[]; limits: Record<string, number> };
  trade_stats: { closing_fills: number; win_rate_pct: number | null; avg_win: number | null; avg_loss: number | null; profit_factor: number | null; commissions: number };
  positions: Position[];
}

function Gauge({ label, value, limit, unit = "%" }: { label: string; value: number; limit: number; unit?: string }) {
  const r = Math.min(1, Math.abs(value) / limit);
  const tone = r > 0.9 ? "var(--down)" : r > 0.7 ? "var(--warn)" : "var(--accent)";
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row between small"><span className="muted">{label}</span><span className="num">{value.toFixed(1)}{unit} <span className="faint">of {limit}{unit}</span></span></div>
      <div className="progress" role="meter" aria-valuenow={value} aria-valuemax={limit} aria-label={label}><i style={{ width: `${r * 100}%`, background: tone }} /></div>
    </div>
  );
}

export default function PortfolioPage() {
  const q = useApi<PA>(["portfolio"], "/portfolio/analytics", { refetchInterval: 15_000 });
  return (
    <div className="page">
      <PageHead title="Portfolio analytics" sub="Exposure, concentration and risk against your limits" />
      <Loadable q={q} rows={10}>
        {(d) => (
          <div className="stack lg">
            {d.account.halted_reason && <Notice kind="warn"><strong>Entries halted.</strong> {d.account.halted_reason}</Notice>}
            <div className="stats">
              <Stat lead label="Equity" value={money(d.account.equity)} />
              <Stat label="Total return" value={<span className={d.account.total_return_pct >= 0 ? "up" : "down"}>{pct(d.account.total_return_pct)}</span>} />
              <Stat label="Gross exposure" value={pct(d.exposure.gross_pct, 1, false)} note={`Net ${pct(d.exposure.net_pct, 1)}`} />
              <Stat label="Beta to S&P 500" value={num(d.beta)} note="60-day, current weights" />
              <Stat label="Open risk to stops" value={money(d.risk.open_risk_to_stops)} note={`${pct(d.risk.open_risk_pct, 2, false)} of equity`} />
              <Stat label="Closed-trade win rate" value={pct(d.trade_stats.win_rate_pct, 1, false)} note={`${d.trade_stats.closing_fills} closing fills`} />
              <Stat label="Profit factor" value={num(d.trade_stats.profit_factor)} />
            </div>
            <div className="grid g-12">
              <Panel className="span-8" title="Equity and drawdown" hint="Sampled every minute while the app runs">
                {new Set(d.equity_history.map((h) => h.equity)).size > 1 ? (
                  <div className="stack lg">
                    <LineChart labels={d.equity_history.map((h) => h.ts.slice(5, 16).replace("T", " "))} height={220} format={(v) => money(v).replace(".00", "")}
                      series={[{ name: "Equity", values: d.equity_history.map((h) => h.equity), color: "var(--chart-1)", area: true }]} />
                    <LineChart labels={d.equity_history.map((h) => h.ts.slice(5, 16).replace("T", " "))} height={110} format={(v) => `${(v * 100).toFixed(2)}%`}
                      series={[{ name: "Drawdown", values: d.equity_history.map((h) => h.drawdown ?? 0), color: "var(--down)", area: true }]} />
                  </div>
                ) : <Empty title="The equity curve starts with your first trade" />}
              </Panel>
              <Panel className="span-4" title="Risk limits in use">
                <div className="stack lg">
                  <Gauge label="Gross exposure" value={d.exposure.gross_pct} limit={d.risk.limits.max_gross_exposure_pct} />
                  {d.sectors.slice(0, 1).map((s) => <Gauge key={s.sector} label={`Largest sector (${s.sector})`} value={s.gross_pct} limit={d.risk.limits.max_sector_pct} />)}
                  <Gauge label="Today's loss" value={Math.max(0, -d.account.day_pnl_pct)} limit={d.risk.limits.max_daily_loss_pct} />
                  <Gauge label="Drawdown from peak" value={Math.max(0, -d.account.drawdown_pct)} limit={d.risk.limits.max_drawdown_pct} />
                  {d.risk.unprotected_positions.length > 0 && <Notice kind="warn">No stop-loss on: {d.risk.unprotected_positions.join(", ")}.</Notice>}
                </div>
              </Panel>
              <Panel className="span-6" title="Sector exposure" hint="Net, % of equity">
                {d.sectors.length ? <BarList format={(v) => `${v.toFixed(1)}%`} items={d.sectors.map((s) => ({ label: s.sector, value: s.net_pct }))} /> : <Empty title="No positions" />}
              </Panel>
              <Panel className="span-6" title="Correlation of holdings" hint="60-day daily returns">
                {d.correlation ? (
                  <div className="table-wrap">
                    <table className="dt" aria-label="Correlation matrix">
                      <thead><tr><th className="sticky" />{d.correlation.symbols.map((s) => <th key={s} className="num">{s}</th>)}</tr></thead>
                      <tbody>
                        {d.correlation.matrix.map((row, i) => (
                          <tr key={i}><td className="sticky sym">{d.correlation!.symbols[i]}</td>
                            {row.map((v, j) => <td key={j} className="num" style={{ background: i === j ? "var(--surface-2)" : heatColor(v, 1) }}>{v.toFixed(2)}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <Empty title="Needs at least two positions" />}
              </Panel>
              <Panel className="span-12" title="Holdings" flush>
                <DataTable<Position> label="Holdings" rows={d.positions} rowKey={(p) => p.symbol} empty={<Empty title="No positions" />}
                  columns={[
                    { key: "s", header: "Symbol", sticky: true, cell: (p) => <SymbolLink symbol={p.symbol} /> },
                    { key: "sec", header: "Sector", cell: (p) => p.sector },
                    { key: "q", header: "Qty", num: true, cell: (p) => p.qty },
                    { key: "mv", header: "Value", num: true, sort: (p) => Math.abs(p.market_value), cell: (p) => money(p.market_value) },
                    { key: "w", header: "Weight", num: true, sort: (p) => Math.abs(p.market_value), cell: (p) => pct((p.market_value / d.account.equity) * 100, 1) },
                    { key: "u", header: "Unrealized", num: true, sort: (p) => p.unrealized, cell: (p) => <span className={p.unrealized >= 0 ? "up" : "down"}>{money(p.unrealized, true)}</span> },
                  ]} />
              </Panel>
            </div>
          </div>
        )}
      </Loadable>
    </div>
  );
}
