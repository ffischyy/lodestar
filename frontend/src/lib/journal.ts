import type { Fill, Order } from "../api/types";

/** One round trip: from flat, through any scale-ins and scale-outs, back to flat. */
export interface Trade {
  id: number; symbol: string; side: "long" | "short"; opened: string; closed: string | null; qty: number; entry: number; exit: number | null;
  pnl: number; fees: number; returnPct: number | null; holdHours: number | null; source: string; stop: number | null; r: number | null;
}

export interface JournalNote { setup?: string; notes?: string; grade?: string }
const KEY = "lodestar.journal.v1";

// shortcut: notes live in this browser only, export them from the Journal page. Move to the engine database if they need to sync across devices.
export function loadNotes(): Record<number, JournalNote> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; }
}
export function saveNotes(n: Record<number, JournalNote>) {
  try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* storage full or blocked; the edit stays for this visit */ }
}

/** Pairs fills into round trips. A fill that crosses zero closes the trade and opens a new one with the remainder. */
export function buildTrades(fills: Fill[], orders: Pick<Order, "id" | "bracket_stop">[] = []): Trade[] {
  const stopOf = new Map(orders.map((o) => [o.id, o.bracket_stop]));
  const sorted = [...fills].sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id);
  const open = new Map<string, Trade & { pos: number; cost: number; exitValue: number; exitQty: number }>();
  const done: Trade[] = [];

  const start = (f: Fill, signed: number) => {
    open.set(f.symbol, {
      id: f.id, symbol: f.symbol, side: signed > 0 ? "long" : "short", opened: f.ts, closed: null, qty: Math.abs(signed), entry: f.price, exit: null, pnl: 0, fees: 0,
      returnPct: null, holdHours: null, source: f.source ?? "you", stop: stopOf.get(f.order_id) ?? null, r: null, pos: signed, cost: Math.abs(signed) * f.price, exitValue: 0, exitQty: 0,
    });
  };

  for (const f of sorted) {
    const signed = f.side === "buy" ? f.qty : -f.qty;
    const t = open.get(f.symbol);
    if (!t) { start(f, signed); open.get(f.symbol)!.fees += f.commission; continue; }
    t.fees += f.commission;
    if (Math.sign(signed) === Math.sign(t.pos)) {
      t.pos += signed;
      t.qty += f.qty;
      t.cost += f.qty * f.price;
      t.entry = t.cost / t.qty;
      continue;
    }
    const closing = Math.min(f.qty, Math.abs(t.pos));
    t.exitValue += closing * f.price;
    t.exitQty += closing;
    t.pnl += f.realized_pnl;
    t.pos += Math.sign(signed) * closing;
    if (t.pos !== 0) continue;
    const { pos: _p, cost: _c, exitValue, exitQty, ...trade } = t;
    trade.closed = f.ts;
    trade.exit = exitValue / exitQty;
    trade.returnPct = ((trade.exit / trade.entry - 1) * 100) * (trade.side === "long" ? 1 : -1);
    trade.holdHours = (Date.parse(f.ts) - Date.parse(trade.opened)) / 3_600_000;
    if (trade.stop && trade.entry !== trade.stop) trade.r = trade.pnl / (Math.abs(trade.entry - trade.stop) * trade.qty);
    done.push(trade);
    open.delete(f.symbol);
    const remainder = f.qty - closing;
    if (remainder > 0) start(f, Math.sign(signed) * remainder);
  }
  return [...done.reverse(), ...[...open.values()].map(({ pos: _p, cost: _c, exitValue: _e, exitQty: _q, ...t }) => t)];
}

export function tradeStats(trades: Trade[]) {
  const closed = trades.filter((t) => t.closed);
  const wins = closed.filter((t) => t.pnl > 0), losses = closed.filter((t) => t.pnl <= 0);
  const sum = (x: Trade[]) => x.reduce((s, t) => s + t.pnl, 0);
  const withR = closed.filter((t) => t.r !== null);
  let streak = 0, worstStreak = 0;
  for (const t of [...closed].reverse()) {
    streak = t.pnl <= 0 ? streak + 1 : 0;
    worstStreak = Math.max(worstStreak, streak);
  }
  return {
    count: closed.length, net: sum(closed), winRate: closed.length ? wins.length / closed.length : null, avgWin: wins.length ? sum(wins) / wins.length : null, avgLoss: losses.length ? sum(losses) / losses.length : null,
    profitFactor: losses.length && sum(losses) !== 0 ? sum(wins) / Math.abs(sum(losses)) : null, expectancy: closed.length ? sum(closed) / closed.length : null,
    avgR: withR.length ? withR.reduce((s, t) => s + t.r!, 0) / withR.length : null, best: closed.length ? Math.max(...closed.map((t) => t.pnl)) : null, worst: closed.length ? Math.min(...closed.map((t) => t.pnl)) : null, worstStreak,
  };
}

export function byKey(trades: Trade[], key: (t: Trade) => string) {
  const m = new Map<string, Trade[]>();
  for (const t of trades) if (t.closed) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
  return [...m.entries()].map(([label, rows]) => ({ label, ...tradeStats(rows) })).sort((a, b) => b.net - a.net);
}

/** Net P&L per local calendar day of closing, keyed YYYY-MM-DD. */
export function dailyPnl(trades: Trade[]) {
  const m: Record<string, number> = {};
  for (const t of trades) if (t.closed) { const d = new Date(t.closed).toLocaleDateString("en-CA"); m[d] = (m[d] ?? 0) + t.pnl; }
  return m;
}
