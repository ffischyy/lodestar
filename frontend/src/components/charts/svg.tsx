import { useLayoutEffect, useRef, useState } from "react";
import { isNum } from "../../lib/format";

/* Lightweight SVG charts drawn entirely with theme tokens (CSS variables), so they re-theme instantly. */

export interface Series { name: string; values: (number | null)[]; color: string; area?: boolean; dashed?: boolean; legend?: boolean }

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.clientWidth) setW(Math.max(120, el.clientWidth));
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((e) => setW(Math.max(120, Math.floor(e[0].contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceTicks(min: number, max: number, n = 4): number[] {
  if (!isFinite(min) || !isFinite(max) || min === max) return [min];
  const step0 = (max - min) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

/** Multi-series line chart with hover readout. */
export function LineChart({ labels, series, height = 220, format = (v: number) => v.toFixed(2), zero, yLabel }: {
  labels: string[]; series: Series[]; height?: number; format?: (v: number) => string; zero?: boolean; yLabel?: string;
}) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 56, r: 12, t: 10, b: 22 };
  const all = series.flatMap((s) => s.values.filter(isNum));
  if (zero) all.push(0);
  const lo = Math.min(...all), hi = Math.max(...all);
  const span = hi - lo || Math.abs(hi) || 1;
  const y0 = lo - span * 0.05, y1 = hi + span * 0.05;
  const n = labels.length;
  const X = (i: number) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (w - pad.l - pad.r));
  const Y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0)) * (height - pad.t - pad.b);
  const path = (vals: (number | null)[]) => {
    let d = "", pen = false;
    vals.forEach((v, i) => {
      if (!isNum(v)) { pen = false; return; }
      d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const ticks = niceTicks(y0, y1);
  const xt = n > 1 ? [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1] : [0];
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - pad.l) / (w - pad.l - pad.r)) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };
  if (!all.length) return <div className="muted small">No data to chart.</div>;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <svg width={w} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`Line chart: ${series.map((s) => s.name).join(", ")}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={Y(t)} y2={Y(t)} stroke="var(--chart-grid)" />
            <text x={pad.l - 6} y={Y(t) + 3.5} textAnchor="end" fontSize="10" fill="var(--chart-text)">{format(t)}</text>
          </g>
        ))}
        {zero && y0 < 0 && y1 > 0 && <line x1={pad.l} x2={w - pad.r} y1={Y(0)} y2={Y(0)} stroke="var(--text-3)" strokeDasharray="3 3" />}
        {xt.map((i) => (
          <text key={i} x={X(i)} y={height - 6} fontSize="10" fill="var(--chart-text)" textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>{labels[i]}</text>
        ))}
        {series.map((s) => (
          <g key={s.name}>
            {s.area && (
              <path d={`${path(s.values)}L${X(n - 1)},${Y(Math.max(y0, Math.min(0, y1)))}L${X(0)},${Y(Math.max(y0, Math.min(0, y1)))}Z`} fill={s.color} opacity={0.12} />
            )}
            <path d={path(s.values)} fill="none" stroke={s.color} strokeWidth={1.6} strokeDasharray={s.dashed ? "4 3" : undefined} />
          </g>
        ))}
        {hover !== null && <line x1={X(hover)} x2={X(hover)} y1={pad.t} y2={height - pad.b} stroke="var(--text-3)" strokeDasharray="2 2" />}
        {yLabel && <text x={4} y={pad.t + 2} fontSize="10" fill="var(--chart-text)">{yLabel}</text>}
      </svg>
      {hover !== null && (
        <div className="tip-box" style={{ position: "absolute", left: Math.min(X(hover) + 8, w - 170), top: 8 }}>
          <div className="faint">{labels[hover]}</div>
          {series.map((s) => (
            <div key={s.name} className="row" style={{ gap: 8 }}>
              <span style={{ width: 8, height: 2, background: s.color, display: "inline-block" }} />
              {s.name} <b className="num" style={{ marginLeft: "auto" }}>{isNum(s.values[hover]) ? format(s.values[hover] as number) : "—"}</b>
            </div>
          ))}
        </div>
      )}
      {series.filter((s) => s.legend !== false).length > 1 && (
        <div className="row wrap xs muted" style={{ gap: 12, paddingLeft: pad.l }}>
          {series.filter((s) => s.legend !== false).map((s) => (
            <span key={s.name} className="row" style={{ gap: 4 }}>
              <span style={{ width: 12, height: 2, background: s.color, display: "inline-block", borderTop: s.dashed ? `2px dashed ${s.color}` : undefined }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sparkline({ values, width = 96, height = 26, color }: { values: number[]; width?: number; height?: number; color?: string }) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden />;
  const lo = Math.min(...values), hi = Math.max(...values);
  const c = color ?? (values[values.length - 1] >= values[0] ? "var(--up)" : "var(--down)");
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - lo) / (hi - lo || 1)) * (height - 4)).toFixed(1)}`).join("");
  return (
    <svg width={width} height={height} aria-hidden style={{ display: "block" }}>
      <path d={d} fill="none" stroke={c} strokeWidth={1.4} />
    </svg>
  );
}

/** Reliability diagram: predicted probability (x) vs observed frequency (y), dot size = bin count. */
export function Reliability({ bins, height = 240, label }: { bins: { pred: number; obs: number; n: number }[]; height?: number; label: string }) {
  const [ref, w0] = useWidth();
  const w = Math.min(w0, 420);
  const pad = 46;
  const max = Math.min(1, Math.max(0.5, ...bins.map((b) => Math.max(b.pred, b.obs))) + 0.05);
  const S = (v: number) => (v / max) * (w - pad - 10);
  const T = (v: number) => height - pad - (v / max) * (height - pad - 10);
  const maxN = Math.max(...bins.map((b) => b.n), 1);
  const ticks = niceTicks(0, max, 4);
  return (
    <div ref={ref}>
      <svg width={w} height={height} role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad} x2={pad + S(max)} y1={T(t)} y2={T(t)} stroke="var(--chart-grid)" />
            <text x={pad - 5} y={T(t) + 3} fontSize="10" textAnchor="end" fill="var(--chart-text)">{Math.round(t * 100)}%</text>
            <text x={pad + S(t)} y={height - pad + 14} fontSize="10" textAnchor="middle" fill="var(--chart-text)">{Math.round(t * 100)}%</text>
          </g>
        ))}
        <line x1={pad} y1={T(0)} x2={pad + S(max)} y2={T(max)} stroke="var(--text-3)" strokeDasharray="4 3" />
        <path d={bins.map((b, i) => `${i ? "L" : "M"}${pad + S(b.pred)},${T(b.obs)}`).join("")} fill="none" stroke="var(--chart-1)" strokeWidth={1.5} />
        {bins.map((b, i) => (
          <circle key={i} cx={pad + S(b.pred)} cy={T(b.obs)} r={2.5 + 4 * Math.sqrt(b.n / maxN)} fill="var(--chart-1)" fillOpacity={0.75}>
            <title>{`Predicted ${(b.pred * 100).toFixed(1)}% · observed ${(b.obs * 100).toFixed(1)}% · ${b.n} cases`}</title>
          </circle>
        ))}
        <text x={pad + S(max) / 2} y={height - 4} fontSize="10" textAnchor="middle" fill="var(--chart-text)">Predicted probability</text>
        <text x={10} y={height / 2} fontSize="10" textAnchor="middle" fill="var(--chart-text)" transform={`rotate(-90 10 ${height / 2})`}>Observed</text>
      </svg>
    </div>
  );
}

/** Horizontal bars; negative values extend left of zero. */
export function BarList({ items, format = (v: number) => v.toFixed(2), colorize = true }: {
  items: { label: string; value: number; note?: string }[]; format?: (v: number) => string; colorize?: boolean;
}) {
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1e-9);
  const hasNeg = items.some((i) => i.value < 0);
  return (
    <div className="stack" style={{ gap: 8 }}>
      {items.map((it) => {
        const w = (Math.abs(it.value) / max) * (hasNeg ? 50 : 100);
        const col = !colorize ? "var(--accent)" : it.value >= 0 ? "var(--up)" : "var(--down)";
        return (
          <div key={it.label} className="row small" style={{ gap: 12 }}>
            <span className="truncate" style={{ width: "clamp(110px, 38%, 200px)", flexShrink: 0 }} title={it.label}>{it.label}</span>
            <span style={{ position: "relative", flex: 1, height: 8, background: "var(--surface-3)", borderRadius: 4 }} aria-hidden>
              <i style={{ position: "absolute", top: 0, bottom: 0, borderRadius: 4, background: col, width: `${w}%`,
                left: hasNeg ? (it.value >= 0 ? "50%" : `${50 - w}%`) : 0 }} />
              {hasNeg && <i style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: "var(--text-3)" }} />}
            </span>
            <span className="num right" style={{ width: 70 }}>{format(it.value)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Background colour for a signed value: soft up/down tint scaled by magnitude. */
export function heatColor(v: number | null | undefined, scale: number): string {
  if (!isNum(v)) return "var(--surface-2)";
  // square root: small moves stay legible instead of reading as flat
  const a = Math.sqrt(Math.min(1, Math.abs(v) / scale));
  const base = v >= 0 ? "var(--up)" : "var(--down)";
  return `color-mix(in srgb, ${base} ${Math.round(10 + a * 46)}%, var(--surface))`;
}
