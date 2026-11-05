import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useSnapshot, type SnapshotRow } from "../api/snapshot";
import { useLive } from "../api/live";
import { heatColor } from "../components/charts/svg";
import { Loadable, PageHead, Panel, Seg } from "../components/ui";
import { isNum, moneyShort, pct, price } from "../lib/format";
import { treemap } from "../lib/treemap";

const METRICS = [
  { value: "day", label: "Today", scale: 3 }, { value: "ret_5d", label: "1W", scale: 6 }, { value: "ret_1m", label: "1M", scale: 12 },
  { value: "ret_3m", label: "3M", scale: 20 }, { value: "ret_1y", label: "1Y", scale: 45 },
] as const;
type Metric = (typeof METRICS)[number]["value"];

const LABEL_H = 20;
const size = (r: SnapshotRow) => r.market_cap ?? r.avg_dollar_volume;

/** Sectors sized by market cap, stocks inside them sized the same way, colour for the chosen period. */
export function MarketTreemap({ height = 640, metric = "day" }: { height?: number; metric?: Metric }) {
  const q = useSnapshot();
  const quotes = useLive((s) => s.quotes);
  const host = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!host.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(host.current);
    return () => ro.disconnect();
  }, [q.data !== undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  const layout = useMemo(() => {
    const sectors = new Map<string, SnapshotRow[]>();
    for (const r of q.data ?? []) sectors.set(r.sector, [...(sectors.get(r.sector) ?? []), r]);
    const groups = [...sectors.entries()].map(([sector, rows]) => ({ sector, rows, value: rows.reduce((s, r) => s + size(r), 0) }));
    return treemap(groups, (g) => g.value, { x: 0, y: 0, w, h: height }).map((g) => ({
      ...g, tiles: treemap(g.item.rows, size, { x: g.x, y: g.y + LABEL_H, w: g.w, h: g.h - LABEL_H }),
    }));
  }, [q.data, w, height]);

  const scale = METRICS.find((m) => m.value === metric)!.scale;
  const valueOf = (r: SnapshotRow) => {
    if (metric === "day") return quotes[r.symbol]?.change_pct ?? r.change_pct;
    const v = r[metric];
    return isNum(v) ? v * 100 : null;
  };

  return (
    <Loadable q={q} rows={12}>
      {() => (
        <div ref={host} className="map" style={{ height }}>
          {layout.map((g) => (
            <div key={g.item.sector}>
              <div className="map-sector truncate" style={{ left: g.x, top: g.y, width: g.w, height: LABEL_H }}>{g.item.sector}</div>
              {g.tiles.map((t) => {
                const v = valueOf(t.item);
                const big = t.w > 64 && t.h > 40;
                const label = `${t.item.symbol}, ${t.item.name}: ${pct(v)}, price ${price(t.item.price)}${t.item.market_cap ? `, market cap ${moneyShort(t.item.market_cap)}` : ""}`;
                return (
                  <Link key={t.item.symbol} to={`/research/${t.item.symbol}`} className="map-tile" title={label} aria-label={label}
                    style={{ left: t.x, top: t.y, width: t.w, height: t.h, background: heatColor(v, scale) }}>
                    {t.w > 32 && t.h > 20 && <span className="sym">{t.item.symbol}</span>}
                    {big && <span className="num small">{pct(v, 1)}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </Loadable>
  );
}

function MapLegend({ scale }: { scale: number }) {
  return (
    <div className="map-legend num" aria-label={`Colour scale from minus ${scale} to plus ${scale} percent`}>
      <span>−{scale}%</span>
      {[-1, -0.5, -0.15, 0.15, 0.5, 1].map((f) => <i key={f} style={{ background: heatColor(f * scale, scale) }} />)}
      <span>+{scale}%</span>
    </div>
  );
}

export default function MarketMapPage() {
  const [metric, setMetric] = useState<Metric>("day");
  const scale = METRICS.find((m) => m.value === metric)!.scale;
  return (
    <div className="page">
      <PageHead title="Market map" sub="Every stock in your universe, sized by market cap and coloured by return"
        actions={<Seg label="Period" value={metric} onChange={(v) => setMetric(v as Metric)} options={METRICS.map((m) => ({ value: m.value, label: m.label }))} />} />
      <Panel flush foot={<MapLegend scale={scale} />}><MarketTreemap height={Math.max(480, window.innerHeight - 240)} metric={metric} /></Panel>
    </div>
  );
}
