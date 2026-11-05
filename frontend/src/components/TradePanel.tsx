import clsx from "clsx";
import { Ban, Bot, Hourglass, Pin, PinOff, Play, ShoppingCart, Tag, X } from "lucide-react";
import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import { useApi, useStatus } from "../api/hooks";
import type { AutopilotEventT, AutopilotStatus, Fill } from "../api/types";
import { price } from "../lib/format";
import { aiLabel } from "./controls";
import { SymbolLink } from "./domain";
import { toast } from "./toast";
import { etStamp, TradeFeed } from "./TradeFeed";
import { Empty, Skeleton, Tabs } from "./ui";

type Tab = "all" | "ai" | "decisions";
const isAiFill = (f: Fill) => f.source === "ai" || /AI trade/.test(f.reason ?? "");

/** The side "Live trades" panel: every buy and sell, the AI's trades on their own, and the AI's decisions. */
export function TradePanel({ pinned, onPin, onClose }: { pinned: boolean; onPin: (p: boolean) => void; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem("lodestar.tradetab") as Tab) || "all");
  const choose = (t: Tab) => { setTab(t); try { localStorage.setItem("lodestar.tradetab", t); } catch { /* ignore */ } };
  return (
    <aside className={clsx("side-drawer", pinned && "pinned")} role={pinned ? "complementary" : "dialog"} aria-label="Live trades">
      <div className="side-drawer-head">
        <h2 className="grow">Live trades</h2>
        <button className="btn ghost sm icon desktop-only" onClick={() => onPin(!pinned)} aria-label={pinned ? "Unpin panel" : "Keep this panel open beside every page"}
          title={pinned ? "Unpin" : "Pin open beside every page"}>{pinned ? <PinOff size={16} /> : <Pin size={16} />}</button>
        <button className="btn ghost sm icon" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </div>
      <AiStrip />
      <div className="side-tabs">
        <Tabs value={tab} onChange={choose} tabs={[{ value: "all", label: "All trades" }, { value: "ai", label: "AI trades" }, { value: "decisions", label: "AI decisions" }]} />
      </div>
      <div className="side-drawer-body">
        {tab === "all" && <TradeFeed limit={150} />}
        {tab === "ai" && <TradeFeed limit={300} filter={isAiFill} workingFilter={(o) => o.owner === "ai" || o.source === "ai"}
          emptyText="Every buy and sell the AI makes appears here the moment it happens, with its reason, plus the stop-loss and take-profit it attached." />}
        {tab === "decisions" && <Decisions />}
      </div>
      <div className="side-drawer-foot xs">
        <NavLink to="/trade" onClick={() => !pinned && onClose()}>Trade desk</NavLink>
        <NavLink to="/autopilot" onClick={() => !pinned && onClose()}>AI autopilot</NavLink>
        <NavLink to="/practice" onClick={() => !pinned && onClose()}>Practice trading</NavLink>
      </div>
    </aside>
  );
}

/** One line on what the AI is doing right now, so an empty list is never a mystery. */
function AiStrip() {
  const status = useStatus();
  const ap = useApi<AutopilotStatus>(["autopilot"], "/autopilot", { refetchInterval: 5000 });
  const qc = useQueryClient();
  const s = status.data;
  if (!s) return null;
  const label = aiLabel(s);
  const start = async () => {
    try { await api.post("/autopilot/enable", { enabled: true }); toast("success", "AI trading started"); qc.invalidateQueries(); }
    catch (e) { toast("error", "Could not start AI trading", errMsg(e)); }
  };
  return (
    <div className={clsx("ai-strip", s.autopilot_enabled && label !== "Paused" && label !== "Waiting" ? "on" : "off")}>
      <Bot size={16} aria-hidden />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="small"><b>AI trading: {label}</b>{ap.data && s.autopilot_enabled ? <span className="faint"> · {ap.data.trades_today} trades today · {ap.data.open_positions} positions</span> : null}</div>
        <div className="xs faint ai-strip-why">{s.autopilot_enabled ? (ap.data?.last_summary || "Waiting for its first check…") : "Switched off: the AI will not buy or sell."}</div>
      </div>
      {!s.autopilot_enabled && <button className="btn primary sm" onClick={start}><Play size={12} /> Start</button>}
    </div>
  );
}

const KIND: Record<string, { icon: typeof Bot; label: string; cls: string }> = {
  buy: { icon: ShoppingCart, label: "Bought", cls: "up" },
  sell: { icon: Tag, label: "Sold", cls: "down" },
  proposal: { icon: Hourglass, label: "Proposed", cls: "warn" },
  skip: { icon: Ban, label: "Blocked", cls: "faint" },
  error: { icon: Ban, label: "Error", cls: "down" },
};

function Decisions() {
  const q = useApi<AutopilotEventT[]>(["ap-events", "panel"], "/autopilot/events?limit=120", { refetchInterval: 4000 });
  if (q.isLoading) return <Skeleton rows={5} />;
  const rows = (q.data ?? []).filter((e) => e.kind !== "info");
  if (!rows.length) return <Empty title="No AI decisions yet">When the AI buys, sells, proposes a trade or is blocked by a risk rule, it shows up here with its reasoning.</Empty>;
  return (
    <ul className="feed-list">
      {rows.map((e) => {
        const k = KIND[e.kind] ?? KIND.skip;
        const side = (e.payload?.side as string) ?? (e.kind === "sell" ? "sell" : "buy");
        return (
          <li key={e.id} className="feed-row">
            <span className={clsx("feed-icon", k.cls)} aria-hidden><k.icon size={16} /></span>
            <div className="feed-main">
              <div className="feed-line">
                <span className={clsx("src-badge", "src-ai")}><Bot size={11} aria-hidden />AI</span>
                <span><b>{k.label}</b>{e.kind === "proposal" ? ` ${side}` : ""} {e.qty ? e.qty.toLocaleString() : ""} {e.symbol && <SymbolLink symbol={e.symbol} />}{e.price ? <> at <b className="num">{price(e.price)}</b></> : null}</span>
                {e.status === "pending" && <span className="xs warn">waiting for you</span>}
                {e.payload?.action === "exit" && <span className="xs faint">exit</span>}
              </div>
              <div className="feed-why xs muted" title={e.reason}>{e.reason}</div>
            </div>
            <span className="feed-time xs faint num">{etStamp(e.ts)}</span>
          </li>
        );
      })}
    </ul>
  );
}
