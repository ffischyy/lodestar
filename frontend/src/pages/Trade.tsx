import clsx from "clsx";
import { ArrowDownToLine, ArrowUpFromLine, Bot, Download, Power, RotateCcw, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errMsg } from "../api/client";
import { useAccount, useApi, useStatus } from "../api/hooks";
import { useQuote } from "../api/live";
import type { Account, Fill, Order, Position, Quote, Research } from "../api/types";
import { LineChart } from "../components/charts/svg";
import { DataTable } from "../components/DataTable";
import { LivePrice, QuoteLine, SymbolLink } from "../components/domain";
import { SandboxSwitch } from "../components/SandboxSwitch";
import { SourceBadge, TradeFeed } from "../components/TradeFeed";
import { toast } from "../components/toast";
import { Confirm, Delta, Empty, ErrorState, Field, Modal, Notice, NumberInput, PageHead, Panel, Seg, Skeleton, Spinner, Stat, StatusPill, Tabs,
  Tooltip } from "../components/ui";
import { download, toCsv } from "../lib/csv";
import { dateTime, isNum, money, pct, price } from "../lib/format";

export default function TradePage() {
  const acct = useAccount();
  const status = useStatus();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<"open" | "orders" | "fills">("open");
  const [confirm, setConfirm] = useState<null | { kind: "close"; symbol: string } | { kind: "flatten" }>(null);
  const [reset, setReset] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["paper"] }); qc.invalidateQueries({ queryKey: ["status"] }); };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast("success", ok); refresh(); } catch (e) { toast("error", "Action failed", errMsg(e)); }
  };

  if (acct.isLoading) return <div className="page"><Skeleton rows={12} /></div>;
  if (acct.error) return <div className="page"><ErrorState error={acct.error} retry={() => acct.refetch()} /></div>;
  const a = acct.data!;
  const open = a.orders.filter((o) => o.status === "open");

  return (
    <div className="page">
      <PageHead title="Trade desk"
        sub="Paper account. No real money is involved"
        actions={<>
          <SandboxSwitch on={a.sandbox} big />
          <Link to="/autopilot" className={clsx("btn", status.data?.autopilot_enabled && "active")}><Bot size={16} /> AI autopilot: {status.data?.autopilot_enabled ? "on" : "off"}</Link>
        </>} />
      <div className="stack lg">
        {status.data?.replay?.active && (
          <Notice kind="sim"><strong>Practice account.</strong> Fake trades on real past market data ({status.data.replay.sim_time_et} ET, {status.data.replay.speed}x speed).
            Your normal paper account is untouched. <Link to="/practice">Practice controls</Link></Notice>
        )}
        {!a.trading_enabled && (
          <Notice kind="error"><strong>Trading is switched off.</strong> No new orders are placed or filled, by you or the AI. Stop-loss and take-profit exits still protect open positions.{" "}
            <button className="btn sm" onClick={() => act(() => api.post("/paper/trading", { enabled: true }), "Trading switched on")}><Power size={16} /> Switch trading on</button></Notice>
        )}
        {a.halted_reason && (
          <Notice kind="warn"><strong>New entries halted.</strong> {a.halted_reason}{" "}
            <button className="btn sm" onClick={() => act(() => api.post("/paper/clear-halt"), "Halt cleared")}>Clear halt</button></Notice>
        )}
        <MoneyPanel a={a} />
        <div className="grid g-12">
          <div className="span-5"><TicketPanel a={a} initialSymbol={params.get("s") ?? ""} /></div>
          <div className="span-7">
            <Panel title="Live trade activity" hint="Who traded, what, at what price and why">
              <div className="feed-scroll"><TradeFeed limit={30} /></div>
            </Panel>
          </div>
        </div>
        <div className="grid g-12">
          <div className="span-6"><FundsPanel a={a} /></div>
          <div className="span-6"><EquityPanel /></div>
        </div>
        <Panel flush
          title={<Tabs value={tab} onChange={setTab} tabs={[{ value: "open", label: `Positions (${a.positions.length})` }, { value: "orders", label: `Orders (${open.length} working)` }, { value: "fills", label: `Trade history (${a.fills.length})` }]} />}
          actions={<>
            <button className="btn sm" disabled={!a.positions.length} onClick={() => setConfirm({ kind: "flatten" })}>Sell everything</button>
            <button className="btn ghost sm" disabled={!a.fills.length} onClick={() => download("lodestar-fills.csv", toCsv(a.fills as unknown as Record<string, unknown>[]))}><Download size={16} /> Export fills</button>
            <button className="btn ghost sm" onClick={() => setReset(true)}><RotateCcw size={16} /> Reset account</button>
          </>}>
          {tab === "open" && <PositionsTable rows={a.positions} equity={a.equity} onClose={(s) => setConfirm({ kind: "close", symbol: s })} />}
          {tab === "orders" && <OrdersTable rows={a.orders} onCancel={(id) => act(() => api.del(`/paper/orders/${id}`), "Order cancelled")} />}
          {tab === "fills" && <FillsTable rows={a.fills} />}
        </Panel>
        <p className="xs faint">Stop orders trigger on the quote and fill at the quote price, so a gap through your stop fills worse than the stop, as in real markets. Borrow fees on shorts are not modelled.</p>
      </div>
      {confirm?.kind === "close" && <Confirm title={`Sell all of ${confirm.symbol}?`} confirmLabel="Close position" body="Sends a market order for the whole position and cancels its stop-loss and take-profit orders."
        onCancel={() => setConfirm(null)} onConfirm={() => { const s = confirm.symbol; setConfirm(null); act(() => api.post(`/paper/positions/${s}/close`), `Closed ${s}`); }} />}
      {confirm?.kind === "flatten" && <Confirm title="Close every position?" danger confirmLabel="Close all" body="Sends market orders to close every open position. Cash is returned to your balance."
        onCancel={() => setConfirm(null)} onConfirm={async () => { setConfirm(null); for (const p of a.positions) await act(() => api.post(`/paper/positions/${p.symbol}/close`), `Closed ${p.symbol}`); }} />}
      {reset && <ResetDialog onClose={() => setReset(false)} onDone={refresh} current={a.money.net_deposits} />}
    </div>
  );
}

/* ------------------------------------------------------------------ money */
export function MoneyPanel({ a }: { a: Account }) {
  const m = a.money;
  const tot = Math.max(1e-9, m.cash + m.long_market_value);
  const free = Math.max(0, m.available_to_trade);
  return (
    <section className="panel" aria-label="Account summary">
      <div className="money-hero">
        <div className="money-main">
          <span className="muted small">Account value</span>
          <span className="big num">{money(a.equity)}</span>
          <span className="row small" style={{ gap: 8 }}>
            <span className={m.profit >= 0 ? "num up" : "num down"}>{money(m.profit, true)} ({pct(m.return_pct)})</span><span className="faint">all time</span>
          </span>
          <span className="row small" style={{ gap: 8 }}>
            <span className={a.day_pnl >= 0 ? "num up" : "num down"}>{money(a.day_pnl, true)} ({pct(a.day_pnl_pct)})</span><span className="faint">today</span>
          </span>
          <div style={{ marginTop: 8 }}>
            <div className="alloc" aria-hidden>
              <i style={{ width: `${(free / tot) * 100}%`, background: "var(--chart-2)" }} />
              <i style={{ width: `${(m.reserved_for_orders / tot) * 100}%`, background: "var(--warn)" }} />
              <i style={{ width: `${(m.long_market_value / tot) * 100}%`, background: "var(--accent)" }} />
            </div>
            <div className="row wrap xs muted" style={{ marginTop: 8, gap: 12 }}>
              <span><i className="legend-dot" style={{ background: "var(--chart-2)" }} />Cash {pct((free / tot) * 100, 0, false)}</span>
              {m.reserved_for_orders > 0 && <span><i className="legend-dot" style={{ background: "var(--warn)" }} />Reserved {pct((m.reserved_for_orders / tot) * 100, 0, false)}</span>}
              <span><i className="legend-dot" style={{ background: "var(--accent)" }} />Invested {pct((m.long_market_value / tot) * 100, 0, false)}</span>
            </div>
          </div>
        </div>
        <div className="money-grid">
          <Stat label="Available to trade" value={money(m.available_to_trade)} note={m.reserved_for_orders > 0 ? `${money(m.reserved_for_orders)} held for orders` : `Cash ${money(m.cash)}`} />
          <Stat label="Holdings worth now" value={money(m.long_market_value)} note={`${money(m.invested_cost)} paid, ${m.open_positions} open`} />
          <Stat label="Unrealized profit" value={<span className={a.unrealized_pnl >= 0 ? "up" : "down"}>{money(a.unrealized_pnl, true)}</span>} note="On open positions" />
          <Stat label="Realized profit" value={<span className={a.realized_pnl >= 0 ? "up" : "down"}>{money(a.realized_pnl, true)}</span>} note="Locked in, after fees" />
          <Stat label="Money put in" value={money(m.net_deposits)} note={`Start ${money(m.starting_cash)}${m.deposits ? ` + ${money(m.deposits)} deposited` : ""}${m.withdrawals ? ` − ${money(m.withdrawals)} withdrawn` : ""}`} />
          <Stat label="Total bought / sold" value={<span className="num">{money(m.total_bought).replace(".00", "")} / {money(m.total_sold).replace(".00", "")}</span>} note={`${m.trades} fills, ${money(m.fees_paid)} fees`} />
          <Stat label="Win rate" value={isNum(m.win_rate_pct) ? pct(m.win_rate_pct, 0, false) : "—"} note={`${m.closed_trades} closed trade${m.closed_trades === 1 ? "" : "s"}`} />
          <Stat label="Drawdown from peak" value={<span className={a.drawdown_pct < 0 ? "down" : ""}>{pct(a.drawdown_pct, 2, false)}</span>} note={`Peak ${money(a.peak_equity)}`} />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ ticket */
interface Preview {
  qty: number; est_price: number; notional: number; ok: boolean; violations: string[]; warnings: string[]; quote: Quote;
  costs: { round_trip_cost: number; round_trip_pct: number }; sizing: { qty: number; binding_constraint: string } | null;
  risk_at_stop: number | null; reward_at_target: number | null; simulated_data: boolean;
}
const SYM_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

function TicketPanel({ a, initialSymbol }: { a: Account; initialSymbol: string }) {
  const [symInput, setSymInput] = useState(initialSymbol.toUpperCase());
  const [symbol, setSymbol] = useState(initialSymbol.toUpperCase());
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [unit, setUnit] = useState<"shares" | "dollars">("shares");
  const [amount, setAmount] = useState<number | null>(null);
  const [type, setType] = useState<"market" | "limit" | "stop">("market");
  const [limit, setLimit] = useState<number | null>(null);
  const [sl, setSl] = useState<number | null>(null);
  const [tp, setTp] = useState<number | null>(null);
  const [pv, setPv] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const qc = useQueryClient();
  const live = useQuote(symbol || null);
  const coid = useRef(`ui-${Date.now()}`);
  const syms = useApi<{ symbol: string; name: string }[]>(["search-all"], "/market/search?q=&limit=1000");
  const held = a.positions.find((p) => p.symbol === symbol);

  useEffect(() => { const t = window.setTimeout(() => { if (SYM_RE.test(symInput)) setSymbol(symInput); }, 350); return () => window.clearTimeout(t); }, [symInput]);
  const px = (type === "limit" && limit) || live?.price || pv?.est_price || null;
  const qty = useMemo(() => {
    if (!amount || amount <= 0) return null;
    if (unit === "shares") return Math.floor(amount);
    return px ? Math.floor(amount / px) : null;
  }, [amount, unit, px]);

  useEffect(() => {
    if (!symbol || !qty) { setPv(null); setErr(null); return; }
    const t = window.setTimeout(() => {
      api.post<Preview>("/paper/preview", { symbol, side, qty, type, limit_price: type === "limit" ? limit : null, stop_loss: sl, take_profit: tp })
        .then((p) => { setPv(p); setErr(null); }).catch((e) => { setPv(null); setErr(errMsg(e)); });
    }, 250);
    return () => window.clearTimeout(t);
  }, [symbol, side, qty, type, limit, sl, tp]);

  const suggest = async () => {
    if (!symbol) return;
    setSuggesting(true);
    try {
      const r = await api.get<Research>(`/research/${symbol}`);
      const plan = r.plans[side === "buy" ? "long" : "short"].plan;
      setSl(+plan.stop.toFixed(2));
      setTp(+plan.targets[0].toFixed(2));
      toast("info", "Stop and target filled in", `Stop ${price(plan.stop)}, target ${price(plan.targets[0])} (${r.forecast ? `P(target first) ${Math.round((side === "buy" ? r.forecast.p_target_first_long : r.forecast.p_target_first_short) * 100)}%` : "no model yet"}).`);
    } catch (e) { toast("error", "Could not get a plan", errMsg(e)); } finally { setSuggesting(false); }
  };

  const submit = async () => {
    if (!qty) return;
    setBusy(true);
    try {
      const r = await api.post<{ status: string; filled_price: number | null }>("/paper/orders", {
        symbol, side, qty, type, limit_price: type === "limit" ? limit : null, stop_price: type === "stop" ? limit : null,
        stop_loss: sl, take_profit: tp, client_order_id: `${coid.current}-${Math.random().toString(36).slice(2, 8)}`,
      });
      toast("success", r.status === "filled" ? `${side === "buy" ? "Bought" : "Sold"} ${qty} ${symbol}` : `Order placed: ${side} ${qty} ${symbol}`,
        r.filled_price ? `Filled at ${price(r.filled_price)}.${sl || tp ? " Stop-loss / take-profit orders are now working." : ""}` : "It fills when the price reaches your level.");
      qc.invalidateQueries({ queryKey: ["paper"] });
      setAmount(null);
    } catch (e) {
      toast("error", "Order not placed", e instanceof ApiError && e.violations.length ? e.violations.join(" ") : errMsg(e));
    } finally { setBusy(false); }
  };

  const cashAfter = pv ? (side === "buy" ? a.money.available_to_trade - pv.notional : a.money.available_to_trade + pv.notional) : null;
  return (
    <Panel title="Place an order" hint="Paper trade">
      <div className="stack lg">
        <Field label="Stock">
          <input className="input sym" list="trade-syms" placeholder="Ticker, e.g. AAPL" value={symInput} onChange={(e) => setSymInput(e.target.value.toUpperCase().trim())} aria-label="Ticker" />
          <datalist id="trade-syms">{(syms.data ?? []).map((s) => <option key={s.symbol} value={s.symbol}>{s.name}</option>)}</datalist>
        </Field>
        {symbol && <div className="row wrap small" style={{ gap: 8 }}>{live ? <QuoteLine q={live} /> : <span className="faint">Waiting for a quote…</span>}</div>}
        {held && <p className="xs muted">You hold {Math.abs(held.qty)} shares ({held.side}) at {price(held.avg_price)}. <button className="btn ghost sm" onClick={() => { setSide(held.qty > 0 ? "sell" : "buy"); setUnit("shares"); setAmount(Math.abs(held.qty)); }}>Fill in to close</button></p>}
        <div className="side-toggle" role="group" aria-label="Buy or sell">
          <button className="buy" aria-pressed={side === "buy"} onClick={() => setSide("buy")}>Buy</button>
          <button className="sell" aria-pressed={side === "sell"} onClick={() => setSide("sell")}>Sell</button>
        </div>
        <div className="row between wrap">
          <Seg label="Amount in" value={unit} onChange={(v) => { setUnit(v); setAmount(null); }} options={[{ value: "shares", label: "Shares" }, { value: "dollars", label: "Dollars" }]} />
          <Seg label="Order type" value={type} onChange={setType} options={[{ value: "market", label: "Market" }, { value: "limit", label: "Limit" }, { value: "stop", label: "Stop" }]} />
        </div>
        <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
          <Field label={unit === "shares" ? "Number of shares" : "Dollar amount"} help={unit === "dollars" && qty ? `≈ ${qty} shares` : unit === "shares" && qty && px ? `≈ ${money(qty * px)}` : undefined}>
            <NumberInput value={amount} onChange={setAmount} min={0} />
          </Field>
          {type !== "market" && <Field label={type === "limit" ? "Limit price" : "Stop trigger"}><NumberInput value={limit} onChange={setLimit} step={0.01} /></Field>}
        </div>
        {side === "buy" && unit === "dollars" && (
          <div className="quick-amounts">
            {[0.1, 0.25, 0.5].map((f) => <button key={f} className="btn sm" onClick={() => setAmount(Math.floor(a.money.available_to_trade * f))}>{f * 100}% of cash</button>)}
            <button className="btn sm" onClick={() => setAmount(Math.floor(a.money.available_to_trade))}>All cash</button>
          </div>
        )}
        <div>
          <div className="row between"><span className="section-title" style={{ margin: 0 }}>Protection</span>
            <button className="btn ghost sm" onClick={suggest} disabled={!symbol || suggesting}>{suggesting ? <Spinner /> : <Wand2 size={16} />} Suggest stop and target</button></div>
          <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 8 }}>
            <Field label="Stop-loss" help="Sells automatically if price falls here"><NumberInput value={sl} onChange={setSl} step={0.01} /></Field>
            <Field label="Take-profit" help="Sells automatically at this gain"><NumberInput value={tp} onChange={setTp} step={0.01} /></Field>
          </div>
          {sl && px ? <RiskSizer equity={a.equity} entry={+px} stop={sl} target={tp} side={side} onUse={(n) => { setUnit("shares"); setAmount(n); }} /> : null}
        </div>
        {pv && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="ticket-total"><span className="muted">{side === "buy" ? "Estimated cost" : "Estimated proceeds"}</span><b className="num" style={{ fontSize: "var(--fs-lg)" }}>{money(pv.notional)}</b></div>
            <dl className="kv small">
              <dt>Estimated fill</dt><dd className="num">{price(pv.est_price)} × {pv.qty}</dd>
              <dt>Cash after this trade</dt><dd className={clsx("num", (cashAfter ?? 0) < 0 && "down")}>{money(cashAfter)}</dd>
              <dt>Trading costs (round trip)</dt><dd className="num">{money(pv.costs.round_trip_cost)}</dd>
              {isNum(pv.risk_at_stop) && <><dt>Loss if the stop fills</dt><dd className="num down">{money(-pv.risk_at_stop)}</dd></>}
              {isNum(pv.reward_at_target) && <><dt>Gain at the target</dt><dd className="num up">{money(pv.reward_at_target, true)}</dd></>}
            </dl>
          </div>
        )}
        {err && <Notice kind="error">{err}</Notice>}
        {pv?.violations.map((v) => <Notice key={v} kind="error">{v}{/buying power/i.test(v) && a.sandbox ? <> <a href="#funds" className="sym-link">Deposit more play money</a>.</> : null}</Notice>)}
        {pv?.warnings.filter((w) => !w.startsWith("Stop levels")).map((w) => <Notice key={w} kind="warn">{w}</Notice>)}
        <button className={clsx("btn", side === "buy" ? "buy" : "sell")} style={{ height: 42, fontSize: "var(--fs-lg)" }} onClick={submit}
          disabled={busy || !qty || !symbol || (pv ? !pv.ok : true)}>
          {busy && <Spinner />}{side === "buy" ? "Buy" : "Sell"} {qty ?? ""} {symbol || "…"}{pv ? ` for ${money(pv.notional)}` : ""}
        </button>
        {!symbol && <p className="xs faint">Pick a stock, choose buy or sell, and enter how many shares or dollars. You'll see the total, the cash left and any problems before you confirm.</p>}
      </div>
    </Panel>
  );
}

/** Works out share count from risk: how much of the account you accept losing if the stop fills. */
function RiskSizer({ equity, entry, stop, target, side, onUse }: { equity: number; entry: number; stop: number; target: number | null; side: "buy" | "sell"; onUse: (qty: number) => void }) {
  const [riskPct, setRiskPct] = useState(1);
  const perShare = Math.abs(entry - stop);
  const wrongSide = side === "buy" ? stop >= entry : stop <= entry;
  if (wrongSide || !perShare) return null;
  const budget = (equity * riskPct) / 100;
  const qty = Math.floor(budget / perShare);
  const rr = target ? Math.abs(target - entry) / perShare : null;
  return (
    <div className="sizer" style={{ marginTop: 8 }}>
      <div className="row between small">
        <span className="muted">Risk per trade</span>
        <span className="row" role="group" aria-label="Risk per trade">
          {[0.5, 1, 2].map((v) => <button key={v} type="button" className={clsx("btn sm", riskPct === v && "active")} aria-pressed={riskPct === v} onClick={() => setRiskPct(v)}>{v}%</button>)}
        </span>
      </div>
      <div className="row between small">
        <span className="num">{money(budget)} at risk{isNum(rr) ? `, ${rr.toFixed(1)}R to target` : ""}</span>
        <button type="button" className="btn sm" disabled={!qty} onClick={() => onUse(qty)}>Use {qty} shares</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ funds */
function FundsPanel({ a }: { a: Account }) {
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const tx = useApi<{ id: number; ts: string; kind: string; amount: number; note: string }[]>(["transfers"], "/paper/transfers");
  const locked = mode === "deposit" && !a.sandbox;
  const tooMuch = mode === "withdraw" && (amount ?? 0) > a.money.available_to_trade;
  const go = async () => {
    if (!amount) return;
    setBusy(true);
    try {
      await api.post(`/paper/${mode}`, { amount });
      toast("success", mode === "deposit" ? `Deposited ${money(amount)}` : `Withdrew ${money(amount)}`,
        mode === "deposit" ? "Play money added to your cash balance." : "Removed from your cash balance.");
      setAmount(null);
      qc.invalidateQueries({ queryKey: ["paper"] });
      qc.invalidateQueries({ queryKey: ["transfers"] });
    } catch (e) { toast("error", mode === "deposit" ? "Deposit refused" : "Withdrawal refused", errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Panel id="funds" title="Add or remove money" hint={a.sandbox ? "Sandbox: play money" : "Funded mode"}
      actions={<Seg label="Transfer type" value={mode} onChange={(v) => { setMode(v); setAmount(null); }}
        options={[{ value: "deposit", label: <span className="row" style={{ gap: 4 }}><ArrowDownToLine size={16} /> Deposit</span> },
          { value: "withdraw", label: <span className="row" style={{ gap: 4 }}><ArrowUpFromLine size={16} /> Withdraw</span> }]} />}>
      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <div className="stack lg">
          {locked ? (
            <Notice kind="warn"><strong>Deposits need Sandbox mode.</strong> With Sandbox off you can only trade the cash already in the account ({money(a.money.available_to_trade)} available). Turn Sandbox on to add play money.</Notice>
          ) : (
            <>
              <Field label={mode === "deposit" ? "Amount to deposit" : "Amount to withdraw"}
                help={mode === "deposit" ? "Any amount, up to $1,000,000,000 at a time" : `Up to ${money(a.money.available_to_trade)} (money not invested or reserved)`}
                error={tooMuch ? `More than your available ${money(a.money.available_to_trade)}.` : null}>
                <NumberInput value={amount} onChange={setAmount} min={0} invalid={tooMuch} />
              </Field>
              <div className="quick-amounts">
                {mode === "deposit"
                  ? [1_000, 10_000, 100_000, 1_000_000].map((v) => <button key={v} className="btn sm" onClick={() => setAmount(v)}>+{money(v).replace(".00", "")}</button>)
                  : [0.25, 0.5, 1].map((f) => <button key={f} className="btn sm" onClick={() => setAmount(Math.floor(a.money.available_to_trade * f * 100) / 100)}>{f === 1 ? "All available" : `${f * 100}%`}</button>)}
              </div>
              <button className="btn primary" onClick={go} disabled={busy || !amount || tooMuch}>
                {busy && <Spinner />}{mode === "deposit" ? `Deposit ${amount ? money(amount) : ""}` : `Withdraw ${amount ? money(amount) : ""}`}
              </button>
            </>
          )}
          <p className="xs faint">Deposits and withdrawals are not counted as profit or loss: returns are measured against the money you put in.</p>
        </div>
        <div>
          <div className="section-title">Recent transfers</div>
          {tx.data && tx.data.length ? (
            <ul className="stack small" style={{ listStyle: "none", padding: 0, margin: 0, gap: 8 }}>
              {tx.data.slice(0, 6).map((t) => (
                <li key={t.id} className="row between">
                  <span className={t.kind === "deposit" ? "up" : "down"}>{t.kind === "deposit" ? "+" : "−"}{money(t.amount)}</span>
                  <span className="faint xs">{dateTime(t.ts)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="small faint">None yet. You started with {money(a.money.starting_cash)}.</p>}
        </div>
      </div>
    </Panel>
  );
}

function EquityPanel() {
  const q = useApi<{ equity_history: { ts: string; equity: number }[] }>(["portfolio"], "/portfolio/analytics", { refetchInterval: 30_000 });
  const h = q.data?.equity_history ?? [];
  return (
    <Panel title="Account value over time" hint="Sampled each minute while Lodestar runs">
      {new Set(h.map((x) => x.equity)).size > 1 ? (
        <LineChart labels={h.map((x) => x.ts.slice(5, 16).replace("T", " "))} height={170} format={(v) => money(v).replace(".00", "")}
          series={[{ name: "Account value", values: h.map((x) => x.equity), color: "var(--chart-1)", area: true }]} />
      ) : <p className="small faint">The chart starts with your first trade</p>}
    </Panel>
  );
}

/* ------------------------------------------------------------------ tables */
export function PositionsTable({ rows, equity, onClose }: { rows: Position[]; equity: number; onClose: (s: string) => void }) {
  return (
    <DataTable<Position> label="Open positions" rows={rows} rowKey={(p) => p.symbol}
      empty={<Empty title="You don't own anything yet">Place an order above, trade from the scanner, or let the AI autopilot trade for you.</Empty>}
      columns={[
        { key: "s", header: "Stock", sticky: true, sort: (p) => p.symbol, cell: (p) => <SymbolLink symbol={p.symbol} /> },
        { key: "side", header: "Side", cell: (p) => <span className={`badge ${p.side === "long" ? "up" : "down"}`}>{p.side === "long" ? "Own" : "Short"}</span> },
        { key: "q", header: "Shares", num: true, cell: (p) => Math.abs(p.qty) },
        { key: "avg", header: "Paid per share", num: true, cell: (p) => price(p.avg_price) },
        { key: "m", header: "Price now", num: true, cell: (p) => <LivePrice symbol={p.symbol} fallback={p.mark} /> },
        { key: "cost", header: "Cost", num: true, sort: (p) => Math.abs(p.qty * p.avg_price), cell: (p) => money(Math.abs(p.qty * p.avg_price)) },
        { key: "mv", header: "Worth now", num: true, sort: (p) => Math.abs(p.market_value), cell: (p) => money(Math.abs(p.market_value)) },
        { key: "u", header: "Profit", num: true, sort: (p) => p.unrealized, cell: (p) => <span className={p.unrealized >= 0 ? "up" : "down"}>{money(p.unrealized, true)}</span> },
        { key: "up", header: "%", num: true, sort: (p) => p.unrealized_pct, cell: (p) => <Delta value={p.unrealized_pct} /> },
        { key: "w", header: "Of account", num: true, cell: (p) => pct((Math.abs(p.market_value) / Math.max(1, equity)) * 100, 1, false) },
        { key: "st", header: "Data", cell: (p) => <StatusPill status={p.data_status} /> },
        { key: "x", header: "", cell: (p) => <button className="btn sm" onClick={() => onClose(p.symbol)}>{p.side === "long" ? "Sell all" : "Cover"}</button> },
      ]} />
  );
}

function OrdersTable({ rows, onCancel }: { rows: Order[]; onCancel: (id: number) => void }) {
  return (
    <DataTable<Order> label="Orders" rows={rows} rowKey={(o) => o.id} maxHeight={480} initialSort={{ key: "t", desc: true }}
      empty={<Empty title="No orders yet" />}
      columns={[
        { key: "t", header: "Time", sort: (o) => o.created_at, cell: (o) => <span className="num muted">{dateTime(o.created_at)}</span> },
        { key: "s", header: "Stock", cell: (o) => <SymbolLink symbol={o.symbol} /> },
        { key: "side", header: "Side", cell: (o) => <span className={o.side === "buy" ? "up" : "down"}>{o.side}</span> },
        { key: "q", header: "Shares", num: true, cell: (o) => o.qty },
        { key: "ty", header: "Type", cell: (o) => <span>{o.parent_id ? (o.type === "stop" ? "stop-loss" : "take-profit") : o.type}</span> },
        { key: "px", header: "Price", num: true, cell: (o) => price(o.limit_price ?? o.stop_price) },
        { key: "by", header: "Placed by", cell: (o) => (o.client_order_id.startsWith("auto-") || o.note.startsWith("autopilot") ? <span className="badge up"><Bot size={11} /> AI</span> : o.parent_id ? <span className="faint">bracket</span> : <span className="faint">you</span>) },
        { key: "st", header: "Status", cell: (o) => <span className={`badge ${o.status === "filled" ? "up" : o.status === "rejected" ? "error" : o.status === "open" ? "accent" : ""}`}>{o.status === "open" ? "working" : o.status}</span> },
        { key: "f", header: "Filled at", num: true, cell: (o) => price(o.filled_price) },
        { key: "n", header: "Note", cell: (o) => <Tooltip text={o.note || "—"}><span className="muted small truncate" style={{ maxWidth: 220, display: "inline-block" }}>{o.note}</span></Tooltip> },
        { key: "x", header: "", cell: (o) => o.status === "open" ? <button className="btn ghost sm icon" aria-label={`Cancel order ${o.id}`} onClick={() => onCancel(o.id)}><X size={16} /></button> : null },
      ]} />
  );
}

function FillsTable({ rows }: { rows: Fill[] }) {
  return (
    <DataTable<Fill> label="Trade history" rows={rows} rowKey={(f) => f.id} maxHeight={480} empty={<Empty title="No trades yet" />}
      columns={[
        { key: "t", header: "Time", cell: (f) => <span className="num muted">{dateTime(f.ts)}</span> },
        { key: "by", header: "By", cell: (f) => <SourceBadge source={f.source} /> },
        { key: "s", header: "Stock", cell: (f) => <SymbolLink symbol={f.symbol} /> },
        { key: "side", header: "Side", cell: (f) => <span className={f.side === "buy" ? "up" : "down"}>{f.side === "buy" ? "Bought" : "Sold"}</span> },
        { key: "q", header: "Shares", num: true, cell: (f) => f.qty },
        { key: "p", header: "Price", num: true, cell: (f) => price(f.price) },
        { key: "v", header: "Total", num: true, cell: (f) => money(f.qty * f.price) },
        { key: "c", header: "Fees", num: true, cell: (f) => money(f.commission) },
        { key: "r", header: "Profit locked in", num: true, cell: (f) => (Math.abs(f.realized_pnl + f.commission) > 1e-9 ? <span className={f.realized_pnl >= 0 ? "up" : "down"}>{money(f.realized_pnl, true)}</span> : <span className="faint">—</span>) },
        { key: "why", header: "Why", cell: (f) => <Tooltip text={f.reason || "—"}><span className="muted small truncate" style={{ maxWidth: 260, display: "inline-block" }}>{f.reason || "—"}</span></Tooltip> },
      ]} />
  );
}

function ResetDialog({ onClose, onDone, current }: { onClose: () => void; onDone: () => void; current: number }) {
  const [cash, setCash] = useState<number | null>(Math.round(current));
  return (
    <Modal title="Start the paper account over?" onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger" onClick={async () => {
          try { await api.post("/paper/reset", { starting_cash: cash, confirm: true }); toast("success", "Paper account reset"); onDone(); onClose(); }
          catch (e) { toast("error", "Reset failed", errMsg(e)); }
        }}>Delete history and start over</button></>}>
      <div className="stack lg">
        <p className="small muted">Every order, trade, position, deposit and autopilot log entry is deleted. This cannot be undone.</p>
        <label className="field"><span>Starting cash ($)</span><NumberInput value={cash} onChange={setCash} /></label>
      </div>
    </Modal>
  );
}

