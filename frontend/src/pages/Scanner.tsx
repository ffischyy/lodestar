import { Play, SlidersHorizontal, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import { useApi, useScan } from "../api/hooks";
import type { Candidate } from "../api/types";
import { BarList } from "../components/charts/svg";
import { DataTable } from "../components/DataTable";
import { EvidenceList, Hint, OrderTicket, PlanTable, SymbolLink } from "../components/domain";
import { toast } from "../components/toast";
import { Delta, Empty, ErrorState, Field, Notice, NumberInput, PageHead, Panel, ScoreBar, Seg, Skeleton, Spinner, StatusPill, Tabs, Stat } from "../components/ui";
import { ago, frac, money, moneyShort, num, prob } from "../lib/format";
import { SimBanner } from "./Overview";

const COMPONENT_LABELS: Record<string, string> = {
  net_expected_return: "Expected net return", prob_edge: "Probability edge", reward_risk: "Reward / risk", model_reliability: "Model reliability",
  signal_agreement: "Signal agreement", liquidity: "Liquidity", regime_fit: "Regime fit", data_quality: "Data quality",
};

export default function ScannerPage() {
  const scan = useScan();
  const qc = useQueryClient();
  const [view, setView] = useState<"qualified" | "rejected">("qualified");
  const [sel, setSel] = useState<Candidate | null>(null);
  const [sector, setSector] = useState("all");
  const [side, setSide] = useState<"all" | "long" | "short">("all");
  const [tuning, setTuning] = useState(false);
  const [ticket, setTicket] = useState<Candidate | null>(null);

  const run = async () => {
    try {
      const r = await api.post<{ started: boolean; message?: string }>("/scanner/run");
      toast("info", r.started ? "Scan started" : "Scan already running", "Results refresh automatically when it finishes.");
      window.setTimeout(() => qc.invalidateQueries({ queryKey: ["scanner"] }), 4000);
    } catch (e) {
      toast("error", "Could not start a scan", errMsg(e));
    }
  };

  const r = scan.data?.result;
  const list = useMemo(() => {
    const src = view === "qualified" ? r?.candidates ?? [] : r?.rejected ?? [];
    return src.filter((c) => (sector === "all" || c.sector === sector) && (side === "all" || c.direction === side));
  }, [r, view, sector, side]);
  const sectors = useMemo(() => Array.from(new Set([...(r?.candidates ?? []), ...(r?.rejected ?? [])].map((c) => c.sector))).sort(), [r]);

  return (
    <div className="page">
      <PageHead title="Opportunity scanner"
        sub="Every stock scored, then filtered on data, edge, uncertainty and liquidity. An empty list is a valid answer"
        actions={<>
          {r && <span className="small muted">Scanned {ago(r.scanned_at)} in {r.duration_s}s</span>}
          <button className="btn" onClick={() => setTuning(true)}><SlidersHorizontal size={16} /> Filters and weights</button>
          <button className="btn primary" onClick={run} disabled={scan.data?.running}>{scan.data?.running ? <Spinner /> : <Play size={16} />} Scan now</button>
        </>} />
      <div className="stack lg">
        <SimBanner />
        {scan.isLoading ? <Skeleton rows={8} /> : scan.error ? <ErrorState error={scan.error} retry={() => scan.refetch()} /> : !r ? (
          <Panel><Empty title={scan.data?.has_model ? "The first scan is running" : "Waiting for a trained model"}>
            {scan.data?.has_model ? "Results appear here in a few seconds." : <>Training starts automatically. Follow it on <Link to="/models" className="sym-link">Model evaluation</Link>.</>}
          </Empty></Panel>
        ) : (
          <>
            {r.model && !r.model.passed && <Notice kind="warn">The active model <strong>failed</strong> its validation gates, so the scanner rejects every idea that depends on it. That is intentional: no edge was demonstrated.</Notice>}
            <div className="stats">
              <Stat label="Universe" value={r.universe_size} />
              <Stat lead label="Qualified" value={r.candidates.length} />
              <Stat label="Rejected" value={r.rejected.length} />
              <Stat label="Regime" value={String(r.regime.values.label_name ?? "—")} />
              <Stat label="Model" value={r.model ? `${r.model.champion} #${r.model.run_id}` : "None"} />
            </div>
            <div className="grid g-12">
              <Panel className="span-8" flush
                title={<Tabs value={view} onChange={setView} tabs={[{ value: "qualified", label: `Qualified (${r.candidates.length})` }, { value: "rejected", label: `Rejected (${r.rejected.length})` }]} />}
                actions={<>
                  <select className="select" style={{ width: 150 }} value={sector} onChange={(e) => setSector(e.target.value)} aria-label="Sector filter">
                    <option value="all">All sectors</option>{sectors.map((s) => <option key={s}>{s}</option>)}
                  </select>
                  <Seg label="Direction" value={side} onChange={setSide} options={[{ value: "all", label: "All" }, { value: "long", label: "Long" }, { value: "short", label: "Short" }]} />
                </>}>
                <DataTable<Candidate> label="Scanner results" rows={list} rowKey={(c) => `${c.symbol}-${c.direction}`} selectedKey={sel ? `${sel.symbol}-${sel.direction}` : null}
                  onRowClick={setSel} maxHeight="62vh" initialSort={{ key: "score", desc: true }}
                  empty={<Empty title={view === "qualified" ? "No trade qualifies right now" : "Nothing was rejected"}>
                    {view === "qualified" ? "Every candidate failed at least one rule. Open the Rejected tab to see why, or loosen the filters." : null}
                  </Empty>}
                  columns={[
                    { key: "sym", header: "Symbol", sticky: true, sort: (c) => c.symbol, cell: (c) => <SymbolLink symbol={c.symbol} /> },
                    { key: "dir", header: "Side", cell: (c) => <span className={`badge ${c.direction === "long" ? "up" : "down"}`}>{c.direction === "long" ? "▲ Long" : "▼ Short"}</span> },
                    { key: "strat", header: "Setup", cell: (c) => <span className="muted" title={c.strategy}>{c.strategy.replace(" + ML forecast", "")}</span> },
                    { key: "px", header: "Price", num: true, sort: (c) => c.price, cell: (c) => <span className="row" style={{ justifyContent: "flex-end", gap: 8 }}>{num(c.price)}{!["live", "simulated", "historical"].includes(c.data_status) && <StatusPill status={c.data_status} />}</span> },
                    { key: "net", header: <Hint tip="Model mean return over the horizon minus estimated round-trip costs">Net exp.</Hint>, num: true, sort: (c) => c.net_exp_return, cell: (c) => <Delta value={c.net_exp_return} kind="frac" /> },
                    { key: "rng", header: "80% range", num: true, cell: (c) => <span className="muted">{frac(c.q10, 1)} / {frac(c.q90, 1)}</span> },
                    { key: "pt", header: <Hint tip="Calibrated probability the target is hit before the stop">P(target)</Hint>, num: true, sort: (c) => c.p_target_first, cell: (c) => prob(c.p_target_first) },
                    { key: "edge", header: <Hint tip="P(target first) minus the historical base rate">Edge</Hint>, num: true, sort: (c) => c.prob_edge, cell: (c) => <Delta value={c.prob_edge} kind="frac" digits={1} bare /> },
                    { key: "score", header: "Score", num: true, sort: (c) => c.score, cell: (c) => <span className="row" style={{ justifyContent: "flex-end" }}><ScoreBar value={c.score} max={100} />{num(c.score, 0)}</span> },
                    ...(view === "rejected" ? [{ key: "why", header: "Main reason", cell: (c: Candidate) => <span className="down small truncate" style={{ maxWidth: 260, display: "inline-block" }} title={c.reasons.join(" ")}>{c.reasons[0]}</span> }] : []),
                  ]} />
              </Panel>
              <div className="span-4 stack lg">
                {sel ? <CandidateDetail c={sel} onClose={() => setSel(null)} onTrade={() => setTicket(sel)} /> : (
                  <Panel title="Why candidates were rejected">
                    {r.reason_counts.length ? (
                      <BarList colorize={false} format={(v) => String(v)} items={r.reason_counts.map((x) => ({ label: x.reason, value: x.count }))} />
                    ) : <p className="small faint">Nothing was rejected.</p>}
                    <p className="xs faint" style={{ marginTop: 12 }}>A candidate can fail several rules. Select a row to see its full evidence.</p>
                  </Panel>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      {tuning && <TuneDialog onClose={() => setTuning(false)} />}
      {ticket && <OrderTicket onClose={() => setTicket(null)}
        defaults={{ symbol: ticket.symbol, side: ticket.direction === "long" ? "buy" : "sell", qty: ticket.sizing.qty || undefined, stop: +ticket.plan.stop.toFixed(2), target: +ticket.plan.targets[0].toFixed(2) }} />}
    </div>
  );
}

function CandidateDetail({ c, onClose, onTrade }: { c: Candidate; onClose: () => void; onTrade: () => void }) {
  return (
    <Panel title={<span className="row"><span className="sym">{c.symbol}</span><span className={`badge ${c.direction === "long" ? "up" : "down"}`}>{c.direction}</span></span>}
      hint={c.name} actions={<button className="btn ghost sm icon" onClick={onClose} aria-label="Close details"><X size={16} /></button>}>
      <div className="stack lg">
        {c.rejected && <Notice kind="error"><strong>Rejected.</strong> {c.reasons.join(" ")}</Notice>}
        <div className="stats">
          <div className="stat"><div className="label">Score</div><div className="value num">{num(c.score, 0)}</div></div>
          <div className="stat"><div className="label">Net exp. ({c.horizon_days}d)</div><div className="value"><Delta value={c.net_exp_return} kind="frac" /></div></div>
          <div className="stat"><div className="label">P(target first)</div><div className="value num">{prob(c.p_target_first)}</div><div className="note">Base rate {prob(c.base_target_first)}</div></div>
        </div>
        <div>
          <div className="section-title">Trade plan</div>
          <PlanTable plan={c.plan} />
          <p className="xs faint" style={{ marginTop: 8 }}>{c.plan.invalidation}</p>
        </div>
        <div>
          <div className="section-title">Sizing and costs</div>
          <dl className="kv small">
            <dt>Suggested size</dt><dd className="num">{c.sizing.qty} shares ({money(c.sizing.position_value)})</dd>
            <dt>Loss at stop</dt><dd className="num down">{money(-c.sizing.risk_at_stop)} ({num(c.sizing.risk_pct_of_equity)}% of equity)</dd>
            <dt>Limited by</dt><dd>{c.sizing.binding_constraint}</dd>
            <dt>Avg. dollar volume</dt><dd className="num">{moneyShort(c.avg_dollar_volume)}</dd>
            <dt>Round-trip costs</dt><dd className="num">{frac(c.costs.round_trip_pct, 2, false)} ({money(c.costs.round_trip_cost)})</dd>
          </dl>
        </div>
        <div>
          <div className="section-title">Score components</div>
          <BarList colorize={false} format={(v) => v.toFixed(2)} items={Object.entries(c.components).map(([k, v]) => ({ label: COMPONENT_LABELS[k] ?? k, value: v }))} />
        </div>
        <div><div className="section-title">Supporting evidence</div><EvidenceList items={c.supporting} kind="support" /></div>
        <div><div className="section-title">Contradicting evidence</div><EvidenceList items={c.contradicting} kind="against" /></div>
        <div>
          <div className="section-title">Main risks</div>
          <ul className="small muted" style={{ margin: 0, paddingLeft: 16 }}>{c.risks.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
        {c.notes.length > 0 && <Notice kind="warn">{c.notes.join(" ")}</Notice>}
        <div className="row">
          <Link className="btn" to={`/research/${c.symbol}`}>Full research</Link>
          <button className={`btn ${c.direction === "long" ? "buy" : "sell"}`} onClick={onTrade} disabled={c.rejected}>Paper trade</button>
        </div>
      </div>
    </Panel>
  );
}

function TuneDialog({ onClose }: { onClose: () => void }) {
  const st = useApi<{ settings: { scanner: Record<string, number | Record<string, number>> } }>(["settings"], "/settings");
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, number | Record<string, number>> | null>(null);
  const v = draft ?? st.data?.settings.scanner;
  if (!v) return null;
  const set = (k: string, val: number | null) => setDraft({ ...v, [k]: val ?? 0 });
  const w = v.weights as Record<string, number>;
  const save = async () => {
    try {
      await api.patch("/settings", { scanner: v });
      toast("success", "Scanner settings saved", "They apply from the next scan.");
      qc.invalidateQueries({ queryKey: ["settings"] });
      onClose();
    } catch (e) {
      toast("error", "Settings not saved", errMsg(e));
    }
  };
  const fields: [string, string, string][] = [
    ["min_price", "Minimum price ($)", ""], ["min_avg_dollar_volume", "Minimum avg. dollar volume", "20-day average"],
    ["max_spread_bps", "Maximum spread (bps)", ""], ["min_prob_edge", "Minimum probability edge", "e.g. 0.03 = 3 points above base rate"],
    ["min_net_expected_return_pct", "Minimum net expected return (%)", "After costs"], ["max_uncertainty_pct", "Maximum forecast range width (%)", "q90 − q10"],
    ["min_model_reliability", "Minimum model reliability (0–1)", ""], ["event_blackout_days", "Earnings blackout (days)", ""], ["interval_minutes", "Auto-scan every (minutes)", ""],
  ];
  return (
    <div className="drawer" role="dialog" aria-label="Scanner filters and weights">
      <div className="modal-head"><h2 className="grow">Filters and weights</h2><button className="btn ghost sm icon" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
      <div className="modal-body stack lg">
        <div className="section-title">Hard filters</div>
        <div className="form-grid">
          {fields.map(([k, label, help]) => (
            <Field key={k} label={label} help={help}><NumberInput value={v[k] as number} onChange={(x) => set(k, x)} /></Field>
          ))}
        </div>
        <div className="section-title">Ranking weights</div>
        <p className="xs faint">Weights are relative; they are normalised to sum to 1.</p>
        {Object.entries(w).map(([k, val]) => (
          <label key={k} className="row small" style={{ gap: 12 }}>
            <span style={{ width: 170 }}>{COMPONENT_LABELS[k] ?? k}</span>
            <input type="range" min={0} max={0.5} step={0.01} value={val} onChange={(e) => setDraft({ ...v, weights: { ...w, [k]: +e.target.value } })} aria-label={COMPONENT_LABELS[k]} />
            <span className="num" style={{ width: 36 }}>{val.toFixed(2)}</span>
          </label>
        ))}
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={async () => { await api.post("/settings/reset?section=scanner"); qc.invalidateQueries({ queryKey: ["settings"] }); setDraft(null); toast("info", "Scanner settings restored to defaults"); }}>Restore defaults</button>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
    </div>
  );
}
