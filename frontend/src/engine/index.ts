/**
 * The in-browser engine: answers the same /api routes as the Python engine so the site can run on any static host.
 * It covers everything: market data, research, paper trading, model training, the scanner, the autopilot, backtests and practice replay.
 * Long model jobs run in a Web Worker (lab.ts). Paper state lives in localStorage and model results in IndexedDB, both in this browser.
 */
import { ApiError } from "../api/client";
import { publish } from "../api/live";
import type { Candle, Forecast, Quote } from "../api/types";
import defaults from "./defaults.json";
import { calibrationBins, clean, forecastAll, METHODS, runJob, STRATEGIES, TURBO_DEFAULTS, type Artifact, type Bars, type BtConfig, type Job, type TurboConfig } from "./lab";
import { atr, hash, indicators, INDEXES, meta, normal, rng, rsi, SECTOR_ETFS, simBars, simNews, simProfile, simQuote, sma, UNIVERSE } from "./market";

const KEY = "lodestar.browser-engine.v1";
const ACCOUNT_LABEL = "Paper account";

interface PaperOrder {
  id: number; created_at: string; client_order_id: string; symbol: string; side: "buy" | "sell"; qty: number; type: string; limit_price: number | null; stop_price: number | null;
  status: string; filled_price: number | null; filled_at: string | null; parent_id: number | null; oco_group: string | null; bracket_stop: number | null; bracket_target: number | null;
  commission: number; note: string; data_status: string; source: "you" | "ai" | "stop-loss" | "take-profit";
}
interface PaperFill { id: number; order_id: number; ts: string; symbol: string; side: string; qty: number; price: number; commission: number; realized_pnl: number; source: string; type: string; closing: boolean; reason: string }
interface Pos { qty: number; avg: number; opened_at: string }
interface Rule { id: number; name: string; kind: string; symbol: string | null; threshold: number | null; enabled: boolean; cooldown_minutes: number; last_fired_at: string | null }
interface EventRow { id: number; alert_id: number | null; ts: string; level: string; title: string; body: string; symbol: string | null; read: boolean }
interface Dash { id: number; name: string; layout: unknown[]; is_default: boolean; updated_at: string }

interface State {
  nextId: number; cash: number; startingCash: number; realized: number; peak: number; dayStart: number; dayDate: string; halted: string | null;
  positions: Record<string, Pos>; orders: PaperOrder[]; fills: PaperFill[]; transfers: { id: number; ts: string; kind: string; amount: number; note: string }[];
  equity: { ts: string; equity: number; cash: number; drawdown: number }[];
  watchlists: { id: number; name: string; symbols: string[] }[]; alerts: Rule[]; events: EventRow[]; dashboards: Dash[]; themes: Record<string, unknown>[];
  settings: typeof defaults.settings; keys: { id: string; secret: string } | null;
}

function fresh(): State {
  const now = new Date().toISOString();
  return {
    nextId: 2, cash: 100_000, startingCash: 100_000, realized: 0, peak: 100_000, dayStart: 100_000, dayDate: now.slice(0, 10), halted: null, positions: {}, orders: [], fills: [], transfers: [],
    equity: [{ ts: now, equity: 100_000, cash: 100_000, drawdown: 0 }], watchlists: [], alerts: [], events: [],
    dashboards: [{ id: 1, name: "Main desk", layout: defaults.default_layout, is_default: true, updated_at: now }], themes: [], settings: structuredClone(defaults.settings), keys: null,
  };
}

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...fresh(), ...JSON.parse(raw) };
  } catch { /* corrupted or blocked storage: start clean rather than fail to open */ }
  return fresh();
}

/** Practice replay. While active, the paper account is swapped out and the clock runs on replayed time. */
const rp = {
  active: false, status: "idle", message: "", progress: 0, speed: 10, playing: false, days: [] as number[], hist: {} as Record<string, Candle[]>, dayI: 0, minute: 0, startI: 0, source: "", label: "", startCash: 100_000,
  saved: null as Partial<State> | null, summary: null as unknown, trainedDay: 0, apMark: 0, resume: "playing",
};
const nowMs = () => (rp.active && rp.days.length ? etOpenMs(rp.days[rp.dayI]) + Math.min(rp.minute, 389.999) * 60_000 : Date.now());
function etOpenMs(t: number) {
  const guess = Date.parse(`${new Date(t * 1000).toISOString().slice(0, 10)}T13:30:00Z`);
  return new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }) === "9" ? guess : guess + 3_600_000;
}

const st: State = load();
let saveTimer = 0;
function save() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(rp.saved ? { ...st, ...rp.saved } : st)); } catch { /* storage full: state stays in memory for this visit */ }
  }, 200);
}
const nextId = () => st.nextId++;
const iso = () => new Date(nowMs()).toISOString();

/* --------------------------------------------------------------- data source */
const useAlpaca = () => st.settings.data.provider === "alpaca" && !!st.keys;
const noNews = () => useAlpaca() || rp.active;
const ALPACA = "https://data.alpaca.markets/v2/stocks";
async function alpaca<T>(path: string): Promise<T> {
  const res = await fetch(`${ALPACA}${path}`, { headers: { "APCA-API-KEY-ID": st.keys!.id, "APCA-API-SECRET-KEY": st.keys!.secret } });
  if (!res.ok) throw new ApiError(502, res.status === 401 || res.status === 403 ? "Alpaca rejected these keys." : `Alpaca returned HTTP ${res.status}.`);
  return res.json();
}

const ALPACA_TF: Record<string, [string, number]> = { "1D": ["1Day", 365 * 5], "1H": ["1Hour", 90], "15Min": ["15Min", 45], "5Min": ["5Min", 15] };
const barCache = new Map<string, { at: number; bars: Candle[] }>();
async function bars(symbol: string, tf: string): Promise<Candle[]> {
  if (rp.active) return replayBars(symbol, tf);
  if (!useAlpaca()) return simBars(symbol, tf);
  const key = `${symbol}:${tf}`;
  const hit = barCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.bars;
  const [frame, days] = ALPACA_TF[tf] ?? ALPACA_TF["1D"];
  const start = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const out: Candle[] = [];
  let token = "";
  do {
    const page = await alpaca<{ bars: { t: string; o: number; h: number; l: number; c: number; v: number }[] | null; next_page_token: string | null }>(
      `/${encodeURIComponent(symbol)}/bars?timeframe=${frame}&start=${start}&limit=10000&adjustment=all&feed=iex${token ? `&page_token=${token}` : ""}`);
    for (const b of page.bars ?? []) out.push({ time: Date.parse(b.t) / 1000, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
    token = page.next_page_token ?? "";
  } while (token);
  barCache.set(key, { at: Date.now(), bars: out });
  return out;
}

async function quotes(symbols: string[]): Promise<Record<string, Quote>> {
  const unique = [...new Set(symbols)];
  if (rp.active) return Object.fromEntries(unique.flatMap((s) => { const q = replayQuote(s); return q ? [[s, q]] : []; }));
  if (!useAlpaca()) return Object.fromEntries(unique.map((s) => [s, simQuote(s)]));
  type Snap = { latestTrade?: { p: number; t: string }; latestQuote?: { ap: number; bp: number }; dailyBar?: { o: number; h: number; l: number; v: number }; prevDailyBar?: { c: number } };
  const snaps = await alpaca<Record<string, Snap>>(`/snapshots?symbols=${unique.map(encodeURIComponent).join(",")}&feed=iex`);
  const out: Record<string, Quote> = {};
  for (const [s, q] of Object.entries(snaps)) {
    const price = q.latestTrade?.p;
    if (price == null) continue;
    const prev = q.prevDailyBar?.c ?? null;
    const bid = q.latestQuote?.bp || null, ask = q.latestQuote?.ap || null;
    out[s] = {
      symbol: s, price, ts: q.latestTrade!.t, status: "live", source: "alpaca", prev_close: prev, open: q.dailyBar?.o ?? null, high: q.dailyBar?.h ?? null, low: q.dailyBar?.l ?? null,
      volume: q.dailyBar?.v ?? null, bid, ask, session: "regular", venue_note: "IEX only", change: prev ? price - prev : null, change_pct: prev ? (price / prev - 1) * 100 : null,
      spread_bps: bid && ask ? ((ask - bid) / price) * 10_000 : null,
    };
  }
  return out;
}

const universe = () => (st.settings.universe.symbols.length ? (st.settings.universe.symbols as string[]) : Object.keys(UNIVERSE));

function clock() {
  const now = new Date(nowMs());
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false })
    .formatToParts(now).map((p) => [p.type, p.value]));
  const mins = +parts.hour % 24 * 60 + +parts.minute;
  const weekday = !["Sat", "Sun"].includes(parts.weekday);
  const session = !weekday ? "closed" : mins >= 240 && mins < 570 ? "pre" : mins >= 570 && mins < 960 ? "regular" : mins >= 960 && mins < 1200 ? "post" : "closed";
  return { now_utc: now.toISOString(), now_et: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`, session, trading_day: weekday };
}

/* --------------------------------------------------------------- paper broker */
const usable = (q: Quote) => q.status === "live" || q.status === "simulated" || q.status === "replay";
const fillPrice = (q: Quote, side: string) => {
  const slip = 1 + (side === "buy" ? 1 : -1) * st.settings.costs.slippage_bps / 10_000;
  return (side === "buy" ? q.ask ?? q.price : q.bid ?? q.price) * slip;
};

function positionsView(qs: Record<string, Quote>) {
  return Object.entries(st.positions).map(([symbol, p]) => {
    const mark = qs[symbol]?.price ?? p.avg;
    const unrealized = (mark - p.avg) * p.qty;
    return {
      symbol, qty: p.qty, side: p.qty > 0 ? "long" : "short", avg_price: p.avg, mark, market_value: mark * p.qty, unrealized, unrealized_pct: (mark / p.avg - 1) * 100 * Math.sign(p.qty),
      sector: meta(symbol)[1], data_status: qs[symbol]?.status ?? "unavailable", opened_at: p.opened_at, day_change_pct: qs[symbol]?.change_pct ?? null, entered_at: p.opened_at,
    };
  });
}

const reserved = () => st.orders.filter((o) => o.status === "open" && o.side === "buy" && !o.parent_id).reduce((s, o) => s + o.qty * (o.limit_price ?? o.stop_price ?? 0), 0);

function fillView(f: PaperFill) {
  return { ...f, total: f.qty * f.price, account: ACCOUNT_LABEL };
}

async function account() {
  const qs = await quotes(Object.keys(st.positions));
  const positions = positionsView(qs);
  const mv = positions.reduce((s, p) => s + p.market_value, 0);
  const equity = st.cash + mv;
  const dep = st.transfers.filter((t) => t.kind === "deposit").reduce((s, t) => s + t.amount, 0);
  const wd = st.transfers.filter((t) => t.kind === "withdrawal").reduce((s, t) => s + t.amount, 0);
  const net = st.startingCash + dep - wd;
  const longs = positions.filter((p) => p.qty > 0), shorts = positions.filter((p) => p.qty < 0);
  const closes = st.fills.filter((f) => f.closing);
  const available = st.cash - reserved();
  const unreal = positions.reduce((s, p) => s + p.unrealized, 0);
  return {
    account_id: 1, starting_cash: st.startingCash, cash: st.cash, equity, buying_power: Math.max(0, available), market_value: mv, realized_pnl: st.realized, unrealized_pnl: unreal,
    total_pnl: equity - net, total_return_pct: net > 0 ? (equity / net - 1) * 100 : 0,
    money: {
      starting_cash: st.startingCash, deposits: dep, withdrawals: wd, net_deposits: net, cash: st.cash, reserved_for_orders: reserved(), available_to_trade: Math.max(0, available),
      invested_cost: longs.reduce((s, p) => s + p.qty * p.avg_price, 0), long_market_value: longs.reduce((s, p) => s + p.market_value, 0), short_market_value: shorts.reduce((s, p) => s + p.market_value, 0),
      equity, profit: equity - net, return_pct: net > 0 ? (equity / net - 1) * 100 : 0,
      total_bought: st.fills.filter((f) => f.side === "buy").reduce((s, f) => s + f.qty * f.price, 0), total_sold: st.fills.filter((f) => f.side === "sell").reduce((s, f) => s + f.qty * f.price, 0),
      fees_paid: st.fills.reduce((s, f) => s + f.commission, 0), trades: st.fills.length, closed_trades: closes.length,
      win_rate_pct: closes.length ? (closes.filter((f) => f.realized_pnl > 0).length / closes.length) * 100 : null,
      cash_pct: equity ? (st.cash / equity) * 100 : 0, invested_pct: equity ? (mv / equity) * 100 : 0, open_positions: positions.length,
    },
    sandbox: st.settings.paper.sandbox, day_pnl: equity - st.dayStart, day_pnl_pct: st.dayStart ? (equity / st.dayStart - 1) * 100 : 0, drawdown_pct: st.peak ? (equity / st.peak - 1) * 100 : 0,
    peak_equity: st.peak, halted_reason: st.halted, trading_enabled: st.settings.paper.trading_enabled, positions, orders: st.orders.slice(-200).reverse(), fills: st.fills.slice(-200).reverse().map(fillView),
    account_label: ACCOUNT_LABEL,
  };
}

function applyFill(o: PaperOrder, price: number, status: string) {
  const signed = o.side === "buy" ? o.qty : -o.qty;
  const held = st.positions[o.symbol];
  let realized = 0;
  let closing = false;
  if (held && Math.sign(held.qty) !== Math.sign(signed)) {
    const closed = Math.min(Math.abs(held.qty), o.qty);
    realized = (price - held.avg) * closed * Math.sign(held.qty);
    closing = true;
  }
  const commission = Math.max(st.settings.costs.min_commission, st.settings.costs.commission_per_share * o.qty);
  st.cash -= signed * price + commission;
  st.realized += realized - commission;
  const newQty = (held?.qty ?? 0) + signed;
  if (newQty === 0) delete st.positions[o.symbol];
  else if (!held || Math.sign(held.qty) !== Math.sign(newQty)) st.positions[o.symbol] = { qty: newQty, avg: price, opened_at: iso() };
  else if (Math.abs(newQty) > Math.abs(held.qty)) st.positions[o.symbol] = { ...held, qty: newQty, avg: (held.avg * held.qty + price * signed) / newQty };
  else st.positions[o.symbol] = { ...held, qty: newQty };

  Object.assign(o, { status: "filled", filled_price: price, filled_at: iso(), commission, data_status: status });
  const fill: PaperFill = { id: nextId(), order_id: o.id, ts: iso(), symbol: o.symbol, side: o.side, qty: o.qty, price, commission, realized_pnl: realized - commission, source: o.source, type: o.type, closing, reason: o.note };
  st.fills.push(fill);
  if (o.oco_group) for (const x of st.orders) if (x.oco_group === o.oco_group && x.id !== o.id && x.status === "open") x.status = "cancelled";
  if (o.bracket_stop || o.bracket_target) {
    const group = `oco-${o.id}`;
    const side = o.side === "buy" ? "sell" : "buy";
    const child = (type: string, stop: number | null, limit: number | null, source: PaperOrder["source"]) =>
      st.orders.push({ ...o, id: nextId(), created_at: iso(), client_order_id: `${o.client_order_id}-${type}`, side, type, stop_price: stop, limit_price: limit, status: "open", filled_price: null, filled_at: null,
        parent_id: o.id, oco_group: group, bracket_stop: null, bracket_target: null, commission: 0, source, note: source === "stop-loss" ? "Protective stop" : "Profit target" });
    if (o.bracket_stop) child("stop", o.bracket_stop, null, "stop-loss");
    if (o.bracket_target) child("limit", null, o.bracket_target, "take-profit");
  }
  save();
  publish("paper_fill", fillView(fill));
}

function checks(symbol: string, side: string, qty: number, est: number, buyingPower: number) {
  const violations: string[] = [];
  const held = st.positions[symbol]?.qty ?? 0;
  if (!st.settings.paper.trading_enabled) violations.push("Trading is switched off.");
  if (st.halted) violations.push(st.halted);
  if (side === "buy" && held >= 0 && est * qty > buyingPower) violations.push(`Not enough buying power: this needs $${(est * qty).toFixed(2)}, you have $${buyingPower.toFixed(2)}.`);
  if (side === "sell" && qty > held && !st.settings.general.allow_short) violations.push(held > 0 ? `You hold only ${held} shares. Short selling is off in Settings.` : "You do not hold this stock. Short selling is off in Settings.");
  return violations;
}

interface OrderIn { symbol: string; side: string; qty?: number | null; type?: string; limit_price?: number | null; stop_price?: number | null; stop_loss?: number | null; take_profit?: number | null; client_order_id?: string; note?: string }

async function preview(o: OrderIn) {
  const symbol = o.symbol.toUpperCase();
  const q = (await quotes([symbol]))[symbol];
  if (!q) throw new ApiError(400, `No quote available for ${symbol}`);
  const a = await account();
  const est = o.type === "limit" && o.limit_price ? o.limit_price : fillPrice(q, o.side);
  const risk = st.settings.risk;
  let sizing = null;
  if (o.stop_loss) {
    const perShare = Math.abs(est - o.stop_loss);
    const budget = (a.equity * risk.risk_per_trade_pct) / 100;
    const byRisk = perShare ? Math.floor(budget / perShare) : 0;
    const byPosition = Math.floor((a.equity * risk.max_position_pct) / 100 / est);
    const byCash = Math.floor(a.buying_power / est);
    const sized = Math.max(0, Math.min(byRisk, byPosition, byCash));
    sizing = { qty: sized, risk_budget: budget, per_share_risk: perShare, position_value: sized * est, risk_at_stop: sized * perShare, risk_pct_of_equity: (sized * perShare / a.equity) * 100,
      binding_constraint: sized === byRisk ? "risk per trade" : sized === byPosition ? "max position size" : "buying power", notes: [] as string[] };
  }
  const qty = o.qty || sizing?.qty || 0;
  const violations = qty ? checks(symbol, o.side, qty, est, a.buying_power) : ["Quantity is zero."];
  if (!usable(q)) violations.push(`Quote is ${q.status}; market orders need a fresh price.`);
  if (o.stop_loss && (o.side === "buy" ? o.stop_loss >= est : o.stop_loss <= est)) violations.push("Stop-loss is on the wrong side of the entry price.");
  if (o.take_profit && (o.side === "buy" ? o.take_profit <= est : o.take_profit >= est)) violations.push("Take-profit is on the wrong side of the entry price.");
  const bps = (q.spread_bps ?? st.settings.costs.default_spread_bps) + st.settings.costs.slippage_bps * 2;
  const pct = bps / 10_000;
  return {
    symbol, side: o.side, qty, est_price: est, notional: est * qty, quote: q, sizing, costs: { spread_bps: q.spread_bps, slippage_bps: st.settings.costs.slippage_bps, round_trip_pct: pct, round_trip_cost: pct * est * qty, spread_source: "quote" },
    risk_at_stop: o.stop_loss ? Math.abs(est - o.stop_loss) * qty : null, reward_at_target: o.take_profit ? Math.abs(o.take_profit - est) * qty : null,
    ok: !violations.length, violations, warnings: [] as string[], simulated_data: q.status === "simulated",
  };
}

async function submit(o: OrderIn) {
  if (!o.qty) throw new ApiError(400, "Quantity is required", ["Quantity is required"]);
  if (!["buy", "sell"].includes(o.side)) throw new ApiError(400, "side must be buy or sell");
  const existing = o.client_order_id && st.orders.find((x) => x.client_order_id === o.client_order_id);
  if (existing) return existing;
  const pv = await preview(o);
  if (!pv.ok) throw new ApiError(400, "Order rejected", pv.violations);
  const symbol = o.symbol.toUpperCase();
  const order: PaperOrder = {
    id: nextId(), created_at: iso(), client_order_id: o.client_order_id ?? `api-${Date.now()}`, symbol, side: o.side as "buy" | "sell", qty: o.qty, type: o.type ?? "market", limit_price: o.limit_price ?? null,
    stop_price: o.stop_price ?? null, status: "open", filled_price: null, filled_at: null, parent_id: null, oco_group: null, bracket_stop: o.stop_loss ?? null, bracket_target: o.take_profit ?? null,
    commission: 0, note: o.note ?? "", data_status: pv.quote.status, source: o.note?.startsWith("autopilot") ? "ai" : "you",
  };
  st.orders.push(order);
  if (order.type === "market") applyFill(order, fillPrice(pv.quote, o.side), pv.quote.status);
  save();
  return order;
}

async function closePosition(symbol: string, note = "Closed from the trade desk", id = `close-${Date.now()}`) {
  const p = st.positions[symbol];
  if (!p) throw new ApiError(400, `No open position in ${symbol}`);
  for (const o of st.orders) if (o.symbol === symbol && o.status === "open") o.status = "cancelled";
  const q = (await quotes([symbol]))[symbol], side = p.qty > 0 ? "sell" : "buy";
  const order: PaperOrder = { id: nextId(), created_at: iso(), client_order_id: id, symbol, side, qty: Math.abs(p.qty), type: "market", limit_price: null, stop_price: null, status: "open", filled_price: null, filled_at: null,
    parent_id: null, oco_group: null, bracket_stop: null, bracket_target: null, commission: 0, note, data_status: q.status, source: note.startsWith("autopilot") ? "ai" : "you" };
  st.orders.push(order);
  applyFill(order, fillPrice(q, side), q.status);
  return order;
}

function triggered(o: PaperOrder, q: Quote) {
  if (o.type === "limit") return o.side === "buy" ? q.price <= o.limit_price! : q.price >= o.limit_price!;
  if (o.type === "stop") return o.side === "buy" ? q.price >= o.stop_price! : q.price <= o.stop_price!;
  return false;
}

function pushEvent(rule: Rule | null, level: string, title: string, body: string, symbol: string | null) {
  const ev: EventRow = { id: nextId(), alert_id: rule?.id ?? null, ts: iso(), level, title, body, symbol, read: false };
  st.events.push(ev);
  st.events = st.events.slice(-300);
  save();
  publish("alert", ev);
}

function processTick(qs: Record<string, Quote>) {
  for (const o of st.orders) {
    if (o.status !== "open") continue;
    const q = qs[o.symbol];
    if (!q || !triggered(o, q)) continue;
    const protective = o.source !== "you";
    if (!st.settings.paper.trading_enabled && !protective) continue;
    applyFill(o, o.type === "limit" ? o.limit_price! : fillPrice(q, o.side), q.status);
  }
  const now = Date.now();
  for (const r of st.alerts) {
    const q = r.symbol ? qs[r.symbol] : undefined;
    if (!r.enabled || !q || r.threshold == null) continue;
    if (r.last_fired_at && now - Date.parse(r.last_fired_at) < r.cooldown_minutes * 60_000) continue;
    const hit = r.kind === "price_above" ? q.price >= r.threshold : r.kind === "price_below" ? q.price <= r.threshold : r.kind === "pct_change" ? Math.abs(q.change_pct ?? 0) >= r.threshold : false;
    if (hit) {
      r.last_fired_at = iso();
      pushEvent(r, "info", r.name, `${r.symbol} is at ${q.price.toFixed(2)}.`, r.symbol);
    }
  }
}

/* --------------------------------------------------------------- analysis */
const pctRet = (c: Candle[], n: number) => (c.length > n ? c[c.length - 1].close / c[c.length - 1 - n].close - 1 : null);
const last = <T,>(a: (T | null)[]) => a[a.length - 1];
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

function profile(symbol: string) {
  if (!useAlpaca()) return simProfile(symbol);
  const [name, sector] = meta(symbol);
  return { symbol, name, sector, industry: "", market_cap: null, pe_ratio: null, forward_pe: null, eps: null, dividend_yield: null, beta: null, fifty_two_week_high: null, fifty_two_week_low: null,
    next_earnings: null, description: "", source: "alpaca", simulated: false, fields_unavailable: ["fundamentals"] };
}

function signal(key: string, name: string, score: number, summary: string) {
  const clamped = +Math.max(-1, Math.min(1, score)).toFixed(2);
  return { key, name, category: "technical", score: clamped, direction: clamped > 0.1 ? "bullish" : clamped < -0.1 ? "bearish" : "neutral", summary, values: {}, flags: [] as string[] };
}

function regime(spy: Candle[], breadth: number | null) {
  const closes = spy.map((k) => k.close);
  const px = closes[closes.length - 1];
  const vs200 = px / (last(sma(closes, 200)) ?? px) - 1;
  const high = Math.max(...closes.slice(-252));
  const dd = px / high - 1;
  const rets = closes.slice(-504).map((c, i, a) => (i ? Math.log(c / a[i - 1]) : 0));
  const rolling = rets.map((_, i) => (i < 20 ? 0 : Math.sqrt(rets.slice(i - 20, i).reduce((s, r) => s + r * r, 0) / 20)));
  const volNow = rolling[rolling.length - 1];
  const volPct = rolling.filter((v) => v <= volNow).length / rolling.length;
  const up = vs200 > 0;
  const label = up && dd > -0.1 ? "Uptrend" : up ? "Pullback" : "Downtrend";
  const score = Math.max(-1, Math.min(1, vs200 * 10 + dd * 2));
  return {
    key: "regime", name: "Market regime", category: "regime", score: +score.toFixed(2), direction: score > 0.1 ? "bullish" : score < -0.1 ? "bearish" : "neutral",
    summary: `${label}: S&P 500 proxy ${vs200 >= 0 ? "above" : "below"} its 200-day average, ${(dd * 100).toFixed(1)}% from its 1-year high.`,
    values: { label: label.toLowerCase(), label_name: label, vol_percentile_2y: +volPct.toFixed(4), drawdown_1y: +dd.toFixed(4), breadth_above_50d: breadth, spy_vs_200d: +vs200.toFixed(4) }, flags: [],
  };
}

/** Share of past days where the target was hit before the stop, using the same 2 ATR / 1.5 ATR barriers as the model labels. */
function barrierRates(c: Candle[], window = 500, horizon = 10) {
  const from = Math.max(20, c.length - window - horizon);
  let long = 0, short = 0, n = 0, pos = 0;
  const fwd: number[] = [];
  for (let i = from; i < c.length - horizon; i++) {
    const a = atr(c.slice(Math.max(0, i - 30), i + 1));
    const p = c[i].close;
    let l = 0, s = 0;
    for (let j = i + 1; j <= i + horizon; j++) {
      if (!l) l = c[j].low <= p - 1.5 * a ? -1 : c[j].high >= p + 2 * a ? 1 : 0;
      if (!s) s = c[j].high >= p + 1.5 * a ? -1 : c[j].low <= p - 2 * a ? 1 : 0;
    }
    if (l === 1) long++;
    if (s === 1) short++;
    const r = c[i + horizon].close / p - 1;
    if (r > 0) pos++;
    fwd.push(r);
    n++;
  }
  fwd.sort((a, b) => a - b);
  return { window_days: n, long_target_first_rate: n ? long / n : 0, short_target_first_rate: n ? short / n : 0, positive_return_rate: n ? pos / n : 0, median_fwd_return: fwd[fwd.length >> 1] ?? 0 };
}

async function research(symbol: string) {
  const all = await bars(symbol, "1D"), c = completed(all);
  if (c.length < 60) throw new ApiError(404, `Not enough history for ${symbol}.`);
  const q = (await quotes([symbol]))[symbol], spy = completed(await bars("SPY", "1D"));
  const px = q?.price ?? all[all.length - 1].close, a = atr(c.slice(-120)), sigs = signalsOf(symbol, c, spy), reg = regime(spy, null), sectors = await sectorContext();
  const fc = (await predictAll())[symbol] ?? null, art = activeArt(), mc = st.settings.model, stopAtr = art?.barrier_stop_atr ?? mc.barrier_stop_atr, targetAtr = art?.barrier_target_atr ?? mc.barrier_target_atr;
  const plan = (d: string) => ({ plan: tradePlan(d, px, a, stopAtr, targetAtr), agreement: +agreement(sigs, d).toFixed(3), evidence: evidence(sigs, d, fc, reg, sectors, symbol), risks: risksFor(sigs, fc, q?.status ?? "unavailable", d, c) });
  const plans = { long: plan("long"), short: plan("short") }, tilt = fc ? fc.exp_return * 20 : 0, lean = plans.long.agreement + tilt >= plans.short.agreement - tilt ? "long" : "short";
  const r = { symbol, name: meta(symbol)[0], sector: meta(symbol)[1], quote: q ?? null, profile: profile(symbol), signals: sigs, regime: reg, forecast: fc, model: modelInfo(), lean, plans, history: barrierRates(c, 500, art?.horizon_days ?? mc.horizon_days),
    news: noNews() ? [] : simNews(30, [symbol]).slice(0, 8), prediction_history: lab.predictions.filter((p) => p.symbol === symbol && p.source === sourceName()).slice(-50).reverse(), llm_available: false, generated_at: iso(),
    bars_meta: { status: q?.status ?? "unavailable", issues: [], source: sourceName() } };
  return { ...r, narrative: narrative(r, lean) };
}

/** Rule-generated summary built only from the bundle's numbers. */
function narrative(r: { symbol: string; name: string; sector: string; regime: ReturnType<typeof regime>; forecast: Forecast | null; history: ReturnType<typeof barrierRates>; plans: Record<string, { plan: ReturnType<typeof tradePlan>; evidence: { supporting: Obj[]; contradicting: Obj[] }; risks: string[] }> }, d: string) {
  const p = r.plans[d], fc = r.forecast, pct0 = (v: number) => `${(v * 100).toFixed(0)}%`, lines = [`${r.symbol} (${r.name}, ${r.sector}). Market regime: ${r.regime.values.label_name}.`];
  if (fc) {
    lines.push(`Over the next ${fc.horizon_days} trading days the ${fc.model} model estimates a ${pct0(fc.p_up)} chance of a positive return and a ${pct0(d === "long" ? fc.p_target_first_long : fc.p_target_first_short)} chance that the ${d} target (${fc.barrier_target_atr}×ATR) is reached before the stop (${fc.barrier_stop_atr}×ATR). Central return estimate ${signedPct(fc.exp_return, 2)}, 80% range ${signedPct(fc.q10)} to ${signedPct(fc.q90)}.`);
    lines.push(`For context, this stock reached the same ${d} target first ${pct0(d === "long" ? r.history.long_target_first_rate : r.history.short_target_first_rate)} of the time over the last two years (unconditional).`);
  } else lines.push("No trained model is active, so there is no statistical forecast.");
  const sup = p.evidence.supporting.slice(0, 3), opp = p.evidence.contradicting.slice(0, 3);
  if (sup.length) lines.push(`Supporting: ${sup.map((e) => `${e.source}: ${e.text}`).join(" ")}`);
  if (opp.length) lines.push(`Contradicting: ${opp.map((e) => `${e.source}: ${e.text}`).join(" ")}`);
  const pl = p.plan;
  lines.push(`A ${d} plan would enter around ${pl.entry_low.toFixed(2)} to ${pl.entry_high.toFixed(2)}, stop ${pl.stop.toFixed(2)}, targets ${pl.targets.map((t) => t.toFixed(2)).join(", ")}. ${pl.invalidation}`);
  lines.push(`Main risks: ${p.risks.slice(0, 3).join(" ")}`);
  lines.push("This is a statistical estimate, not a prediction of what will happen.");
  return lines.join("\n\n");
}

let snapshotCache: { at: number; key: string; rows: unknown[] } | null = null;
async function snapshot() {
  const syms = universe();
  const key = `${sourceName()}:${rp.active ? rp.dayI : ""}:${syms.join()}`;
  if (snapshotCache && snapshotCache.key === key && Date.now() - snapshotCache.at < 30_000) return snapshotCache.rows;
  const qs = await quotes(syms);
  const rows = [];
  for (const s of syms) {
    const c = await bars(s, "1D");
    if (c.length < 30) continue;
    rows.push(snapshotRow(s, c, qs[s]));
  }
  snapshotCache = { at: Date.now(), key, rows };
  return rows;
}

function snapshotRow(symbol: string, c: Candle[], q: Quote | undefined) {
  const closes = c.map((k) => k.close);
  const px = q?.price ?? closes[closes.length - 1];
  const year = c.slice(-252);
  const hi = Math.max(...year.map((k) => k.high)), lo = Math.min(...year.map((k) => k.low));
  const s50 = last(sma(closes, 50)), s200 = last(sma(closes, 200));
  const avgVol = c.slice(-21, -1).reduce((s, k) => s + k.volume, 0) / 20;
  const p = profile(symbol);
  return {
    symbol, name: meta(symbol)[0], sector: meta(symbol)[1], price: px, change_pct: q?.change_pct ?? null, volume: q?.volume ?? null, avg_volume: avgVol, rel_volume: avgVol && q?.volume ? q.volume / avgVol : null,
    avg_dollar_volume: avgVol * px, market_cap: p.market_cap, pe_ratio: p.pe_ratio, dividend_yield: p.dividend_yield, beta: p.beta, next_earnings: p.next_earnings, rsi14: last(rsi(closes)),
    atr_pct: (atr(c.slice(-120)) / px) * 100, ret_5d: pctRet(c, 5), ret_1m: pctRet(c, 21), ret_3m: pctRet(c, 63), ret_1y: pctRet(c, 252), dist_sma50: s50 ? px / s50 - 1 : null, dist_sma200: s200 ? px / s200 - 1 : null,
    dist_52w_high: px / hi - 1, dist_52w_low: px / lo - 1, status: q?.status ?? "unavailable",
  };
}

async function overview() {
  const uni = universe();
  const qs = await quotes([...Object.keys(INDEXES), ...Object.keys(SECTOR_ETFS), ...uni]);
  const spy = await bars("SPY", "1D");
  const rows = uni.flatMap((s) => {
    const q = qs[s];
    return q?.change_pct != null ? [{ symbol: s, name: meta(s)[0], sector: meta(s)[1], price: q.price, change_pct: q.change_pct, volume: q.volume, status: q.status }] : [];
  }).sort((a, b) => a.change_pct - b.change_pct);
  const snap = await snapshot() as { dist_sma50: number | null }[];
  const above = snap.filter((r) => (r.dist_sma50 ?? 0) > 0).length / (snap.length || 1);
  const indexes = await Promise.all(Object.entries(INDEXES).map(async ([symbol, name]) => ({ symbol, name, quote: qs[symbol] ?? null, spark: (await bars(symbol, "1D")).slice(-40).map((k) => k.close) })));
  const sectors = await Promise.all(Object.entries(SECTOR_ETFS).map(async ([symbol, sector]) => {
    const c = await bars(symbol, "1D");
    return { symbol, sector, change_pct: qs[symbol]?.change_pct ?? null, ret_1m: pctRet(c, 21), ret_3m: pctRet(c, 63), status: qs[symbol]?.status ?? null };
  }));
  return {
    indexes, sectors, gainers: rows.slice(-6).reverse(), losers: rows.slice(0, 6),
    breadth: { advancers: rows.filter((r) => r.change_pct > 0).length, decliners: rows.filter((r) => r.change_pct < 0).length, unchanged: rows.filter((r) => r.change_pct === 0).length, above_50d: above },
    regime: regime(spy, above), top_opportunities: lab.scan?.candidates?.slice(0, 6) ?? [], scanned_at: lab.scan?.scanned_at ?? null, news: noNews() ? [] : simNews(3, uni).slice(0, 8), status: { provider: st.settings.data.provider }, model: modelInfo(),
  };
}

async function analytics() {
  const a = await account();
  const risk = st.settings.risk;
  const sectorMap: Record<string, { gross: number; net: number }> = {};
  for (const p of a.positions) {
    const x = (sectorMap[p.sector] ??= { gross: 0, net: 0 });
    x.gross += Math.abs(p.market_value);
    x.net += p.market_value;
  }
  const pctOf = (v: number) => (a.equity ? (v / a.equity) * 100 : 0);
  const stops = st.orders.filter((o) => o.status === "open" && o.source === "stop-loss");
  const closes = st.fills.filter((f) => f.closing);
  const wins = closes.filter((f) => f.realized_pnl > 0), losses = closes.filter((f) => f.realized_pnl <= 0);
  const sum = (x: PaperFill[]) => x.reduce((s, f) => s + f.realized_pnl, 0);
  const openRisk = a.positions.reduce((s, p) => {
    const stop = stops.find((o) => o.symbol === p.symbol);
    return s + (stop ? Math.abs(p.mark - stop.stop_price!) * Math.abs(p.qty) : 0);
  }, 0);
  const long = a.positions.filter((p) => p.qty > 0).reduce((s, p) => s + p.market_value, 0);
  const short = a.positions.filter((p) => p.qty < 0).reduce((s, p) => s + p.market_value, 0);
  return {
    account: { equity: a.equity, cash: a.cash, starting_cash: a.starting_cash, realized_pnl: a.realized_pnl, unrealized_pnl: a.unrealized_pnl, total_pnl: a.total_pnl, total_return_pct: a.total_return_pct,
      day_pnl: a.day_pnl, day_pnl_pct: a.day_pnl_pct, drawdown_pct: a.drawdown_pct, halted_reason: a.halted_reason },
    equity_history: st.equity, sectors: Object.entries(sectorMap).map(([sector, v]) => ({ sector, gross_pct: pctOf(v.gross), net_pct: pctOf(v.net) })).sort((x, y) => y.gross_pct - x.gross_pct),
    exposure: { gross_pct: pctOf(long - short), net_pct: pctOf(long + short), long, short, positions: a.positions.length }, correlation: null, beta: null,
    risk: { open_risk_to_stops: openRisk, open_risk_pct: pctOf(openRisk), unprotected_positions: a.positions.filter((p) => !stops.some((o) => o.symbol === p.symbol)).map((p) => p.symbol),
      limits: { max_gross_exposure_pct: risk.max_gross_exposure_pct, max_sector_pct: risk.max_sector_pct, max_daily_loss_pct: risk.max_daily_loss_pct, max_drawdown_pct: risk.max_drawdown_pct, max_position_pct: risk.max_position_pct } },
    trade_stats: { closing_fills: closes.length, win_rate_pct: closes.length ? (wins.length / closes.length) * 100 : null, avg_win: wins.length ? sum(wins) / wins.length : null, avg_loss: losses.length ? sum(losses) / losses.length : null,
      profit_factor: losses.length && sum(losses) ? sum(wins) / Math.abs(sum(losses)) : null, commissions: st.fills.reduce((s, f) => s + f.commission, 0) },
    positions: a.positions,
  };
}

/* --------------------------------------------------------------- settings merge */
function merge(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object") merge(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    else target[k] = v;
  }
}

function status() {
  const live = useAlpaca(), run = lab.models.find((r) => r.id === trainingId);
  return {
    version: "browser", provider: rp.active ? "replay" : live ? "alpaca" : "simulation", provider_label: rp.active ? rp.label : live ? "Alpaca Market Data" : "Simulation", simulated: rp.active ? rp.source === "simulation" : !live, quote_status: rp.active ? "replay" : live ? "live" : "simulated", clock: clock(), model: modelInfo(), training: trainingId !== null,
    training_run: run ? { id: run.id, progress: run.progress, message: run.message } : null, scanner_running: scanning, unread_alerts: st.events.filter((e) => !e.read).length, paper_trading_enabled: st.settings.paper.trading_enabled, live_trading_enabled: false, sandbox: st.settings.paper.sandbox,
    autopilot_enabled: !!apCfg().enabled, autopilot_mode: apCfg().mode, autopilot_paused_until: apCfg().pause_until, replay: replayBrief(),
  };
}

/* --------------------------------------------------------------- lab state (IndexedDB: results are too big for localStorage) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
interface ModelRun { id: number; created_at: string; finished_at: string | null; status: string; source: string; champion: string | null; passed: boolean | null; active: boolean; progress: number; message: string; error: string | null; metrics: Obj | null; config: Obj }
interface BtRun { id: number; name: string; created_at: string; status: string; source: string; config: Obj; progress: number; error: string | null; results: Obj | null; equity: unknown[]; trades: unknown[] }
interface TurboRun { id: number; created_at: string; status: string; progress: number; error: string | null; config: Obj; result: Obj | null }
interface Prediction { id: number; symbol: string; asof: string; created_at: string; horizon_days: number; model: string; model_run_id: number; price: number; p_up: number; p_target_first: number; exp_return: number; q10: number; q90: number; target_price: number; stop_price: number; resolved: boolean; realized_return: number | null; hit: string | null; source: string }
interface ApEvent { id: number; ts: string; kind: string; symbol: string | null; qty: number | null; price: number | null; reason: string; order_id: number | null; status: string; payload: Obj }
const lab = { models: [] as ModelRun[], arts: {} as Record<number, Artifact>, backtests: [] as BtRun[], turbo: [] as TurboRun[], predictions: [] as Prediction[], ap: [] as ApEvent[], scan: null as Obj | null };

const openDb = () => new Promise<IDBDatabase>((res, rej) => {
  const r = indexedDB.open("lodestar-lab", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const labReady = (async () => {
  try {
    const db = await openDb();
    const saved = await new Promise<typeof lab | undefined>((res, rej) => { const g = db.transaction("kv").objectStore("kv").get("lab"); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); });
    if (!saved) return;
    Object.assign(lab, saved);
    for (const r of [...lab.models, ...lab.backtests, ...lab.turbo]) if (r.status === "running") Object.assign(r, { status: "failed", error: "The page was closed while this was running." });
  } catch { /* private window or blocked storage: results last for this visit */ }
})();
let labTimer = 0;
function saveLab() {
  window.clearTimeout(labTimer);
  labTimer = window.setTimeout(async () => {
    try { const db = await openDb(); db.transaction("kv", "readwrite").objectStore("kv").put(lab, "lab"); } catch { /* results last for this visit */ }
  }, 500);
}

/** Runs a model job in a Web Worker so the page stays smooth. Returns a function that kills it. */
function startJob(job: Job, on: { progress?: (p: number, message?: string, partial?: unknown) => void; done: (r: unknown) => void; fail: (m: string) => void }) {
  if (typeof Worker === "undefined") {
    setTimeout(() => { try { on.done(runJob(job, on.progress ?? (() => undefined))); } catch (e) { on.fail((e as Error).message); } });
    return () => undefined;
  }
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e) => {
    const m = e.data;
    if (m.done) { w.terminate(); on.done(m.result); } else if (m.error) { w.terminate(); on.fail(m.error); } else on.progress?.(m.p, m.message, m.partial);
  };
  w.onerror = (e) => { w.terminate(); on.fail(e.message || "The calculation stopped unexpectedly."); };
  w.postMessage(job);
  return () => w.terminate();
}

const sourceName = () => (rp.active ? "replay" : useAlpaca() ? "alpaca" : "simulation");
const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const etDate = (ts: string | number) => new Date(ts).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** Drops the session still in progress, so features never mix partial and full days. */
function completed(c: Candle[]) {
  if (!useAlpaca() || rp.active) return c.slice(0, -1);
  const k = clock();
  return c.length && dayOf(c[c.length - 1].time) === k.now_et.slice(0, 10) && (k.session === "pre" || k.session === "regular") ? c.slice(0, -1) : c;
}

async function universeBars() {
  const out: Bars = {}, problems: string[] = [];
  for (const s of universe()) {
    try { out[s] = completed(await bars(s, "1D")); } catch (e) { problems.push(`${s}: ${(e as Error).message}`); }
  }
  return { bars: out, spy: completed(await bars("SPY", "1D")), problems };
}

/* --------------------------------------------------------------- models */
let trainingId: number | null = null;
async function startTraining() {
  if (trainingId !== null) throw new ApiError(409, "A training job is already running");
  const mc = st.settings.model, id = nextId();
  const run: ModelRun = { id, created_at: iso(), finished_at: null, status: "running", source: sourceName(), champion: null, passed: null, active: false, progress: 0, message: "Loading market data", error: null, metrics: null, config: { ...mc } };
  lab.models.unshift(run);
  trainingId = id;
  const fail = (m: string) => { Object.assign(run, { status: "failed", error: m, finished_at: iso(), message: `Failed: ${m}` }); trainingId = null; saveLab(); };
  try {
    const u = await universeBars();
    startJob({ kind: "train", args: { bars: u.bars, spy: u.spy, source: run.source, runId: id, horizon: mc.horizon_days, kt: mc.barrier_target_atr, ks: mc.barrier_stop_atr, methods: mc.methods, selection: mc.selection, minRows: mc.min_train_rows, problems: u.problems } }, {
      progress: (p, message) => { run.progress = p; if (message) run.message = message; },
      done: (r) => {
        const { metrics, artifact } = r as { metrics: Obj; artifact: Artifact };
        for (const m of lab.models) if (m.source === run.source) m.active = false;
        lab.arts[id] = artifact;
        for (const k of Object.keys(lab.arts).map(Number).sort((a, b) => b - a).slice(5)) delete lab.arts[k];   // models are large; keep the newest five
        Object.assign(run, { status: "done", finished_at: iso(), metrics, champion: artifact.champion, passed: artifact.passed, active: true, progress: 1,
          message: `Done in ${metrics.duration_s}s, champion ${artifact.champion}, ${artifact.passed ? "passed" : "failed"} validation gates` });
        trainingId = null; fcCache = null; saveLab();
      },
      fail,
    });
  } catch (e) { fail((e as Error).message); }
  return id;
}

const activeArt = () => { const r = lab.models.find((m) => m.active && m.source === sourceName()); return r ? lab.arts[r.id] ?? null : null; };
function modelInfo() {
  const a = activeArt();
  return a && { run_id: a.run_id, champion: a.champion, passed: a.passed, reliability: a.reliability, source: a.source, trained_through: a.trained_through, horizon_days: a.horizon_days, barrier_target_atr: a.barrier_target_atr, barrier_stop_atr: a.barrier_stop_atr };
}
const runRow = (r: ModelRun, full: boolean) => {
  const m = r.metrics ?? {};
  const row: Obj = { id: r.id, created_at: r.created_at, finished_at: r.finished_at, status: r.status, source: r.source, champion: r.champion, passed: r.passed, active: r.active, progress: r.progress, message: r.message, error: r.error,
    reliability: m.reliability ?? null, baseline_comparison: m.baseline_comparison ?? null, trained_through: m.trained_through ?? null, horizon_days: r.config.horizon_days };
  return full ? { ...row, metrics: m, config: r.config } : row;
};

let fcCache: { at: number; key: string; fc: Record<string, Forecast> } | null = null;
async function predictAll(maxAge = 120_000) {
  const art = activeArt();
  if (!art) return {};
  const key = `${art.run_id}:${rp.active ? rp.dayI : clock().now_et.slice(0, 10)}`;
  if (fcCache?.key === key && Date.now() - fcCache.at < maxAge) return fcCache.fc;
  const u = await universeBars();
  const recent = Object.fromEntries(Object.entries(u.bars).map(([s, c]) => [s, c.slice(-330)]));
  const fc = forecastAll(art, recent, u.spy.slice(-330)) as unknown as Record<string, Forecast>;
  fcCache = { at: Date.now(), key, fc };
  return fc;
}

/* --------------------------------------------------------------- trade plans, sizing, signals */
const STOP_DISCLAIMER = "Stop levels are not guaranteed: an opening gap or fast market can fill a stop well beyond its price, so the realised loss can exceed the planned risk.";
function tradePlan(direction: string, price: number, a: number, stopAtr: number, targetAtr: number) {
  const sgn = direction === "long" ? 1 : -1, stop = price - sgn * stopAtr * a, r = Math.abs(price - stop), t1 = price + sgn * targetAtr * a, t2 = price + sgn * 2.5 * r;
  const targets = [...new Set([+t1.toFixed(4), +t2.toFixed(4)])].sort((x, y) => sgn * (x - y));
  const [lo, hi] = sgn > 0 ? [price - 0.25 * a, price + 0.1 * a] : [price - 0.1 * a, price + 0.25 * a];
  return { direction, entry: price, entry_low: lo, entry_high: hi, stop, targets, atr: a, risk_per_share: r, reward_risk: Math.abs(t1 - price) / r,
    invalidation: `Close ${sgn > 0 ? "below" : "above"} ${stop.toFixed(2)} (stop), or the setup's supporting signals reverse before entry. Do not chase beyond ${(sgn > 0 ? hi : lo).toFixed(2)}.` };
}
function costEstimate(price: number, qty: number, spread: number | null) {
  const c = st.settings.costs, sp = spread ?? c.default_spread_bps, side = sp / 2 + c.slippage_bps, comm = qty ? Math.max(c.min_commission, c.commission_per_share * qty) : 0;
  return { spread_bps: sp, slippage_bps: c.slippage_bps, round_trip_pct: (2 * side) / 1e4 + (price ? (2 * c.commission_per_share) / price : 0), round_trip_cost: (Math.abs(price * qty) * 2 * side) / 1e4 + 2 * comm, commission_round_trip: 2 * comm, spread_source: spread != null ? "quote" : "default estimate" };
}
function positionSize(equity: number, entry: number, stop: number, power: number, spread: number | null, existing: number) {
  const r = st.settings.risk, c = st.settings.costs, per = Math.abs(entry - stop);
  if (per <= 0 || entry <= 0 || equity <= 0) return { qty: 0, notes: ["invalid entry/stop/equity"], risk_budget: 0 };
  const sp = spread ?? c.default_spread_bps, cost = ((entry * (sp / 2 + c.slippage_bps)) / 1e4) * 2 + 2 * c.commission_per_share, budget = (equity * r.risk_per_trade_pct) / 100;
  const byRisk = budget / (per + cost), byPos = Math.max(0, (equity * r.max_position_pct) / 100 - Math.abs(existing)) / entry, byBp = Math.max(0, power) / entry;
  const qty = Math.max(0, Math.floor(Math.min(byRisk, byPos, byBp))), binding = byRisk <= byPos && byRisk <= byBp ? "risk budget" : byPos <= byBp ? "max position size" : "buying power";
  return { qty, risk_budget: budget, per_share_risk: per, per_share_cost: cost, position_value: qty * entry, risk_at_stop: qty * (per + cost), risk_pct_of_equity: (qty * (per + cost) * 100) / equity, binding_constraint: binding,
    limits: { by_risk: Math.floor(byRisk), by_max_position: Math.floor(byPos), by_buying_power: Math.floor(byBp) }, notes: binding === "risk budget" ? [] : [`size capped by ${binding}`] };
}

type Sig = ReturnType<typeof signal>;
function signalsOf(symbol: string, c: Candle[], spy: Candle[]) {
  const closes = c.map((k) => k.close), px = closes[closes.length - 1];
  const r126 = pctRet(c, 126) ?? 0, r21 = pctRet(c, 21) ?? 0, s50 = last(sma(closes, 50)) ?? px, s200 = last(sma(closes, 200)) ?? px, rsiNow = last(rsi(closes)) ?? 50, rel = r21 - (pctRet(spy, 21) ?? 0);
  const news = noNews() ? [] : simNews(7, [symbol]), tone = news.length ? news.reduce((s, n) => s + n.sentiment, 0) / news.length : 0;
  const out = [
    signal("momentum", "Momentum", r126 * 3, `6-month return ${(r126 * 100).toFixed(1)}%, 1-month ${(r21 * 100).toFixed(1)}%.`),
    signal("trend", "Trend", (px / s50 - 1) * 8 + (s50 / s200 - 1) * 8, `Price is ${px >= s50 ? "above" : "below"} its 50-day average, and the 50-day is ${s50 >= s200 ? "above" : "below"} the 200-day.`),
    signal("mean_reversion", "Mean reversion", (50 - rsiNow) / 30, `RSI(14) is ${rsiNow.toFixed(0)}.`),
    signal("relative_strength", "Relative strength", rel * 8, `${(rel * 100).toFixed(1)} points against SPY over 1 month.`),
    signal("news", "News", tone, news.length ? `${news.length} headlines in the last week, average tone ${tone.toFixed(2)}.` : "No recent headlines."),
  ];
  const earnings = profile(symbol).next_earnings;
  if (earnings) {
    const away = (Date.parse(earnings) - nowMs()) / 86_400_000;
    if (away >= 0 && away <= st.settings.scanner.event_blackout_days) out[0].flags.push("earnings_imminent");
  }
  return out;
}
function agreement(sigs: Sig[], direction: string) {
  const w: Record<string, number> = { momentum: 1, trend: 1, relative_strength: 0.8, mean_reversion: 0.7, news: 0.4 }, sgn = direction === "long" ? 1 : -1;
  const den = sigs.reduce((s, x) => s + (w[x.key] ?? 0), 0);
  return den ? sigs.reduce((s, x) => s + (w[x.key] ?? 0) * x.score * sgn, 0) / den : 0;
}
async function sectorContext() {
  const out: Record<string, { etf: string; ret_1m: number; ret_3m: number }> = {};
  for (const [etf, name] of Object.entries(SECTOR_ETFS)) {
    const c = completed(await bars(etf, "1D")), m1 = pctRet(c, 21), m3 = pctRet(c, 63);
    if (m1 != null && m3 != null) out[name] = { etf, ret_1m: m1, ret_3m: m3 };
  }
  return out;
}
const signedPct = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
function evidence(sigs: Sig[], direction: string, fc: Forecast | null | undefined, reg: ReturnType<typeof regime>, sectors: Awaited<ReturnType<typeof sectorContext>>, symbol: string) {
  const sgn = direction === "long" ? 1 : -1, sup: Obj[] = [], opp: Obj[] = [];
  const add = (score: number, row: Obj) => { if (Math.abs(score) > 0.1 || row.force) (score > 0 ? sup : opp).push({ ...row, score: +score.toFixed(2) }); };
  for (const s of sigs) if (s.direction !== "neutral") add(s.score * sgn, { source: s.name, category: s.category, text: s.summary, force: true });
  add(reg.score * sgn, { source: "Market regime", category: "regime", text: reg.summary });
  const sector = meta(symbol)[1], sec = sectors[sector];
  if (sec) add(Math.tanh(sec.ret_1m / 0.04) * sgn, { source: "Sector", category: "context", text: `${sector} sector (${sec.etf}) ${signedPct(sec.ret_1m)} over 1 month, ${signedPct(sec.ret_3m)} over 3 months.` });
  if (fc) add(Math.tanh((fc.exp_return * sgn) / 0.02), { source: "ML forecast", category: "ml", force: true, text: `ML forecast (${fc.model}, ${fc.horizon_days}-day): expected return ${signedPct(fc.exp_return, 2)} (80% interval ${signedPct(fc.q10)} to ${signedPct(fc.q90)}).` });
  const by = (a: Obj, b: Obj) => Math.abs(b.score) - Math.abs(a.score);
  const strip = (r: Obj) => { const { force: _f, ...x } = r; return x; };
  return { supporting: sup.sort(by).map(strip), contradicting: opp.sort(by).map(strip) };
}
function risksFor(sigs: Sig[], fc: Forecast | null | undefined, status: string, direction: string, c: Candle[]) {
  const out: string[] = [], flags = new Set(sigs.flatMap((s) => s.flags));
  if (flags.has("earnings_imminent")) out.push("Earnings announcement inside the blackout window: overnight gap risk is high and model inputs are unreliable.");
  const a = atr(c.slice(-120)), slow = atr(c.slice(-250, -100));
  if (slow && a > slow * 1.4) out.push("Volatility is elevated vs the past year; stops are wider and gap risk higher.");
  if (fc && fc.uncertainty > 0.1) out.push(`Wide forecast interval (${(fc.uncertainty * 100).toFixed(1)}%): the model's central estimate is low-confidence.`);
  if (fc && !fc.validated) out.push("The active model did not pass out-of-sample validation gates; treat its numbers as unproven.");
  if (direction === "short") out.push("Short positions have theoretically unlimited loss and can be squeezed; borrow costs are not modelled.");
  if (status === "simulated") out.push("All prices are simulated; nothing here reflects real market conditions.");
  out.push(STOP_DISCLAIMER);
  return out;
}

/* --------------------------------------------------------------- scanner */
const practiceMode = () => !!(st.settings.paper.sandbox && st.settings.autopilot.practice_mode);
const STRATEGY_NAMES: Record<string, string> = { momentum: "Momentum continuation", trend: "Trend following", mean_reversion: "Mean reversion", relative_strength: "Relative strength", news: "News-driven" };
const clip01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

function evaluate(symbol: string, direction: string, c: Candle[], q: Quote | undefined, fc: Forecast | undefined, reg: ReturnType<typeof regime>, sectors: Awaited<ReturnType<typeof sectorContext>>, sigs: Sig[], baseRates: Obj, positions: Record<string, { qty: number; price: number }>, equity: number, cash: number) {
  const sc = st.settings.scanner, risk = st.settings.risk, sgn = direction === "long" ? 1 : -1, reasons: string[] = [];
  const price = q?.price ?? c[c.length - 1].close, status = q?.status ?? "historical", a = atr(c.slice(-120)), art = activeArt();
  const cfg = art ? { stop: art.barrier_stop_atr, target: art.barrier_target_atr, horizon: art.horizon_days } : { stop: risk.stop_atr_mult, target: 2, horizon: sc.horizon_days };
  const plan = tradePlan(direction, price, a, cfg.stop, cfg.target), spread = q?.spread_bps ?? null, held = positions[symbol], same = held && held.qty > 0 === (direction === "long");
  const sizing = positionSize(equity, plan.entry, plan.stop, cash, spread, same ? Math.abs(held.qty * held.price) : 0), cost = costEstimate(price, sizing.qty, spread);
  const adv = mean(c.slice(-20).map((k) => k.close * k.volume)), agree = agreement(sigs, direction), flags = new Set(sigs.flatMap((s) => s.flags));
  let exp = 0, probEdge = 0, unc = 0, modelRr = 0, pTf = NaN, pProfit = NaN, base = NaN, rel = 0, qLo = NaN, qHi = NaN, asof = new Date(c[c.length - 1].time * 1000).toISOString();
  if (fc) {
    exp = fc.exp_return * sgn;
    pTf = sgn > 0 ? fc.p_target_first_long : fc.p_target_first_short;
    base = baseRates[sgn > 0 ? "target_first_long" : "target_first_short"] ?? pTf;
    probEdge = pTf - base;
    pProfit = sgn > 0 ? fc.p_up : 1 - fc.p_up;
    unc = fc.uncertainty;
    rel = fc.validated || practiceMode() ? fc.reliability : Math.min(fc.reliability, 0.2);
    const mfe = sgn > 0 ? fc.exp_favorable_excursion : -fc.exp_adverse_excursion, mae = sgn > 0 ? -fc.exp_adverse_excursion : fc.exp_favorable_excursion;
    modelRr = mae > 0 ? mfe / mae : 0;
    [qLo, qHi] = sgn > 0 ? [fc.q10, fc.q90] : [-fc.q90, -fc.q10];
    asof = fc.asof;
  } else reasons.push("No validated model is active (train one on the Models screen).");
  const net = exp - cost.round_trip_pct;
  if (status === "stale" || status === "cached") reasons.push(`Price data is ${status}.`);
  if (c[c.length - 1].time - Date.parse(asof) / 1000 > 4 * 86400) reasons.push("Forecast is older than the latest completed bar (model data stale).");
  if (price < sc.min_price) reasons.push(`Price ${price.toFixed(2)} below minimum ${sc.min_price.toFixed(2)}.`);
  if (adv < sc.min_avg_dollar_volume) reasons.push(`Average dollar volume $${(adv / 1e6).toFixed(1)}M below $${(sc.min_avg_dollar_volume / 1e6).toFixed(0)}M.`);
  if (spread != null && spread > sc.max_spread_bps) reasons.push(`Spread ${spread.toFixed(1)} bps above ${sc.max_spread_bps.toFixed(0)} bps.`);
  if (fc) {
    if (net * 100 < sc.min_net_expected_return_pct) reasons.push(`Expected return after costs ${signedPct(net, 2)} below ${sc.min_net_expected_return_pct.toFixed(2)}%.`);
    if (probEdge < sc.min_prob_edge) reasons.push(`Probability edge ${signedPct(probEdge)} below ${(sc.min_prob_edge * 100).toFixed(0)}% (target-first ${(pTf * 100).toFixed(0)}% vs base ${(base * 100).toFixed(0)}%).`);
    if (unc * 100 > sc.max_uncertainty_pct) reasons.push(`Forecast interval ${(unc * 100).toFixed(1)}% wider than ${sc.max_uncertainty_pct.toFixed(0)}%.`);
    if (rel < sc.min_model_reliability && !practiceMode()) reasons.push(`Model reliability ${rel.toFixed(2)} below ${sc.min_model_reliability.toFixed(2)}${fc.validated ? "" : " (model failed validation gates)"}.`);
  }
  if (flags.has("earnings_imminent")) reasons.push("Earnings inside the event blackout window.");
  if (direction === "short" && !st.settings.general.allow_short) reasons.push("Short selling disabled in settings.");
  if (agree < -0.4) reasons.push(`Technical signals strongly contradict the direction (agreement ${agree.toFixed(2)}).`);
  if (sizing.qty < 1) reasons.push("Position size rounds to zero under current risk limits.");
  const notes: string[] = [], sector = meta(symbol)[1], secVal = Object.entries(positions).reduce((s, [x, p]) => s + (meta(x)[1] === sector ? Math.abs(p.qty) * p.price : 0), 0);
  if (equity > 0 && (secVal / equity) * 100 > risk.max_sector_pct * 0.8) notes.push(`${sector} exposure already ${((secVal / equity) * 100).toFixed(0)}% of equity.`);
  if (positions[symbol]) notes.push("Already held in the paper portfolio.");
  const comps: Record<string, number> = { net_expected_return: clip01(net / 0.03), prob_edge: clip01(probEdge / 0.1), reward_risk: clip01(modelRr / 2), model_reliability: clip01(rel), signal_agreement: clip01((agree + 1) / 2),
    liquidity: clip01((Math.log10(Math.max(adv, 1)) - 7) / 2), regime_fit: clip01((reg.score * sgn + 1) / 2), data_quality: 1 };
  const w = sc.weights as Record<string, number>, tw = Object.keys(comps).reduce((s, k) => s + (w[k] ?? 0), 0) || 1, score = (100 * Object.keys(comps).reduce((s, k) => s + comps[k] * (w[k] ?? 0), 0)) / tw;
  const lead = sigs.filter((s) => STRATEGY_NAMES[s.key] && s.score * sgn > 0.15).sort((x, y) => (y.score - x.score) * sgn)[0];
  const ev = evidence(sigs, direction, fc, reg, sectors, symbol), p = profile(symbol);
  return { symbol, name: p.name ?? meta(symbol)[0], sector, direction, strategy: lead ? `${STRATEGY_NAMES[lead.key]} + ML forecast` : "ML forecast", price, data_status: status, horizon_days: cfg.horizon, exp_return: exp, net_exp_return: net, q10: qLo, q90: qHi, uncertainty: unc,
    p_profit: pProfit, p_target_first: pTf, base_target_first: base, prob_edge: probEdge, reward_risk: plan.reward_risk, model_reward_risk: modelRr, model_reliability: rel, signal_agreement: agree, avg_dollar_volume: adv, spread_bps: spread,
    regime: reg.values.label, plan, sizing, costs: cost, score: +score.toFixed(2), components: Object.fromEntries(Object.entries(comps).map(([k, v]) => [k, +v.toFixed(3)])), supporting: ev.supporting, contradicting: ev.contradicting,
    risks: risksFor(sigs, fc, status, direction, c), notes, rejected: !!reasons.length, reasons, forecast_asof: asof, signals: Object.fromEntries(sigs.map((s) => [s.key, s.score])), next_earnings: p.next_earnings };
}

const REASON_CATS = [["Model reliability", "Model not reliable enough"], ["No validated model", "No model"], ["Expected return after costs", "Edge too small after costs"], ["Probability edge", "Probability edge too small"], ["Forecast interval", "Forecast too uncertain"], ["Earnings", "Earnings blackout"],
  ["Price data is", "Stale data"], ["Forecast is older", "Stale data"], ["Average dollar volume", "Illiquid"], ["Spread", "Spread too wide"], ["Price ", "Price too low"], ["Technical signals", "Signals contradict"], ["Position size", "Size rounds to zero"], ["Short selling", "Shorts disabled"]];
function reasonCounts(rejected: { reasons: string[] }[]) {
  const counts = new Map<string, number>();
  for (const c of rejected) for (const k of new Set(c.reasons.map((r) => REASON_CATS.find(([pre]) => r.startsWith(pre))?.[1] ?? "Other"))) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

let scanning = false;
async function runScan() {
  if (scanning) return lab.scan;
  scanning = true;
  const t0 = performance.now();
  try {
    const a = await account(), positions = Object.fromEntries(a.positions.map((p) => [p.symbol, { qty: p.qty, price: p.mark }]));
    const equity = st.settings.risk.account_equity_override ?? a.equity, syms = universe(), spy = completed(await bars("SPY", "1D"));
    const fcs = await predictAll(0), info = modelInfo(), baseRates = lab.models.find((m) => m.id === info?.run_id)?.metrics?.label_base_rates ?? {};
    const qs = await quotes(syms), sectors = await sectorContext(), reg = regime(spy, null);
    const cands: ReturnType<typeof evaluate>[] = [], rejected: typeof cands = [], errors: { symbol: string; error: string }[] = [];
    for (const sym of syms) {
      try {
        const c = completed(await bars(sym, "1D"));
        if (c.length < 220) { errors.push({ symbol: sym, error: "insufficient history" }); continue; }
        const sigs = signalsOf(sym, c, spy);
        for (const d of st.settings.general.allow_short ? ["long", "short"] : ["long"]) {
          const x = evaluate(sym, d, c, qs[sym], fcs[sym], reg, sectors, sigs, baseRates, positions, equity, a.buying_power);
          (x.rejected ? rejected : cands).push(x);
        }
      } catch (e) { errors.push({ symbol: sym, error: (e as Error).message }); }
    }
    cands.sort((x, y) => y.score - x.score);
    const best = new Map<string, (typeof cands)[number]>();
    for (const c of rejected) if (!best.has(c.symbol) || c.score > best.get(c.symbol)!.score) best.set(c.symbol, c);
    lab.scan = clean({ scanned_at: iso(), duration_s: +((performance.now() - t0) / 1000).toFixed(2), universe_size: syms.length, candidates: cands, rejected: [...best.values()].sort((x, y) => y.score - x.score), errors, regime: reg, model: info,
      provider: sourceName(), simulated: !useAlpaca(), settings: st.settings.scanner, reason_counts: reasonCounts(rejected) });
    logPredictions(fcs);
    await resolvePredictions();
    saveLab();
    return lab.scan;
  } finally { scanning = false; }
}

function logPredictions(fcs: Record<string, Forecast>) {
  for (const f of Object.values(fcs)) {
    if (lab.predictions.some((p) => p.symbol === f.symbol && p.asof === f.asof && p.model_run_id === f.model_run_id)) continue;
    lab.predictions.push({ id: nextId(), symbol: f.symbol, asof: f.asof, created_at: iso(), horizon_days: f.horizon_days, model: f.model, model_run_id: f.model_run_id, price: f.price_asof, p_up: f.p_up, p_target_first: f.p_target_first_long, exp_return: f.exp_return, q10: f.q10, q90: f.q90,
      target_price: f.price_asof * (1 + f.barrier_target_atr * f.atr_pct), stop_price: f.price_asof * (1 - f.barrier_stop_atr * f.atr_pct), resolved: false, realized_return: null, hit: null, source: f.source });
  }
  lab.predictions = lab.predictions.slice(-5000);
}
async function resolvePredictions() {
  for (const p of lab.predictions) {
    if (p.resolved || p.source !== sourceName()) continue;
    const after = completed(await bars(p.symbol, "1D")).filter((k) => k.time > Date.parse(p.asof) / 1000);
    if (after.length < p.horizon_days) continue;
    const win = after.slice(0, p.horizon_days);
    p.realized_return = win[win.length - 1].close / p.price - 1;
    p.hit = "timeout";
    for (const b of win) {
      if (b.low <= p.stop_price) { p.hit = "stop"; break; }
      if (b.high >= p.target_price) { p.hit = "target"; break; }
    }
    p.resolved = true;
  }
}

/* --------------------------------------------------------------- autopilot (paper only) */
const PICKINESS: Record<string, { label: string; min_score: number | null; about: string }> = {
  strict: { label: "Strict", min_score: null, about: "Only ideas that pass every one of the scanner's quality thresholds. Few trades; it can wait days." },
  balanced: { label: "Balanced", min_score: 45, about: "Ideas the model rates positive after costs (expected return > 0.1%, edge > 0.5 points), even if they miss the scanner's stricter thresholds." },
  active: { label: "Active", min_score: 30, about: "Any idea with a positive expected result after costs and a better-than-base-rate chance of hitting its target. Most trades, lowest conviction." },
};
const SOFT = ["Expected return after costs", "Probability edge", "Forecast interval", "Model reliability"];
const ap = { last_cycle: null as string | null, last_summary: "", paused_reason: null as string | null, logged: "", running: false };
const apCfg = () => st.settings.autopilot as Obj;
function apLog(kind: string, reason: string, symbol: string | null = null, qty: number | null = null, price: number | null = null, order_id: number | null = null, status = "done", payload: Obj = {}) {
  const e: ApEvent = { id: nextId(), ts: iso(), kind, symbol, qty, price, reason: reason.slice(0, 2000), order_id, status, payload };
  lab.ap.push(e);
  lab.ap = lab.ap.slice(-2000);
  saveLab();
  return e;
}
const tradesToday = () => lab.ap.filter((e) => (e.kind === "buy" || e.kind === "sell") && e.status === "done" && etDate(e.ts) === etDate(nowMs())).length;
function ownedPositions(positions: Awaited<ReturnType<typeof account>>["positions"]) {
  return positions.flatMap((p) => {
    const e = lab.ap.find((x) => x.symbol === p.symbol && (x.kind === "buy" || x.kind === "sell") && x.status === "done" && x.payload.action === "entry" && Date.parse(x.ts) >= Date.parse(p.opened_at) - 10_000);
    return e ? [{ ...p, entry_event: e.id, entered_at: e.ts }] : [];
  });
}
function scheduleAllows(): [boolean, string] {
  const cfg = apCfg(), k = clock(), mode = cfg.schedule === "auto" ? (useAlpaca() && !rp.active ? "market_hours" : "always") : cfg.schedule;
  if (mode === "always") return [true, "Runs at any time (simulated prices update around the clock)."];
  if (mode === "market_hours") return k.session === "regular" ? [true, "Inside regular market hours."] : [false, "Waiting for regular market hours (9:30 to 16:00 ET)."];
  const wd = (new Date(`${k.now_et.slice(0, 10)}T00:00:00Z`).getUTCDay() + 6) % 7, hm = k.now_et.slice(11, 16);
  if (!cfg.days.includes(wd)) return [false, "Today is not one of the allowed days."];
  return hm >= cfg.custom_start && hm <= cfg.custom_end ? [true, `Allowed ${cfg.custom_start} to ${cfg.custom_end} ET.`] : [false, `Outside your window (${cfg.custom_start} to ${cfg.custom_end} ET).`];
}
function eligible(c: Obj, pick: string) {
  if (!c.rejected) return true;
  if (pick === "strict") return false;
  const soft = pick === "active" ? [...SOFT, "Technical signals"] : SOFT;
  if (!c.reasons.every((r: string) => soft.some((s) => r.startsWith(s)))) return false;
  const net = c.net_exp_return ?? 0, edge = c.prob_edge ?? 0;
  return pick === "balanced" ? net > 0.001 && edge > 0.005 : net > 0 && edge > 0;
}
const effectiveMinScore = () => { const cfg = apCfg(), cap = (PICKINESS[cfg.pickiness] ?? PICKINESS.balanced).min_score; return cap == null ? cfg.min_score : Math.min(cfg.min_score, cap); };

async function apExecute(side: string, symbol: string, qty: number, price: number, reason: string, payload: Obj) {
  const cfg = apCfg(), bracket = payload.action === "entry" && cfg.use_brackets, id = `auto-${crypto.randomUUID().slice(0, 16)}`;
  try {
    const o = payload.action === "exit" ? await closePosition(symbol, `autopilot exit`, id) : await submit({ symbol, side, qty, stop_loss: bracket ? payload.stop : undefined, take_profit: bracket ? payload.target : undefined, client_order_id: id, note: `autopilot ${payload.action}` });
    return { ...apLog(side, reason, symbol, o.qty, o.filled_price ?? price, o.id, "done", payload), action: payload.action };
  } catch (e) {
    const why = e instanceof ApiError && e.violations?.length ? e.violations.join("; ") : (e as Error).message;
    return { ...apLog("skip", `${side} ${qty} ${symbol} blocked by risk checks: ${why}`, symbol, qty, price, null, "done", payload), action: payload.action, status: "blocked" };
  }
}
const apAct = async (side: string, symbol: string, qty: number, price: number, reason: string, payload: Obj) => (
  apCfg().mode === "approve" ? { ...apLog("proposal", reason, symbol, qty, price, null, "pending", { ...payload, side }), action: payload.action } : apExecute(side, symbol, qty, price, reason, payload));

async function apCycle(force: boolean) {
  if (ap.running) return { skipped: "A cycle is already running." };
  ap.running = true;
  try { return await apRun(force); } finally { ap.running = false; }
}
async function apRun(force: boolean) {
  const cfg = apCfg(), done = (s: string, keep = false) => { if (!keep) ap.last_summary = s; return { actions: [] as Obj[], summary: s }; };
  ap.last_cycle = new Date().toISOString();
  if (!cfg.enabled && !force) return done("Autopilot is off.");
  if (cfg.stop_at && !force && nowMs() >= Date.parse(cfg.stop_at)) { merge(cfg, { enabled: false, stop_at: null }); save(); apLog("info", "Autopilot switched itself off at the stop time you set."); return done("Stopped at the time you chose."); }
  if (cfg.pause_until && !force) {
    if (nowMs() < Date.parse(cfg.pause_until)) return done(`Paused by you until ${new Date(cfg.pause_until).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} ET.`);
    cfg.pause_until = null; save();
  }
  if (!st.settings.paper.trading_enabled) return done("Trading is switched off (top bar). The AI will carry on when you switch trading back on.");
  const [ok, why] = scheduleAllows();
  if (!ok && !force) return done(why);
  let snap = await account();
  if (snap.halted_reason) return done(`Account halted: ${snap.halted_reason}`);
  if (snap.day_pnl_pct <= -Math.abs(cfg.stop_on_daily_loss_pct)) { ap.paused_reason = `Paused for today: down ${snap.day_pnl_pct.toFixed(2)}% (your limit is ${cfg.stop_on_daily_loss_pct}%).`; return done(ap.paused_reason); }
  ap.paused_reason = null;
  const cutoff = nowMs() - cfg.proposal_ttl_minutes * 60_000;
  for (const e of lab.ap) if (e.status === "pending" && Date.parse(e.ts) < cutoff) e.status = "expired";

  const fcs = await predictAll(), info = modelInfo(), practice = practiceMode(), modelOk = !!(info && (info.passed || practice)), actions: Obj[] = [];
  for (const p of ownedPositions(snap.positions)) {
    const fc = fcs[p.symbol], heldDays = (nowMs() - Date.parse(p.entered_at)) / 86_400_000;
    let reason: string | null = null;
    if (cfg.max_hold_days && heldDays >= (cfg.max_hold_days * 7) / 5) reason = `Held ${heldDays.toFixed(1)} days, past your ${cfg.max_hold_days}-trading-day limit.`;
    else if (cfg.exit_on_signal_flip && fc) {
      const long = p.qty > 0, exp = long ? fc.exp_return : -fc.exp_return, pTf = long ? fc.p_target_first_long : fc.p_target_first_short;
      if (exp < 0 && pTf < fc.barrier_stop_atr / (fc.barrier_target_atr + fc.barrier_stop_atr)) reason = `Forecast turned against the position: expected ${signedPct(exp, 2)} over ${fc.horizon_days} days, P(target first) ${(pTf * 100).toFixed(0)}%.`;
    }
    if (reason) actions.push(await apAct(p.qty > 0 ? "sell" : "buy", p.symbol, Math.abs(p.qty), p.mark, reason, { action: "exit" }));
  }
  const res = lab.scan ?? {}, pick = cfg.pickiness ?? "balanced", pool: Obj[] = [...(res.candidates ?? []), ...(res.rejected ?? [])], strictN = pool.filter((c) => !c.rejected).length;
  const cands = pool.filter((c) => eligible(c, pick)).sort((a, b) => b.score - a.score), minScore = effectiveMinScore();
  const list = cfg.symbols_mode === "watchlist" && cfg.watchlist_id ? st.watchlists.find((w) => w.id === +cfg.watchlist_id) : null, allowed = cfg.symbols_mode === "watchlist" && cfg.watchlist_id ? new Set((list?.symbols ?? []).map((s) => s.toUpperCase())) : null;
  const held = new Set(snap.positions.map((p) => p.symbol)), pending = new Set(lab.ap.filter((e) => e.status === "pending").map((e) => e.symbol));
  let owned = ownedPositions(snap.positions), openAuto = owned.length, autoValue = owned.reduce((s, p) => s + Math.abs(p.market_value), 0), eq = snap.equity;
  const used = tradesToday(), skipped: Record<string, number> = {}, skip = (r: string) => { skipped[r] = (skipped[r] ?? 0) + 1; };
  if (!info) skip("no trained model"); else if (!modelOk) skip("model failed validation");

  if (cfg.rotate_for_better && modelOk && openAuto >= cfg.max_open_positions && cfg.max_open_positions > 0) {
    const scored = new Map(pool.map((c) => [c.symbol, c])), acted = new Set(actions.map((a) => a.symbol));
    const fresh = cands.filter((c) => !held.has(c.symbol) && !pending.has(c.symbol) && c.score >= minScore && (c.direction === "long" || cfg.allow_short) && (!allowed || allowed.has(c.symbol)));
    const heldScore = (p: (typeof owned)[number]) => { const c = scored.get(p.symbol); return !c ? null : (c.direction === "long") !== p.qty > 0 ? 0 : +c.score; };
    const swappable = owned.filter((p) => !acted.has(p.symbol) && heldScore(p) !== null && nowMs() - Date.parse(p.entered_at) >= 86_400_000);
    if (swappable.length && fresh.length) {
      const weakest = swappable.reduce((a, b) => (heldScore(b)! < heldScore(a)! ? b : a)), ws = heldScore(weakest)!, best = fresh[0];
      if (best.score - ws >= cfg.rotate_margin) {
        const a = await apAct(weakest.qty > 0 ? "sell" : "buy", weakest.symbol, Math.abs(weakest.qty), weakest.mark, `Swapped out to make room for ${best.symbol} (score ${best.score.toFixed(0)}); ${ws === 0 ? "its forecast has turned against it" : `it now scores ${ws.toFixed(0)}`}.`, { action: "exit", swap_for: best.symbol });
        actions.push(a);
        if (a.status === "done") { snap = await account(); eq = snap.equity; owned = ownedPositions(snap.positions); openAuto = owned.length; autoValue = owned.reduce((s, p) => s + Math.abs(p.market_value), 0); }
      }
    }
  }
  for (const c of cands) {
    if (!modelOk) break;
    if (c.score < minScore) { skip(`score below ${minScore.toFixed(0)}`); continue; }
    if (c.direction === "short" && !cfg.allow_short) { skip("shorts not allowed"); continue; }
    if (allowed && !allowed.has(c.symbol)) { skip("not on the chosen watchlist"); continue; }
    if (held.has(c.symbol) || pending.has(c.symbol)) { skip("already held or proposed"); continue; }
    if (used + actions.filter((a) => a.action === "entry").length >= cfg.max_trades_per_day) { skip("daily trade limit reached"); continue; }
    if (openAuto >= cfg.max_open_positions) { skip("max open positions reached"); continue; }
    const price = c.price;
    let qty = Math.floor(c.sizing.qty);
    qty = Math.min(qty, Math.floor(((eq * Math.min(cfg.max_position_pct, st.settings.risk.max_position_pct)) / 100) / price), Math.floor(Math.max(0, (eq * cfg.max_capital_pct) / 100 - autoValue) / price), Math.floor(snap.buying_power / price));
    if (qty < 1) { skip("no capital left within your limits"); continue; }
    const text = `${practice && !info!.passed ? "[Practice mode: model not validated] " : ""}${c.rejected ? `[${PICKINESS[pick].label}: below the scanner's strict thresholds] ` : ""}${c.strategy}: score ${c.score.toFixed(0)}, expected ${signedPct(c.net_exp_return, 2)} after costs over ${c.horizon_days} days, P(target before stop) ${(c.p_target_first * 100).toFixed(0)}% vs ${(c.base_target_first * 100).toFixed(0)}% base rate.`;
    const a = await apAct(c.direction === "long" ? "buy" : "sell", c.symbol, qty, price, text, { action: "entry", stop: +c.plan.stop.toFixed(2), target: +c.plan.targets[0].toFixed(2), score: c.score, direction: c.direction });
    actions.push(a);
    if (a.status === "done" || a.status === "pending") { openAuto++; autoValue += qty * price; held.add(c.symbol); }
  }
  const nIn = actions.filter((a) => a.action === "entry" && a.status === "done").length, nOut = actions.filter((a) => a.action === "exit" && a.status === "done").length, nProp = actions.filter((a) => a.status === "pending").length;
  const parts = [`Found ${cands.length} idea(s) good enough at '${PICKINESS[pick].label}' (${strictN} pass the scanner's strict rules)`];
  if (nIn || nOut) parts.push(`opened ${nIn}, closed ${nOut}`);
  if (nProp) parts.push(`${nProp} proposal(s) waiting for approval`);
  const sk = Object.entries(skipped).sort((a, b) => b[1] - a[1]);
  if (sk.length) parts.push(`skipped: ${sk.map(([k, v]) => `${v} ${k}`).join(", ")}`);
  if (!cands.length) parts.push(pick !== "strict" ? "nothing currently has a positive expected result after costs" : "the scanner has nothing that passes its rules right now");
  ap.last_summary = `${parts.join("; ")}.`;
  if (actions.length || ap.logged !== ap.last_summary) { apLog("info", ap.last_summary, null, null, null, null, "done", { skipped }); ap.logged = ap.last_summary; }
  return { actions, summary: ap.last_summary, skipped };
}

async function apStatus() {
  const cfg = apCfg(), [ok, why] = scheduleAllows(), snap = await account(), owned = ownedPositions(snap.positions);
  const realized = st.fills.reduce((s, f) => {
    const o = st.orders.find((x) => x.id === f.order_id), parent = o?.parent_id ? st.orders.find((x) => x.id === o.parent_id) : o;
    return s + (parent?.note.startsWith("autopilot") ? f.realized_pnl : 0);
  }, 0);
  return { enabled: cfg.enabled, mode: cfg.mode, schedule_ok: ok, schedule_note: why, paused_reason: ap.paused_reason, last_cycle: ap.last_cycle, last_summary: ap.last_summary, trades_today: tradesToday(), max_trades_per_day: cfg.max_trades_per_day,
    open_positions: owned.length, max_open_positions: cfg.max_open_positions, invested: owned.reduce((s, p) => s + Math.abs(p.market_value), 0), unrealized: owned.reduce((s, p) => s + p.unrealized, 0), realized, pending: lab.ap.filter((e) => e.status === "pending").length, positions: owned,
    model: modelInfo(), paper_trading_enabled: st.settings.paper.trading_enabled, pause_until: cfg.pause_until, stop_at: cfg.stop_at, now: iso(), practice_mode: practiceMode(), sandbox: st.settings.paper.sandbox, pickiness: cfg.pickiness, pickiness_options: PICKINESS,
    effective_min_score: effectiveMinScore(), next_cycle: null, universe: universe().length, settings: cfg };
}

/* --------------------------------------------------------------- practice replay */
const SPEEDS = [1, 10, 25, 50, 75, 100], MINUTES = 390, MIN_TRAIN_YEARS = 3;
const REPLAY_KEYS = ["cash", "startingCash", "realized", "peak", "dayStart", "dayDate", "halted", "positions", "orders", "fills", "transfers", "equity"] as const;
function etOpen(t: number) {
  const d = dayOf(t), guess = Date.parse(`${d}T13:30:00Z`);
  return new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }) === "9" ? guess : guess + 3_600_000;
}
function bridgePath(k: Candle, seed: number) {
  const n = MINUTES + 1, r = rng(seed), o = Math.log(k.open), c = Math.log(k.close), hi = Math.log(Math.max(k.high, k.open, k.close)), lo = Math.log(Math.min(k.low, k.open, k.close));
  const w = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) w[i] = w[i - 1] + normal(r);
  const dev = w.map((x, i) => x - (i / (n - 1)) * w[n - 1]), base = dev.map((_, i) => o + (i / (n - 1)) * (c - o));
  let ip = 1, il = 1;
  for (let i = 1; i < n - 1; i++) { if (dev[i] > dev[ip]) ip = i; if (dev[i] < dev[il]) il = i; }
  const a = dev[ip] > 1e-12 ? (hi - base[ip]) / dev[ip] : 0, b = dev[il] < -1e-12 ? (lo - base[il]) / dev[il] : 0;
  const out = dev.map((d, i) => Math.exp(Math.min(hi, Math.max(lo, base[i] + (d > 0 ? a * d : b * d)))));
  out[0] = k.open; out[n - 1] = k.close;
  return out;
}
const pathCache = new Map<string, number[]>();
function pathOf(symbol: string, k: Candle) {
  const key = `${symbol}:${k.time}`;
  let p = pathCache.get(key);
  if (!p) {
    if (pathCache.size > 4000) pathCache.clear();
    p = bridgePath(k, hash(key));
    pathCache.set(key, p);
  }
  return p;
}
const replayIdx = (c: Candle[]) => { const t = rp.days[rp.dayI]; let lo = 0, hi = c.length - 1, at = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m].time <= t) { at = m; lo = m + 1; } else hi = m - 1; } return at; };
function partialBar(symbol: string, k: Candle): Candle {
  const m = Math.floor(rp.minute), p = pathOf(symbol, k).slice(0, m + 1);
  return { ...k, high: Math.max(...p), low: Math.min(...p), close: p[p.length - 1], volume: Math.round(k.volume * (rp.minute / MINUTES)) };
}
function replayBars(symbol: string, tf: string): Candle[] {
  const c = rp.hist[symbol];
  if (!c) return [];
  const i = replayIdx(c);
  if (i < 0) return [];
  const live = c[i].time === rp.days[rp.dayI];
  if (tf === "1D") return live ? [...c.slice(0, i), partialBar(symbol, c[i])] : c.slice(0, i + 1);
  const step = ({ "1H": 60, "15Min": 15, "5Min": 5 } as Record<string, number>)[tf] ?? 60, out: Candle[] = [];
  for (const k of c.slice(Math.max(0, i - 5), i + 1)) {
    const p = pathOf(symbol, k), open = etOpen(k.time) / 1000, end = k === c[i] && live ? Math.floor(rp.minute) : MINUTES;
    for (let m = 0; m < end; m += step) {
      const part = p.slice(m, Math.min(m + step, end) + 1);
      out.push({ time: open + m * 60, open: part[0], high: Math.max(...part), low: Math.min(...part), close: part[part.length - 1], volume: Math.round((k.volume * step) / MINUTES) });
    }
  }
  return out;
}
function replayQuote(symbol: string): Quote | null {
  const c = rp.hist[symbol];
  if (!c) return null;
  const i = replayIdx(c);
  if (i < 0) return null;
  const k = c[i], live = k.time === rp.days[rp.dayI], b = live ? partialBar(symbol, k) : k, prev = c[i - 1]?.close ?? null, half = (b.close * 3) / 20_000;
  return { symbol, price: b.close, ts: iso(), status: "replay", source: "replay", prev_close: prev, open: b.open, high: b.high, low: b.low, volume: b.volume, bid: b.close - half, ask: b.close + half, session: "regular", venue_note: rp.label,
    change: prev ? b.close - prev : null, change_pct: prev ? (b.close / prev - 1) * 100 : null, spread_bps: 3 };
}

function replayBounds() {
  const days = rp.days.length ? rp.days : simBars("SPY", "1D").map((k) => k.time), first = days[0], lastDay = days[days.length - 1], y = 365.25 * 86400;
  const earliest = first + MIN_TRAIN_YEARS * y, latest = lastDay - 7 * 86400;
  return { earliest_start: dayOf(earliest), latest_start: dayOf(latest), default_start: dayOf(Math.max(earliest, lastDay - y)) };
}
async function replaySummary() {
  if (!rp.active) return rp.summary;
  const a = await account(), spy = rp.hist.SPY, q = replayQuote("SPY"), first = spy?.find((k) => k.time >= rp.days[rp.startI])?.open;
  return { equity: a.equity, profit: a.money.profit, return_pct: a.money.return_pct, trades: a.money.trades, win_rate_pct: a.money.win_rate_pct, spy_return_pct: q && first ? (q.price / first - 1) * 100 : null, days_replayed: rp.dayI - rp.startI, from: dayOf(rp.days[rp.startI]), to: dayOf(rp.days[rp.dayI]) };
}
function replayBrief() {
  const on = rp.active && rp.days.length;
  const t = on ? nowMs() : 0;
  return { active: rp.active, status: rp.status, speed: rp.speed, playing: rp.playing, sim_time_et: on ? `${new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/,/, "")}` : null,
    current_date: rp.days.length ? dayOf(rp.days[rp.dayI]) : null, progress: rp.progress, message: rp.message, simulated_history: rp.source === "simulation", source_label: rp.label, day_progress: +Math.min(1, rp.minute / MINUTES).toFixed(4) };
}
async function replayState() {
  const has = rp.days.length > 0;
  return { ...replayBrief(), speeds: SPEEDS, source: rp.source, start_cash: rp.startCash, start_date: has ? dayOf(rp.days[rp.startI]) : null, last_date: has ? dayOf(rp.days[rp.days.length - 1]) : null, sim_time: rp.active ? iso() : null,
    days_replayed: has ? rp.dayI - rp.startI : 0, days_left: has ? rp.days.length - 1 - rp.dayI : 0, real_seconds_per_day: +((MINUTES * 60) / rp.speed).toFixed(1), ...replayBounds(), summary: await replaySummary() };
}
async function replayPrepare(start: string | null, source: string) {
  try {
    if (source === "yahoo") throw new Error("Yahoo Finance blocks requests from websites. Choose Alpaca (free keys under Data providers) or simulated history.");
    if (source === "alpaca" && !useAlpaca()) throw new Error("Add your Alpaca keys under Data providers first, or choose simulated history.");
    const real = source === "alpaca" || (source === "auto" && useAlpaca());
    const syms = [...new Set([...universe(), ...Object.keys(INDEXES), ...Object.keys(SECTOR_ETFS)])], hist: Record<string, Candle[]> = {};
    for (const [i, s] of syms.entries()) {
      hist[s] = real ? await bars(s, "1D") : simBars(s, "1D");
      rp.progress = (0.8 * (i + 1)) / syms.length;
    }
    const days = hist.SPY.map((k) => k.time), y = 365.25 * 86400;
    if (days.length < 252 * (MIN_TRAIN_YEARS + 0.2)) throw new Error(`Only ${days.length} trading days of history were found; about ${MIN_TRAIN_YEARS} years are needed.`);
    const want = Math.min(Math.max(start ? Date.parse(start) / 1000 : days[days.length - 1] - y, days[0] + MIN_TRAIN_YEARS * y), days[days.length - 1] - 7 * 86400), si = days.findIndex((d) => d >= want);
    rp.saved = Object.fromEntries(REPLAY_KEYS.map((k) => [k, st[k]])) as unknown as Partial<State>;
    const now = new Date(etOpen(days[si]) ).toISOString();
    Object.assign(rp, { hist, days, source: real ? "alpaca" : "simulation", label: real ? "Real past prices (Alpaca, IEX)" : "Simulated history", startI: si, dayI: si, minute: 0, playing: true, trainedDay: si, apMark: st.nextId, active: true });
    Object.assign(st, { cash: rp.startCash, startingCash: rp.startCash, realized: 0, peak: rp.startCash, dayStart: rp.startCash, dayDate: now.slice(0, 10), halted: null, positions: {}, orders: [], fills: [], transfers: [], equity: [{ ts: now, equity: rp.startCash, cash: rp.startCash, drawdown: 0 }] });
    lab.scan = null; fcCache = null; snapshotCache = null;
    Object.assign(rp, { progress: 0.9, message: "Training the model on history before the start date (the clock waits for it)." });
    await startTraining();
    Object.assign(rp, { progress: 1, status: "training" });
  } catch (e) {
    Object.assign(rp, { status: "error", message: (e as Error).message, active: false });
  }
}
function replayAdvance(dt: number) {
  if (!rp.active) return;
  if (trainingId !== null) { if (rp.status !== "training") { rp.resume = rp.status; rp.status = "training"; rp.message = "Clock paused while the model trains on the history seen so far."; } return; }
  if (rp.status === "training") { rp.status = rp.resume === "paused" ? "paused" : rp.playing ? "playing" : "paused"; rp.message = ""; }
  if (!(rp.playing && rp.status === "playing")) return;
  rp.minute += (dt * rp.speed) / 60;
  while (rp.minute >= MINUTES) {
    if (rp.dayI >= rp.days.length - 1) { Object.assign(rp, { minute: MINUTES - 1e-3, playing: false, status: "ended", message: "Reached the end of the available history." }); return; }
    rp.minute = Math.min(rp.minute - MINUTES, MINUTES - 1);
    rp.dayI++;
  }
  if (rp.dayI - rp.trainedDay >= Math.max(1, Math.round((st.settings.model.retrain_days * 5) / 7))) { rp.trainedDay = rp.dayI; void startTraining(); }
}
async function replayStop() {
  if (trainingId !== null && rp.active) throw new ApiError(400, "The model for this practice session is still training. Try stopping again in a moment.");
  rp.summary = rp.active ? await replaySummary() : rp.summary;
  if (rp.saved) Object.assign(st, rp.saved);
  const ids = lab.models.filter((m) => m.source === "replay").map((m) => m.id);
  ids.forEach((id) => delete lab.arts[id]);
  lab.models = lab.models.filter((m) => m.source !== "replay");
  lab.predictions = lab.predictions.filter((p) => p.source !== "replay");
  lab.ap = lab.ap.filter((e) => e.id < rp.apMark);
  Object.assign(rp, { active: false, playing: false, status: "idle", message: "", saved: null, hist: {} });
  lab.scan = null; fcCache = null; snapshotCache = null;
  pathCache.clear();
  save(); saveLab();
  return replayState();
}

/* --------------------------------------------------------------- backtest and turbo jobs */
const BT_DEFAULTS = { strategy: "momentum", params: null, symbols: null, start: null, end: null, initial_capital: 100_000, risk_per_trade_pct: 0.75, max_position_pct: 15, max_positions: 10, stop_atr: 1.5, target_atr: 2, max_hold_days: 10, slippage_bps: 5, spread_bps: 3, commission_per_share: 0, allow_short: false, oos_fraction: 0.3 };
const btRow = (r: BtRun, full: boolean) => {
  const m = r.results?.metrics ?? {}, row: Obj = { id: r.id, name: r.name, created_at: r.created_at, status: r.status, source: r.source, config: r.config, progress: r.progress, error: r.error,
    summary: Object.fromEntries(["total_return_pct", "sharpe", "max_drawdown_pct", "trades", "win_rate_pct"].map((k) => [k, m[k] ?? null])), benchmark_return_pct: r.results?.benchmark?.total_return_pct ?? null };
  return full ? { ...row, results: r.results, equity: r.equity, trades: r.trades } : row;
};
async function startBacktest(body: Obj) {
  const { name, ...rest } = body, cfg = { ...BT_DEFAULTS, ...rest } as unknown as BtConfig;
  if (!STRATEGIES[cfg.strategy]) throw new ApiError(400, "unknown strategy");
  if (cfg.start && cfg.end && cfg.start >= cfg.end) throw new ApiError(400, "start must be before end");
  for (const d of [cfg.start, cfg.end]) if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new ApiError(400, "dates must be YYYY-MM-DD");
  if (cfg.symbols) cfg.symbols = cfg.symbols.map((s) => s.toUpperCase());
  const r: BtRun = { id: nextId(), name: name || STRATEGIES[cfg.strategy].name, created_at: iso(), status: "running", source: sourceName(), config: cfg as unknown as Obj, progress: 0, error: null, results: null, equity: [], trades: [] };
  lab.backtests.unshift(r);
  lab.backtests = lab.backtests.slice(0, 100);
  const fail = (m: string) => { Object.assign(r, { status: "failed", error: m }); saveLab(); };
  try {
    const u = await universeBars();
    startJob({ kind: "backtest", args: { cfg, bars: u.bars, spy: u.spy } }, { progress: (p) => { r.progress = +p.toFixed(3); }, done: (x) => { Object.assign(r, x as Obj, { status: "done", progress: 1 }); saveLab(); }, fail });
  } catch (e) { fail((e as Error).message); }
  return { id: r.id };
}
let turboStop: (() => void) | null = null, turboRunning: TurboRun | null = null;
const turboRow = (r: TurboRun, full: boolean) => {
  const res = r.result ?? {}, row: Obj = { id: r.id, created_at: r.created_at, status: r.status, progress: r.progress, error: r.error, config: r.config,
    summary: Object.fromEntries(["trades", "trades_per_minute_engine", "trades_per_minute_total", "median_return_pct", "pct_markets_profitable", "win_rate_pct", "markets_done", "wall_seconds"].map((k) => [k, res[k] ?? null])) };
  return full ? { ...row, result: res } : row;
};
async function startTurbo(body: Obj) {
  const cfg = { ...TURBO_DEFAULTS, ...body } as TurboConfig;
  if (!["monte_carlo", "history"].includes(cfg.mode)) throw new ApiError(400, "mode must be monte_carlo or history");
  if (!["ai", "momentum", "reversal", "random"].includes(cfg.strategy)) throw new ApiError(400, "strategy must be ai, momentum, reversal or random");
  if (cfg.markets * cfg.symbols * cfg.years > 400_000) throw new ApiError(400, "That run is too large for one go (markets × stocks × years must be under 400,000). Reduce one of them.");
  if (turboRunning) throw new ApiError(409, "A turbo simulation is already running");
  const r: TurboRun = { id: nextId(), created_at: iso(), status: "running", progress: 0, error: null, config: cfg, result: null };
  lab.turbo.unshift(r);
  lab.turbo = lab.turbo.slice(0, 50);
  turboRunning = r;
  const end = (patch: Partial<TurboRun>) => { Object.assign(r, patch); turboRunning = null; turboStop = null; saveLab(); };
  const hist = cfg.mode === "history" ? (await universeBars()).bars : null;
  turboStop = startJob({ kind: "turbo", args: { cfg, bars: hist } }, { progress: (p, _m, partial) => { r.progress = +p.toFixed(4); if (partial) r.result = partial as Obj; }, done: (x) => end({ status: "done", progress: 1, result: x as Obj }), fail: (m) => end({ status: "failed", error: m }) });
  return { id: r.id };
}

/* --------------------------------------------------------------- router */
type Ctx = { q: URLSearchParams; body: Record<string, unknown>; m: RegExpMatchArray };
type Handler = (c: Ctx) => unknown;

const crud = <T extends { id: number }>(list: () => T[], name: string) => ({
  find: (id: string) => {
    const row = list().find((x) => x.id === +id);
    if (!row) throw new ApiError(404, `${name} not found`);
    return row;
  },
});
const lists = crud(() => st.watchlists, "Watchlist"), rules = crud(() => st.alerts, "Alert"), dashes = crud(() => st.dashboards, "Dashboard");
const alertRow = (a: Rule) => ({ ...a, kind_label: (defaults.alert_kinds as Record<string, string>)[a.kind] ?? a.kind });
const num = (v: unknown) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new ApiError(400, "Enter a positive amount"); return n; };

const ROUTES: [string, RegExp, Handler][] = [
  ["GET", /^\/status$/, status],
  ["GET", /^\/health$/, () => {
    const k = status();
    return { time: iso(), version: "browser", data: { provider: { label: k.provider_label, quote_status: k.quote_status, rate_limit_per_min: 200 }, clock: k.clock, health: {} }, loops: {}, ws_clients: 0,
      db: { path: "This browser", size_bytes: null, rows: { model_runs: lab.models.length, backtests: lab.backtests.length, predictions: lab.predictions.length, paper_orders: st.orders.length } }, model: k.model && { run_id: k.model.run_id, champion: k.model.champion, passed: k.model.passed }, training: k.training,
      scanner: { running: scanning, last: lab.scan?.scanned_at ?? null, last_duration_s: lab.scan?.duration_s ?? null, errors: lab.scan?.errors ?? null }, versions: { engine: "browser" }, paths: { data_dir: "This browser's storage", env_file: "This browser's storage" }, log_tail: [] };
  }],
  ["GET", /^\/market\/overview$/, overview],
  ["GET", /^\/market\/snapshot$/, snapshot],
  ["GET", /^\/market\/quotes$/, ({ q }) => quotes((q.get("symbols") ?? "").split(",").filter(Boolean).map((s) => s.toUpperCase()))],
  ["GET", /^\/market\/search$/, ({ q }) => {
    const t = (q.get("q") ?? "").toLowerCase();
    const all = [...Object.keys(UNIVERSE), ...Object.keys(INDEXES), ...Object.keys(SECTOR_ETFS)];
    return all.filter((s) => s.toLowerCase().includes(t) || meta(s)[0].toLowerCase().includes(t)).sort()
      .slice(0, +(q.get("limit") ?? 20)).map((symbol) => ({ symbol, name: meta(symbol)[0], sector: meta(symbol)[1] }));
  }],
  ["GET", /^\/market\/bars\/([^/]+)$/, async ({ q, m }) => {
    const symbol = decodeURIComponent(m[1]).toUpperCase(), tf = q.get("tf") ?? "1D";
    const candles = await bars(symbol, tf);
    return { symbol, timeframe: tf, candles, indicators: indicators(candles, (q.get("indicators") ?? "").split(",").filter(Boolean)),
      meta: { status: useAlpaca() ? "live" : "simulated", source: st.settings.data.provider, issues: [], last_bar: candles.length ? new Date(candles[candles.length - 1].time * 1000).toISOString() : null, bars: candles.length } };
  }],
  ["GET", /^\/research\/([^/]+)$/, ({ m }) => research(decodeURIComponent(m[1]).toUpperCase())],
  ["POST", /^\/research\/([^/]+)\/narrative$/, async ({ m, q }) => { const r = await research(decodeURIComponent(m[1]).toUpperCase()); return { kind: "rules", label: "Rule-generated from the numbers above", text: narrative(r, q.get("direction") || r.lean) }; }],
  ["GET", /^\/scanner$/, () => ({ running: scanning, result: lab.scan, has_model: !!activeArt() })],
  ["POST", /^\/scanner\/run$/, () => { if (scanning) return { started: false, message: "A scan is already running" }; void runScan(); return { started: true }; }],

  ["GET", /^\/methods$/, () => METHODS],
  ["GET", /^\/models$/, () => ({ runs: lab.models.filter((r) => r.source === sourceName()).slice(0, 50).map((r) => runRow(r, false)), training: trainingId !== null, active: modelInfo(), provider: sourceName() })],
  ["POST", /^\/models\/train$/, async () => ({ id: await startTraining() })],
  ["GET", /^\/models\/(\d+)$/, ({ m }) => { const r = lab.models.find((x) => x.id === +m[1]); if (!r) throw new ApiError(404, "not found"); return runRow(r, true); }],
  ["POST", /^\/models\/(\d+)\/activate$/, ({ m }) => {
    const r = lab.models.find((x) => x.id === +m[1]);
    if (!r || r.status !== "done" || !lab.arts[r.id]) throw new ApiError(400, "Only recent completed runs can be activated");
    if (r.source !== sourceName()) throw new ApiError(400, `This model was trained on '${r.source}' data; the active provider is '${sourceName()}'.`);
    lab.models.forEach((x) => { x.active = x.id === r.id; });
    fcCache = null; saveLab();
    return { active: r.id };
  }],

  ["GET", /^\/strategies$/, () => Object.values(STRATEGIES).map((info) => {
    const cfg = (st.settings.strategies as Obj)[info.key] ?? {};
    return { ...info, enabled: cfg.enabled ?? true, params: { ...info.params, ...(cfg.params ?? {}) }, default_params: info.params };
  })],
  ["PUT", /^\/strategies\/([^/]+)$/, async ({ m, body }) => {
    const info = STRATEGIES[m[1]];
    if (!info) throw new ApiError(404, "unknown strategy");
    const patch: Obj = {};
    if (body.enabled != null) patch.enabled = body.enabled;
    if (body.params) {
      for (const [k, v] of Object.entries(body.params as Obj)) {
        if (!(k in info.params)) throw new ApiError(400, `unknown parameter: ${k}`);
        if (typeof v !== "number" || v < 0) throw new ApiError(400, `${k} must be a non-negative number`);
      }
      patch.params = body.params;
    }
    merge(st.settings.strategies, { [m[1]]: patch });
    save();
    return handle("GET", "/strategies");
  }],

  ["GET", /^\/backtests$/, () => lab.backtests.map((r) => btRow(r, false))],
  ["POST", /^\/backtests$/, ({ body }) => startBacktest(body)],
  ["GET", /^\/backtests\/(\d+)$/, ({ m }) => { const r = lab.backtests.find((x) => x.id === +m[1]); if (!r) throw new ApiError(404, "not found"); return btRow(r, true); }],
  ["DELETE", /^\/backtests\/(\d+)$/, ({ m }) => { lab.backtests = lab.backtests.filter((x) => x.id !== +m[1]); saveLab(); return { deleted: +m[1] }; }],

  ["GET", /^\/predictions\/calibration$/, () => {
    const rows = lab.predictions.filter((p) => p.resolved && p.source === sourceName());
    if (!rows.length) return { n: 0, bins: [], message: "No predictions have reached their horizon yet." };
    const y = rows.map((r) => +(r.hit === "target")), p = rows.map((r) => r.p_target_first), yu = rows.map((r) => +((r.realized_return ?? 0) > 0)), pu = rows.map((r) => r.p_up), bins = Math.min(10, Math.max(2, Math.floor(rows.length / 20)));
    const part = (yy: number[], pp: number[]) => { const rel = calibrationBins(yy, pp, bins); return { ece: rel.ece, bins: rel.bins, hit_rate: mean(yy), mean_prob: mean(pp) }; };
    return { n: rows.length, target_first: part(y, p), positive_return: part(yu, pu), brier_target_first: mean(p.map((v, i) => (v - y[i]) ** 2)) };
  }],
  ["GET", /^\/predictions$/, ({ q }) => {
    const sym = q.get("symbol")?.toUpperCase(), res = q.get("resolved"), rows = lab.predictions.filter((p) => p.source === sourceName());
    return { total: rows.length, items: rows.filter((p) => (!sym || p.symbol === sym) && (res === null || p.resolved === (res === "true"))).sort((a, b) => b.asof.localeCompare(a.asof) || a.symbol.localeCompare(b.symbol)).slice(0, +(q.get("limit") ?? 300)) };
  }],

  ["GET", /^\/autopilot$/, apStatus],
  ["POST", /^\/autopilot\/enable$/, ({ body }) => {
    merge(apCfg(), { enabled: !!body.enabled, ...(body.enabled ? {} : { pause_until: null }) });
    save();
    apLog("info", body.enabled ? "Autopilot switched on." : "Autopilot switched off.");
    return apStatus();
  }],
  ["POST", /^\/autopilot\/pause$/, ({ body }) => {
    const until = body.clear ? null : body.minutes ? new Date(nowMs() + Number(body.minutes) * 60_000).toISOString() : (body.until as string | undefined) ?? null;
    apCfg().pause_until = until;
    save();
    apLog("info", until ? "Paused by you." : "Pause cleared: the autopilot is active again.");
    return apStatus();
  }],
  ["POST", /^\/autopilot\/stop-at$/, ({ body }) => { apCfg().stop_at = body.at ?? null; save(); return apStatus(); }],
  ["PATCH", /^\/autopilot\/settings$/, ({ body }) => { merge(apCfg(), body); save(); return apStatus(); }],
  ["POST", /^\/autopilot\/run$/, async () => { await runScan(); return apCycle(true); }],
  ["GET", /^\/autopilot\/events$/, ({ q }) => {
    const kind = q.get("kind"), rows = lab.ap.filter((e) => (kind === "trades" ? e.kind === "buy" || e.kind === "sell" : kind === "pending" ? e.status === "pending" : true));
    return rows.slice(-(+(q.get("limit") ?? 200))).reverse();
  }],
  ["POST", /^\/autopilot\/proposals\/(\d+)$/, async ({ m, q }) => {
    const e = lab.ap.find((x) => x.id === +m[1]);
    if (!e || e.status !== "pending") throw new ApiError(400, "This proposal is no longer pending.");
    if (q.get("approve") !== "true") { e.status = "rejected"; saveLab(); return { status: "rejected" }; }
    e.status = "approved";
    return apExecute(e.payload.side, e.symbol!, e.qty!, e.price!, `Approved by you. ${e.reason}`, e.payload);
  }],

  ["GET", /^\/turbo\/defaults$/, () => TURBO_DEFAULTS],
  ["POST", /^\/turbo\/run$/, ({ body }) => startTurbo(body)],
  ["POST", /^\/turbo\/cancel$/, () => { if (turboRunning) { turboStop?.(); Object.assign(turboRunning, { status: "cancelled", progress: 1 }); turboRunning = null; turboStop = null; saveLab(); } return { cancelling: true }; }],
  ["GET", /^\/turbo\/runs$/, () => ({ running: !!turboRunning, runs: lab.turbo.map((r) => turboRow(r, false)) })],
  ["GET", /^\/turbo\/runs\/(\d+)$/, ({ m }) => { const r = lab.turbo.find((x) => x.id === +m[1]); if (!r) throw new ApiError(404, "not found"); return turboRow(r, true); }],
  ["DELETE", /^\/turbo\/runs\/(\d+)$/, ({ m }) => { lab.turbo = lab.turbo.filter((x) => x.id !== +m[1]); saveLab(); return { deleted: +m[1] }; }],

  ["GET", /^\/replay$/, replayState],
  ["POST", /^\/replay\/start$/, async ({ body }) => {
    if (!st.settings.paper.sandbox) throw new ApiError(400, "Practice trading uses play money, so it needs Sandbox mode. Turn Sandbox mode on first.");
    const speed = Number(body.speed ?? 10);
    if (!SPEEDS.includes(speed)) throw new ApiError(400, `Speed must be one of ${SPEEDS.map((x) => `${x}x`).join(", ")}.`);
    if (trainingId !== null) throw new ApiError(400, "A model is training right now. Try again when it finishes.");
    if (rp.status === "loading") throw new ApiError(400, "A practice session is already being prepared.");
    if (rp.active) await replayStop();
    Object.assign(rp, { status: "loading", progress: 0, message: "Loading price history", speed, startCash: Number(body.starting_cash ?? 100_000), summary: null });
    void replayPrepare((body.start_date as string) ?? null, String(body.source ?? "auto"));
    return replayState();
  }],
  ["POST", /^\/replay\/speed$/, ({ body }) => { if (!SPEEDS.includes(Number(body.speed))) throw new ApiError(400, "Unknown speed"); rp.speed = Number(body.speed); return replayState(); }],
  ["POST", /^\/replay\/play$/, () => {
    if (!rp.active) throw new ApiError(400, "No practice session is running.");
    if (rp.status === "ended") throw new ApiError(400, "This practice session reached the end of the available history. Start a new one.");
    rp.playing = true;
    if (rp.status === "paused") rp.status = "playing"; else rp.resume = "playing";
    return replayState();
  }],
  ["POST", /^\/replay\/pause$/, () => { rp.playing = false; if (rp.status === "playing") rp.status = "paused"; else rp.resume = "paused"; return replayState(); }],
  ["POST", /^\/replay\/stop$/, replayStop],
  ["GET", /^\/news$/, ({ q }) => {
    const sym = q.get("symbol")?.toUpperCase(), sent = q.get("sentiment");
    const days = +(q.get("days") ?? 7);
    if (noNews()) return [];
    return simNews(days, sym ? [sym] : universe()).filter((n) => !sent || (sent === "positive" ? n.sentiment > 0 : sent === "negative" ? n.sentiment < 0 : n.sentiment === 0)).slice(0, +(q.get("limit") ?? 50));
  }],
  ["GET", /^\/news\/summary$/, ({ q }) => {
    const map = new Map<string, { symbol: string; articles: number; total: number; positive: number; negative: number; latest: string }>();
    for (const n of noNews() ? [] : simNews(+(q.get("days") ?? 7), universe())) {
      const s = map.get(n.symbols[0]) ?? { symbol: n.symbols[0], articles: 0, total: 0, positive: 0, negative: 0, latest: n.ts };
      s.articles++; s.total += n.sentiment; s.positive += +(n.sentiment > 0); s.negative += +(n.sentiment < 0);
      map.set(s.symbol, s);
    }
    return [...map.values()].map(({ total, ...s }) => ({ ...s, avg_sentiment: total / s.articles }));
  }],
  ["POST", /^\/news\/refresh$/, () => ({ new: 0 })],

  ["GET", /^\/paper\/account$/, account],
  ["POST", /^\/paper\/preview$/, ({ body }) => preview(body as unknown as OrderIn)],
  ["POST", /^\/paper\/orders$/, ({ body }) => submit(body as unknown as OrderIn)],
  ["DELETE", /^\/paper\/orders\/(\d+)$/, ({ m }) => {
    const o = st.orders.find((x) => x.id === +m[1] && x.status === "open");
    if (!o) throw new ApiError(400, "That order is no longer open");
    o.status = "cancelled"; save();
    return { cancelled: o.id };
  }],
  ["POST", /^\/paper\/positions\/([^/]+)\/close$/, ({ m }) => closePosition(decodeURIComponent(m[1]).toUpperCase())],
  ["POST", /^\/paper\/kill$/, async ({ q }) => {
    st.orders.forEach((o) => { if (o.status === "open") o.status = "cancelled"; });
    if (q.get("flatten") === "true") for (const s of Object.keys(st.positions)) await handle("POST", `/paper/positions/${s}/close`, {});
    save();
    return { ok: true };
  }],
  ["POST", /^\/paper\/(enable|trading)$/, ({ body }) => { st.settings.paper.trading_enabled = !!body.enabled; save(); return { enabled: !!body.enabled }; }],
  ["POST", /^\/paper\/clear-halt$/, () => { st.halted = null; save(); return { ok: true }; }],
  ["GET", /^\/paper\/activity$/, async ({ q }) => {
    const limit = +(q.get("limit") ?? 50);
    const working = st.orders.filter((o) => o.status === "open").map((o) => ({ ...o, owner: o.source, trigger: o.limit_price ?? o.stop_price }));
    return { account: ACCOUNT_LABEL, fills: st.fills.slice(-limit).reverse().map(fillView), working, trading_enabled: st.settings.paper.trading_enabled };
  }],
  ["POST", /^\/paper\/deposit$/, ({ body }) => {
    if (!st.settings.paper.sandbox) throw new ApiError(400, "Deposits need Sandbox mode.");
    const amount = num(body.amount);
    st.cash += amount; st.transfers.unshift({ id: nextId(), ts: iso(), kind: "deposit", amount, note: "" }); save();
    return { cash: st.cash };
  }],
  ["POST", /^\/paper\/withdraw$/, ({ body }) => {
    const amount = num(body.amount);
    if (amount > st.cash - reserved()) throw new ApiError(400, "That is more than your available cash.");
    st.cash -= amount; st.transfers.unshift({ id: nextId(), ts: iso(), kind: "withdrawal", amount, note: "" }); save();
    return { cash: st.cash };
  }],
  ["GET", /^\/paper\/transfers$/, () => st.transfers],
  ["POST", /^\/paper\/sandbox$/, ({ body }) => { st.settings.paper.sandbox = !!body.enabled; save(); return { enabled: !!body.enabled }; }],
  ["POST", /^\/paper\/reset$/, ({ body }) => {
    const f = fresh();
    const cash = Number(body.starting_cash) > 0 ? Number(body.starting_cash) : st.startingCash;
    Object.assign(st, { cash, startingCash: cash, realized: 0, peak: cash, dayStart: cash, halted: null, positions: {}, orders: [], fills: [], transfers: [], equity: [{ ...f.equity[0], equity: cash, cash }] });
    save();
    return { ok: true };
  }],
  ["GET", /^\/portfolio\/analytics$/, analytics],

  ["GET", /^\/watchlists$/, () => st.watchlists],
  ["POST", /^\/watchlists$/, ({ body }) => { const w = { id: nextId(), name: String(body.name), symbols: (body.symbols as string[]) ?? [] }; st.watchlists.push(w); save(); return w; }],
  ["PUT", /^\/watchlists\/(\d+)$/, ({ m, body }) => { const w = lists.find(m[1]); Object.assign(w, { name: body.name, symbols: body.symbols }); save(); return w; }],
  ["DELETE", /^\/watchlists\/(\d+)$/, ({ m }) => { st.watchlists = st.watchlists.filter((x) => x.id !== +m[1]); save(); return { deleted: +m[1] }; }],

  ["GET", /^\/alerts$/, () => ({ kinds: Object.fromEntries(Object.entries(defaults.alert_kinds).filter(([k]) => k.startsWith("price") || k === "pct_change")), alerts: st.alerts.map(alertRow) })],
  ["POST", /^\/alerts$/, ({ body }) => { const a: Rule = { ...(body as unknown as Rule), enabled: body.enabled !== false, cooldown_minutes: Number(body.cooldown_minutes ?? 60), id: nextId(), last_fired_at: null, symbol: body.symbol ? String(body.symbol).toUpperCase() : null }; st.alerts.push(a); save(); return alertRow(a); }],
  ["PUT", /^\/alerts\/(\d+)$/, ({ m, body }) => { const a = rules.find(m[1]); Object.assign(a, body, { id: a.id }); save(); return alertRow(a); }],
  ["DELETE", /^\/alerts\/(\d+)$/, ({ m }) => { st.alerts = st.alerts.filter((x) => x.id !== +m[1]); save(); return { deleted: +m[1] }; }],
  ["GET", /^\/alerts\/events$/, ({ q }) => ({ unread: st.events.filter((e) => !e.read).length, events: st.events.slice(-(+(q.get("limit") ?? 100))).reverse() })],
  ["POST", /^\/alerts\/events\/read$/, () => { st.events.forEach((e) => { e.read = true; }); save(); return { ok: true }; }],

  ["GET", /^\/dashboards$/, () => ({ widgets: defaults.widgets, default_layout: defaults.default_layout, dashboards: st.dashboards })],
  ["POST", /^\/dashboards$/, ({ body }) => { const d: Dash = { id: nextId(), name: String(body.name ?? "New dashboard"), layout: (body.layout as unknown[]) ?? defaults.default_layout, is_default: false, updated_at: iso() }; st.dashboards.push(d); save(); return d; }],
  ["PUT", /^\/dashboards\/(\d+)$/, ({ m, body }) => { const d = dashes.find(m[1]); Object.assign(d, { name: body.name, layout: body.layout, updated_at: iso() }); save(); return d; }],
  ["POST", /^\/dashboards\/(\d+)\/duplicate$/, ({ m }) => { const d = dashes.find(m[1]); const c = { ...structuredClone(d), id: nextId(), name: `${d.name} copy`, is_default: false }; st.dashboards.push(c); save(); return c; }],
  ["POST", /^\/dashboards\/(\d+)\/default$/, ({ m }) => { st.dashboards.forEach((d) => { d.is_default = d.id === +m[1]; }); save(); return { ok: true }; }],
  ["POST", /^\/dashboards\/(\d+)\/restore$/, ({ m }) => { const d = dashes.find(m[1]); d.layout = defaults.default_layout; save(); return d; }],
  ["DELETE", /^\/dashboards\/(\d+)$/, ({ m }) => { st.dashboards = st.dashboards.filter((x) => x.id !== +m[1]); save(); return { deleted: +m[1] }; }],

  ["GET", /^\/themes$/, () => st.themes],
  ["POST", /^\/themes$/, ({ body }) => { const t = { ...body, id: nextId() }; st.themes.push(t); save(); return t; }],
  ["PUT", /^\/themes\/(\d+)$/, ({ m, body }) => { st.themes = st.themes.map((t) => (t.id === +m[1] ? { ...body, id: +m[1] } : t)); save(); return { ...body, id: +m[1] }; }],
  ["DELETE", /^\/themes\/(\d+)$/, ({ m }) => { st.themes = st.themes.filter((t) => t.id !== +m[1]); save(); return { deleted: +m[1] }; }],

  ["GET", /^\/settings$/, () => ({ settings: st.settings, defaults: defaults.settings })],
  ["PATCH", /^\/settings$/, ({ body }) => { merge(st.settings, body); barCache.clear(); snapshotCache = null; save(); return { settings: st.settings }; }],
  ["POST", /^\/settings\/reset$/, ({ q }) => {
    const section = q.get("section") as keyof State["settings"] | null;
    if (section) (st.settings as Record<string, unknown>)[section] = structuredClone(defaults.settings[section]);
    else st.settings = structuredClone(defaults.settings);
    save();
    return { settings: st.settings };
  }],
  ["GET", /^\/providers$/, () => ({
    active: st.settings.data.provider, effective: useAlpaca() ? "alpaca" : "simulation", providers: defaults.providers.filter((p) => p.name !== "yahoo"), alpaca_feed: "iex",
    keys: { ALPACA_API_KEY_ID: { set: !!st.keys, masked: st.keys ? `${st.keys.id.slice(0, 3)}…${st.keys.id.slice(-2)}` : null }, ALPACA_API_SECRET_KEY: { set: !!st.keys, masked: st.keys ? "stored in this browser" : null }, ANTHROPIC_API_KEY: { set: false, masked: null } },
    status: { provider: { label: status().provider_label, quote_status: status().quote_status }, health: {} },
  })],
  ["PUT", /^\/providers\/keys$/, ({ body }) => {
    const id = String(body.ALPACA_API_KEY_ID ?? "").trim(), secret = String(body.ALPACA_API_SECRET_KEY ?? "").trim();
    st.keys = id && secret ? { id, secret } : null;
    save();
    return { ok: true };
  }],
  ["POST", /^\/providers\/test$/, async ({ q }) => {
    if (q.get("name") !== "alpaca") return { ok: true, message: "Simulation is always available." };
    if (!st.keys) return { ok: false, message: "Add your Alpaca keys first." };
    try {
      const snap = await alpaca<Record<string, { latestTrade?: { p: number } }>>("/snapshots?symbols=SPY&feed=iex");
      return { ok: true, message: `SPY ${snap.SPY?.latestTrade?.p ?? "unavailable"}` };
    } catch (e) { return { ok: false, message: (e as Error).message }; }
  }],
];

export async function handle(method: string, path: string, body?: unknown): Promise<unknown> {
  await labReady;
  const [route, query] = path.split("?");
  for (const [verb, re, fn] of ROUTES) {
    if (verb !== method) continue;
    const m = route.match(re);
    if (m) return structuredClone(await fn({ q: new URLSearchParams(query), body: (body ?? {}) as Record<string, unknown>, m }));
  }
  throw new ApiError(404, `Not available in the browser engine: ${route}`);
}

let timer = 0;
let lastEquity = 0;
async function tick() {
  try {
    const held = Object.keys(st.positions);
    const pending = st.orders.filter((o) => o.status === "open").map((o) => o.symbol);
    const watched = st.watchlists.flatMap((w) => w.symbols);
    const alerted = st.alerts.flatMap((a) => (a.symbol ? [a.symbol] : []));
    const qs = await quotes([...Object.keys(INDEXES), ...universe(), ...held, ...pending, ...watched, ...alerted]);
    publish("quotes", qs);
    processTick(qs);
    const today = iso().slice(0, 10);
    const mv = Object.entries(st.positions).reduce((s, [sym, p]) => s + p.qty * (qs[sym]?.price ?? p.avg), 0);
    const equity = st.cash + mv;
    if (st.dayDate !== today) Object.assign(st, { dayDate: today, dayStart: equity });
    if (equity > st.peak) st.peak = equity;
    if (Date.now() - lastEquity > 60_000) {
      lastEquity = Date.now();
      st.equity.push({ ts: iso(), equity, cash: st.cash, drawdown: st.peak ? equity / st.peak - 1 : 0 });
      st.equity = st.equity.slice(-2000);
      save();
    }
  } catch (e) {
    console.warn("Lodestar browser engine tick failed", e);
  }
}

/** Starts the quote loop. Slower with real data, to stay inside Alpaca's free rate limit. */
export function start() {
  if (timer) return;
  void tick();
  // first visit: train a model in the background so the AI screens have something to show
  void labReady.then(() => setTimeout(() => { if (!lab.models.some((m) => m.source === sourceName()) && trainingId === null) void startTraining(); }, 3000));
  let beats = 0, busy = false;
  timer = window.setInterval(async () => {
    replayAdvance(1);
    const period = rp.active ? 1 : useAlpaca() ? 10 : 3;
    if (document.hidden || busy || ++beats % period) return;
    busy = true;
    await tick();
    await background().catch((e) => console.warn("Lodestar background job failed", e));
    busy = false;
  }, 1000);
}

let lastCycle = 0;
/** Scans on schedule once a model exists, and runs the autopilot. Both stop when this tab closes. */
async function background() {
  if (activeArt() && trainingId === null && nowMs() - (lab.scan ? Date.parse(lab.scan.scanned_at) : 0) > st.settings.scanner.interval_minutes * 60_000) await runScan();
  if (apCfg().enabled && Date.now() - lastCycle > apCfg().interval_seconds * 1000) { lastCycle = Date.now(); await apCycle(false); }
}
