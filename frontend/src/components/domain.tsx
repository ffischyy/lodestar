import clsx from "clsx";
import { CheckCircle2, CircleAlert, CircleMinus, CirclePlus, ExternalLink, ShieldAlert } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errMsg } from "../api/client";
import { useQuote, useTick } from "../api/live";
import type { Evidence, Forecast, NewsItem, Plan, Quote, Signal } from "../api/types";
import { ago, frac, isNum, money, num, price, prob } from "../lib/format";
import { toast } from "./toast";
import { Delta, Field, Modal, Notice, NumberInput, Seg, Spinner, StatusPill, Tooltip } from "./ui";

const METHOD_SHORT: Record<string, string> = {
  logistic: "Logistic", gbm: "Gradient boosting", forest: "Random forest", knn: "Pattern analog", factor: "4-factor", ensemble: "Ensemble",
};

export function SymbolLink({ symbol, className }: { symbol: string; className?: string }) {
  return <Link to={`/research/${symbol}`} className={clsx("sym-link", className)}>{symbol}</Link>;
}

/** Price that marks each update with a brief underline tick instead of flashing the cell. */
export function LivePrice({ symbol, fallback }: { symbol: string; fallback?: number | null }) {
  const q = useQuote(symbol);
  const tick = useTick(symbol);
  const [cls, setCls] = useState<string | null>(null);
  useEffect(() => {
    if (!tick) return;
    setCls(`tick-${tick}`);
    const t = window.setTimeout(() => setCls(null), 900);
    return () => window.clearTimeout(t);
  }, [q?.price, tick]);
  return <span className={clsx("num", cls)}>{price(q?.price ?? fallback)}</span>;
}

export function QuoteLine({ q, big }: { q: Quote | null | undefined; big?: boolean }) {
  if (!q) return <span className="faint">No quote</span>;
  return (
    <span className="row wrap" style={{ gap: 12, alignItems: "baseline" }}>
      <span className="num" style={{ fontSize: big ? "var(--fs-2xl)" : undefined, fontWeight: 500 }}><LivePrice symbol={q.symbol} fallback={q.price} /></span>
      <Delta value={q.change} kind="abs" />
      <Delta value={q.change_pct} />
      <StatusPill status={q.status} note={q.venue_note} />
      {q.status !== "replay" && <span className="faint xs">{ago(q.ts)}</span>}
    </span>
  );
}

const DIR_ICON = { bullish: CirclePlus, bearish: CircleMinus, neutral: CircleMinus, info: CircleAlert } as const;

export function SignalTable({ signals }: { signals: Signal[] }) {
  return (
    <div className="stack" style={{ gap: 12 }}>
      {signals.map((s) => {
        const Icon = DIR_ICON[s.direction as keyof typeof DIR_ICON] ?? CircleAlert;
        const tone = s.direction === "bullish" ? "up" : s.direction === "bearish" ? "down" : "muted";
        return (
          <div key={s.key} style={{ display: "grid", gridTemplateColumns: "150px 64px 1fr", gap: 12, alignItems: "start" }} className="small">
            <span className="row" style={{ gap: 8 }}>
              <Icon size={16} className={tone} aria-hidden />
              <b style={{ fontWeight: 500 }}>{s.name}</b>
            </span>
            <span className={clsx("num", tone)} title="Score from −1 (bearish) to +1 (bullish)">
              {s.direction === "info" ? s.direction.replace("info", "context") : `${s.score > 0 ? "+" : ""}${s.score.toFixed(2)}`}
            </span>
            <span className="muted">
              {s.summary}
              {s.flags.length > 0 && s.flags.map((f) => <span key={f} className="badge warn" style={{ marginLeft: 8 }}>{f.replace(/_/g, " ")}</span>)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function EvidenceList({ items, kind }: { items: Evidence[]; kind: "support" | "against" }) {
  if (!items.length) return <p className="faint small">{kind === "support" ? "No supporting evidence." : "No contradicting evidence found."}</p>;
  return (
    <ul className="evidence">
      {items.map((e, i) => (
        <li key={i}>
          {kind === "support" ? <CheckCircle2 size={16} className="up" aria-label="Supports" /> : <ShieldAlert size={16} className="down" aria-label="Contradicts" />}
          <span><b>{e.source}.</b> {e.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function ForecastBlock({ f, direction = "long" }: { f: Forecast | null | undefined; direction?: "long" | "short" }) {
  if (!f) return <Notice>No forecast — train a model on the Model evaluation screen for this data source.</Notice>;
  const pt = direction === "long" ? f.p_target_first_long : f.p_target_first_short;
  return (
    <div className="stack lg">
      {!f.validated && <Notice kind="warn">This model <strong>failed</strong> out-of-sample validation. Its numbers are shown for transparency, not as reliable estimates.</Notice>}
      <div className="stats">
        <Statx label={`Expected return, ${f.horizon_days}d`} value={<Delta value={f.exp_return} kind="frac" />} note="Model mean estimate" />
        <Statx label="80% range" value={<span className="num">{frac(f.q10, 1)} to {frac(f.q90, 1)}</span>} note={`Width ${frac(f.uncertainty, 1, false)}`} />
        <Statx label="P(positive return)" value={prob(f.p_up)} note="Calibrated probability" />
        <Statx label={`P(target before stop), ${direction}`} value={prob(pt)} note={`${f.barrier_target_atr}×ATR target, ${f.barrier_stop_atr}×ATR stop`} />
        <Statx label="Expected volatility" value={frac(f.exp_volatility, 1, false)} note="Over the horizon" />
        <Statx label="Typical excursions" value={<span className="num"><span className="up">{frac(f.exp_favorable_excursion, 1)}</span> / <span className="down">{frac(f.exp_adverse_excursion, 1)}</span></span>} note="Best / worst point, expected" />
      </div>
      {f.by_method && Object.keys(f.by_method).length > 1 && (
        <div>
          <div className="section-title">How each method sees it ({direction} target before stop)</div>
          <div className="stack" style={{ gap: 4 }}>
            {Object.entries(f.by_method).sort((a, b) => (direction === "long" ? b[1].p_target_first_long - a[1].p_target_first_long : b[1].p_target_first_short - a[1].p_target_first_short)).map(([k, v]) => {
              const p = direction === "long" ? v.p_target_first_long : v.p_target_first_short;
              return (
                <div key={k} className="row small" style={{ gap: 8 }}>
                  <span className="truncate" style={{ width: 150, flexShrink: 0 }}>{METHOD_SHORT[k] ?? k}{k === f.model && <span className="badge accent" style={{ marginLeft: 4 }}>in use</span>}</span>
                  <span style={{ flex: 1, height: 6, background: "var(--surface-3)", borderRadius: 3, position: "relative" }} aria-hidden>
                    <i style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(100, p * 100)}%`, background: k === f.model ? "var(--accent)" : "var(--chart-2)", borderRadius: 3 }} />
                  </span>
                  <span className="num" style={{ width: 40, textAlign: "right" }}>{prob(p)}</span>
                </div>
              );
            })}
          </div>
          <p className="xs faint" style={{ marginTop: 4 }}>When the methods disagree a lot, treat the forecast as less certain.</p>
        </div>
      )}
      <p className="xs faint">
        {f.model} model #{f.model_run_id}, reliability {num(f.reliability)}, computed from the close of {f.asof.slice(0, 10)}. Probabilities are statistical
        estimates validated on past data, not promises about the future.
      </p>
    </div>
  );
}

function Statx({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value num">{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

export function PlanTable({ plan }: { plan: Plan }) {
  return (
    <dl className="kv">
      <dt>Entry zone</dt><dd className="num">{price(plan.entry_low)} – {price(plan.entry_high)}</dd>
      <dt>Stop-loss</dt><dd className="num down">{price(plan.stop)} <span className="faint">({frac((plan.stop - plan.entry) / plan.entry, 1)})</span></dd>
      {plan.targets.map((t, i) => (
        <Fragment key={i}><dt>Target {i + 1}</dt><dd className="num up">{price(t)} <span className="faint">({frac((t - plan.entry) / plan.entry, 1)})</span></dd></Fragment>
      ))}
      <dt>Reward / risk to T1</dt><dd className="num">{num(plan.reward_risk)}</dd>
      <dt>ATR (14)</dt><dd className="num">{price(plan.atr)}</dd>
    </dl>
  );
}

export function NewsList({ items, compactView }: { items: NewsItem[]; compactView?: boolean }) {
  if (!items.length) return <p className="faint small">No recent headlines from the active provider.</p>;
  return (
    <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0, gap: compactView ? 8 : 12 }}>
      {items.map((n) => {
        const tone = n.sentiment > 0.05 ? "up" : n.sentiment < -0.05 ? "down" : "flat";
        return (
          <li key={n.id} style={{ display: "grid", gridTemplateColumns: "54px 1fr", gap: 12 }}>
            <span className={clsx("badge", tone === "flat" ? "" : tone)} title={`Lexicon sentiment ${n.sentiment.toFixed(2)}${n.terms.length ? ` from: ${n.terms.join(", ")}` : ""}`}
              style={{ justifyContent: "center" }}>
              {n.sentiment > 0.05 ? "+" : n.sentiment < -0.05 ? "−" : "±"}{Math.abs(n.sentiment).toFixed(2)}
            </span>
            <div className="small" style={{ minWidth: 0 }}>
              {n.url ? (
                <a href={n.url} target="_blank" rel="noreferrer noopener" style={{ color: "var(--text)" }}>
                  {n.headline} <ExternalLink size={11} className="faint" aria-label="opens in a new tab" />
                </a>
              ) : <span style={{ color: "var(--text)" }}>{n.headline}</span>}
              <div className="faint xs row wrap" style={{ gap: 8, marginTop: 2 }}>
                {n.symbols.slice(0, 4).map((s) => <SymbolLink key={s} symbol={s} />)}
                <span>{n.publisher}</span><span>{ago(n.ts)}</span>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------------------------------------------------------- order ticket */
export interface TicketDefaults { symbol: string; side?: "buy" | "sell"; stop?: number; target?: number; qty?: number; limit?: number }

interface Preview {
  qty: number; est_price: number; notional: number; ok: boolean; violations: string[]; warnings: string[];
  costs: { round_trip_cost: number; round_trip_pct: number; spread_source: string };
  sizing: { qty: number; risk_budget: number; binding_constraint: string; risk_pct_of_equity: number } | null;
  risk_at_stop: number | null; reward_at_target: number | null; simulated_data: boolean; quote: Quote;
}

export function OrderTicket({ defaults, onClose }: { defaults: TicketDefaults; onClose: () => void }) {
  const [side, setSide] = useState<"buy" | "sell">(defaults.side ?? "buy");
  const [type, setType] = useState<"market" | "limit" | "stop">(defaults.limit ? "limit" : "market");
  const [qty, setQty] = useState<number | null>(defaults.qty ?? null);
  const [limit, setLimit] = useState<number | null>(defaults.limit ?? null);
  const [stopPx, setStopPx] = useState<number | null>(null);
  const [sl, setSl] = useState<number | null>(defaults.stop ?? null);
  const [tp, setTp] = useState<number | null>(defaults.target ?? null);
  const [pv, setPv] = useState<Preview | null>(null);
  const [pvErr, setPvErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const coid = useMemo(() => `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      api.post<Preview>("/paper/preview", { symbol: defaults.symbol, side, qty, type, limit_price: limit, stop_loss: sl, take_profit: tp })
        .then((p) => { setPv(p); setPvErr(null); if (qty == null && p.qty) setQty(p.qty); })
        .catch((e) => setPvErr(errMsg(e)));
    }, 200);
    return () => window.clearTimeout(t);
  }, [defaults.symbol, side, qty, type, limit, sl, tp]);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ status: string; filled_price: number | null; warnings?: string[] }>("/paper/orders", {
        symbol: defaults.symbol, side, qty, type, limit_price: type === "limit" ? limit : null, stop_price: type === "stop" ? stopPx : null,
        stop_loss: sl, take_profit: tp, client_order_id: coid,
      });
      toast("success", r.status === "filled" ? `Paper order filled: ${side} ${qty} ${defaults.symbol}` : `Paper order placed: ${side} ${qty} ${defaults.symbol}`,
        r.filled_price ? `Filled at ${price(r.filled_price)}${sl || tp ? "; bracket exits are working." : "."}` : "Waiting for the price to reach your level.");
      qc.invalidateQueries({ queryKey: ["paper"] });
      onClose();
    } catch (e) {
      toast("error", "Order rejected", e instanceof ApiError && e.violations.length ? e.violations.join(" ") : errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={<span className="row">Paper order <span className="sym">{defaults.symbol}</span></span>} onClose={onClose}
      foot={<>
        <span className="xs faint grow">Simulated fills only. No real orders are sent.</span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={clsx("btn", side === "buy" ? "buy" : "sell")} onClick={submit} disabled={busy || !qty || !pv?.ok}>
          {busy ? <Spinner /> : null}{side === "buy" ? "Buy" : "Sell"} {qty ?? ""} {defaults.symbol}
        </button>
      </>}>
      <div className="stack lg">
        <div className="row wrap between">
          <Seg label="Side" value={side} onChange={setSide} options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell / short" }]} />
          <Seg label="Order type" value={type} onChange={setType} options={[{ value: "market", label: "Market" }, { value: "limit", label: "Limit" }, { value: "stop", label: "Stop" }]} />
        </div>
        {pv && <div className="row small"><span className="muted">Quote</span><QuoteLine q={pv.quote} /></div>}
        <div className="form-grid">
          <Field label="Quantity (shares)" help={pv?.sizing ? `Risk sizing suggests ${pv.sizing.qty} (limited by ${pv.sizing.binding_constraint})` : "Set a stop-loss to get a risk-based size"}>
            <NumberInput value={qty} onChange={(v) => setQty(v && v > 0 ? Math.floor(v) : null)} min={1} />
          </Field>
          {type === "limit" && <Field label="Limit price"><NumberInput value={limit} onChange={setLimit} step={0.01} /></Field>}
          {type === "stop" && <Field label="Stop trigger"><NumberInput value={stopPx} onChange={setStopPx} step={0.01} /></Field>}
          <Field label="Stop-loss (bracket)" help="Exit order created after entry fills"><NumberInput value={sl} onChange={setSl} step={0.01} /></Field>
          <Field label="Take-profit (bracket)"><NumberInput value={tp} onChange={setTp} step={0.01} /></Field>
        </div>
        {pv?.sizing && qty !== pv.sizing.qty && (
          <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setQty(pv.sizing!.qty)}>Use risk-based size ({pv.sizing.qty})</button>
        )}
        {pvErr && <Notice kind="error">{pvErr}</Notice>}
        {pv && (
          <dl className="kv small">
            <dt>Estimated fill</dt><dd className="num">{price(pv.est_price)}</dd>
            <dt>Notional</dt><dd className="num">{money(pv.notional)}</dd>
            <dt>Round-trip costs</dt><dd className="num">{money(pv.costs.round_trip_cost)} <span className="faint">({frac(pv.costs.round_trip_pct, 2, false)}, spread from {pv.costs.spread_source})</span></dd>
            {isNum(pv.risk_at_stop) && <><dt>Loss if stop fills</dt><dd className="num down">{money(-pv.risk_at_stop)}</dd></>}
            {isNum(pv.reward_at_target) && <><dt>Gain at target</dt><dd className="num up">{money(pv.reward_at_target, true)}</dd></>}
          </dl>
        )}
        {pv?.violations.map((v) => <Notice key={v} kind="error">{v}</Notice>)}
        {pv?.warnings.map((w) => <Notice key={w} kind="warn">{w}</Notice>)}
        {pv?.simulated_data && <Notice kind="sim">Prices are <strong>simulated</strong>. Fills reflect the simulator, not a real market.</Notice>}
      </div>
    </Modal>
  );
}

export function Hint({ children, tip }: { children: ReactNode; tip: string }) {
  return <Tooltip text={tip}><span style={{ borderBottom: "1px dotted var(--text-3)", cursor: "help" }}>{children}</span></Tooltip>;
}
