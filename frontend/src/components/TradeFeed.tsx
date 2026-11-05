import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, Bot, Clock, ShieldCheck, Target, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useApi } from "../api/hooks";
import type { Activity, Fill, TradeSource, WorkingOrder } from "../api/types";
import { isNum, money, price } from "../lib/format";
import { SymbolLink } from "./domain";
import { Empty, Skeleton, Tooltip } from "./ui";

export const SOURCE: Record<TradeSource, { label: string; icon: typeof User; cls: string; tip: string }> = {
  you: { label: "You", icon: User, cls: "src-you", tip: "An order you placed yourself." },
  ai: { label: "AI", icon: Bot, cls: "src-ai", tip: "Placed by the AI autopilot." },
  "stop-loss": { label: "Stop-loss", icon: ShieldCheck, cls: "src-stop", tip: "An automatic stop-loss exit attached when the position was opened." },
  "take-profit": { label: "Take-profit", icon: Target, cls: "src-target", tip: "An automatic take-profit exit attached when the position was opened." },
};

export function SourceBadge({ source }: { source?: TradeSource }) {
  const s = SOURCE[source ?? "you"];
  return (
    <Tooltip text={s.tip}>
      <span className={clsx("src-badge", s.cls)}><s.icon size={11} aria-hidden />{s.label}</span>
    </Tooltip>
  );
}

export function etStamp(iso: string, withYear = false) {
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric",
    ...(withYear ? { year: "numeric" } : {}), hour: "2-digit", minute: "2-digit" });
}

/** Live list of every trade: who placed it (you / AI / automatic exit), what, where, at what price and why. */
export function TradeFeed({ limit = 40, compact, filter, workingFilter, emptyText }: {
  limit?: number; compact?: boolean; filter?: (f: Fill) => boolean; workingFilter?: (o: WorkingOrder) => boolean; emptyText?: string;
}) {
  const q = useApi<Activity>(["paper", "activity", limit], `/paper/activity?limit=${limit}`, { refetchInterval: 4000 });
  const seen = useRef<Set<number> | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!q.data) return;
    const ids = new Set(q.data.fills.map((f) => f.id));
    if (seen.current) {
      const n = new Set([...ids].filter((i) => !seen.current!.has(i)));
      if (n.size) {
        setFresh(n);
        const t = window.setTimeout(() => setFresh(new Set()), 2600);
        seen.current = ids;
        return () => window.clearTimeout(t);
      }
    }
    seen.current = ids;
  }, [q.data]);
  if (q.isLoading) return <Skeleton rows={5} />;
  if (!q.data) return null;
  const replay = q.data.account.startsWith("Practice");
  const fills = filter ? q.data.fills.filter(filter) : q.data.fills;
  const working = workingFilter ? q.data.working.filter(workingFilter) : q.data.working;
  return (
    <div className="feed">
      <div className="feed-where xs faint">
        <span>Where: <b className="text-2">{q.data.account}</b></span>
        {!q.data.trading_enabled && <span className="down">· Trading is switched off</span>}
      </div>
      {working.length > 0 && (
        <div className="feed-working">
          <div className="xs faint feed-sub"><Clock size={11} /> Waiting to fill ({working.length})</div>
          {working.slice(0, compact ? 3 : 8).map((o) => <WorkingRow key={o.id} o={o} />)}
        </div>
      )}
      {fills.length === 0 ? (
        <Empty title="No trades yet">{emptyText ?? "Every buy and sell appears here the moment it fills: yours, the AI's, and automatic stop-loss or take-profit exits."}</Empty>
      ) : (
        <ul className="feed-list" aria-live="polite">
          {fills.map((f) => <FillRow key={f.id} f={f} fresh={fresh.has(f.id)} compact={compact} withYear={replay} />)}
        </ul>
      )}
    </div>
  );
}

function FillRow({ f, fresh, compact, withYear }: { f: Fill; fresh: boolean; compact?: boolean; withYear: boolean }) {
  const buy = f.side === "buy";
  const verb = f.closing ? (buy ? "Bought back" : "Sold") : (buy ? "Bought" : "Sold short");
  const pnl = f.closing ? f.realized_pnl : null;
  return (
    <li className={clsx("feed-row", fresh && "fresh", buy ? "is-buy" : "is-sell")}>
      <span className={clsx("feed-icon", buy ? "up" : "down")} aria-hidden>{buy ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}</span>
      <div className="feed-main">
        <div className="feed-line">
          <SourceBadge source={f.source} />
          <span><b>{verb}</b> {f.qty.toLocaleString()} <SymbolLink symbol={f.symbol} /> at <b className="num">{price(f.price)}</b></span>
          <span className="num faint">= {money(f.total ?? f.qty * f.price)}</span>
          {isNum(pnl) && <span className={clsx("num", pnl >= 0 ? "up" : "down")}>{pnl >= 0 ? "+" : "−"}{money(Math.abs(pnl))} {pnl >= 0 ? "profit" : "loss"}</span>}
        </div>
        {!compact && f.reason && <div className="feed-why xs muted" title={f.reason}>{f.reason}</div>}
      </div>
      <span className="feed-time xs faint num">{etStamp(f.ts, withYear)}</span>
    </li>
  );
}

function WorkingRow({ o }: { o: WorkingOrder }) {
  const what = o.source === "stop-loss" ? `Stop-loss: ${o.side} ${o.qty} if price ${o.side === "sell" ? "falls" : "rises"} to` : o.source === "take-profit" ? `Take-profit: ${o.side} ${o.qty} if price reaches`
    : `${o.side === "buy" ? "Buy" : "Sell"} ${o.qty} ${o.type} at`;
  return (
    <div className="feed-wrow small">
      <SourceBadge source={o.owner === "ai" && o.parent_id ? "ai" : o.source} />
      <SymbolLink symbol={o.symbol} />
      <span className="muted">{what}</span>
      <b className="num">{price(o.trigger)}</b>
    </div>
  );
}
