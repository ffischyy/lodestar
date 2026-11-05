import {
  CandlestickSeries, ColorType, createChart, createSeriesMarkers, CrosshairMode, type ISeriesMarkersPluginApi, type SeriesMarker, HistogramSeries, type IChartApi, type IPriceLine, type ISeriesApi,
  LineSeries, LineStyle, type LogicalRange, type MouseEventParams, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { BarsResponse, Fill, LinePoint } from "../../api/types";
import { token } from "../../theme/store";
import { compact, price } from "../../lib/format";

export interface PlanLines { entry?: number; stop?: number; targets?: number[] }

const OVERLAYS: Record<string, { color: string }> = {
  sma20: { color: "chart-2" }, sma50: { color: "chart-1" }, sma200: { color: "chart-4" },
  ema9: { color: "chart-3" }, ema21: { color: "chart-5" }, vwap20: { color: "chart-3" },
};

const asLine = (pts: LinePoint[]) => pts.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }));
const asCandles = (data: BarsResponse) => data.candles.map((k) => ({ ...k, time: k.time as UTCTimestamp }));
const asVolume = (data: BarsResponse, up: string, down: string) =>
  data.candles.map((k) => ({ time: k.time as UTCTimestamp, value: k.volume, color: k.close >= k.open ? `${up}55` : `${down}55` }));

/** Keys that change the chart's structure. Everything else is a data refresh, which must not reset zoom or scroll. */
const structureKey = (d: BarsResponse) => [d.symbol, d.timeframe, Object.keys(d.indicators).sort().join()].join("|");

/** Candles + volume + overlays + optional RSI / MACD panes, styled from theme tokens. */
export function PriceChart({ data, height = 420, lines, livePrice, showVolume = true, trades, levels, onChartClick, compare, onRange, range }: {
  data: BarsResponse; height?: number; lines?: PlanLines; livePrice?: number | null; showVolume?: boolean; trades?: Fill[];
  /** User-drawn horizontal levels. */ levels?: number[];
  /** Fired with the price under the cursor when the chart is clicked. */ onChartClick?: (price: number) => void;
  /** Second symbol drawn as % change on its own left scale. */ compare?: BarsResponse | null;
  onRange?: (r: LogicalRange) => void; range?: LogicalRange | null;
}) {
  const markersApi = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const refresh = useRef<(d: BarsResponse) => void>(() => undefined);
  const priceLines = useRef<IPriceLine[]>([]);
  const levelLines = useRef<IPriceLine[]>([]);
  const compareSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const clickRef = useRef(onChartClick);
  clickRef.current = onChartClick;
  const rangeRef = useRef(onRange);
  rangeRef.current = onRange;
  const syncing = useRef(false);
  const latest = useRef(data);
  latest.current = data;
  const [legend, setLegend] = useState<{ o: number; h: number; l: number; c: number; v: number } | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const structure = structureKey(data);

  useEffect(() => {
    const f = () => setThemeTick((n) => n + 1);
    window.addEventListener("lodestar:theme", f);
    return () => window.removeEventListener("lodestar:theme", f);
  }, []);

  // structure effect: only symbol, timeframe, indicator set, height or theme recreate the chart
  useEffect(() => {
    if (!host.current) return;
    const data0 = latest.current;
    const t = (k: Parameters<typeof token>[0]) => token(k) || "#888";
    const c = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: t("chart-text"), fontFamily: token("font-num") || "sans-serif",
        fontSize: 11, attributionLogo: true, panes: { separatorColor: t("border"), separatorHoverColor: t("border-strong") } },
      grid: { vertLines: { color: t("chart-grid") }, horzLines: { color: t("chart-grid") } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: t("text-3"), labelBackgroundColor: t("surface-2") },
        horzLine: { color: t("text-3"), labelBackgroundColor: t("surface-2") } },
      rightPriceScale: { borderColor: t("border") },
      timeScale: { borderColor: t("border"), timeVisible: data0.timeframe !== "1D", secondsVisible: false, rightOffset: 4 },
      localization: { priceFormatter: (p: number) => (Math.abs(p) >= 1 || p === 0 ? p.toFixed(2) : p.toFixed(4)) },
    });
    chart.current = c;
    const up = t("up"), down = t("down");
    const cs = c.addSeries(CandlestickSeries, { upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
      priceLineColor: t("accent") });
    cs.setData(asCandles(data0));
    candles.current = cs;

    if (showVolume) {
      const vs = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      vs.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vs.setData(asVolume(data0, up, down));
      volume.current = vs;
    }
    const ind = data0.indicators;
    const updaters: ((d: BarsResponse) => void)[] = [];
    for (const [k, o] of Object.entries(OVERLAYS)) {
      if (Array.isArray(ind[k])) {
        const s = c.addSeries(LineSeries, { color: t(o.color as never), lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
          crosshairMarkerVisible: false, title: "" });
        s.setData(asLine(ind[k] as LinePoint[]));
        updaters.push((d) => s.setData(asLine(d.indicators[k] as LinePoint[])));
      }
    }
    if (ind.bb && !Array.isArray(ind.bb)) {
      for (const part of ["upper", "lower"]) {
        const s = c.addSeries(LineSeries, { color: t("text-3"), lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false,
          crosshairMarkerVisible: false });
        s.setData(asLine((ind.bb as Record<string, LinePoint[]>)[part]));
        updaters.push((d) => s.setData(asLine((d.indicators.bb as Record<string, LinePoint[]>)[part])));
      }
    }
    let pane = 1;
    if (Array.isArray(ind.rsi)) {
      const rs = c.addSeries(LineSeries, { color: t("chart-2"), lineWidth: 1, priceLineVisible: false }, pane);
      rs.setData(asLine(ind.rsi as LinePoint[]));
      updaters.push((d) => rs.setData(asLine(d.indicators.rsi as LinePoint[])));
      rs.createPriceLine({ price: 70, color: t("text-3"), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: "" });
      rs.createPriceLine({ price: 30, color: t("text-3"), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: "" });
      pane++;
    }
    if (ind.macd && !Array.isArray(ind.macd)) {
      const hist = (d: BarsResponse) => (d.indicators.macd as Record<string, LinePoint[]>).hist.map((p) => ({ time: p.time as UTCTimestamp, value: p.value, color: p.value >= 0 ? `${up}99` : `${down}99` }));
      const h = c.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
      h.setData(hist(data0));
      const a = c.addSeries(LineSeries, { color: t("chart-1"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, pane);
      const b = c.addSeries(LineSeries, { color: t("chart-2"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, pane);
      const m0 = ind.macd as Record<string, LinePoint[]>;
      a.setData(asLine(m0.macd));
      b.setData(asLine(m0.signal));
      updaters.push((d) => {
        const m = d.indicators.macd as Record<string, LinePoint[]>;
        h.setData(hist(d)); a.setData(asLine(m.macd)); b.setData(asLine(m.signal));
      });
      pane++;
    }
    refresh.current = (d) => {
      cs.setData(asCandles(d));
      volume.current?.setData(asVolume(d, up, down));
      updaters.forEach((u) => u(d));
    };
    const panes = c.panes();
    if (panes.length > 1) panes.slice(1).forEach((p) => p.setHeight(Math.round(height * 0.18)));
    const last = data0.candles.length;
    if (last > 0) {
      const visible = data0.timeframe === "1D" ? 180 : 160;
      c.timeScale().setVisibleLogicalRange({ from: Math.max(0, last - visible), to: last + 3 });
    }
    const onMove = (p: MouseEventParams<Time>) => {
      const d = p.seriesData.get(cs) as { open: number; high: number; low: number; close: number } | undefined;
      if (!d) return setLegend(null);
      const v = latest.current.candles.find((k) => k.time === p.time)?.volume ?? 0;
      setLegend({ o: d.open, h: d.high, l: d.low, c: d.close, v });
    };
    c.subscribeCrosshairMove(onMove);
    const onClick = (p: MouseEventParams<Time>) => {
      if (!clickRef.current || !p.point) return;
      const v = cs.coordinateToPrice(p.point.y);
      if (v != null) clickRef.current(v);
    };
    c.subscribeClick(onClick);
    const onScroll = (r: LogicalRange | null) => { if (r && !syncing.current) rangeRef.current?.(r); };
    c.timeScale().subscribeVisibleLogicalRangeChange(onScroll);
    return () => {
      c.timeScale().unsubscribeVisibleLogicalRangeChange(onScroll);
      c.unsubscribeClick(onClick);
      c.unsubscribeCrosshairMove(onMove);
      c.remove();
      chart.current = null;
      candles.current = null;
      volume.current = null;
      markersApi.current = null;
      priceLines.current = [];
      levelLines.current = [];
      compareSeries.current = null;
    };
  }, [structure, height, showVolume, themeTick]);

  // data effect: a refresh keeps the user's zoom and scroll position
  useEffect(() => { refresh.current(data); }, [data]);

  // follow a sibling chart's time range
  useEffect(() => {
    const c = chart.current;
    if (!c || !range) return;
    syncing.current = true;
    c.timeScale().setVisibleLogicalRange(range);
    requestAnimationFrame(() => { syncing.current = false; });
  }, [range]);

  // buy / sell markers for every fill in this symbol: who traded (You / AI / exit) and at what price
  useEffect(() => {
    const cs = candles.current;
    if (!cs) return;
    const times = data.candles.map((k) => k.time);
    const marks: SeriesMarker<Time>[] = [];
    for (const f of trades ?? []) {
      if (f.symbol !== data.symbol || !times.length) continue;
      const t = Math.floor(new Date(f.ts).getTime() / 1000);
      let i = times.length - 1;
      while (i > 0 && times[i] > t) i--;                 // the bar the fill happened in
      if (times[i] > t && data.timeframe !== "1D") continue;
      const buy = f.side === "buy";
      const who = f.source === "ai" ? "AI " : f.source === "stop-loss" ? "Stop " : f.source === "take-profit" ? "Target " : "";
      marks.push({ time: times[i] as UTCTimestamp, position: buy ? "belowBar" : "aboveBar", color: token(buy ? "up" : "down") || (buy ? "#3c3" : "#c33"),
        shape: buy ? "arrowUp" : "arrowDown", text: `${who}${buy ? "Buy" : "Sell"} ${f.qty} @ ${f.price.toFixed(2)}` });
    }
    marks.sort((a, b) => (a.time as number) - (b.time as number));
    if (!markersApi.current) markersApi.current = createSeriesMarkers(cs, marks);
    else markersApi.current.setMarkers(marks);
  }, [trades, data, structure, themeTick]);

  // trade-plan lines are redrawn without rebuilding the chart
  useEffect(() => {
    const cs = candles.current;
    if (!cs) return;
    priceLines.current.forEach((l) => cs.removePriceLine(l));
    priceLines.current = [];
    if (!lines) return;
    const add = (p: number | undefined, color: string, title: string, style = LineStyle.Dashed) => {
      if (p == null || !Number.isFinite(p)) return;
      priceLines.current.push(cs.createPriceLine({ price: p, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    };
    add(lines.entry, token("accent"), "Entry", LineStyle.Solid);
    add(lines.stop, token("down"), "Stop");
    lines.targets?.forEach((t, i) => add(t, token("up"), `T${i + 1}`));
  }, [lines, structure, themeTick]);

  useEffect(() => {
    const cs = candles.current;
    if (!cs) return;
    levelLines.current.forEach((l) => cs.removePriceLine(l));
    levelLines.current = (levels ?? []).map((p) => cs.createPriceLine({ price: p, color: token("text-2"), lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "" }));
  }, [levels, structure, themeTick]);

  // comparison symbol as % change from the first bar both series share
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    if (compareSeries.current) { c.removeSeries(compareSeries.current); compareSeries.current = null; }
    if (!compare?.candles.length) return;
    c.applyOptions({ leftPriceScale: { visible: true, borderColor: token("border") } });
    const firstTime = Math.max(data.candles[Math.max(0, data.candles.length - 180)]?.time ?? 0, compare.candles[0].time);
    const pts = compare.candles.filter((k) => k.time >= firstTime);
    if (!pts.length) return;
    const base = pts[0].close;
    const s = c.addSeries(LineSeries, { color: token("accent"), lineWidth: 1, priceScaleId: "left", priceLineVisible: false, title: compare.symbol,
      priceFormat: { type: "custom", formatter: (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`, minMove: 0.01 } });
    s.setData(pts.map((k) => ({ time: k.time as UTCTimestamp, value: (k.close / base - 1) * 100 })));
    compareSeries.current = s;
    return () => { if (chart.current) chart.current.applyOptions({ leftPriceScale: { visible: false } }); };
  }, [compare, data.symbol, structure, themeTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // stream the live price into the last candle (simulation/live), never rewriting history
  useEffect(() => {
    const cs = candles.current;
    const lastC = data.candles[data.candles.length - 1];
    if (!cs || !lastC || livePrice == null || data.timeframe !== "1D") return;
    cs.update({ time: lastC.time as UTCTimestamp, open: lastC.open, high: Math.max(lastC.high, livePrice), low: Math.min(lastC.low, livePrice), close: livePrice });
  }, [livePrice, data]);

  const last = data.candles[data.candles.length - 1];
  const L = legend ?? (last ? { o: last.open, h: last.high, l: last.low, c: last.close, v: last.volume } : null);
  return (
    <div className="chart-host" style={{ height }}>
      {L && (
        <div className="chart-legend num" aria-hidden>
          <span>O <b>{price(L.o)}</b></span><span>H <b>{price(L.h)}</b></span><span>L <b>{price(L.l)}</b></span>
          <span>C <b className={L.c >= L.o ? "up" : "down"}>{price(L.c)}</b></span><span>Vol <b>{compact(L.v)}</b></span>
        </div>
      )}
      <div ref={host} style={{ position: "absolute", inset: 0 }} role="img"
        aria-label={`${data.symbol} ${data.timeframe} price chart, last close ${last ? price(last.close) : "unknown"}`} />
    </div>
  );
}
