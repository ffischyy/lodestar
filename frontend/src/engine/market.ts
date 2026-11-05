/**
 * Market data for the in-browser engine: a deterministic synthetic market (the same symbol shows the same
 * history on every reload), plus indicators. Good results on this data say nothing about real markets.
 */
import type { Candle, LinePoint, Quote } from "../api/types";

export const UNIVERSE: Record<string, [string, string]> = {
  AAPL: ["Apple Inc.", "Technology"], MSFT: ["Microsoft Corp.", "Technology"], NVDA: ["NVIDIA Corp.", "Technology"], AVGO: ["Broadcom Inc.", "Technology"],
  ORCL: ["Oracle Corp.", "Technology"], AMD: ["Advanced Micro Devices", "Technology"], CRM: ["Salesforce Inc.", "Technology"],
  GOOGL: ["Alphabet Inc. Class A", "Communication"], META: ["Meta Platforms", "Communication"], NFLX: ["Netflix Inc.", "Communication"], DIS: ["Walt Disney Co.", "Communication"],
  AMZN: ["Amazon.com Inc.", "Consumer Disc."], TSLA: ["Tesla Inc.", "Consumer Disc."], HD: ["Home Depot", "Consumer Disc."], MCD: ["McDonald's Corp.", "Consumer Disc."], NKE: ["Nike Inc.", "Consumer Disc."],
  WMT: ["Walmart Inc.", "Consumer Staples"], COST: ["Costco Wholesale", "Consumer Staples"], PG: ["Procter & Gamble", "Consumer Staples"], KO: ["Coca-Cola Co.", "Consumer Staples"],
  JPM: ["JPMorgan Chase", "Financials"], BAC: ["Bank of America", "Financials"], GS: ["Goldman Sachs", "Financials"], V: ["Visa Inc.", "Financials"], MA: ["Mastercard Inc.", "Financials"],
  UNH: ["UnitedHealth Group", "Health Care"], LLY: ["Eli Lilly & Co.", "Health Care"], JNJ: ["Johnson & Johnson", "Health Care"], MRK: ["Merck & Co.", "Health Care"], ABBV: ["AbbVie Inc.", "Health Care"],
  XOM: ["Exxon Mobil", "Energy"], CVX: ["Chevron Corp.", "Energy"], COP: ["ConocoPhillips", "Energy"],
  CAT: ["Caterpillar Inc.", "Industrials"], GE: ["GE Aerospace", "Industrials"], UNP: ["Union Pacific", "Industrials"], HON: ["Honeywell", "Industrials"],
  LIN: ["Linde plc", "Materials"], NEE: ["NextEra Energy", "Utilities"], PLD: ["Prologis Inc.", "Real Estate"],
};
export const INDEXES: Record<string, string> = { SPY: "S&P 500 ETF", QQQ: "Nasdaq-100 ETF", IWM: "Russell 2000 ETF", DIA: "Dow Jones ETF" };
export const SECTOR_ETFS: Record<string, string> = {
  XLK: "Technology", XLC: "Communication", XLY: "Consumer Disc.", XLP: "Consumer Staples", XLF: "Financials", XLV: "Health Care",
  XLE: "Energy", XLI: "Industrials", XLB: "Materials", XLU: "Utilities", XLRE: "Real Estate",
};

export function meta(symbol: string): [string, string] {
  if (UNIVERSE[symbol]) return UNIVERSE[symbol];
  if (INDEXES[symbol]) return [INDEXES[symbol], "Index"];
  if (SECTOR_ETFS[symbol]) return [`${SECTOR_ETFS[symbol]} Sector SPDR`, "Sector ETF"];
  return [symbol, "Unclassified"];
}

export function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const normal = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

const DAY = 86_400_000;
const START = Date.UTC(2021, 0, 4);
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

function tradingDays(now = Date.now()) {
  const out: number[] = [];
  for (let t = START; t <= now; t += DAY) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) out.push(t);
  }
  return out;
}

let factorCache: { n: number; market: number[]; sectors: Record<string, number[]> } | null = null;
function factors(n: number) {
  if (factorCache?.n === n) return factorCache;
  const series = (key: string, vol: number, drift: number, clustered: boolean) => {
    const r = rng(hash(key));
    let v = vol;
    return Array.from({ length: n }, () => {
      if (clustered) v = 0.94 * v + 0.06 * vol * (0.5 + 1.6 * r());
      return drift + v * normal(r);
    });
  };
  factorCache = { n, market: series("market", 0.0095, 0.00045, true), sectors: {} };
  for (const s of new Set(Object.values(UNIVERSE).map((u) => u[1]))) factorCache.sectors[s] = series(`sector:${s}`, 0.005, 0, false);
  return factorCache;
}

interface Params { beta: number; vol: number; start: number; volume: number; spreadBps: number; cap: number }
function params(symbol: string): Params {
  const r = rng(hash(`p:${symbol}`));
  const isIndex = !!INDEXES[symbol] || !!SECTOR_ETFS[symbol];
  return {
    beta: isIndex ? (symbol === "SPY" ? 1 : 0.85 + r() * 0.35) : 0.6 + r() * 0.95,
    vol: isIndex ? 0.002 : 0.009 + r() * 0.012,
    start: 40 + r() * 460,
    volume: Math.exp(14.5 + r() * 2.2),
    spreadBps: isIndex ? 1 : 3 + r() * 6,
    cap: Math.exp(25.5 + r() * 2.6),
  };
}

const dailyCache = new Map<string, { n: number; bars: Candle[] }>();
/** Completed daily bars, oldest first. The last entry is today (weekdays) and is finalised by `liveBar`. */
function daily(symbol: string): Candle[] {
  const days = tradingDays();
  const hit = dailyCache.get(symbol);
  if (hit?.n === days.length) return hit.bars;
  const p = params(symbol);
  const f = factors(days.length);
  const sector = f.sectors[meta(symbol)[1]];
  const r = rng(hash(`d:${symbol}`));
  let close = p.start;
  const bars = days.map((t, i) => {
    const ret = p.beta * f.market[i] + (sector?.[i] ?? 0) + p.vol * normal(r);
    const open = close * (1 + 0.15 * p.vol * normal(r));
    const next = Math.max(1, close * Math.exp(ret));
    const span = (0.5 + r()) * (p.vol + 0.006);
    const bar: Candle = {
      time: t / 1000, open: +open.toFixed(4), close: +next.toFixed(4),
      high: +(Math.max(open, next) * (1 + span * r())).toFixed(4), low: +(Math.min(open, next) * (1 - span * r())).toFixed(4),
      volume: Math.round(p.volume * Math.exp(0.35 * normal(r)) * (1 + 18 * Math.abs(ret))),
    };
    close = next;
    return bar;
  });
  dailyCache.set(symbol, { n: days.length, bars });
  return bars;
}

const STEPS = 78;
const pathCache = new Map<string, number[]>();
/** A 5-minute intraday path for one day, pinned to that day's open and close. */
function dayPath(symbol: string, bar: Candle): number[] {
  const key = `${symbol}:${bar.time}`;
  const hit = pathCache.get(key);
  if (hit) return hit;
  const r = rng(hash(key));
  const w = [0];
  for (let i = 1; i <= STEPS; i++) w.push(w[i - 1] + normal(r));
  const size = (bar.high - bar.low) / 6 / Math.sqrt(STEPS) * 2;
  const path = w.map((x, i) => {
    const frac = i / STEPS;
    const v = bar.open + (bar.close - bar.open) * frac + (x - w[STEPS] * frac) * size;
    return Math.min(bar.high, Math.max(bar.low, v));
  });
  if (pathCache.size > 4000) pathCache.clear();
  pathCache.set(key, path);
  return path;
}

/** How far through the simulated day we are. The simulator keeps moving outside market hours so the app stays useful at night. */
const dayFraction = (now: number) => ((now % DAY) / DAY);

function current(symbol: string, now = Date.now()) {
  const bars = daily(symbol);
  const last = bars[bars.length - 1];
  const isToday = isoDay(last.time * 1000) === isoDay(now);
  if (!isToday) return { price: last.close, open: last.open, high: last.high, low: last.low, volume: last.volume, prevClose: bars[bars.length - 2]?.close ?? last.open };
  const path = dayPath(symbol, last);
  const f = dayFraction(now) * STEPS;
  const i = Math.floor(f);
  const seen = path.slice(0, i + 1);
  const r = rng(hash(`${symbol}:${Math.floor(now / 3000)}`));
  const micro = 1 + (r() - 0.5) * 0.0006;
  const price = (path[i] + (path[Math.min(STEPS, i + 1)] - path[i]) * (f - i)) * micro;
  return {
    price, open: last.open, high: Math.max(...seen, price), low: Math.min(...seen, price),
    volume: Math.round(last.volume * (0.4 + 0.6 * dayFraction(now))), prevClose: bars[bars.length - 2]?.close ?? last.open,
  };
}

export function simQuote(symbol: string, now = Date.now()): Quote {
  const c = current(symbol, now);
  const p = params(symbol);
  const half = c.price * p.spreadBps / 20_000;
  const change = c.price - c.prevClose;
  return {
    symbol, price: +c.price.toFixed(4), ts: new Date(now).toISOString(), status: "simulated", source: "simulation",
    prev_close: c.prevClose, open: c.open, high: c.high, low: c.low, volume: c.volume, bid: +(c.price - half).toFixed(4), ask: +(c.price + half).toFixed(4),
    session: "simulated", venue_note: "synthetic", change, change_pct: (change / c.prevClose) * 100, spread_bps: p.spreadBps,
  };
}

export function simBars(symbol: string, tf: string): Candle[] {
  const now = Date.now();
  const bars = daily(symbol);
  if (tf === "1D") {
    const out = bars.slice();
    const lastIdx = out.length - 1;
    if (isoDay(out[lastIdx].time * 1000) === isoDay(now)) {
      const c = current(symbol, now);
      out[lastIdx] = { ...out[lastIdx], high: c.high, low: c.low, close: c.price, volume: c.volume };
    }
    return out;
  }
  const size = tf === "1H" ? 12 : tf === "15Min" ? 3 : 1;
  const out: Candle[] = [];
  const session = 14.5 * 3600;   // 09:30 ET in standard time
  for (const bar of bars.slice(-(tf === "1H" ? 60 : tf === "15Min" ? 30 : 12))) {
    const path = dayPath(symbol, bar);
    const isToday = isoDay(bar.time * 1000) === isoDay(now);
    const end = isToday ? Math.floor(dayFraction(now) * STEPS) : STEPS;
    for (let i = 0; i + size <= end; i += size) {
      const slice = path.slice(i, i + size + 1);
      out.push({ time: bar.time + session + i * 300, open: slice[0], close: slice[slice.length - 1], high: Math.max(...slice), low: Math.min(...slice),
        volume: Math.round((bar.volume / STEPS) * size) });
    }
  }
  return out;
}

export function simProfile(symbol: string) {
  const [name, sector] = meta(symbol);
  const r = rng(hash(`f:${symbol}`));
  const closes = simBars(symbol, "1D").slice(-252);
  const px = closes[closes.length - 1].close;
  const pe = 9 + r() * 38;
  const earningsDay = Date.now() + (3 + Math.floor(r() * 85)) * DAY;
  return {
    symbol, name, sector, industry: `${sector} (simulated)`, market_cap: params(symbol).cap, pe_ratio: pe, forward_pe: pe * (0.82 + r() * 0.2), eps: px / pe,
    dividend_yield: r() * 3.2, beta: params(symbol).beta, fifty_two_week_high: Math.max(...closes.map((c) => c.high)), fifty_two_week_low: Math.min(...closes.map((c) => c.low)),
    next_earnings: new Date(earningsDay - (earningsDay % (7 * DAY)) + 3 * DAY).toISOString(), description: "[SIMULATED] Synthetic company profile.", source: "simulation",
    simulated: true, fields_unavailable: [] as string[],
  };
}

const HEADLINES: [string, number, string][] = [
  ["{n} beats estimates as demand holds up", 0.5, "beats"], ["{n} raises full-year guidance", 0.6, "raises"], ["Analysts upgrade {n} on margin outlook", 0.4, "upgrade"],
  ["{n} misses revenue forecast", -0.5, "misses"], ["{n} cuts outlook on softer orders", -0.6, "cuts"], ["Regulators open inquiry into {n}", -0.4, "inquiry"],
  ["{n} announces share buyback", 0.3, "buyback"], ["{n} names new chief financial officer", 0, "names"],
];

export function simNews(days: number, symbols: string[]) {
  const out = [];
  const today = Math.floor(Date.now() / DAY);
  for (let d = 0; d < days; d++) {
    for (const s of symbols) {
      const r = rng(hash(`n:${s}:${today - d}`));
      if (r() > 0.14) continue;
      const [h, sentiment, term] = HEADLINES[Math.floor(r() * HEADLINES.length)];
      const ts = (today - d) * DAY + (13 + Math.floor(r() * 8)) * 3_600_000;
      if (ts > Date.now()) continue;
      out.push({ id: hash(`${s}${ts}`), ts: new Date(ts).toISOString(), headline: h.replace("{n}", meta(s)[0]), summary: "[SIMULATED] Synthetic headline for learning the app.",
        url: "", publisher: "Simulation", symbols: [s], sentiment, terms: [term], simulated: true });
    }
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts));
}

/* --------------------------------------------------------------- indicators (causal: each value uses only earlier bars) */
export function sma(v: number[], n: number): (number | null)[] {
  let sum = 0;
  return v.map((x, i) => {
    sum += x;
    if (i >= n) sum -= v[i - n];
    return i >= n - 1 ? sum / n : null;
  });
}
export function ema(v: number[], n: number): (number | null)[] {
  const k = 2 / (n + 1);
  let e: number | null = null;
  return v.map((x, i) => {
    e = e === null ? x : x * k + e * (1 - k);
    return i >= n - 1 ? e : null;
  });
}
export function rsi(v: number[], n = 14): (number | null)[] {
  let up = 0, down = 0;
  return v.map((x, i) => {
    if (i === 0) return null;
    const d = x - v[i - 1];
    if (i <= n) {
      up += Math.max(d, 0) / n;
      down += Math.max(-d, 0) / n;
      if (i < n) return null;
    } else {
      up = (up * (n - 1) + Math.max(d, 0)) / n;
      down = (down * (n - 1) + Math.max(-d, 0)) / n;
    }
    return down === 0 ? 100 : 100 - 100 / (1 + up / down);
  });
}
export function atr(b: Candle[], n = 14) {
  let a = 0;
  b.forEach((k, i) => {
    const prev = i ? b[i - 1].close : k.close;
    const tr = Math.max(k.high - k.low, Math.abs(k.high - prev), Math.abs(k.low - prev));
    a = i < n ? (a * i + tr) / (i + 1) : (a * (n - 1) + tr) / n;
  });
  return a;
}

export function indicators(c: Candle[], keys: string[]) {
  const close = c.map((k) => k.close);
  const line = (vals: (number | null)[]): LinePoint[] =>
    vals.flatMap((v, i) => (v === null ? [] : [{ time: c[i].time, value: +v.toFixed(4) }]));
  const out: Record<string, LinePoint[] | Record<string, LinePoint[]>> = {};
  for (const key of keys) {
    const m = /^(sma|ema)(\d+)$/.exec(key);
    if (m) out[key] = line(m[1] === "sma" ? sma(close, +m[2]) : ema(close, +m[2]));
    else if (key === "rsi") out.rsi = line(rsi(close));
    else if (key === "vwap20") {
      const pv = sma(c.map((k) => ((k.high + k.low + k.close) / 3) * k.volume), 20);
      const vol = sma(c.map((k) => k.volume), 20);
      out.vwap20 = line(pv.map((x, i) => (x === null || !vol[i] ? null : x / vol[i]!)));
    } else if (key === "bb") {
      const mid = sma(close, 20);
      const dev = mid.map((x, i) => (x === null ? null : Math.sqrt(close.slice(i - 19, i + 1).reduce((s, v) => s + (v - x) ** 2, 0) / 20)));
      out.bb = { mid: line(mid), upper: line(mid.map((x, i) => (x === null ? null : x + 2 * dev[i]!))), lower: line(mid.map((x, i) => (x === null ? null : x - 2 * dev[i]!))) };
    } else if (key === "macd") {
      const a = ema(close, 12), b = ema(close, 26);
      const macd = a.map((x, i) => (x === null || b[i] === null ? null : x - b[i]!));
      const firstValid = macd.findIndex((x) => x !== null);
      const sig = [...Array(firstValid).fill(null), ...ema(macd.slice(firstValid) as number[], 9)];
      out.macd = { macd: line(macd), signal: line(sig), hist: line(macd.map((x, i) => (x === null || sig[i] === null ? null : x - sig[i]))) };
    }
  }
  return out;
}
