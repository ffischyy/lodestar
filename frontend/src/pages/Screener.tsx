import { Download, Save, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSnapshot, type SnapshotRow } from "../api/snapshot";
import { useLive } from "../api/live";
import { DataTable, type Column } from "../components/DataTable";
import { LivePrice, SymbolLink } from "../components/domain";
import { Delta, Field, Loadable, NumberInput, PageHead, Panel } from "../components/ui";
import { download, toCsv } from "../lib/csv";
import { date, frac, isNum, moneyShort, num } from "../lib/format";

type RangeKey = "price" | "change_pct" | "rel_volume" | "rsi14" | "atr_pct" | "pe_ratio" | "cap_b" | "ret_1m_pct";
interface Filters {
  sector: string; aboveSma50: boolean; aboveSma200: boolean; nearHigh: boolean; earningsSoon: boolean;
  min: Partial<Record<RangeKey, number | null>>; max: Partial<Record<RangeKey, number | null>>;
}
const EMPTY: Filters = { sector: "", aboveSma50: false, aboveSma200: false, nearHigh: false, earningsSoon: false, min: {}, max: {} };

const RANGES: { key: RangeKey; label: string; get: (r: SnapshotRow) => number | null }[] = [
  { key: "price", label: "Price", get: (r) => r.price },
  { key: "change_pct", label: "Change today, %", get: (r) => r.change_pct },
  { key: "ret_1m_pct", label: "1-month return, %", get: (r) => (isNum(r.ret_1m) ? r.ret_1m * 100 : null) },
  { key: "rel_volume", label: "Relative volume", get: (r) => r.rel_volume },
  { key: "rsi14", label: "RSI 14", get: (r) => r.rsi14 },
  { key: "atr_pct", label: "ATR, % of price", get: (r) => r.atr_pct },
  { key: "pe_ratio", label: "P/E", get: (r) => r.pe_ratio },
  { key: "cap_b", label: "Market cap, $B", get: (r) => (isNum(r.market_cap) ? r.market_cap / 1e9 : null) },
];

const PRESETS: { name: string; f: Partial<Filters> }[] = [
  { name: "Momentum leaders", f: { aboveSma50: true, aboveSma200: true, min: { ret_1m_pct: 5 } } },
  { name: "Oversold in an uptrend", f: { aboveSma200: true, max: { rsi14: 40 } } },
  { name: "Unusual volume", f: { min: { rel_volume: 1.5 } } },
  { name: "Near 52-week high", f: { nearHigh: true } },
  { name: "Earnings within 14 days", f: { earningsSoon: true } },
  { name: "Low P/E", f: { max: { pe_ratio: 15 } } },
];

const SAVED_KEY = "lodestar.screens.v1";
const loadSaved = (): { name: string; f: Filters }[] => {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) ?? "[]"); } catch { return []; }
};

const within14 = (iso: string | null) => {
  if (!iso) return false;
  const days = (Date.parse(iso) - Date.now()) / 86_400_000;
  return days >= 0 && days <= 14;
};

export function matches(r: SnapshotRow, f: Filters) {
  if (f.sector && r.sector !== f.sector) return false;
  if (f.aboveSma50 && !((r.dist_sma50 ?? -1) > 0)) return false;
  if (f.aboveSma200 && !((r.dist_sma200 ?? -1) > 0)) return false;
  if (f.nearHigh && r.dist_52w_high < -0.05) return false;
  if (f.earningsSoon && !within14(r.next_earnings)) return false;
  return RANGES.every(({ key, get }) => {
    const lo = f.min[key], hi = f.max[key], v = get(r);
    if (lo == null && hi == null) return true;
    return isNum(v) && (lo == null || v >= lo) && (hi == null || v <= hi);
  });
}

const COLUMNS: Column<SnapshotRow>[] = [
  { key: "sym", header: "Symbol", cell: (r) => <SymbolLink symbol={r.symbol} />, sort: (r) => r.symbol, sticky: true },
  { key: "sector", header: "Sector", cell: (r) => <span className="muted">{r.sector}</span>, sort: (r) => r.sector },
  { key: "price", header: "Price", num: true, cell: (r) => <LivePrice symbol={r.symbol} fallback={r.price} />, sort: (r) => r.price },
  { key: "chg", header: "Today", num: true, cell: (r) => <Delta value={r.change_pct} bare />, sort: (r) => r.change_pct },
  { key: "m1", header: "1M", num: true, cell: (r) => <Delta value={r.ret_1m} kind="frac" digits={1} bare />, sort: (r) => r.ret_1m },
  { key: "m3", header: "3M", num: true, cell: (r) => <Delta value={r.ret_3m} kind="frac" digits={1} bare />, sort: (r) => r.ret_3m },
  { key: "rv", header: "Rel vol", num: true, cell: (r) => num(r.rel_volume), sort: (r) => r.rel_volume, title: "Today's volume against the 20-day average" },
  { key: "rsi", header: "RSI", num: true, cell: (r) => num(r.rsi14, 0), sort: (r) => r.rsi14 },
  { key: "atr", header: "ATR %", num: true, cell: (r) => num(r.atr_pct, 1), sort: (r) => r.atr_pct },
  { key: "high", header: "From 52w high", num: true, cell: (r) => frac(r.dist_52w_high, 1), sort: (r) => r.dist_52w_high },
  { key: "cap", header: "Mkt cap", num: true, cell: (r) => moneyShort(r.market_cap), sort: (r) => r.market_cap },
  { key: "pe", header: "P/E", num: true, cell: (r) => num(r.pe_ratio, 1), sort: (r) => r.pe_ratio },
  { key: "earn", header: "Earnings", num: true, cell: (r) => (r.next_earnings ? date(r.next_earnings) : "—"), sort: (r) => r.next_earnings },
];

export default function ScreenerPage() {
  const q = useSnapshot();
  const nav = useNavigate();
  const [f, setF] = useState<Filters>(EMPTY);
  const [saved, setSaved] = useState(loadSaved);
  const [name, setName] = useState("");
  // merges live change % so filters on today's move stay current between snapshots
  const quotes = useLive((s) => s.quotes);
  const rows = useMemo(() => (q.data ?? []).map((r) => ({ ...r, change_pct: quotes[r.symbol]?.change_pct ?? r.change_pct })).filter((r) => matches(r, f)), [q.data, f, quotes]);
  const sectors = useMemo(() => [...new Set((q.data ?? []).map((r) => r.sector))].sort(), [q.data]);

  const persist = (next: typeof saved) => {
    setSaved(next);
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(next)); } catch { /* remembered for this visit only */ }
  };
  const setRange = (side: "min" | "max", key: RangeKey, v: number | null) => setF((x) => ({ ...x, [side]: { ...x[side], [key]: v } }));
  const flag = (key: "aboveSma50" | "aboveSma200" | "nearHigh" | "earningsSoon", label: string) => (
    <label className="check"><input type="checkbox" checked={f[key]} onChange={(e) => setF((x) => ({ ...x, [key]: e.target.checked }))} /> {label}</label>
  );

  return (
    <div className="page">
      <PageHead title="Screener" sub="Filter your universe on price, trend, volume and fundamentals"
        actions={<button className="btn" disabled={!rows.length} onClick={() => download("lodestar-screen.csv", toCsv(rows))}><Download size={16} /> Export CSV</button>} />
      <div className="screener">
        <Panel title="Filters" actions={<button className="btn ghost sm" onClick={() => setF(EMPTY)}>Clear</button>}>
          <div className="stack lg">
            <div className="chip-row" role="group" aria-label="Preset screens">
              {PRESETS.map((p) => <button key={p.name} onClick={() => setF({ ...EMPTY, ...p.f })}>{p.name}</button>)}
              {saved.map((s) => (
                <span key={s.name} className="saved-screen">
                  <button onClick={() => setF(s.f)}>{s.name}</button>
                  <button aria-label={`Delete ${s.name}`} onClick={() => persist(saved.filter((x) => x.name !== s.name))}><Trash2 size={16} /></button>
                </span>
              ))}
            </div>
            <Field label="Sector">
              <select className="select" value={f.sector} onChange={(e) => setF((x) => ({ ...x, sector: e.target.value }))}>
                <option value="">All sectors</option>
                {sectors.map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <div className="stack">
              {flag("aboveSma50", "Above 50-day average")}
              {flag("aboveSma200", "Above 200-day average")}
              {flag("nearHigh", "Within 5% of 52-week high")}
              {flag("earningsSoon", "Earnings within 14 days")}
            </div>
            <div className="range-grid">
              <span /><span className="faint xs">Min</span><span className="faint xs">Max</span>
              {RANGES.map(({ key, label }) => (
                <div key={key} style={{ display: "contents" }}>
                  <span className="small muted">{label}</span>
                  <NumberInput value={f.min[key] ?? null} onChange={(v) => setRange("min", key, v)} aria-label={`${label} minimum`} />
                  <NumberInput value={f.max[key] ?? null} onChange={(v) => setRange("max", key, v)} aria-label={`${label} maximum`} />
                </div>
              ))}
            </div>
            <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { persist([...saved.filter((s) => s.name !== name.trim()), { name: name.trim(), f }]); setName(""); } }}>
              <input className="input" placeholder="Name this screen" value={name} onChange={(e) => setName(e.target.value)} aria-label="Screen name" />
              <button className="btn" disabled={!name.trim()}><Save size={16} /> Save</button>
            </form>
          </div>
        </Panel>
        <Panel title="Results" hint={q.data ? `${rows.length} of ${q.data.length}` : undefined} flush>
          <Loadable q={q} rows={10}>
            {() => <DataTable label="Screener results" rows={rows} columns={COLUMNS} rowKey={(r) => r.symbol} initialSort={{ key: "chg", desc: true }}
              onRowClick={(r) => nav(`/research/${r.symbol}`)} maxHeight="calc(100vh - 220px)" empty={<p className="state small">No stocks match. Loosen a filter.</p>} />}
          </Loadable>
        </Panel>
      </div>
    </div>
  );
}
