import { Bell, Columns2, Eraser, Grid2X2, Minus, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { LogicalRange } from "lightweight-charts";
import { api, errMsg } from "../api/client";
import { useAccount, useBars } from "../api/hooks";
import { useQuote } from "../api/live";
import { PriceChart } from "../components/charts/PriceChart";
import { QuoteLine } from "../components/domain";
import { toast } from "../components/toast";
import { ErrorState, PageHead, Panel, Seg, Skeleton } from "../components/ui";
import { price } from "../lib/format";
import { TIMEFRAMES } from "./Research";

const INDICATORS = [
  { key: "sma20", label: "SMA 20" }, { key: "sma50", label: "SMA 50" }, { key: "sma200", label: "SMA 200" }, { key: "ema9", label: "EMA 9" },
  { key: "ema21", label: "EMA 21" }, { key: "bb", label: "Bollinger" }, { key: "vwap20", label: "VWAP 20" }, { key: "rsi", label: "RSI" }, { key: "macd", label: "MACD" },
];

interface PaneCfg { symbol: string; tf: string; ind: string[]; compare?: string }
const KEY = "lodestar.charts.v1";
const LEVELS_KEY = "lodestar.levels.v1";
const DEFAULT: { layout: 1 | 2 | 4; linked: boolean; panes: PaneCfg[] } = {
  layout: 2, linked: true,
  panes: [{ symbol: "SPY", tf: "1D", ind: ["sma50", "sma200", "rsi"] }, { symbol: "QQQ", tf: "1D", ind: ["sma50", "macd"] },
    { symbol: "AAPL", tf: "1H", ind: ["ema9", "ema21"] }, { symbol: "MSFT", tf: "15Min", ind: ["vwap20"] }],
};

function load() {
  try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { return DEFAULT; }
}
function loadLevels(): Record<string, number[]> {
  try { return JSON.parse(localStorage.getItem(LEVELS_KEY) ?? "{}"); } catch { return {}; }
}
const SYM = /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/;

export default function ChartsPage() {
  const [params] = useSearchParams();
  const [st, setSt] = useState<typeof DEFAULT>(() => {
    const s = load();
    const sym = params.get("s");
    if (sym) s.panes[0] = { ...s.panes[0], symbol: sym.toUpperCase() };
    return s;
  });
  const [levels, setLevels] = useState(loadLevels);
  const [range, setRange] = useState<{ from: number; tf: string; r: LogicalRange } | null>(null);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* ignore */ } }, [st]);
  useEffect(() => { try { localStorage.setItem(LEVELS_KEY, JSON.stringify(levels)); } catch { /* ignore */ } }, [levels]);
  const setPane = (i: number, p: Partial<PaneCfg>) => setSt((s) => ({ ...s, panes: s.panes.map((x, j) => (j === i ? { ...x, ...p } : x)) }));
  const height = st.layout === 1 ? 640 : st.layout === 2 ? 560 : 380;
  return (
    <div className="page">
      <PageHead title="Chart workspace" sub="Up to four linked charts. Click with the level tool to mark a price"
        actions={<>
          <label className="check small"><input type="checkbox" checked={st.linked} onChange={(e) => setSt((s) => ({ ...s, linked: e.target.checked }))} /> Link time scales</label>
          <Seg label="Layout" value={String(st.layout)} onChange={(v) => setSt((s) => ({ ...s, layout: +v as 1 | 2 | 4 }))}
            options={[{ value: "1", label: <Square size={16} aria-label="One chart" /> }, { value: "2", label: <Columns2 size={16} aria-label="Two charts" /> }, { value: "4", label: <Grid2X2 size={16} aria-label="Four charts" /> }]} />
        </>} />
      <div className={`grid ${st.layout === 1 ? "" : "cols-2"}`}>
        {st.panes.slice(0, st.layout).map((p, i) => (
          <ChartPane key={i} cfg={p} height={height} onChange={(x) => setPane(i, x)}
            levels={levels[p.symbol] ?? NO_LEVELS} onLevels={(l) => setLevels((m) => ({ ...m, [p.symbol]: l }))}
            range={st.linked && range && range.from !== i && range.tf === p.tf ? range.r : null} onRange={st.linked ? (r) => setRange({ from: i, tf: p.tf, r }) : undefined} />
        ))}
      </div>
    </div>
  );
}

const NO_LEVELS: number[] = [];

function ChartPane({ cfg, height, onChange, levels, onLevels, range, onRange }: {
  cfg: PaneCfg; height: number; onChange: (p: Partial<PaneCfg>) => void; levels: number[]; onLevels: (l: number[]) => void; range: LogicalRange | null; onRange?: (r: LogicalRange) => void;
}) {
  const [sym, setSym] = useState(cfg.symbol);
  const [cmp, setCmp] = useState(cfg.compare ?? "");
  const [tool, setTool] = useState(false);
  const bars = useBars(cfg.symbol, cfg.tf, cfg.ind);
  const compare = useBars(cfg.compare ?? null, cfg.tf, []);
  const acct = useAccount();
  const q = useQuote(cfg.symbol);
  const toggle = (k: string) => onChange({ ind: cfg.ind.includes(k) ? cfg.ind.filter((x) => x !== k) : [...cfg.ind, k] });
  const alertAt = async (level: number) => {
    const last = q?.price ?? level;
    const kind = level >= last ? "price_above" : "price_below";
    try {
      await api.post("/alerts", { name: `${cfg.symbol} ${kind === "price_above" ? "above" : "below"} ${price(level)}`, kind, symbol: cfg.symbol, threshold: +level.toFixed(2), cooldown_minutes: 60 });
      toast("success", "Alert set", `${cfg.symbol} at ${price(level)}`);
    } catch (e) { toast("error", "Alert not set", errMsg(e)); }
  };
  return (
    <Panel flush
      title={
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (SYM.test(sym)) onChange({ symbol: sym.toUpperCase() }); }}>
          <input className="input sym" style={{ width: 90 }} value={sym} onChange={(e) => setSym(e.target.value.toUpperCase())} aria-label="Symbol" />
        </form>
      }
      hint={<QuoteLine q={q} />}
      actions={<Seg label="Timeframe" value={cfg.tf} onChange={(tf) => onChange({ tf })} options={TIMEFRAMES.map((t) => ({ value: t.value, label: t.label }))} />}>
      <div className="row wrap chart-tools">
        {INDICATORS.map((it) => (
          <button key={it.key} className={`btn sm ${cfg.ind.includes(it.key) ? "active" : "ghost"}`} aria-pressed={cfg.ind.includes(it.key)} onClick={() => toggle(it.key)}>{it.label}</button>
        ))}
        <span className="sep" aria-hidden />
        <button className={`btn sm ${tool ? "active" : "ghost"}`} aria-pressed={tool} onClick={() => setTool((t) => !t)}><Minus size={16} /> Level</button>
        {levels.length > 0 && <>
          <button className="btn ghost sm" onClick={() => alertAt(levels[levels.length - 1])}><Bell size={16} /> Alert at {price(levels[levels.length - 1])}</button>
          <button className="btn ghost sm icon" aria-label="Clear levels" title="Clear levels" onClick={() => onLevels([])}><Eraser size={16} /></button>
        </>}
        <span className="sep" aria-hidden />
        <form onSubmit={(e) => { e.preventDefault(); onChange({ compare: SYM.test(cmp) ? cmp.toUpperCase() : undefined }); }}>
          <input className="input sym" style={{ width: 96, height: 28 }} placeholder="Compare" value={cmp} onChange={(e) => setCmp(e.target.value.toUpperCase())} aria-label="Compare with symbol" />
        </form>
      </div>
      {bars.isLoading ? <div style={{ padding: 16, height }}><Skeleton rows={8} /></div> : bars.error ? <ErrorState error={bars.error} retry={() => bars.refetch()} /> :
        bars.data ? <PriceChart data={bars.data} height={height} livePrice={q?.price} trades={acct.data?.fills} levels={levels} compare={cfg.compare ? compare.data : null}
          range={range} onRange={onRange} onChartClick={tool ? (p) => { onLevels([...levels, +p.toFixed(2)]); setTool(false); } : undefined} /> : null}
    </Panel>
  );
}
