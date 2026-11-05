/**
 * The model lab: forecasting, backtesting and the turbo simulator, as pure functions with no browser state.
 * It is the Python engine's pipeline (ml/, backtest/, turbo.py) rewritten to run in a Web Worker.
 * Everything keeps the same look-ahead rules: features use bars up to t, labels use bars after t, windows are purged.
 *
 * shortcut: training is thinned so a run takes seconds on a phone (5,000 rows per fit, every third test date, smaller
 * ensembles than scikit-learn's). Results are in the same family as the Python engine's, not identical to them.
 */
import type { Candle } from "../api/types";

export type Bars = Record<string, Candle[]>;
export const FEATURES = [
  "r1", "r5", "r21", "r63", "r126_skip5", "vol20", "vol60", "vol_ratio", "atr_pct", "rsi14", "rsi2", "z20", "pct_b",
  "dist_ema20", "dist_sma50", "dist_sma200", "adx", "macd_hist_n", "logvol_ratio", "donchian_pos",
  "rs21", "rs63", "spy_r21", "spy_vol20", "spy_dist200", "xs_rank_r21", "xs_rank_r63", "xs_rank_vol20", "breadth50",
];
const NF = FEATURES.length;
const col = (name: string) => FEATURES.indexOf(name);

export const METHODS: Record<string, { name: string; family: string; about: string }> = {
  base_rate: { name: "Base rate (baseline)", family: "baseline", about: "Always predicts how often the outcome happened in training. Every other method must beat it." },
  logistic: { name: "Logistic regression", family: "linear", about: "Weighted sum of all 29 features, regularised. Fast, stable, easy to calibrate." },
  gbm: { name: "Gradient boosting", family: "trees", about: "Dozens of shallow decision trees, each correcting the last. Captures non-linear effects." },
  forest: { name: "Random forest (extra trees)", family: "trees", about: "Many randomised trees averaged together. Robust to noise, rarely over-confident." },
  knn: { name: "Pattern analog (k-nearest neighbours)", family: "analog", about: "Finds the most similar past setups across all stocks and uses how they turned out." },
  factor: { name: "4-factor statistical model", family: "statistical", about: "Only momentum, short-term reversal, relative strength and trend distance. Few parameters, hard to over-fit." },
  ensemble: { name: "Ensemble (average)", family: "ensemble", about: "Average of the logistic, boosting and forest probabilities. Usually steadier than any single model." },
};
const ENSEMBLE = ["logistic", "gbm", "forest"];
const FACTOR_COLS = ["r126_skip5", "r1", "rs63", "dist_sma200"].map(col);
const KNN_COLS = ["r5", "r21", "r63", "rsi14", "vol20", "dist_sma50", "rs21", "z20"].map(col);
const MAX_FIT = 5000, MAX_CAL = 2000;

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const mean = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : NaN; };
function quantile(sorted: ArrayLike<number>, q: number) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const sortedNums = (a: ArrayLike<number>) => Float64Array.from(a).filter(Number.isFinite).sort();
const median = (a: ArrayLike<number>) => quantile(sortedNums(a), 0.5);
function std(a: ArrayLike<number>, ddof = 1) {
  const m = mean(a);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2;
  return a.length > ddof ? Math.sqrt(s / (a.length - ddof)) : 0;
}

/** Replaces NaN and Infinity with null, the way the Python engine's JSON output does. */
export function clean<T>(o: T): T {
  if (typeof o === "number") return (Number.isFinite(o) ? o : null) as T;
  if (Array.isArray(o)) return o.map(clean) as T;
  if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, clean(v)])) as T;
  return o;
}

/* ------------------------------------------------------------------ indicators (NaN until enough history) */
function smaN(v: number[], n: number) {
  const out = new Array<number>(v.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= n) s -= v[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}
function emaN(v: number[], n: number) {
  const k = 2 / (n + 1);
  const out = new Array<number>(v.length).fill(NaN);
  let e = v[0];
  for (let i = 0; i < v.length; i++) {
    e = i ? v[i] * k + e * (1 - k) : v[0];
    if (i >= n - 1) out[i] = e;
  }
  return out;
}
function stdN(v: number[], n: number) {
  const out = new Array<number>(v.length).fill(NaN);
  for (let i = n - 1; i < v.length; i++) out[i] = std(v.slice(i - n + 1, i + 1));
  return out;
}
function rsiN(c: number[], n: number) {
  const out = new Array<number>(c.length).fill(NaN);
  let up = 0, dn = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], u = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) { up += u / n; dn += l / n; } else { up = (up * (n - 1) + u) / n; dn = (dn * (n - 1) + l) / n; }
    if (i >= n) out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  }
  return out;
}
function atrN(b: Candle[], n = 14) {
  const tr = b.map((k, i) => (i ? Math.max(k.high - k.low, Math.abs(k.high - b[i - 1].close), Math.abs(k.low - b[i - 1].close)) : k.high - k.low));
  return smaN(tr, n);
}
function adxN(b: Candle[], n = 14) {
  const out = new Array<number>(b.length).fill(NaN);
  let trs = 0, p = 0, m = 0, adx = NaN;
  for (let i = 1; i < b.length; i++) {
    const up = b[i].high - b[i - 1].high, dn = b[i - 1].low - b[i].low;
    const tr = Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close));
    const pd = up > dn && up > 0 ? up : 0, md = dn > up && dn > 0 ? dn : 0;
    if (i <= n) { trs += tr; p += pd; m += md; } else { trs += tr - trs / n; p += pd - p / n; m += md - m / n; }
    if (i < n) continue;
    const pi = trs ? (100 * p) / trs : 0, mi = trs ? (100 * m) / trs : 0;
    const dx = pi + mi ? (100 * Math.abs(pi - mi)) / (pi + mi) : 0;
    adx = Number.isNaN(adx) ? dx : (adx * (n - 1) + dx) / n;
    if (i >= 2 * n) out[i] = adx;
  }
  return out;
}
const rollMax = (v: number[], n: number) => v.map((_, i) => (i < n - 1 ? NaN : Math.max(...v.slice(i - n + 1, i + 1))));
const rollMin = (v: number[], n: number) => v.map((_, i) => (i < n - 1 ? NaN : Math.min(...v.slice(i - n + 1, i + 1))));
const lagDiff = (v: number[], k: number) => v.map((x, i) => (i >= k ? x - v[i - k] : NaN));
const realizedVol = (c: number[], n: number) => stdN(c.map((x, i) => (i ? Math.log(x / c[i - 1]) : NaN)), n).map((s) => s * Math.sqrt(252));

/* ------------------------------------------------------------------ features and labels */
function symbolFeatures(b: Candle[], spy: Map<number, number>, spyTimes: number[]) {
  const c = b.map((k) => k.close), lc = c.map(Math.log), n = b.length;
  // SPY aligned to this symbol's days, last known value carried forward
  let j = 0, lastSpy = NaN;
  const sc = b.map((k) => {
    while (j < spyTimes.length && spyTimes[j] <= k.time) lastSpy = spy.get(spyTimes[j++])!;
    return lastSpy;
  });
  const lsc = sc.map(Math.log);
  const vol20 = realizedVol(c, 20), vol60 = realizedVol(c, 60), atr = atrN(b), m20 = smaN(c, 20), sd20 = stdN(c, 20);
  const e12 = emaN(c, 12), e26 = emaN(c, 26), e20 = emaN(c, 20), s50 = smaN(c, 50), s200 = smaN(c, 200);
  const macd = e12.map((x, i) => x - e26[i]), sig = emaN(macd.map((x) => (Number.isNaN(x) ? 0 : x)), 9), adx = adxN(b);
  const rsi14 = rsiN(c, 14), rsi2 = rsiN(c, 2), logv = smaN(b.map((k) => k.volume), 20);
  const hi = rollMax(b.map((k) => k.high), 20), lo = rollMin(b.map((k) => k.low), 20);
  const r21 = lagDiff(lc, 21), r63 = lagDiff(lc, 63), sr21 = lagDiff(lsc, 21), sr63 = lagDiff(lsc, 63), svol = realizedVol(sc, 20), s200s = smaN(sc, 200);
  const X = new Float64Array(n * NF);
  const above = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = [
      i ? lc[i] - lc[i - 1] : NaN, i >= 5 ? lc[i] - lc[i - 5] : NaN, r21[i], r63[i], i >= 126 ? lc[i - 5] - lc[i - 126] : NaN, vol20[i], vol60[i], vol20[i] / vol60[i],
      atr[i] / c[i], rsi14[i] / 100, rsi2[i] / 100, (c[i] - m20[i]) / sd20[i], (c[i] - (m20[i] - 2 * sd20[i])) / (4 * sd20[i]),
      c[i] / e20[i] - 1, c[i] / s50[i] - 1, c[i] / s200[i] - 1, adx[i] / 100, (macd[i] - sig[i]) / c[i], Math.log((b[i].volume + 1) / (logv[i] + 1)), (c[i] - lo[i]) / (hi[i] - lo[i]),
      r21[i] - sr21[i], r63[i] - sr63[i], sr21[i], svol[i], sc[i] / s200s[i] - 1, NaN, NaN, NaN, NaN,
    ];
    for (let f = 0; f < NF; f++) X[i * NF + f] = Number.isFinite(v[f]) ? v[f] : NaN;
    above[i] = Number.isNaN(s50[i]) ? NaN : +(c[i] > s50[i]);
  }
  return { X, above, atrp: atr.map((a, i) => a / c[i]), vol20 };
}

interface Panel {
  n: number; X: Float64Array; time: Float64Array; sym: Int32Array; symbols: string[]; close: Float64Array; vol20: Float64Array;
  fwd: Float64Array; up: Float64Array; tbL: Float64Array; tbS: Float64Array; mfe: Float64Array; mae: Float64Array; atrp: Float64Array;
}

function buildPanel(bars: Bars, spyBars: Candle[], h: number, kt: number, ks: number, withLabels = true): Panel | null {
  const spy = new Map(spyBars.map((k) => [k.time, k.close])), spyTimes = spyBars.map((k) => k.time);
  const symbols = Object.keys(bars).filter((s) => bars[s].length >= 260);
  if (!symbols.length) return null;
  const parts = symbols.map((s) => ({ b: bars[s], ...symbolFeatures(bars[s], spy, spyTimes) }));
  const n = parts.reduce((s, p) => s + p.b.length, 0);
  const p: Panel = { n, X: new Float64Array(n * NF), time: new Float64Array(n), sym: new Int32Array(n), symbols, close: new Float64Array(n), vol20: new Float64Array(n), fwd: new Float64Array(n).fill(NaN),
    up: new Float64Array(n).fill(NaN), tbL: new Float64Array(n).fill(NaN), tbS: new Float64Array(n).fill(NaN), mfe: new Float64Array(n).fill(NaN), mae: new Float64Array(n).fill(NaN), atrp: new Float64Array(n) };
  const above = new Float64Array(n);
  let at = 0;
  parts.forEach((q, si) => {
    const m = q.b.length;
    p.X.set(q.X, at * NF);
    above.set(q.above, at);
    for (let t = 0; t < m; t++) {
      const i = at + t, k = q.b[t];
      p.time[i] = k.time; p.sym[i] = si; p.close[i] = k.close; p.vol20[i] = q.vol20[t]; p.atrp[i] = q.atrp[t];
      if (!withLabels || t >= m - h || !Number.isFinite(q.atrp[t])) continue;
      const px = k.close, a = q.atrp[t];
      const up = px * (1 + kt * a), dn = px * (1 - ks * a), su = px * (1 + ks * a), sd = px * (1 - kt * a);
      let hi = -Infinity, lo = Infinity, l = -1, s = -1;
      for (let j = t + 1; j <= t + h; j++) {
        const b = q.b[j];
        hi = Math.max(hi, b.high); lo = Math.min(lo, b.low);
        if (l < 0) l = b.low <= dn ? 0 : b.high >= up ? 1 : -1;       // same-bar touch counts as stop
        if (s < 0) s = b.high >= su ? 0 : b.low <= sd ? 1 : -1;
      }
      p.fwd[i] = q.b[t + h].close / px - 1; p.up[i] = +(p.fwd[i] > 0); p.tbL[i] = Math.max(l, 0); p.tbS[i] = Math.max(s, 0); p.mfe[i] = hi / px - 1; p.mae[i] = lo / px - 1;
    }
    at += m;
  });
  // cross-sectional features combine values from one date only
  const byDate = new Map<number, number[]>();
  for (let i = 0; i < n; i++) (byDate.get(p.time[i]) ?? byDate.set(p.time[i], []).get(p.time[i])!).push(i);
  const rank = (rows: number[], src: number, dst: number) => {
    const ok = rows.filter((i) => Number.isFinite(p.X[i * NF + src])).sort((a, b) => p.X[a * NF + src] - p.X[b * NF + src]);
    ok.forEach((i, r) => { p.X[i * NF + dst] = (r + 1) / ok.length; });
  };
  for (const rows of byDate.values()) {
    rank(rows, col("r21"), col("xs_rank_r21")); rank(rows, col("r63"), col("xs_rank_r63")); rank(rows, col("vol20"), col("xs_rank_vol20"));
    const a = rows.filter((i) => !Number.isNaN(above[i]));
    const b = a.length ? a.reduce((s, i) => s + above[i], 0) / a.length : NaN;
    for (const i of rows) p.X[i * NF + col("breadth50")] = b;
  }
  return p;
}

/* ------------------------------------------------------------------ models */
interface Tree { f: number[]; t: number[]; l: number[]; r: number[]; v: number[] }
export type Model =
  | { k: "base"; p: number }
  | { k: "lin"; med: number[]; mu: number[]; sd: number[]; w: number[]; b: number; cols: number[]; logit: boolean }
  | { k: "gbm"; med: number[]; base: number; lr: number; trees: Tree[]; logit: boolean }
  | { k: "forest"; med: number[]; trees: Tree[] }
  | { k: "knn"; med: number[]; mu: number[]; sd: number[]; x: number[]; y: number[]; kk: number }
  | { k: "avg"; m: Model[] }
  | { k: "cal"; m: Model; a: number; b: number };

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const take = (X: Float64Array, rows: number[]) => { const o = new Float64Array(rows.length * NF); rows.forEach((r, i) => o.set(X.subarray(r * NF, r * NF + NF), i * NF)); return o; };
function medians(X: Float64Array, n: number) {
  const out = new Array<number>(NF);
  const c = new Float64Array(n);
  for (let f = 0; f < NF; f++) { for (let i = 0; i < n; i++) c[i] = X[i * NF + f]; const m = median(c); out[f] = Number.isFinite(m) ? m : 0; }
  return out;
}
function impute(X: Float64Array, n: number, med: number[]) {
  const o = X.slice();
  for (let i = 0; i < n * NF; i++) if (Number.isNaN(o[i])) o[i] = med[i % NF];
  return o;
}

function solve(A: Float64Array[], b: Float64Array) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    const d = A[c][c] || 1e-9;
    for (let r = c + 1; r < n; r++) {
      const m = A[r][c] / d;
      if (!m) continue;
      for (let k = c; k < n; k++) A[r][k] -= m * A[c][k];
      b[r] -= m * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / (A[r][r] || 1e-9);
  }
  return x;
}

/** Newton steps for L2 logistic regression; one exact solve for ridge. The intercept is not penalised. */
function fitLinear(X: Float64Array, y: ArrayLike<number>, n: number, cols: number[], lambda: number, logit: boolean, steps = 7): Extract<Model, { k: "lin" }> {
  const med = medians(X, n), d = cols.length, mu = new Array<number>(d), sd = new Array<number>(d);
  const Z = new Float64Array(n * d), Xi = impute(X, n, med);
  cols.forEach((c, j) => {
    let s = 0, q = 0;
    for (let i = 0; i < n; i++) s += Xi[i * NF + c];
    mu[j] = s / n;
    for (let i = 0; i < n; i++) q += (Xi[i * NF + c] - mu[j]) ** 2;
    sd[j] = Math.sqrt(q / n) + 1e-9;
    for (let i = 0; i < n; i++) Z[i * d + j] = (Xi[i * NF + c] - mu[j]) / sd[j];
  });
  let w = new Float64Array(d + 1);
  for (let it = 0; it < (logit ? steps : 1); it++) {
    const A = Array.from({ length: d + 1 }, () => new Float64Array(d + 1)), g = new Float64Array(d + 1);
    for (let i = 0; i < n; i++) {
      let z = w[d];
      for (let j = 0; j < d; j++) z += w[j] * Z[i * d + j];
      const p = logit ? sigmoid(z) : z, h = logit ? Math.max(p * (1 - p), 1e-6) : 1, r = y[i] - p;
      for (let a = 0; a <= d; a++) {
        const za = a === d ? 1 : Z[i * d + a];
        g[a] += r * za;
        for (let b = a; b <= d; b++) A[a][b] += h * za * (b === d ? 1 : Z[i * d + b]);
      }
    }
    for (let a = 0; a <= d; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
    for (let a = 0; a < d; a++) { A[a][a] += lambda; g[a] -= lambda * w[a]; }
    const step = solve(A, g);
    w = w.map((v, i) => v + step[i]);
  }
  return { k: "lin", med, mu, sd, w: Array.from(w.subarray(0, d)), b: w[d], cols, logit };
}

const walk = (t: Tree, X: ArrayLike<number>, at: number) => { let i = 0; while (t.f[i] >= 0) i = X[at + t.f[i]] <= t.t[i] ? t.l[i] : t.r[i]; return t.v[i]; };

/** One regression tree on quantile bins, splitting on Newton gain. `leaf` sets each leaf's value from its rows. */
function growTree(bins: Uint8Array, edges: number[][], g: Float64Array, h: Float64Array, rows: Int32Array, depth: number, minLeaf: number, leaf: (rows: Int32Array) => number): Tree {
  const t: Tree = { f: [], t: [], l: [], r: [], v: [] };
  const NB = 32, sumG = new Float64Array(NB), sumH = new Float64Array(NB), cnt = new Int32Array(NB);
  const node = (idx: Int32Array, d: number): number => {
    const id = t.f.length;
    t.f.push(-1); t.t.push(0); t.l.push(0); t.r.push(0); t.v.push(0);
    let bestF = -1, bestB = 0, best = 1e-9;
    if (d < depth && idx.length >= 2 * minLeaf) {
      let G = 0, H = 0;
      for (const i of idx) { G += g[i]; H += h[i]; }
      const parent = (G * G) / (H + 1);
      for (let f = 0; f < NF; f++) {
        sumG.fill(0); sumH.fill(0); cnt.fill(0);
        for (const i of idx) { const b = bins[i * NF + f]; sumG[b] += g[i]; sumH[b] += h[i]; cnt[b]++; }
        let gl = 0, hl = 0, nl = 0;
        for (let b = 0; b < edges[f].length; b++) {
          gl += sumG[b]; hl += sumH[b]; nl += cnt[b];
          if (nl < minLeaf || idx.length - nl < minLeaf) continue;
          const gain = (gl * gl) / (hl + 1) + ((G - gl) * (G - gl)) / (H - hl + 1) - parent;
          if (gain > best) { best = gain; bestF = f; bestB = b; }
        }
      }
    }
    if (bestF < 0) { t.v[id] = leaf(idx); return id; }
    t.f[id] = bestF; t.t[id] = edges[bestF][bestB];
    const nl = idx.reduce((s, i) => s + +(bins[i * NF + bestF] <= bestB), 0);
    const L = new Int32Array(nl), R = new Int32Array(idx.length - nl);
    let a = 0, c = 0;
    for (const i of idx) { if (bins[i * NF + bestF] <= bestB) L[a++] = i; else R[c++] = i; }
    t.l[id] = node(L, d + 1); t.r[id] = node(R, d + 1);
    return id;
  };
  node(rows, 0);
  return t;
}

function fitGbm(X0: Float64Array, y: ArrayLike<number>, n: number, loss: "logit" | "mse" | "quantile", q = 0.5): Extract<Model, { k: "gbm" }> {
  const med = medians(X0, n), X = impute(X0, n, med), lr = 0.1, rounds = 40, minLeaf = 60;
  const edges: number[][] = [], bins = new Uint8Array(n * NF), c = new Float64Array(n);
  for (let f = 0; f < NF; f++) {
    for (let i = 0; i < n; i++) c[i] = X[i * NF + f];
    const s = c.slice().sort(), e = [...new Set(Array.from({ length: 31 }, (_, b) => quantile(s, (b + 1) / 32)))];
    edges.push(e);
    for (let i = 0; i < n; i++) { let b = 0; while (b < e.length && c[i] > e[b]) b++; bins[i * NF + f] = b; }
  }
  const ys = Float64Array.from(y as ArrayLike<number>), my = mean(ys);
  const base = loss === "logit" ? Math.log(Math.max(my, 1e-6) / Math.max(1 - my, 1e-6)) : loss === "quantile" ? quantile(ys.slice().sort(), q) : my;
  const F = new Float64Array(n).fill(base), g = new Float64Array(n), h = new Float64Array(n).fill(1), rows = Int32Array.from({ length: n }, (_, i) => i), trees: Tree[] = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n; i++) {
      if (loss === "logit") { const p = sigmoid(F[i]); g[i] = ys[i] - p; h[i] = Math.max(p * (1 - p), 1e-6); }
      else if (loss === "mse") g[i] = ys[i] - F[i];
      else g[i] = ys[i] > F[i] ? q : q - 1;
    }
    const leaf = (idx: Int32Array) => {
      if (loss === "quantile") return quantile(Float64Array.from(idx, (i) => ys[i] - F[i]).sort(), q);
      let G = 0, H = 0;
      for (const i of idx) { G += g[i]; H += h[i]; }
      return G / (H + 1);
    };
    const t = growTree(bins, edges, g, h, rows, 3, minLeaf, leaf);
    trees.push(t);
    for (let i = 0; i < n; i++) F[i] += lr * walk(t, X, i * NF);
  }
  return { k: "gbm", med, base, lr, trees, logit: loss === "logit" };
}

/** Extremely randomised trees: one random threshold per candidate feature. */
function fitForest(X0: Float64Array, y: ArrayLike<number>, n: number, seed = 7): Extract<Model, { k: "forest" }> {
  const med = medians(X0, n), X = impute(X0, n, med), r = rng(seed), minLeaf = 40, maxDepth = 6, mtry = Math.ceil(NF / 2);
  const grow = (): Tree => {
    const t: Tree = { f: [], t: [], l: [], r: [], v: [] };
    const node = (idx: Int32Array, d: number): number => {
      const id = t.f.length;
      t.f.push(-1); t.t.push(0); t.l.push(0); t.r.push(0);
      let s = 0;
      for (const i of idx) s += y[i];
      t.v.push(s / idx.length);
      if (d >= maxDepth || idx.length < 2 * minLeaf) return id;
      let bestScore = -Infinity, bestF = -1, bestT = 0;
      for (let c = 0; c < mtry; c++) {
        const f = Math.floor(r() * NF);
        let lo = Infinity, hi = -Infinity;
        for (const i of idx) { const v = X[i * NF + f]; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (hi <= lo) continue;
        const cut = lo + r() * (hi - lo);
        let sl = 0, nl = 0;
        for (const i of idx) if (X[i * NF + f] <= cut) { sl += y[i]; nl++; }
        if (nl < minLeaf || idx.length - nl < minLeaf) continue;
        const score = (sl * sl) / nl + ((s - sl) * (s - sl)) / (idx.length - nl);
        if (score > bestScore) { bestScore = score; bestF = f; bestT = cut; }
      }
      if (bestF < 0) return id;
      t.f[id] = bestF; t.t[id] = bestT;
      const L: number[] = [], R: number[] = [];
      for (const i of idx) (X[i * NF + bestF] <= bestT ? L : R).push(i);
      t.l[id] = node(Int32Array.from(L), d + 1); t.r[id] = node(Int32Array.from(R), d + 1);
      return id;
    };
    node(Int32Array.from({ length: n }, (_, i) => i), 0);
    return t;
  };
  return { k: "forest", med, trees: Array.from({ length: 20 }, grow) };
}

function fitKnn(X0: Float64Array, y: ArrayLike<number>, n: number): Extract<Model, { k: "knn" }> {
  const cap = Math.min(n, 1000), from = n - cap, med = medians(X0, n), X = impute(X0, n, med), d = KNN_COLS.length;
  const mu: number[] = [], sd: number[] = [], x = new Array<number>(cap * d);
  KNN_COLS.forEach((c, j) => {
    const v = Float64Array.from({ length: cap }, (_, i) => X[(i + from) * NF + c]);
    mu[j] = mean(v); sd[j] = std(v, 0) + 1e-9;
    for (let i = 0; i < cap; i++) x[i * d + j] = (v[i] - mu[j]) / sd[j];
  });
  return { k: "knn", med, mu, sd, x, y: Array.from({ length: cap }, (_, i) => y[i + from]), kk: Math.min(50, cap) };
}

export function predict(m: Model, X: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n);
  switch (m.k) {
    case "base": return out.fill(m.p);
    case "lin":
      for (let i = 0; i < n; i++) {
        let z = m.b;
        m.cols.forEach((c, j) => { const v = X[i * NF + c]; z += (m.w[j] * ((Number.isNaN(v) ? m.med[c] : v) - m.mu[j])) / m.sd[j]; });
        out[i] = m.logit ? sigmoid(z) : z;
      }
      return out;
    case "gbm": {
      const Xi = impute(X, n, m.med);
      for (let i = 0; i < n; i++) {
        let z = m.base;
        for (const t of m.trees) z += m.lr * walk(t, Xi, i * NF);
        out[i] = m.logit ? sigmoid(z) : z;
      }
      return out;
    }
    case "forest": {
      const Xi = impute(X, n, m.med);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (const t of m.trees) s += walk(t, Xi, i * NF);
        out[i] = s / m.trees.length;
      }
      return out;
    }
    case "knn": {
      const d = KNN_COLS.length, cap = m.y.length, Xi = impute(X, n, m.med), dist = new Float64Array(cap), z = new Float64Array(d);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < d; j++) z[j] = (Xi[i * NF + KNN_COLS[j]] - m.mu[j]) / m.sd[j];
        for (let r = 0; r < cap; r++) { let s = 0; for (let j = 0; j < d; j++) s += (z[j] - m.x[r * d + j]) ** 2; dist[r] = s; }
        const cut = dist.slice().sort()[m.kk - 1];
        let sw = 0, sy = 0;
        for (let r = 0; r < cap; r++) if (dist[r] <= cut) { const w = 1 / (Math.sqrt(dist[r]) + 1e-6); sw += w; sy += w * m.y[r]; }
        out[i] = sy / sw;
      }
      return out;
    }
    case "avg": {
      for (const a of m.m) { const p = predict(a, X, n); for (let i = 0; i < n; i++) out[i] += p[i] / m.m.length; }
      return out;
    }
    case "cal": {
      const r = predict(m.m, X, n);
      for (let i = 0; i < n; i++) { const c = Math.min(1 - 1e-6, Math.max(1e-6, r[i])); out[i] = Math.min(0.999, Math.max(0.001, sigmoid(m.a * Math.log(c / (1 - c)) + m.b))); }
      return out;
    }
  }
}

function fitClassifier(kind: string, X: Float64Array, y: ArrayLike<number>, n: number): Model {
  if (kind === "base_rate") return { k: "base", p: mean(y) };
  if (kind === "logistic") return fitLinear(X, y, n, FEATURES.map((_, i) => i), 20, true);
  if (kind === "factor") return fitLinear(X, y, n, FACTOR_COLS, 1, true);
  if (kind === "gbm") return fitGbm(X, y, n, "logit");
  if (kind === "forest") return fitForest(X, y, n);
  if (kind === "knn") return fitKnn(X, y, n);
  throw new Error(kind);
}
function fitRegressor(kind: string, X: Float64Array, y: ArrayLike<number>, n: number, q?: number): Model {
  if (q !== undefined && kind !== "gbm") return { k: "base", p: quantile(sortedNums(y), q) };
  if (kind === "base_rate") return { k: "base", p: mean(y) };
  if (kind === "logistic") return fitLinear(X, y, n, FEATURES.map((_, i) => i), 50, false);
  if (kind === "factor") return fitLinear(X, y, n, FACTOR_COLS, 10, false);
  if (kind === "gbm") return fitGbm(X, y, n, q === undefined ? "mse" : "quantile", q);
  if (kind === "forest") return fitForest(X, y, n);
  if (kind === "knn") return fitKnn(X, y, n);
  if (kind === "ensemble") return { k: "avg", m: ENSEMBLE.map((m) => fitRegressor(m, X, y, n)) };
  throw new Error(kind);
}

interface Slice { X: Float64Array; n: number; pick: (a: Float64Array) => number[] }
function slice(p: Panel, rows: number[]): Slice { return { X: take(p.X, rows), n: rows.length, pick: (a) => rows.map((r) => a[r]) }; }
/** Platt scaling on a later, disjoint window. */
function fitCalibrated(kind: string, F: Slice, yf: number[], C: Slice, yc: number[]): Model {
  if (kind === "ensemble") return { k: "avg", m: ENSEMBLE.map((m) => fitCalibrated(m, F, yf, C, yc)) };
  const m = fitClassifier(kind, F.X, yf, F.n);
  if (kind === "base_rate" || new Set(yc).size < 2 || yc.length < 200) return m;
  const raw = predict(m, C.X, C.n), Z = new Float64Array(C.n * NF);
  for (let i = 0; i < C.n; i++) { const c = Math.min(1 - 1e-6, Math.max(1e-6, raw[i])); Z[i * NF] = Math.log(c / (1 - c)); }
  const lin = fitLinear(Z, yc, C.n, [0], 1e-4, true, 12);
  return { k: "cal", m, a: lin.w[0] / lin.sd[0], b: lin.b - (lin.w[0] * lin.mu[0]) / lin.sd[0] };
}

/* ------------------------------------------------------------------ evaluation */
function auc(y: number[], p: Float64Array) {
  const order = Array.from(p.keys()).sort((a, b) => p[a] - p[b]);
  let rankSum = 0, pos = 0, i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && p[order[j + 1]] === p[order[i]]) j++;
    for (let k = i; k <= j; k++) if (y[order[k]] === 1) { rankSum += (i + j) / 2 + 1; pos++; }
    i = j + 1;
  }
  const neg = y.length - pos;
  return pos && neg ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
}
function reliability(y: number[], p: ArrayLike<number>, nBins = 10) {
  const order = Array.from({ length: y.length }, (_, i) => i).sort((a, b) => p[a] - p[b]);
  const bins: { pred: number; obs: number; n: number }[] = [];
  let ece = 0;
  for (let b = 0; b < nBins; b++) {
    const part = order.slice(Math.floor((b * y.length) / nBins), Math.floor(((b + 1) * y.length) / nBins));
    if (!part.length) continue;
    const mp = mean(part.map((i) => p[i])), mo = mean(part.map((i) => y[i]));
    ece += (part.length / y.length) * Math.abs(mp - mo);
    bins.push({ pred: +mp.toFixed(4), obs: +mo.toFixed(4), n: part.length });
  }
  return { ece, bins };
}
export const calibrationBins = reliability;
function classMetrics(y: number[], p0: ArrayLike<number>, base: ArrayLike<number>) {
  const c = (v: number) => Math.min(1 - 1e-6, Math.max(1e-6, v));
  if (new Set(y).size < 2) return { n: y.length, error: "single class in test set" };
  const p = Float64Array.from(p0, c), ref = Float64Array.from(base, c);
  const brier = mean(p.map((v, i) => (v - y[i]) ** 2)), bref = mean(ref.map((v, i) => (v - y[i]) ** 2));
  const rel = reliability(y, p);
  return { n: y.length, auc: auc(y, p), brier, brier_baseline: bref, brier_skill: bref > 0 ? 1 - brier / bref : 0, log_loss: -mean(p.map((v, i) => (y[i] ? Math.log(v) : Math.log(1 - v)))),
    ece: rel.ece, positive_rate: mean(y), mean_prob: mean(p), reliability: rel.bins };
}
const ranks = (a: number[]) => { const o = a.map((_, i) => i).sort((x, y) => a[x] - a[y]); const r = new Array<number>(a.length); o.forEach((i, k) => { r[i] = k; }); return r; };
function corr(a: number[], b: number[]) {
  const ma = mean(a), mb = mean(b);
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return sa && sb ? s / Math.sqrt(sa * sb) : NaN;
}
function returnMetrics(dates: number[], pred: ArrayLike<number>, real: number[]) {
  const by = new Map<number, number[]>();
  dates.forEach((d, i) => (by.get(d) ?? by.set(d, []).get(d)!).push(i));
  const ics: number[] = [], spreads: number[] = [];
  for (const rows of by.values()) {
    const a = rows.map((i) => pred[i]), b = rows.map((i) => real[i]);
    if (rows.length < 8 || new Set(a).size < 2) continue;
    const ic = corr(ranks(a), ranks(b));
    if (Number.isFinite(ic)) ics.push(ic);
    const s = sortedNums(a), lo = quantile(s, 0.2), hi = quantile(s, 0.8);
    spreads.push(mean(rows.filter((i) => pred[i] >= hi).map((i) => real[i])) - mean(rows.filter((i) => pred[i] <= lo).map((i) => real[i])));
  }
  const sd = std(ics);
  return { ic_mean: ics.length ? mean(ics) : null, ic_t_stat: ics.length > 2 && sd > 0 ? mean(ics) / (sd / Math.sqrt(ics.length)) : null, ic_positive_share: ics.length ? ics.filter((v) => v > 0).length / ics.length : null,
    top_minus_bottom_quintile: spreads.length ? mean(spreads) : null, sign_accuracy: mean(real.map((r, i) => +(Math.sign(pred[i]) === Math.sign(r)))), dates: ics.length };
}
function reliabilityScore(m: { brier_skill?: number; auc?: number; ece?: number }) {
  if (m.brier_skill === undefined) return 0;
  const clip = (v: number) => Math.max(0, Math.min(1, v));
  const bss = clip(m.brier_skill / 0.03), a = clip((m.auc! - 0.5) / 0.08), cal = clip(1 - m.ece! / 0.05);
  return +(m.brier_skill <= 0 || m.auc! <= 0.5 ? 0.15 * cal : 0.5 * bss + 0.3 * a + 0.2 * cal).toFixed(3);
}

/* ------------------------------------------------------------------ training */
export interface Artifact {
  models: { tb_long: Model; tb_short: Model; up: Model; ret: Model; q10: Model; q90: Model; mfe: Model; mae: Model; by_method: Record<string, { tb_long: Model; tb_short: Model; up: Model }> };
  champion: string; passed: boolean; reliability: number; source: string; run_id: number; trained_through: string; horizon_days: number; barrier_target_atr: number; barrier_stop_atr: number;
}
export interface TrainInput { bars: Bars; spy: Candle[]; source: string; runId: number; horizon: number; kt: number; ks: number; methods: string[]; selection: string; minRows: number; problems: string[] }
type Progress = (p: number, message?: string, partial?: unknown) => void;
const thin = (rows: number[], cap: number) => (rows.length <= cap ? rows : Array.from({ length: cap }, (_, i) => rows[Math.floor((i * rows.length) / cap)]));

export function train(a: TrainInput, progress: Progress) {
  const t0 = performance.now(), { horizon: h, kt, ks } = a;
  progress(0.05, "Building features and labels");
  const p = buildPanel(a.bars, a.spy, h, kt, ks);
  if (!p) throw new Error("No symbols with enough history (need at least 260 daily bars)");
  const lab: number[] = [];
  for (let i = 0; i < p.n; i++) if (Number.isFinite(p.tbL[i]) && Number.isFinite(p.fwd[i]) && Number.isFinite(p.vol20[i])) lab.push(i);
  if (lab.length < a.minRows) throw new Error(`Only ${lab.length} labelled rows; need ${a.minRows}`);
  const scale = (i: number) => Math.max(p.vol20[i], 0.05) * Math.sqrt(h / 252);
  const z = new Float64Array(p.n), zMfe = new Float64Array(p.n), zMae = new Float64Array(p.n);
  for (const i of lab) { z[i] = p.fwd[i] / scale(i); zMfe[i] = p.mfe[i] / scale(i); zMae[i] = p.mae[i] / scale(i); }
  const dates = [...new Set(lab.map((i) => p.time[i]))].sort((x, y) => x - y);
  const dateIndex = new Map(dates.map((d, i) => [d, i]));
  const between = (from: number, to: number) => lab.filter((i) => { const k = dateIndex.get(p.time[i])!; return k >= from && k < to; });

  // purged walk-forward: a gap of `horizon` days separates fit, calibration and test
  const minFit = 504, cal = 126, test = 126, splits: [number, number, number, number, number][] = [];
  for (let i = minFit + h + cal + h; i < dates.length; i += test) splits.push([i - h - cal - h, i - h - cal, i - h, i, Math.min(dates.length, i + test)]);
  if (!splits.length) throw new Error("Not enough history for walk-forward validation (need about 3 years)");
  const chosen = a.methods.filter((k) => METHODS[k] && k !== "base_rate");
  if (!chosen.length) chosen.push("logistic");
  const kinds = ["base_rate", ...chosen];
  const oos: Record<string, number[]> = { date: [], yTb: [], yUp: [], z: [], fold: [], q10: [], q90: [] };
  for (const k of kinds) oos[`tb_${k}`] = [], oos[`up_${k}`] = [], oos[`ret_${k}`] = [];
  const folds: unknown[] = [];
  splits.forEach(([fitEnd, calStart, calEnd, testStart, testEnd], fi) => {
    progress(0.1 + (0.65 * fi) / splits.length, `Walk-forward fold ${fi + 1}/${splits.length}`);
    const Frows = thin(between(0, fitEnd), MAX_FIT), Crows = thin(between(calStart, calEnd), MAX_CAL);
    const Trows = between(testStart, testEnd).filter((i) => dateIndex.get(p.time[i])! % 3 === 0);
    if (!Trows.length || Frows.length < 500) return;
    const F = slice(p, Frows), C = slice(p, Crows), T = slice(p, Trows);
    const tbF = F.pick(p.tbL), upF = F.pick(p.up), zF = F.pick(z), tbC = C.pick(p.tbL), upC = C.pick(p.up);
    const col_: Record<string, Float64Array> = {};
    for (const k of kinds) {
      if (k === "ensemble" && ENSEMBLE.every((m) => col_[`tb_${m}`])) {
        for (const pre of ["tb", "up", "ret"]) col_[`${pre}_ensemble`] = Float64Array.from({ length: T.n }, (_, i) => mean(ENSEMBLE.map((m) => col_[`${pre}_${m}`][i])));
        continue;
      }
      col_[`tb_${k}`] = predict(fitCalibrated(k, F, tbF, C, tbC), T.X, T.n);
      col_[`up_${k}`] = predict(fitCalibrated(k, F, upF, C, upC), T.X, T.n);
      col_[`ret_${k}`] = predict(fitRegressor(k, F.X, zF, F.n), T.X, T.n);
    }
    const q10 = predict(fitRegressor("gbm", F.X, zF, F.n, 0.1), T.X, T.n), q90 = predict(fitRegressor("gbm", F.X, zF, F.n, 0.9), T.X, T.n);
    Trows.forEach((r, i) => {
      oos.date.push(p.time[r]); oos.yTb.push(p.tbL[r]); oos.yUp.push(p.up[r]); oos.z.push(z[r]); oos.fold.push(fi + 1); oos.q10.push(q10[i]); oos.q90.push(q90[i]);
      for (const c of Object.keys(col_)) oos[c].push(col_[c][i]);
    });
    folds.push({ fold: fi + 1, train_end: day(dates[fitEnd - 1]), test_start: day(dates[testStart]), test_end: day(dates[testEnd - 1]), train_rows: between(0, fitEnd).length, test_rows: T.n });
  });
  if (!oos.date.length) throw new Error("Walk-forward validation produced no test rows");

  progress(0.78, "Scoring out-of-sample predictions");
  const models: Record<string, Record<string, unknown>> = {};
  for (const k of kinds) {
    const per = [...new Set(oos.fold)].flatMap((f) => {
      const rows = oos.fold.flatMap((v, i) => (v === f ? [i] : []));
      const cm = classMetrics(rows.map((i) => oos.yTb[i]), rows.map((i) => oos[`tb_${k}`][i]), rows.map((i) => oos.tb_base_rate[i]));
      return "auc" in cm ? [{ fold: f, test_start: day(Math.min(...rows.map((i) => oos.date[i]))), auc: +cm.auc!.toFixed(4), brier_skill: +cm.brier_skill!.toFixed(4) }] : [];
    });
    models[k] = { target_first: classMetrics(oos.yTb, oos[`tb_${k}`], oos.tb_base_rate), positive_return: classMetrics(oos.yUp, oos[`up_${k}`], oos.up_base_rate),
      expected_return: returnMetrics(oos.date, oos[`ret_${k}`], oos.z), per_fold: per };
  }
  const tf = (k: string) => models[k].target_first as { brier_skill?: number; auc?: number; ece?: number; n: number };
  const ic = (k: string) => (models[k].expected_return as { ic_mean: number | null }).ic_mean ?? -1;
  const champion = chosen.includes(a.selection) ? a.selection : chosen.reduce((x, y) => ((tf(y).brier_skill ?? -1) > (tf(x).brier_skill ?? -1) ? y : x));
  const cm = tf(champion);
  const gates = { brier_skill_gt_0: (cm.brier_skill ?? -1) > 0, "auc_gt_0.52": (cm.auc ?? 0) > 0.52, "ece_lt_0.05": (cm.ece ?? 1) < 0.05, oos_rows_ge_1000: cm.n >= 1000 };
  const passed = Object.values(gates).every(Boolean);
  const rel = passed ? reliabilityScore(cm) : Math.min(0.2, reliabilityScore(cm));
  const retK = chosen.reduce((x, y) => (ic(y) > ic(x) ? y : x));

  progress(0.82, "Fitting final models on full history");
  const F = slice(p, thin(between(0, dates.length - 126 - h), MAX_FIT)), C = slice(p, thin(between(dates.length - 126, dates.length), MAX_CAL)), All = slice(p, thin(lab, MAX_FIT));
  const three = (k: string) => ({ tb_long: fitCalibrated(k, F, F.pick(p.tbL), C, C.pick(p.tbL)), tb_short: fitCalibrated(k, F, F.pick(p.tbS), C, C.pick(p.tbS)), up: fitCalibrated(k, F, F.pick(p.up), C, C.pick(p.up)) });
  const main = three(champion), zAll = All.pick(z);
  const art: Artifact["models"] = { ...main, ret: fitRegressor(retK, All.X, zAll, All.n), q10: fitRegressor("gbm", All.X, zAll, All.n, 0.1), q90: fitRegressor("gbm", All.X, zAll, All.n, 0.9),
    mfe: fitRegressor("gbm", All.X, All.pick(zMfe), All.n), mae: fitRegressor("gbm", All.X, All.pick(zMae), All.n), by_method: {} };
  progress(0.9, "Fitting every method for side-by-side forecasts");
  for (const k of chosen) {
    if (k === champion) art.by_method[k] = main;
    else if (k === "ensemble" && ENSEMBLE.every((m) => art.by_method[m])) art.by_method[k] = { tb_long: { k: "avg", m: ENSEMBLE.map((m) => art.by_method[m].tb_long) }, tb_short: { k: "avg", m: ENSEMBLE.map((m) => art.by_method[m].tb_short) }, up: { k: "avg", m: ENSEMBLE.map((m) => art.by_method[m].up) } };
    else art.by_method[k] = three(k);
  }
  progress(0.96, "Computing feature importance");
  const lastSplit = splits[splits.length - 1], S = slice(p, thin(between(lastSplit[3], lastSplit[4]), 1000)), ys = S.pick(p.tbL), r = rng(1);
  const brier = (X: Float64Array) => mean(predict(art.tb_long, X, S.n).map((v, i) => (v - ys[i]) ** 2));
  const baseB = brier(S.X);
  const feature_importance = FEATURES.map((feature, f) => {
    const X = S.X.slice();
    for (let i = S.n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)), a0 = X[i * NF + f]; X[i * NF + f] = X[j * NF + f]; X[j * NF + f] = a0; }
    return { feature, importance: brier(X) - baseB };
  }).sort((x, y) => y.importance - x.importance);
  const seen = oos.q10.map((q, i) => [Math.min(q, oos.q90[i]), Math.max(q, oos.q90[i])]);
  const metrics = clean({
    folds, models, oos_rows: oos.date.length, oos_start: day(Math.min(...oos.date)), oos_end: day(Math.max(...oos.date)), data_problems: a.problems,
    interval_80_coverage: mean(oos.z.map((v, i) => +(v >= seen[i][0] && v <= seen[i][1]))),
    champion, return_model: retK, selection: a.selection, methods: kinds, method_info: Object.fromEntries(kinds.map((k) => [k, METHODS[k]])), gates, passed, reliability: rel,
    baseline_comparison: Object.fromEntries(kinds.map((k) => [k, { brier_skill: tf(k).brier_skill ?? null, auc: tf(k).auc ?? null, ic: ic(k) }])), feature_importance,
    label_base_rates: { target_first_long: mean(lab.map((i) => p.tbL[i])), target_first_short: mean(lab.map((i) => p.tbS[i])), positive_return: mean(lab.map((i) => p.up[i])) },
    train_rows: lab.length, trained_through: day(dates[dates.length - 1]), duration_s: +((performance.now() - t0) / 1000).toFixed(1),
  });
  const artifact: Artifact = { models: art, champion, passed, reliability: rel, source: a.source, run_id: a.runId, trained_through: metrics.trained_through, horizon_days: h, barrier_target_atr: kt, barrier_stop_atr: ks };
  return { metrics, artifact };
}

/** One forecast per symbol from each symbol's last completed bar. */
export function forecastAll(art: Artifact, bars: Bars, spy: Candle[]) {
  const h = art.horizon_days, p = buildPanel(bars, spy, h, art.barrier_target_atr, art.barrier_stop_atr, false);
  const out: Record<string, Record<string, unknown> & { exp_return: number }> = {};
  if (!p) return out;
  const lastRow = new Map<number, number>();
  for (let i = 0; i < p.n; i++) lastRow.set(p.sym[i], i);
  const rows = [...lastRow.values()], S = slice(p, rows), m = art.models;
  const scale = rows.map((r) => Math.max(p.vol20[r], 0.05) * Math.sqrt(h / 252));
  const pr = (x: Model) => predict(x, S.X, S.n);
  const up = pr(m.up), tl = pr(m.tb_long), ts = pr(m.tb_short), ret = pr(m.ret), q1 = pr(m.q10), q9 = pr(m.q90), mfe = pr(m.mfe), mae = pr(m.mae);
  const per = Object.entries(m.by_method).map(([k, v]) => [k, pr(v.up), pr(v.tb_long), pr(v.tb_short)] as const);
  rows.forEach((r, i) => {
    const a = q1[i] * scale[i], b = q9[i] * scale[i], lo = Math.min(a, b), hi = Math.max(a, b), sym = p.symbols[p.sym[r]];
    out[sym] = { symbol: sym, asof: new Date(p.time[r] * 1000).toISOString(), price_asof: p.close[r], horizon_days: h, model: art.champion, model_run_id: art.run_id, validated: art.passed, reliability: art.reliability, source: art.source,
      p_up: up[i], p_target_first_long: tl[i], p_target_first_short: ts[i], exp_return: ret[i] * scale[i], q10: lo, q90: hi, uncertainty: hi - lo, exp_volatility: p.vol20[r] * Math.sqrt(h / 252),
      exp_favorable_excursion: Math.max(0, mfe[i] * scale[i]), exp_adverse_excursion: Math.min(0, mae[i] * scale[i]), potential_downside: lo, barrier_target_atr: art.barrier_target_atr, barrier_stop_atr: art.barrier_stop_atr, atr_pct: p.atrp[r],
      by_method: Object.fromEntries(per.map(([k, u, l, s]) => [k, { p_up: u[i], p_target_first_long: l[i], p_target_first_short: s[i] }])) };
  });
  return out;
}

/* ------------------------------------------------------------------ backtester */
export const STRATEGIES: Record<string, { key: string; name: string; description: string; params: Record<string, number>; exit_rule: string; long_short: string; tags: string[] }> = {
  momentum: { key: "momentum", name: "Cross-sectional momentum", description: "Buys stocks in the top fraction of the universe by 6-month return (skipping the most recent week) that are above their 200-day average; shorts the bottom fraction below it when shorting is enabled.",
    params: { top_pct: 0.2, lookback: 126 }, exit_rule: "ATR stop/target or max holding period", long_short: "long/short", tags: ["technical", "trend"] },
  mean_reversion: { key: "mean_reversion", name: "Short-term mean reversion", description: "Buys when 2-day RSI is deeply oversold while the stock is above its 200-day average (pullback in an uptrend); the mirror for shorts. Exits early when RSI(2) recovers.",
    params: { rsi2_entry: 10, rsi2_exit: 70 }, exit_rule: "RSI(2) recovery, ATR stop/target or max hold", long_short: "long/short", tags: ["statistical"] },
  trend: { key: "trend", name: "Trend following", description: "Enters when EMA20 > EMA50 > SMA200 becomes aligned with ADX above a threshold (strong, established trend).",
    params: { adx_min: 25 }, exit_rule: "ATR stop/target or max hold", long_short: "long/short", tags: ["technical", "trend"] },
  breakout: { key: "breakout", name: "Channel breakout", description: "Enters when price closes beyond the prior N-day high (low) on volume at least a multiple of its 20-day average.",
    params: { channel: 20, volume_mult: 1.5 }, exit_rule: "ATR stop/target or max hold", long_short: "long/short", tags: ["technical"] },
  ml_forecast: { key: "ml_forecast", name: "ML forecast (walk-forward)", description: "Re-trains a calibrated logistic model every quarter using only data available at that time (purged windows), then trades when the calibrated probability of reaching the target before the stop exceeds the training base rate by a margin. Every trade is out-of-sample.",
    params: { min_prob_edge: 0.03 }, exit_rule: "ATR barrier stop/target or max hold", long_short: "long/short", tags: ["ml"] },
};

interface Sig { long: boolean[]; short: boolean[]; score: number[]; exitLong?: boolean[]; exitShort?: boolean[] }
function ruleSignals(key: string, bars: Bars, params: Record<string, number>) {
  const out: Record<string, Sig> = {};
  if (key === "momentum") {
    const lb = params.lookback, top = params.top_pct, rank = new Map<string, number>();
    const byDate = new Map<number, [string, number][]>();
    for (const [s, b] of Object.entries(bars)) b.forEach((k, i) => { if (i >= lb) (byDate.get(k.time) ?? byDate.set(k.time, []).get(k.time)!).push([s, Math.log(b[i - 5].close / b[i - lb].close)]); });
    for (const [t, rows] of byDate) { rows.sort((a, b) => a[1] - b[1]); rows.forEach(([s], r) => rank.set(`${s}:${t}`, (r + 1) / rows.length)); }
    for (const [s, b] of Object.entries(bars)) {
      const c = b.map((k) => k.close), s200 = smaN(c, 200), r = b.map((k) => rank.get(`${s}:${k.time}`) ?? NaN);
      out[s] = { long: r.map((v, i) => v >= 1 - top && c[i] > s200[i] && !(r[i - 1] >= 1 - top)), short: r.map((v, i) => v <= top && !(c[i] > s200[i]) && !(r[i - 1] <= top)), score: r.map((v) => Math.abs(v - 0.5) || 0) };
    }
  } else if (key === "mean_reversion") {
    const e = params.rsi2_entry, x = params.rsi2_exit;
    for (const [s, b] of Object.entries(bars)) {
      const c = b.map((k) => k.close), r2 = rsiN(c, 2), s200 = smaN(c, 200);
      out[s] = { long: r2.map((v, i) => v < e && c[i] > s200[i]), short: r2.map((v, i) => v > 100 - e && !(c[i] > s200[i])), score: r2.map((v) => Math.abs(50 - v) / 50 || 0), exitLong: r2.map((v) => v > x), exitShort: r2.map((v) => v < 100 - x) };
    }
  } else if (key === "trend") {
    for (const [s, b] of Object.entries(bars)) {
      const c = b.map((k) => k.close), e20 = emaN(c, 20), e50 = emaN(c, 50), s200 = smaN(c, 200), a = adxN(b);
      const up = c.map((_, i) => e20[i] > e50[i] && e50[i] > s200[i] && a[i] > params.adx_min), dn = c.map((_, i) => e20[i] < e50[i] && e50[i] < s200[i] && a[i] > params.adx_min);
      out[s] = { long: up.map((v, i) => v && !up[i - 1]), short: dn.map((v, i) => v && !dn[i - 1]), score: a.map((v) => v / 100 || 0) };
    }
  } else if (key === "breakout") {
    const n = params.channel, vm = params.volume_mult;
    for (const [s, b] of Object.entries(bars)) {
      const hi = rollMax(b.map((k) => k.high), n), lo = rollMin(b.map((k) => k.low), n), av = smaN(b.map((k) => k.volume), 20);
      const vr = b.map((k, i) => (i ? k.volume / av[i - 1] : NaN));
      out[s] = { long: b.map((k, i) => i > 0 && k.close > hi[i - 1] && vr[i] > vm), short: b.map((k, i) => i > 0 && k.close < lo[i - 1] && vr[i] > vm), score: vr.map((v) => v / 5 || 0) };
    }
  }
  return out;
}

function mlSignals(bars: Bars, spy: Candle[], h: number, kt: number, ks: number, edge: number, start: number, progress: Progress) {
  const p = buildPanel(bars, spy, h, kt, ks), out: Record<string, Sig> = {};
  if (!p) return out;
  const lab: number[] = [];
  for (let i = 0; i < p.n; i++) if (Number.isFinite(p.tbL[i]) && Number.isFinite(p.vol20[i])) lab.push(i);
  const dates = [...new Set(p.time)].sort((a, b) => a - b), test = dates.filter((d) => d >= start);
  const edges = new Map<string, [number, number]>();
  const chunks = Math.ceil(test.length / 63);
  for (let c = 0; c < chunks; c++) {
    const chunk = new Set(test.slice(c * 63, c * 63 + 63)), t0 = test[c * 63], idx = dates.indexOf(t0);
    const calEnd = dates[Math.max(0, idx - h)], calStart = dates[Math.max(0, idx - h - 126)], fitEnd = dates[Math.max(0, idx - 2 * h - 126)];
    const Fr = lab.filter((i) => p.time[i] < fitEnd), Cr = lab.filter((i) => p.time[i] >= calStart && p.time[i] < calEnd);
    progress(0.1 + (0.4 * c) / chunks);
    if (Fr.length < 2000 || Cr.length < 200) continue;
    const F = slice(p, thin(Fr, MAX_FIT)), C = slice(p, thin(Cr, MAX_CAL)), Tr: number[] = [];
    for (let i = 0; i < p.n; i++) if (chunk.has(p.time[i])) Tr.push(i);
    const T = slice(p, Tr), yl = F.pick(p.tbL), ys = F.pick(p.tbS);
    const pl = predict(fitCalibrated("logistic", F, yl, C, C.pick(p.tbL)), T.X, T.n), ps = predict(fitCalibrated("logistic", F, ys, C, C.pick(p.tbS)), T.X, T.n);
    const bl = mean(yl), bs = mean(ys);
    Tr.forEach((r, i) => edges.set(`${p.symbols[p.sym[r]]}:${p.time[r]}`, [pl[i] - bl, ps[i] - bs]));
  }
  for (const [s, b] of Object.entries(bars)) {
    const e = b.map((k) => edges.get(`${s}:${k.time}`));
    out[s] = { long: e.map((v) => !!v && v[0] > edge), short: e.map((v) => !!v && v[1] > edge), score: e.map((v) => (v ? Math.max(v[0], v[1]) : 0)) };
  }
  return out;
}

export interface BtConfig {
  strategy: string; params?: Record<string, number> | null; symbols?: string[] | null; start?: string | null; end?: string | null; initial_capital: number; risk_per_trade_pct: number; max_position_pct: number; max_positions: number;
  stop_atr: number; target_atr: number; max_hold_days: number; slippage_bps: number; spread_bps: number; commission_per_share: number; allow_short: boolean; oos_fraction: number;
}
interface Trade { symbol: string; side: string; entry_date: string; exit_date: string; entry: number; exit: number; qty: number; pnl: number; gross_pnl: number; return_pct: number; r_multiple: number | null; bars: number; exit_reason: string }

function perfMetrics(eq: { date: string; v: number }[], trades: Trade[], initial: number, costs: number | null, exposure: number[] | null): Record<string, unknown> {
  if (eq.length < 2) return {};
  const e = eq.map((x) => x.v), r = e.slice(1).map((v, i) => v / e[i] - 1), total = e[0] ? e[e.length - 1] / e[0] - 1 : 0, years = Math.max(1 / 252, e.length / 252);
  let peak = -Infinity, dd = 0;
  for (const v of e) { peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); }
  const down = r.filter((v) => v < 0), pnl = trades.map((t) => t.pnl), wins = pnl.filter((v) => v > 0), losses = pnl.filter((v) => v <= 0), sum = (a: number[]) => a.reduce((s, v) => s + v, 0), sd = std(r);
  const m: Record<string, unknown> = {
    start: eq[0].date, end: eq[eq.length - 1].date, total_return_pct: total * 100, cagr_pct: total > -1 ? ((1 + total) ** (1 / years) - 1) * 100 : -100, max_drawdown_pct: dd * 100,
    sharpe: sd > 0 ? (mean(r) / sd) * Math.sqrt(252) : 0, sortino: down.length > 1 && std(down) > 0 ? (mean(r) / std(down)) * Math.sqrt(252) : 0, volatility_pct: sd * Math.sqrt(252) * 100, trades: pnl.length,
    win_rate_pct: pnl.length ? (wins.length / pnl.length) * 100 : null, profit_factor: losses.length && sum(losses) < 0 ? sum(wins) / -sum(losses) : null, expectancy: pnl.length ? mean(pnl) : null,
    expectancy_r: trades.length ? mean(trades.flatMap((t) => (t.r_multiple == null ? [] : [t.r_multiple]))) : null, avg_win: wins.length ? mean(wins) : null, avg_loss: losses.length ? mean(losses) : null,
    avg_bars_held: trades.length ? mean(trades.map((t) => t.bars)) : null, net_profit: e[e.length - 1] - initial,
  };
  if (costs !== null) { m.costs_paid = costs; m.gross_profit_before_costs = (m.net_profit as number) + costs; }
  if (exposure) m.avg_exposure_pct = mean(exposure.map((x, i) => x / e[i])) * 100;
  return m;
}

export function backtest(cfg: BtConfig, allBars: Bars, spy: Candle[], progress: Progress) {
  const syms = (cfg.symbols?.length ? cfg.symbols : Object.keys(allBars)).filter((s) => allBars[s]?.length > 250);
  const bars = Object.fromEntries(syms.map((s) => [s, allBars[s]]));
  const dateStr = spy.map((k) => day(k.time));
  const start = cfg.start ?? dateStr[Math.min(dateStr.length - 1, 252)], end = cfg.end ?? dateStr[dateStr.length - 1];
  const params = { ...STRATEGIES[cfg.strategy].params, ...(cfg.params ?? {}) };
  const startT = spy.find((k) => day(k.time) >= start)?.time ?? spy[spy.length - 1].time;
  const sig = cfg.strategy === "ml_forecast" ? mlSignals(bars, spy, cfg.max_hold_days, cfg.target_atr, cfg.stop_atr, params.min_prob_edge, startT, progress) : ruleSignals(cfg.strategy, bars, params);
  const atr = Object.fromEntries(syms.map((s) => [s, atrN(bars[s])]));
  const at = Object.fromEntries(syms.map((s) => [s, new Map(bars[s].map((k, i) => [k.time, i]))]));
  const days = spy.filter((k) => { const d = day(k.time); return d >= start && d <= end; });
  if (days.length < 20) throw new Error("Backtest window is too short (need at least 20 trading days)");
  const cost = (cfg.spread_bps / 2 + cfg.slippage_bps) / 1e4;
  let cash = cfg.initial_capital, costs = 0;
  interface Pos { qty: number; entry: number; stop: number; target: number; entryT: number; held: number; last: number; comm: number; risk: number; exitNext?: boolean }
  const pos: Record<string, Pos> = {};
  let pending: { symbol: string; sgn: number; score: number; atr: number }[] = [];
  const trades: Trade[] = [], equity: { date: string; v: number }[] = [], exposure: number[] = [];
  days.forEach((d, i) => {
    if (i % 50 === 0) progress(0.5 + (0.45 * i) / days.length);
    const barOf = (s: string) => { const j = at[s].get(d.time); return j === undefined ? null : bars[s][j]; };
    for (const p of pending) {
      const b = barOf(p.symbol);
      if (!b) continue;
      const px = b.open * (1 + p.sgn * cost), stop = px - p.sgn * cfg.stop_atr * p.atr, target = px + p.sgn * cfg.target_atr * p.atr;
      const eqNow = cash + Object.entries(pos).reduce((s, [x, q]) => s + q.qty * (barOf(x)?.open ?? q.last), 0);
      const shortV = Object.values(pos).reduce((s, q) => s + (q.qty < 0 ? -q.qty * q.last : 0), 0);
      const qty = Math.floor(Math.min(((eqNow * cfg.risk_per_trade_pct) / 100) / Math.max(1e-9, Math.abs(px - stop)), (eqNow * cfg.max_position_pct) / 100 / px, Math.max(0, cash - shortV) / px));
      if (qty < 1) continue;
      const comm = cfg.commission_per_share * qty;
      cash -= p.sgn * qty * px + comm;
      costs += qty * b.open * cost + comm;
      pos[p.symbol] = { qty: p.sgn * qty, entry: px, stop, target, entryT: d.time, held: 0, last: px, comm, risk: Math.abs(px - stop) * qty };
    }
    pending = [];
    for (const s of Object.keys(pos)) {
      const b = barOf(s);
      if (!b) continue;
      const q = pos[s], sgn = q.qty > 0 ? 1 : -1, first = q.entryT === d.time;
      let px: number | null = null, why = "";
      if (q.exitNext) { px = b.open; why = "signal exit"; }
      else if (sgn > 0) {
        if (!first && b.open <= q.stop) { px = b.open; why = "stop (gap)"; }
        else if (b.low <= q.stop) { px = q.stop; why = "stop"; }
        else if (!first && b.open >= q.target) { px = b.open; why = "target (gap)"; }
        else if (b.high >= q.target) { px = q.target; why = "target"; }
      } else {
        if (!first && b.open >= q.stop) { px = b.open; why = "stop (gap)"; }
        else if (b.high >= q.stop) { px = q.stop; why = "stop"; }
        else if (!first && b.open <= q.target) { px = b.open; why = "target (gap)"; }
        else if (b.low <= q.target) { px = q.target; why = "target"; }
      }
      if (px === null) {
        q.held++;
        const ex = sgn > 0 ? sig[s]?.exitLong : sig[s]?.exitShort;
        if (ex?.[at[s].get(d.time)!]) q.exitNext = true;      // decided at today's close, executed at tomorrow's open
        if (q.held >= cfg.max_hold_days) { px = b.close; why = "time exit"; }
      }
      q.last = b.close;
      if (px !== null) {
        const fill = px * (1 - sgn * cost), qty = Math.abs(q.qty), comm = cfg.commission_per_share * qty;
        cash += sgn * qty * fill - comm;
        costs += qty * px * cost + comm;
        const net = (fill - q.entry) * q.qty - comm - q.comm;
        trades.push({ symbol: s, side: sgn > 0 ? "long" : "short", entry_date: day(q.entryT), exit_date: day(d.time), entry: +q.entry.toFixed(4), exit: +fill.toFixed(4), qty, pnl: +net.toFixed(2), gross_pnl: +((px - q.entry) * q.qty).toFixed(2),
          return_pct: +(((fill / q.entry - 1) * sgn) * 100).toFixed(3), r_multiple: q.risk ? +(net / q.risk).toFixed(3) : null, bars: q.held + 1, exit_reason: why });
        delete pos[s];
      }
    }
    const open = Object.values(pos);
    equity.push({ date: day(d.time), v: cash + open.reduce((s, q) => s + q.qty * q.last, 0) });
    exposure.push(open.reduce((s, q) => s + Math.abs(q.qty * q.last), 0));
    if (i === days.length - 1) return;
    const slots = cfg.max_positions - open.length;
    if (slots <= 0) return;
    const cands: typeof pending = [];
    for (const s of Object.keys(sig)) {
      const j = at[s]?.get(d.time);
      if (pos[s] || j === undefined) continue;
      const a = atr[s][j];
      if (!Number.isFinite(a)) continue;
      if (sig[s].long[j]) cands.push({ symbol: s, sgn: 1, score: sig[s].score[j], atr: a });
      else if (cfg.allow_short && sig[s].short[j]) cands.push({ symbol: s, sgn: -1, score: sig[s].score[j], atr: a });
    }
    pending = cands.sort((a, b) => b.score - a.score).slice(0, slots);
  });
  const open0 = days[0].open, bench = days.map((k) => (cfg.initial_capital * k.close) / open0);
  const benchEq = equity.map((x, i) => ({ date: x.date, v: bench[i] }));
  let peak = -Infinity;
  const curve = equity.map((x, i) => { peak = Math.max(peak, x.v); return { date: x.date, equity: +x.v.toFixed(2), benchmark: +bench[i].toFixed(2), drawdown: +(x.v / peak - 1).toFixed(4) }; });
  const years = [...new Set(equity.map((x) => x.date.slice(0, 4)))];
  const by_year = years.flatMap((y) => {
    const g = equity.filter((x) => x.date.startsWith(y)).map((x) => x.v);
    if (g.length < 5) return [];
    const tr = trades.filter((t) => t.exit_date.startsWith(y));
    let p = -Infinity, dd = 0;
    for (const v of g) { p = Math.max(p, v); dd = Math.min(dd, v / p - 1); }
    return [{ year: +y, return_pct: (g[g.length - 1] / g[0] - 1) * 100, max_drawdown_pct: dd * 100, trades: tr.length, win_rate_pct: tr.length ? (tr.filter((t) => t.pnl > 0).length / tr.length) * 100 : null }];
  });
  const res: Record<string, unknown> = { metrics: perfMetrics(equity, trades, cfg.initial_capital, costs, exposure), benchmark: perfMetrics(benchEq, [], cfg.initial_capital, 0, null), by_year, params };
  if (cfg.oos_fraction > 0 && cfg.oos_fraction < 1 && cfg.strategy !== "ml_forecast") {
    const split = equity[Math.floor(equity.length * (1 - cfg.oos_fraction))].date, before = equity.filter((x) => x.date < split);
    res.in_sample = perfMetrics(before, trades.filter((t) => t.entry_date < split), cfg.initial_capital, null, null);
    res.out_of_sample = perfMetrics(equity.filter((x) => x.date >= split), trades.filter((t) => t.entry_date >= split), before.length ? before[before.length - 1].v : cfg.initial_capital, null, null);
    res.split_date = split;
  }
  return clean({ results: res, equity: curve, trades });
}

/* ------------------------------------------------------------------ turbo simulator */
export interface TurboConfig {
  mode: string; strategy: string; markets: number; symbols: number; years: number; pattern_strength: string; horizon_days: number; stop_atr: number; target_atr: number; min_prob_edge: number; max_positions: number;
  risk_per_trade_pct: number; max_position_pct: number; slippage_bps: number; spread_bps: number; allow_short: boolean; starting_cash: number; seed: number | null;
}
export const TURBO_DEFAULTS: TurboConfig = { mode: "monte_carlo", strategy: "ai", markets: 20, symbols: 200, years: 8, pattern_strength: "weak", horizon_days: 10, stop_atr: 1.5, target_atr: 2, min_prob_edge: 0.03, max_positions: 20,
  risk_per_trade_pct: 0.5, max_position_pct: 10, slippage_bps: 5, spread_bps: 3, allow_short: false, starting_cash: 100_000, seed: null };

interface Market { D: number; S: number; open: Float64Array; high: Float64Array; low: Float64Array; close: Float64Array }
const STRENGTH: Record<string, [number, number]> = { none: [0, 0], weak: [0.0002, 0.06], medium: [0.00035, 0.1] };

function syntheticMarket(S: number, D: number, seed: number, strength: string): Market {
  const r = rng(seed), [driftSd, rev] = STRENGTH[strength] ?? STRENGTH.weak;
  const P = [[0.985, 0.012, 0.003], [0.02, 0.97, 0.01], [0.02, 0.03, 0.95]], muR = [0.0003, -0.0001, -0.0014], volR = [0.008, 0.011, 0.022];
  const beta = Array.from({ length: S }, () => 0.7 + 0.8 * r()), ivol = Array.from({ length: S }, () => 0.008 + 0.014 * r()), base = Array.from({ length: S }, () => 20 + 180 * r());
  const tdist = () => { let chi = 0; for (let i = 0; i < 5; i++) chi += gauss(r) ** 2; return gauss(r) / Math.sqrt(chi / 5); };
  const m: Market = { D, S, open: new Float64Array(D * S), high: new Float64Array(D * S), low: new Float64Array(D * S), close: new Float64Array(D * S) };
  const drift = new Float64Array(S), prev = new Float64Array(S), lc = base.map(Math.log);
  let reg = 0;
  for (let t = 0; t < D; t++) {
    if (t) { const u = r(), row = P[reg]; reg = u < row[0] ? 0 : u < row[0] + row[1] ? 1 : 2; }
    const mkt = muR[reg] + (volR[reg] * tdist()) / Math.sqrt(5 / 3), hot = reg === 2 ? 1.6 : 1;
    for (let s = 0; s < S; s++) {
      drift[s] = 0.985 * drift[s] + driftSd * gauss(r);
      const resid = gauss(r) * ivol[s] * hot - rev * prev[s];
      prev[s] = resid;
      const ret = beta[s] * mkt + drift[s] + resid, i = t * S + s;
      lc[s] += ret;
      const close = Math.exp(lc[s]), open = t ? m.close[i - S] * Math.exp(0.003 * gauss(r)) : base[s], span = Math.abs(ret) + Math.abs(0.006 * gauss(r));
      m.close[i] = close; m.open[i] = open;
      m.high[i] = Math.max(open, close) * (1 + span * r());
      m.low[i] = Math.min(open, close) * (1 - span * r());
    }
  }
  return m;
}

function historyMarket(bars: Bars): Market {
  const syms = Object.keys(bars).filter((s) => bars[s].length > 300);
  if (syms.length < 5) throw new Error("Not enough history for the universe (need at least 5 stocks with 300+ days).");
  const sets = syms.map((s) => new Map(bars[s].map((k) => [k.time, k])));
  const days = [...sets[0].keys()].filter((t) => sets.every((m) => m.has(t))).sort((a, b) => a - b);
  const D = days.length, S = syms.length, m: Market = { D, S, open: new Float64Array(D * S), high: new Float64Array(D * S), low: new Float64Array(D * S), close: new Float64Array(D * S) };
  days.forEach((t, d) => sets.forEach((set, s) => { const k = set.get(t)!, i = d * S + s; m.open[i] = k.open; m.high[i] = k.high; m.low[i] = k.low; m.close[i] = k.close; }));
  return m;
}

function turboFeatures(m: Market) {
  const { D, S, close: c, high: h, low: l } = m, n = D * S;
  const mom = new Float64Array(n).fill(NaN), rev = new Float64Array(n).fill(NaN), rs = new Float64Array(n).fill(NaN), trend = new Float64Array(n).fill(NaN), atr = new Float64Array(n).fill(NaN);
  const sumC = new Float64Array(S), sumT = new Float64Array(S), trs = new Float64Array(n);
  for (let t = 0; t < D; t++) {
    let xs = 0, xn = 0;
    for (let s = 0; s < S; s++) {
      const i = t * S + s;
      trs[i] = t ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - S]), Math.abs(l[i] - c[i - S])) : h[i] - l[i];
      sumC[s] += c[i]; sumT[s] += trs[i];
      if (t >= 200) sumC[s] -= c[i - 200 * S];
      if (t >= 14) sumT[s] -= trs[i - 14 * S];
      if (t >= 13) atr[i] = sumT[s] / 14;
      if (t >= 199) trend[i] = c[i] / (sumC[s] / 200) - 1;
      if (t >= 126) mom[i] = Math.log(c[i - 5 * S] / c[i - 126 * S]);
      if (t >= 1) rev[i] = Math.log(c[i] / c[i - S]);
      if (t >= 63) { rs[i] = Math.log(c[i] / c[i - 63 * S]); xs += rs[i]; xn++; }
    }
    if (xn) for (let s = 0; s < S; s++) rs[t * S + s] -= xs / xn;
  }
  return { mom, rev, rs, trend, atr };
}

/** First touch of stop or target for one trade entered at open[t+1]. The stop wins a same-bar tie. */
function firstTouch(m: Market, t: number, s: number, sgn: number, atr: number, c: TurboConfig) {
  const S = m.S, h = c.horizon_days, side = (c.spread_bps / 2 + c.slippage_bps) / 1e4;
  const entry = m.open[(t + 1) * S + s] * (1 + sgn * side), stop = entry - sgn * c.stop_atr * atr, tgt = entry + sgn * c.target_atr * atr;
  let k = h, reason = 2, px = 0;
  for (let j = 0; j < h; j++) {
    const i = (t + 1 + j) * S + s, hi = m.high[i], lo = m.low[i], o = m.open[i];
    const hs = sgn > 0 ? lo <= stop : hi >= stop, ht = sgn > 0 ? hi >= tgt : lo <= tgt;
    if (!hs && !ht) continue;
    k = j; reason = hs ? 0 : 1;
    const level = hs ? stop : tgt, gap = j > 0 && (hs ? (sgn > 0 ? o <= stop : o >= stop) : sgn > 0 ? o >= tgt : o <= tgt);
    px = gap ? o : level;
    break;
  }
  if (reason === 2) { k = h - 1; px = m.close[(t + h) * S + s]; }
  const fill = px * (1 - sgn * side), ret = (fill / entry - 1) * sgn;
  return { exitDay: t + 1 + k, ret, r: (ret * entry) / Math.abs(entry - stop), reason, stopDist: Math.abs(entry - stop) / entry, entry, fill };
}

function aiEdges(F: ReturnType<typeof turboFeatures>, m: Market, c: TurboConfig, start: number) {
  const { D, S } = m, h = c.horizon_days, n = D * S, X = new Float64Array(n * NF);
  const ok = new Uint8Array(n), idx: number[] = [];
  for (let i = 0; i < n; i++) {
    X[i * NF] = F.mom[i]; X[i * NF + 1] = F.rev[i]; X[i * NF + 2] = F.rs[i]; X[i * NF + 3] = F.trend[i];
    ok[i] = +(Number.isFinite(F.mom[i]) && Number.isFinite(F.rev[i]) && Number.isFinite(F.rs[i]) && Number.isFinite(F.trend[i]) && Number.isFinite(F.atr[i]));
    if (ok[i] && Math.floor(i / S) < D - h - 1) idx.push(i);
  }
  const edgeL = new Float64Array(n).fill(NaN), edgeS = new Float64Array(n).fill(NaN);
  if (!idx.length) return { edgeL, edgeS };
  const label = (i: number, sgn: number) => +(firstTouch(m, Math.floor(i / S), i % S, sgn, F.atr[i], c).reason === 1);
  const labL = new Float64Array(n), labS = new Float64Array(n);
  for (const i of idx) { labL[i] = label(i, 1); if (c.allow_short) labS[i] = label(i, -1); }
  const cols = [0, 1, 2, 3], r = rng(start + 11);
  for (let c0 = start; c0 < D - 1; c0 += 63) {
    const c1 = Math.min(D - 1, c0 + 63);
    let train = idx.filter((i) => Math.floor(i / S) < c0 - h - 1);
    if (train.length < 2000) continue;
    if (train.length > 6000) train = [...train.slice(-3000), ...Array.from({ length: 3000 }, () => train[Math.floor(r() * (train.length - 3000))])];
    const Xt = take(X, train), rows: number[] = [];
    for (let t = c0; t < c1; t++) for (let s = 0; s < S; s++) if (ok[t * S + s]) rows.push(t * S + s);
    if (!rows.length) continue;
    const Xr = take(X, rows);
    for (const [lab, out] of c.allow_short ? [[labL, edgeL], [labS, edgeS]] : [[labL, edgeL]]) {
      const y = train.map((i) => lab[i]), base = mean(y);
      if (base === 0 || base === 1) continue;
      const p = predict(fitLinear(Xt, y, train.length, cols, 1, true, 5), Xr, rows.length);
      rows.forEach((i, j) => { out[i] = p[j] - base; });
    }
  }
  return { edgeL, edgeS };
}

function simulateMarket(m: Market, c: TurboConfig, r: () => number) {
  const { D, S } = m, F = turboFeatures(m), h = c.horizon_days, start = c.strategy === "ai" ? Math.max(260, Math.floor(D * 0.3)) : 220;
  const tSig = performance.now();
  const cands: { t: number; s: number; sgn: number; score: number }[] = [];
  const dayQ = (a: Float64Array, t: number, q: number[]) => { const v = sortedNums(a.subarray(t * S, (t + 1) * S)); return q.map((x) => quantile(v, x)); };
  const edges = c.strategy === "ai" ? aiEdges(F, m, c, start) : null;
  for (let t = start; t < D - h - 1; t++) {
    const [lo, hi] = c.strategy === "momentum" ? dayQ(F.mom, t, [0.1, 0.9]) : c.strategy === "reversal" ? dayQ(F.rev, t, [0.05, 0.95]) : [0, 0];
    const pRand = Math.min(1, (c.max_positions / Math.max(1, S) / Math.max(1, h)) * 3);
    for (let s = 0; s < S; s++) {
      const i = t * S + s;
      if (!(F.atr[i] > 0)) continue;
      let sgn = 0, score = 0;
      if (edges) {
        if (edges.edgeL[i] >= c.min_prob_edge) { sgn = 1; score = edges.edgeL[i]; }
        else if (c.allow_short && edges.edgeS[i] >= c.min_prob_edge) { sgn = -1; score = edges.edgeS[i]; }
      } else if (c.strategy === "momentum") {
        if (F.mom[i] >= hi && F.trend[i] > 0) sgn = 1;
        else if (c.allow_short && F.mom[i] <= lo && F.trend[i] < 0) sgn = -1;
        score = Math.abs(F.mom[i]) || 0;
      } else if (c.strategy === "reversal") {
        if (F.rev[i] <= lo && F.trend[i] > 0) sgn = 1;
        else if (c.allow_short && F.rev[i] >= hi && F.trend[i] < 0) sgn = -1;
        score = Math.abs(F.rev[i]) || 0;
      } else {
        if (r() < pRand) sgn = 1;
        else if (c.allow_short && r() < pRand) sgn = -1;
        score = r();
      }
      if (sgn) cands.push({ t, s, sgn, score });
    }
  }
  const signal_s = (performance.now() - tSig) / 1000, t0 = performance.now();
  const empty = { trades: 0, candidates: 0, engine_s: 0, signal_s, days: D - start, start_cash: c.starting_cash, final_value: c.starting_cash, profit: 0, tape: [] as unknown[], r_values: [] as number[], equity: [1] };
  if (!cands.length) return empty;
  cands.sort((a, b) => a.t - b.t || b.score - a.score);
  const busy = new Map<number, number>();
  let active: number[] = [];
  const picks: (typeof cands[number] & ReturnType<typeof firstTouch>)[] = [];
  for (const q of cands) {
    const entryDay = q.t + 1;
    if ((busy.get(q.s) ?? -1) >= entryDay) continue;
    active = active.filter((x) => x >= entryDay);
    if (active.length >= c.max_positions) continue;
    const ex = firstTouch(m, q.t, q.s, q.sgn, F.atr[q.t * S + q.s], c);
    busy.set(q.s, ex.exitDay); active.push(ex.exitDay);
    picks.push({ ...q, ...ex });
  }
  const engine_s = (performance.now() - t0) / 1000 + 1e-9, risk = c.risk_per_trade_pct / 100;
  const scaleOf = (p: { stopDist: number }) => Math.min(1, c.max_position_pct / 100 / (risk / Math.max(p.stopDist, 1e-6)));
  const daily = new Float64Array(D);
  for (const p of picks) daily[p.exitDay] += p.r * risk * scaleOf(p);
  const eq: number[] = [];
  let v = 1, peak = 1, dd = 0;
  for (let t = start; t < D; t++) { v *= 1 + Math.max(daily[t], -0.99); eq.push(v); peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); }
  const dr = eq.map((x, i) => x / (i ? eq[i - 1] : 1) - 1), rs = picks.map((p) => p.r), wins = rs.filter((x) => x > 0), losses = rs.filter((x) => x <= 0), sum = (a: number[]) => a.reduce((s, x) => s + x, 0), sd = std(dr, 0);

  // dollar view: each trade's profit is its share of that day's return on the balance before that day
  const order = [...picks].sort((a, b) => a.exitDay - b.exitDay || a.t - b.t), every = Math.max(1, Math.floor(order.length / 400)), why = ["stop-loss", "take-profit", "time limit"];
  let bal = c.starting_cash;
  const pnlAll: number[] = [], tape: unknown[] = [];
  order.forEach((p, j) => {
    const before = c.starting_cash * (p.exitDay - start > 0 ? eq[Math.min(eq.length, p.exitDay - start) - 1] : 1), f = scaleOf(p), pnl = p.r * risk * f * before;
    const shares = Math.max(1, Math.floor(((risk * f) / Math.max(p.stopDist, 1e-6)) * before / Math.max(p.entry, 1e-6)));
    bal += pnl;
    pnlAll.push(pnl);
    if (j % every === 0 || j === order.length - 1) tape.push({ n: j + 1, day: p.t + 1 - start, exit_day: p.exitDay - start, symbol: `SIM-${String(p.s).padStart(3, "0")}`, side: p.sgn > 0 ? "long" : "short", shares, entry: +p.entry.toFixed(2), exit: +p.fill.toFixed(2),
      cost: +(shares * p.entry).toFixed(2), pnl: +pnl.toFixed(2), balance: +bal.toFixed(2), why_exit: why[p.reason] });
  });
  const final = c.starting_cash * eq[eq.length - 1], w$ = pnlAll.filter((x) => x > 0), l$ = pnlAll.filter((x) => x <= 0);
  return { trades: picks.length, candidates: cands.length, engine_s, signal_s, days: D - start, total_return_pct: (eq[eq.length - 1] - 1) * 100, max_drawdown_pct: dd * 100, sharpe: sd > 0 ? (mean(dr) / sd) * Math.sqrt(252) : 0,
    win_rate_pct: (wins.length / rs.length) * 100, avg_r: mean(rs), profit_factor: losses.length && sum(losses) < 0 ? sum(wins) / -sum(losses) : null,
    exit_reasons: { stop: picks.filter((p) => p.reason === 0).length, target: picks.filter((p) => p.reason === 1).length, time: picks.filter((p) => p.reason === 2).length },
    r_values: rs, equity: eq, start_cash: c.starting_cash, final_value: +final.toFixed(2), profit: +(final - c.starting_cash).toFixed(2), gross_profit: +sum(w$).toFixed(2), gross_loss: +sum(l$).toFixed(2),
    avg_profit_per_trade: +mean(pnlAll).toFixed(2), best_trade: +Math.max(...pnlAll).toFixed(2), worst_trade: +Math.min(...pnlAll).toFixed(2), tape };
}

const downsample = (a: number[], n = 160) => (a.length <= n ? a : Array.from({ length: n }, (_, i) => a[Math.floor((i * (a.length - 1)) / (n - 1))])).map((x) => +x.toFixed(5));
type MarketResult = ReturnType<typeof simulateMarket> & { market?: number; total_return_pct?: number; max_drawdown_pct?: number; sharpe?: number; gross_profit?: number; gross_loss?: number };

function turboSummary(results: MarketResult[], curves: number[][], allR: number[], tapes: unknown[][], c: TurboConfig, seed: number, t0: number, barsTotal: number, partial: boolean) {
  const trades = results.reduce((s, x) => s + x.trades, 0), engine = results.reduce((s, x) => s + x.engine_s, 0), wall = (performance.now() - t0) / 1000;
  const rets = results.map((x) => x.total_return_pct ?? 0), sorted = Float64Array.from(rets).sort(), medI = rets.indexOf(sorted[sorted.length >> 1]);
  const counts = new Array<number>(32).fill(0), edges = Array.from({ length: 33 }, (_, i) => -3 + (i * 8) / 32);
  for (const r of allR) counts[Math.min(31, Math.floor(((Math.max(-3, Math.min(5, r)) + 3) / 8) * 32))]++;
  const gain = allR.filter((x) => x > 0).reduce((s, x) => s + x, 0), lose = allR.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  const finals = results.map((x) => x.final_value), cash = c.starting_cash, profits = finals.map((f) => f - cash), finalsSorted = Float64Array.from(finals).sort(), medF = finals.indexOf(finalsSorted[finals.length >> 1]);
  return clean({
    partial, seed, config: c, markets_done: results.length, trades, candidates: results.reduce((s, x) => s + x.candidates, 0), bars_processed: barsTotal, engine_seconds: +engine.toFixed(4), wall_seconds: +wall.toFixed(3),
    trades_per_minute_engine: engine > 0 ? Math.round((trades / engine) * 60) : 0, trades_per_minute_total: wall > 0 ? Math.round((trades / wall) * 60) : 0, win_rate_pct: allR.length ? (allR.filter((x) => x > 0).length / allR.length) * 100 : null,
    avg_r: allR.length ? mean(allR) : null, profit_factor: allR.length && lose < 0 ? gain / -lose : null, median_return_pct: rets.length ? quantile(sorted, 0.5) : null, p05_return_pct: rets.length ? quantile(sorted, 0.05) : null, p95_return_pct: rets.length ? quantile(sorted, 0.95) : null,
    pct_markets_profitable: rets.length ? (rets.filter((x) => x > 0).length / rets.length) * 100 : null, median_max_drawdown_pct: results.length ? median(results.map((x) => x.max_drawdown_pct ?? 0)) : null, median_sharpe: results.length ? median(results.map((x) => x.sharpe ?? 0)) : null,
    r_histogram: { counts: allR.length ? counts : [], edges: allR.length ? edges : [] }, markets: results.map(({ r_values: _r, equity: _e, tape: _t, ...x }) => x), curves: curves.slice(0, 12).map((x) => downsample(x)), median_curve: curves.length ? downsample(curves[medI]) : [],
    money: { start_cash: cash, markets: results.length, median_final: results.length ? quantile(finalsSorted, 0.5) : cash, median_profit: results.length ? median(profits) : 0, median_margin_pct: results.length ? (median(profits) / cash) * 100 : 0, average_profit: results.length ? mean(profits) : 0,
      best_final: results.length ? finalsSorted[finals.length - 1] : cash, worst_final: results.length ? finalsSorted[0] : cash, profitable_markets: profits.filter((x) => x > 0).length, total_profit_all_markets: profits.reduce((s, x) => s + x, 0), avg_profit_per_trade: trades ? profits.reduce((s, x) => s + x, 0) / trades : null,
      gross_profit: results.reduce((s, x) => s + (x.gross_profit ?? 0), 0), gross_loss: results.reduce((s, x) => s + (x.gross_loss ?? 0), 0), latest_market: results.length ? results[results.length - 1].market : null, latest_tape: tapes[tapes.length - 1] ?? [],
      median_market: results.length ? results[medF].market : null, median_tape: tapes[medF] ?? [] },
  });
}

export function turbo(c: TurboConfig, bars: Bars | null, progress: Progress) {
  const t0 = performance.now(), seed = c.seed ?? Date.now() % 2 ** 31, n = c.mode === "history" ? 1 : Math.max(1, c.markets), hist = bars ? historyMarket(bars) : null;
  const results: MarketResult[] = [], curves: number[][] = [], tapes: unknown[][] = [], allR: number[] = [];
  let barsTotal = 0, lastSent = 0;
  for (let i = 0; i < n; i++) {
    const m = hist ?? syntheticMarket(c.symbols, Math.floor(252 * c.years), seed + 1000 * (i + 1), c.pattern_strength);
    barsTotal += m.D * m.S;
    const res: MarketResult = simulateMarket(m, c, rng(seed + i));
    allR.push(...res.r_values); curves.push(res.equity); tapes.push(res.tape); res.market = i + 1; results.push(res);
    if (performance.now() - lastSent > 400) { lastSent = performance.now(); progress((i + 1) / n, undefined, turboSummary(results, curves, allR, tapes, c, seed, t0, barsTotal, true)); }
  }
  return turboSummary(results, curves, allR, tapes, c, seed, t0, barsTotal, false);
}

export type Job = { kind: "train"; args: TrainInput } | { kind: "backtest"; args: { cfg: BtConfig; bars: Bars; spy: Candle[] } } | { kind: "turbo"; args: { cfg: TurboConfig; bars: Bars | null } };
export function runJob(job: Job, progress: Progress): unknown {
  if (job.kind === "train") return train(job.args, progress);
  if (job.kind === "backtest") return backtest(job.args.cfg, job.args.bars, job.args.spy, progress);
  return turbo(job.args.cfg, job.args.bars, progress);
}

