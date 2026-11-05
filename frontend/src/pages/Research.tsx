import { ListPlus, MessageSquareText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import { useAccount, useApi, useBars, useResearch } from "../api/hooks";
import { useQuote } from "../api/live";
import type { PredictionRow } from "../api/types";
import { PriceChart } from "../components/charts/PriceChart";
import { DataTable } from "../components/DataTable";
import { EvidenceList, ForecastBlock, NewsList, OrderTicket, PlanTable, QuoteLine, SignalTable } from "../components/domain";
import { toast } from "../components/toast";
import { Empty, ErrorState, Notice, PageHead, Panel, Seg, Skeleton } from "../components/ui";
import { date, frac, isNum, moneyShort, num, price, prob } from "../lib/format";

const LAST_KEY = "lodestar.lastSymbol";
export const TIMEFRAMES = [{ value: "1D", label: "1D" }, { value: "1H", label: "1H" }, { value: "15Min", label: "15m" }, { value: "5Min", label: "5m" }] as const;

export default function ResearchPage() {
  const { symbol: raw } = useParams();
  const nav = useNavigate();
  const symbol = raw?.toUpperCase();
  useEffect(() => {
    if (!symbol) {
      const last = localStorage.getItem(LAST_KEY);
      nav(`/research/${last || "AAPL"}`, { replace: true });
    } else localStorage.setItem(LAST_KEY, symbol);
  }, [symbol, nav]);
  if (!symbol) return null;
  return <ResearchView key={symbol} symbol={symbol} />;
}

function ResearchView({ symbol }: { symbol: string }) {
  const r = useResearch(symbol);
  const [dir, setDir] = useState<"long" | "short">("long");
  const [tf, setTf] = useState<string>("1D");
  const [ticket, setTicket] = useState<"buy" | "sell" | null>(null);
  const bars = useBars(symbol, tf, tf === "1D" ? ["sma50", "sma200", "rsi"] : ["ema9", "ema21", "vwap20"]);
  const acct = useAccount();
  const live = useQuote(symbol);
  const lists = useApi<{ id: number; name: string; symbols: string[] }[]>(["watchlists"], "/watchlists");
  const qc = useQueryClient();
  useEffect(() => { if (r.data) setDir(r.data.lean); }, [r.data?.symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  const plan = r.data?.plans[dir];
  const lines = useMemo(() => plan ? { entry: plan.plan.entry, stop: plan.plan.stop, targets: plan.plan.targets } : undefined, [plan]);

  if (r.isLoading) return <div className="page"><Skeleton rows={12} /></div>;
  if (r.error) return <div className="page"><ErrorState error={r.error} retry={() => r.refetch()} title={`Could not load ${symbol}`} /></div>;
  const d = r.data!;
  const p = d.profile;
  const q = live ?? d.quote;

  const addToList = async (id: number) => {
    const wl = lists.data?.find((w) => w.id === id);
    if (!wl) return;
    try {
      await api.put(`/watchlists/${id}`, { name: wl.name, symbols: [...wl.symbols, symbol] });
      qc.invalidateQueries({ queryKey: ["watchlists"] });
      toast("success", `Added ${symbol} to ${wl.name}`);
    } catch (e) { toast("error", "Watchlist not updated", errMsg(e)); }
  };

  return (
    <div className="page">
      <PageHead
        title={<span className="row wrap" style={{ gap: 12 }}><span className="sym">{symbol}</span><span className="muted" style={{ fontWeight: 400 }}>{d.name}</span><span className="badge">{d.sector}</span></span>}
        sub={<QuoteLine q={q} big />}
        actions={<>
          {lists.data && lists.data.length > 0 && (
            <select className="select" style={{ width: 170 }} value="" onChange={(e) => e.target.value && addToList(+e.target.value)} aria-label="Add to watchlist">
              <option value="">Add to watchlist…</option>
              {lists.data.map((w) => <option key={w.id} value={w.id} disabled={w.symbols.includes(symbol)}>{w.name}</option>)}
            </select>
          )}
          {(!lists.data || lists.data.length === 0) && <Link to="/watchlists" className="btn"><ListPlus size={16} /> Watchlists</Link>}
          <Link className="btn" to={`/ai?s=${symbol}`}><MessageSquareText size={16} /> Explain</Link>
          <button className="btn buy" onClick={() => setTicket("buy")}>Buy</button>
          <button className="btn sell" onClick={() => setTicket("sell")}>Sell</button>
        </>} />
      <div className="grid g-12">
        <Panel className="span-8" title="Price" flush
          actions={<>
            <Seg label="Timeframe" value={tf} onChange={setTf} options={TIMEFRAMES.map((t) => ({ value: t.value, label: t.label }))} />
          </>}>
          {bars.isLoading ? <div style={{ padding: 16 }}><Skeleton rows={10} /></div> : bars.error ? <ErrorState error={bars.error} retry={() => bars.refetch()} /> :
            bars.data ? <PriceChart data={bars.data} height={520} lines={tf === "1D" ? lines : undefined} livePrice={q?.price} trades={acct.data?.fills} /> : null}
          <div className="panel-foot">
            {tf === "1D" ? `Daily candles with SMA 50 / 200 and RSI(14). Dashed lines show the ${dir} plan: entry, stop and targets.` : "Intraday candles with EMA 9 / 21 and 20-bar VWAP."}
            {bars.data?.meta.issues.length ? ` Data notes: ${bars.data.meta.issues.join("; ")}.` : ""}
          </div>
        </Panel>
        <div className="span-4 stack lg">
          <Panel title="Forecast" actions={<Seg label="Direction" value={dir} onChange={setDir} options={[{ value: "long", label: "Long" }, { value: "short", label: "Short" }]} />}>
            <ForecastBlock f={d.forecast} direction={dir} />
          </Panel>
          {plan && (
            <Panel title={`${dir === "long" ? "Long" : "Short"} plan`} hint={`Signal agreement ${plan.agreement >= 0 ? "+" : ""}${plan.agreement.toFixed(2)}`}>
              <PlanTable plan={plan.plan} />
              <p className="xs faint" style={{ marginTop: 8 }}>{plan.plan.invalidation}</p>
            </Panel>
          )}
        </div>
        {plan && (
          <>
            <Panel className="span-6" title="Supporting evidence"><EvidenceList items={plan.evidence.supporting} kind="support" /></Panel>
            <Panel className="span-6" title="Contradicting evidence"><EvidenceList items={plan.evidence.contradicting} kind="against" /></Panel>
          </>
        )}
        <Panel className="span-8" title="Technical and statistical signals" hint="Descriptions of the data, not forecasts">
          <SignalTable signals={d.signals} />
        </Panel>
        <div className="span-4 stack lg">
          {plan && (
            <Panel title="Main risks">
              <ul className="small muted" style={{ margin: 0, paddingLeft: 16, display: "grid", gap: 8 }}>{plan.risks.map((x) => <li key={x}>{x}</li>)}</ul>
            </Panel>
          )}
          {d.history?.window_days && (
            <Panel title="This stock's history" hint={`last ${d.history.window_days} days`}>
              <dl className="kv small">
                <dt>Long target hit first</dt><dd className="num">{prob(d.history.long_target_first_rate)}</dd>
                <dt>Short target hit first</dt><dd className="num">{prob(d.history.short_target_first_rate)}</dd>
                <dt>Positive {d.forecast?.horizon_days ?? 10}-day return</dt><dd className="num">{prob(d.history.positive_return_rate)}</dd>
                <dt>Median {d.forecast?.horizon_days ?? 10}-day return</dt><dd className="num">{frac(d.history.median_fwd_return)}</dd>
              </dl>
              <p className="xs faint" style={{ marginTop: 8 }}>Unconditional frequencies: a baseline for judging the model's numbers.</p>
            </Panel>
          )}
        </div>
        <Panel className="span-6" title="Company" hint={p?.source ? `Source: ${p.source}` : undefined}>
          {!p ? <Empty title="No profile available from the data provider" /> : (
            <div className="stack lg">
              {p.simulated && <Notice kind="sim">Fundamentals are <strong>simulated</strong>.</Notice>}
              <dl className="kv small">
                <dt>Industry</dt><dd>{p.industry || "—"}</dd>
                <dt>Market cap</dt><dd className="num">{moneyShort(p.market_cap)}</dd>
                <dt>P/E (trailing / forward)</dt><dd className="num">{num(p.pe_ratio, 1)} / {num(p.forward_pe, 1)}</dd>
                <dt>EPS</dt><dd className="num">{num(p.eps)}</dd>
                <dt>Dividend yield</dt><dd className="num">{isNum(p.dividend_yield) ? `${p.dividend_yield.toFixed(2)}%` : "—"}</dd>
                <dt>Beta</dt><dd className="num">{num(p.beta)}</dd>
                <dt>52-week range</dt><dd className="num">{price(p.fifty_two_week_low)} – {price(p.fifty_two_week_high)}</dd>
                <dt>Next earnings</dt><dd className="num">{p.next_earnings ? date(p.next_earnings) : "Unknown"}</dd>
              </dl>
              {p.description && <p className="small muted" style={{ maxWidth: "75ch" }}>{p.description.slice(0, 600)}{p.description.length > 600 ? "…" : ""}</p>}
              {p.fields_unavailable.length > 0 && <p className="xs faint">Not provided by this source: {p.fields_unavailable.join(", ").replace(/_/g, " ")}.</p>}
            </div>
          )}
        </Panel>
        <Panel className="span-6" title="Recent news" hint="Scored by lexicon"><NewsList items={d.news} /></Panel>
        <Panel className="span-12" title="Prediction history" hint="Forecasts logged for this symbol and how they turned out" flush>
          <PredictionTable rows={d.prediction_history} />
        </Panel>
      </div>
      {ticket && plan && (
        <OrderTicket onClose={() => setTicket(null)} defaults={{
          symbol, side: ticket,
          stop: ticket === (dir === "long" ? "buy" : "sell") ? +plan.plan.stop.toFixed(2) : undefined,
          target: ticket === (dir === "long" ? "buy" : "sell") ? +plan.plan.targets[0].toFixed(2) : undefined,
        }} />
      )}
    </div>
  );
}

export function PredictionTable({ rows, showSymbol }: { rows: PredictionRow[]; showSymbol?: boolean }) {
  return (
    <DataTable<PredictionRow> label="Prediction history" rows={rows} rowKey={(p) => p.id} maxHeight={420} initialSort={{ key: "asof", desc: true }}
      empty={<Empty title="No predictions logged yet">The scanner logs one forecast per symbol per trading day. Outcomes fill in once the horizon has passed.</Empty>}
      columns={[
        ...(showSymbol ? [{ key: "sym", header: "Symbol", sticky: true, sort: (p: PredictionRow) => p.symbol, cell: (p: PredictionRow) => <Link className="sym-link" to={`/research/${p.symbol}`}>{p.symbol}</Link> }] : []),
        { key: "asof", header: "As of close", sort: (p) => p.asof, cell: (p) => <span className="num">{p.asof.slice(0, 10)}</span> },
        { key: "h", header: "Horizon", num: true, cell: (p) => `${p.horizon_days}d` },
        { key: "px", header: "Price", num: true, cell: (p) => price(p.price) },
        { key: "pu", header: "P(up)", num: true, sort: (p) => p.p_up, cell: (p) => prob(p.p_up) },
        { key: "pt", header: "P(target)", num: true, sort: (p) => p.p_target_first, cell: (p) => prob(p.p_target_first) },
        { key: "e", header: "Expected", num: true, sort: (p) => p.exp_return, cell: (p) => frac(p.exp_return) },
        { key: "rng", header: "80% range", num: true, cell: (p) => <span className="muted">{frac(p.q10, 1)} / {frac(p.q90, 1)}</span> },
        { key: "rr", header: "Realized", num: true, sort: (p) => p.realized_return, cell: (p) => (p.resolved ? <span className={(p.realized_return ?? 0) >= 0 ? "up" : "down"}>{frac(p.realized_return)}</span> : <span className="faint">pending</span>) },
        { key: "hit", header: "Outcome", cell: (p) => p.hit ? <span className={`badge ${p.hit === "target" ? "up" : p.hit === "stop" ? "down" : ""}`}>{p.hit}</span> : <span className="faint">—</span> },
        { key: "m", header: "Model", cell: (p) => <span className="faint">{p.model} #{p.model_run_id}</span> },
      ]} />
  );
}
