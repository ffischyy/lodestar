import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Fill } from "../api/types";
import { marketEvents } from "../lib/calendar";
import { toCsv } from "../lib/csv";
import { buildTrades, dailyPnl, tradeStats } from "../lib/journal";
import { treemap } from "../lib/treemap";
import { indicators, rsi, simBars, simQuote, sma } from "../engine/market";

const fill = (id: number, side: string, qty: number, price: number, realized = 0, symbol = "AAPL", ts = `2026-10-${String(id).padStart(2, "0")}T15:00:00Z`): Fill =>
  ({ id, order_id: id, ts, symbol, side, qty, price, commission: 0, realized_pnl: realized, source: "you" });

describe("journal", () => {
  it("pairs fills into a round trip with scale-in and R", () => {
    const fills = [fill(1, "buy", 10, 100), fill(2, "buy", 10, 110), fill(3, "sell", 20, 120, 300)];
    const [t] = buildTrades(fills, [{ id: 1, bracket_stop: 95 }]);
    expect(t).toMatchObject({ side: "long", qty: 20, entry: 105, exit: 120, pnl: 300 });
    expect(t.r).toBeCloseTo(300 / (10 * 20));
    expect(t.returnPct).toBeCloseTo((120 / 105 - 1) * 100);
  });
  it("keeps an unclosed position as an open trade", () => {
    const [t] = buildTrades([fill(1, "buy", 10, 100), fill(2, "sell", 4, 110, 40)]);
    expect(t.closed).toBeNull();
    expect(t.pnl).toBe(40);
  });
  it("a fill through zero closes the trade and opens the reverse", () => {
    const trades = buildTrades([fill(1, "buy", 10, 100), fill(2, "sell", 15, 110, 100)]);
    expect(trades.map((t) => [t.side, t.qty, t.closed !== null])).toEqual([["long", 10, true], ["short", 5, false]]);
  });
  it("computes win rate, profit factor and expectancy", () => {
    const trades = buildTrades([
      fill(1, "buy", 1, 100), fill(2, "sell", 1, 130, 30), fill(3, "buy", 1, 100), fill(4, "sell", 1, 90, -10),
      fill(5, "buy", 1, 100), fill(6, "sell", 1, 95, -5),
    ]);
    const s = tradeStats(trades);
    expect(s).toMatchObject({ count: 3, net: 15, expectancy: 5, profitFactor: 2, worstStreak: 2 });
    expect(s.winRate).toBeCloseTo(1 / 3);
    expect(dailyPnl(trades)).toEqual({ "2026-10-02": 30, "2026-10-04": -10, "2026-10-06": -5 });
  });
});

describe("treemap", () => {
  it("covers the box exactly, with areas proportional to value and no overlap", () => {
    const items = [40, 25, 15, 10, 6, 3, 1];
    const box = { x: 0, y: 0, w: 900, h: 500 };
    const tiles = treemap(items, (v) => v, box);
    expect(tiles).toHaveLength(items.length);
    const area = tiles.reduce((s, t) => s + t.w * t.h, 0);
    expect(area).toBeCloseTo(box.w * box.h, 3);
    for (const t of tiles) {
      expect((t.w * t.h) / (box.w * box.h)).toBeCloseTo(t.item / 100, 3);
      expect(t.x + t.w).toBeLessThanOrEqual(box.w + 1e-6);
      expect(t.y + t.h).toBeLessThanOrEqual(box.h + 1e-6);
    }
    for (const a of tiles) for (const b of tiles) if (a !== b) {
      const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;
      expect(overlap).toBe(false);
    }
  });
  it("returns nothing for an empty box or zero values", () => {
    expect(treemap([0, 0], (v) => v, { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
    expect(treemap([1], (v) => v, { x: 0, y: 0, w: 0, h: 10 })).toEqual([]);
  });
});

describe("csv", () => {
  it("quotes separators and defuses spreadsheet formulas", () => {
    expect(toCsv([{ a: 'x,"y"', b: "=HYPERLINK(1)", c: -2, d: null }])).toBe('a,b,c,d\n"x,""y""",\'=HYPERLINK(1),-2,');
  });
});

describe("calendar", () => {
  it("finds the third Friday and listed holidays", () => {
    const e = marketEvents("2026-11-01", "2026-11-30");
    expect(e.find((x) => x.kind === "options")?.date).toBe("2026-11-20");
    expect(e.find((x) => x.kind === "holiday")?.date).toBe("2026-11-26");
    expect(e.map((x) => x.date)).toEqual([...e.map((x) => x.date)].sort());
  });
});

describe("simulated market", () => {
  it("is deterministic and internally consistent", () => {
    const a = simBars("AAPL", "1D"), b = simBars("AAPL", "1D");
    expect(a.length).toBeGreaterThan(1000);
    expect(a.slice(0, -1)).toEqual(b.slice(0, -1));
    for (const k of a) {
      expect(k.high).toBeGreaterThanOrEqual(Math.max(k.open, k.close) - 1e-3);
      expect(k.low).toBeLessThanOrEqual(Math.min(k.open, k.close) + 1e-3);
    }
    const q = simQuote("AAPL");
    expect(q.bid!).toBeLessThan(q.ask!);
    expect(q.status).toBe("simulated");
  });
  it("builds intraday bars in time order", () => {
    const m5 = simBars("MSFT", "5Min");
    expect(m5.length).toBeGreaterThan(100);
    for (let i = 1; i < m5.length; i++) expect(m5[i].time).toBeGreaterThan(m5[i - 1].time);
  });
  it("indicators match hand-worked values", () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
    expect(rsi([1, 2, 3, 4, 5], 3).at(-1)).toBe(100);
    const out = indicators(simBars("SPY", "1D"), ["macd", "bb", "vwap20"]);
    expect(Object.keys(out)).toEqual(["macd", "bb", "vwap20"]);
  });
});

describe("browser engine paper broker", () => {
  beforeEach(() => { vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined }); vi.resetModules(); });

  const engine = async () => {
    const live = await import("../api/live");
    const events: string[] = [];
    live.onLive((t) => events.push(t));
    return { ...(await import("../engine")), events };
  };

  it("fills a market order, creates a bracket, and closes at a profit or loss", async () => {
    const { handle, events } = await engine();
    const o = await handle("POST", "/paper/orders", { symbol: "AAPL", side: "buy", qty: 10, type: "market", stop_loss: 1, take_profit: 100000 }) as { status: string; filled_price: number };
    expect(o.status).toBe("filled");
    expect(events).toContain("paper_fill");
    let a = await handle("GET", "/paper/account") as { positions: { symbol: string; qty: number }[]; orders: { status: string; source: string }[]; cash: number };
    expect(a.positions).toMatchObject([{ symbol: "AAPL", qty: 10 }]);
    expect(a.orders.filter((x) => x.status === "open").map((x) => x.source).sort()).toEqual(["stop-loss", "take-profit"]);
    expect(a.cash).toBeCloseTo(100_000 - 10 * o.filled_price, 2);
    await handle("POST", "/paper/positions/AAPL/close");
    a = await handle("GET", "/paper/account") as typeof a;
    expect(a.positions).toEqual([]);
    expect(a.orders.filter((x) => x.status === "open")).toEqual([]);
  });

  it("rejects orders it cannot honour", async () => {
    const { handle } = await engine();
    await expect(handle("POST", "/paper/orders", { symbol: "AAPL", side: "buy", qty: 1e7 })).rejects.toMatchObject({ violations: [expect.stringMatching(/buying power/)] });
    await expect(handle("POST", "/paper/orders", { symbol: "AAPL", side: "sell", qty: 1 })).rejects.toMatchObject({ violations: [expect.stringMatching(/Short selling/)] });
    await handle("POST", "/paper/trading", { enabled: false });
    await expect(handle("POST", "/paper/orders", { symbol: "AAPL", side: "buy", qty: 1 })).rejects.toMatchObject({ violations: [expect.stringMatching(/switched off/)] });
  });

  it("the same client order id does not double-fill", async () => {
    const { handle } = await engine();
    await handle("POST", "/paper/orders", { symbol: "KO", side: "buy", qty: 5, client_order_id: "x1" });
    await handle("POST", "/paper/orders", { symbol: "KO", side: "buy", qty: 5, client_order_id: "x1" });
    const a = await handle("GET", "/paper/account") as { positions: { qty: number }[] };
    expect(a.positions[0].qty).toBe(5);
  });

  it("answers what the app asks for", async () => {
    const { handle } = await engine();
    for (const p of ["/status", "/market/overview", "/market/snapshot", "/research/AAPL", "/news?limit=5", "/portfolio/analytics", "/dashboards", "/settings", "/providers", "/alerts", "/watchlists", "/scanner", "/market/bars/SPY?tf=1H&indicators=ema9", "/methods", "/models", "/strategies", "/backtests", "/predictions", "/predictions/calibration", "/autopilot", "/turbo/defaults", "/turbo/runs", "/replay"]) {
      await expect(handle("GET", p), p).resolves.toBeTruthy();
    }
    expect(((await handle("GET", "/providers")) as { status: { health: object } }).status.health).toEqual({});
    expect(((await handle("GET", "/health")) as { data: { health: object }; log_tail: string[] }).data.health).toEqual({});
  });
});

const until = async (check: () => Promise<boolean>, ms = 120_000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error("timed out");
};

describe("model lab in the browser", () => {
  beforeEach(() => {
    vi.resetModules();
    const data: Record<string, string> = {};
    vi.stubGlobal("localStorage", { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; }, removeItem: (k: string) => { delete data[k]; } });
  });

  it("trains, validates, forecasts, scans and explains", { timeout: 180_000 }, async () => {
    const { handle } = await import("../engine");
    const { id } = await handle("POST", "/models/train", {}) as { id: number };
    let run: any;
    await until(async () => { run = await handle("GET", `/models/${id}`); return run.status !== "running"; });
    expect(run.error).toBeNull();
    expect(run.status).toBe("done");
    expect(run.metrics.folds.length).toBeGreaterThan(2);
    expect(run.metrics.oos_rows).toBeGreaterThan(1000);
    for (const k of ["logistic", "gbm", "forest", "knn", "factor", "ensemble"]) {
      const m = run.metrics.models[k].target_first;
      expect(m.auc, k).toBeGreaterThan(0.3);
      expect(m.auc, k).toBeLessThan(0.7);       // a random market must not look predictable: this would mean look-ahead
      expect(m.brier, k).toBeLessThan(0.3);
    }
    expect(run.metrics.feature_importance).toHaveLength(29);
    const r = await handle("GET", "/research/AAPL") as any;
    expect(r.forecast.p_up).toBeGreaterThan(0);
    expect(r.forecast.q10).toBeLessThan(r.forecast.q90);
    expect(Object.keys(r.forecast.by_method)).toContain("gbm");
    expect(r.narrative).toContain("chance of a positive return");
    await handle("POST", "/scanner/run", {});
    let scan: any;
    await until(async () => { scan = await handle("GET", "/scanner"); return !scan.running && !!scan.result; });
    expect(scan.result.candidates.length + scan.result.rejected.length).toBeGreaterThan(20);
    expect(JSON.stringify(scan.result)).not.toContain("NaN");
    expect(((await handle("GET", "/predictions")) as any).total).toBeGreaterThan(20);
    await handle("PATCH", "/autopilot/settings", { practice_mode: true, pickiness: "active", min_score: 0 });
    const cycle = await handle("POST", "/autopilot/run", {}) as any;
    expect(cycle.summary).toMatch(/idea/);
    expect((await handle("GET", "/autopilot") as any).model.run_id).toBe(id);
  });

  it("backtests every rule strategy without errors", { timeout: 60_000 }, async () => {
    const { handle } = await import("../engine");
    for (const strategy of ["momentum", "mean_reversion", "trend", "breakout"]) {
      const { id } = await handle("POST", "/backtests", { strategy }) as { id: number };
      let b: any;
      await until(async () => { b = await handle("GET", `/backtests/${id}`); return b.status !== "running"; });
      expect(b.error, strategy).toBeNull();
      expect(b.equity.length, strategy).toBeGreaterThan(100);
      expect(b.results.metrics.trades, strategy).toBeGreaterThan(0);
      for (const t of b.trades) expect(t.exit_date >= t.entry_date, strategy).toBe(true);
    }
  });

  it("runs the turbo simulator and random entries lose to costs on a pattern-free market", { timeout: 60_000 }, async () => {
    const { handle } = await import("../engine");
    const { id } = await handle("POST", "/turbo/run", { markets: 2, symbols: 60, years: 4, strategy: "ai" }) as { id: number };
    let t: any;
    await until(async () => { t = await handle("GET", `/turbo/runs/${id}`); return t.status !== "running"; });
    expect(t.error).toBeNull();
    expect(t.result.markets_done).toBe(2);
    expect(t.result.median_curve.length).toBeGreaterThan(10);
    const r = await handle("POST", "/turbo/run", { markets: 4, symbols: 60, years: 3, strategy: "random", pattern_strength: "none", seed: 5 }) as { id: number };
    await until(async () => { t = await handle("GET", `/turbo/runs/${r.id}`); return t.status !== "running"; });
    expect(t.result.trades).toBeGreaterThan(100);
    expect(t.result.avg_r).toBeLessThan(0.15);
  });

  it("replays history on its own account, then restores the real one", { timeout: 180_000 }, async () => {
    const { handle } = await import("../engine");
    const before = await handle("GET", "/paper/account") as any;
    await handle("POST", "/paper/orders", { symbol: "AAPL", side: "buy", qty: 3, type: "market" });
    await handle("POST", "/replay/start", { speed: 100, starting_cash: 50_000, source: "simulation" });
    let s: any;
    await until(async () => { s = await handle("GET", "/replay"); return s.active && !(await handle("GET", "/status") as any).training; });
    expect(s.simulated_history).toBe(true);
    const a = await handle("GET", "/paper/account") as any;
    expect(a.equity).toBe(50_000);
    expect(a.positions).toHaveLength(0);
    const q = (await handle("GET", "/market/quotes?symbols=AAPL") as any).AAPL;
    expect(q.status).toBe("replay");
    await handle("POST", "/paper/orders", { symbol: "MSFT", side: "buy", qty: 1, type: "market" });
    const bars = await handle("GET", "/market/bars/AAPL?tf=1D") as any;
    expect(new Date(bars.candles.at(-1).time * 1000).toISOString().slice(0, 10)).toBe(s.current_date);   // nothing from the future
    const stopped = await handle("POST", "/replay/stop", {}) as any;
    expect(stopped.active).toBe(false);
    expect(stopped.summary.trades).toBe(1);
    const after = await handle("GET", "/paper/account") as any;
    expect(after.positions.map((p: any) => p.symbol)).toEqual(["AAPL"]);
    expect(after.starting_cash).toBe(before.starting_cash);
  });
});
