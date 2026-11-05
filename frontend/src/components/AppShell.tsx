import clsx from "clsx";
import { ArrowLeftRight, Bell, Keyboard, Menu, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useStatus } from "../api/hooks";
import { connectLive, onLive, useLive } from "../api/live";
import type { AlertEvent } from "../api/types";
import { money } from "../lib/format";
import { GO_KEYS, NAV } from "../nav";
import { prefetchPage } from "../routes";
import { CommandPalette } from "./CommandPalette";
import { AiControl, ReplayChip, TradingSwitch } from "./controls";
import { SandboxSwitch } from "./SandboxSwitch";
import { Shortcuts } from "./Shortcuts";
import { StatusBar } from "./StatusBar";
import { toast, Toasts } from "./toast";
import { TradePanel } from "./TradePanel";
import { Tooltip } from "./ui";

export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M16 2.5 L18.4 13.6 L29.5 16 L18.4 18.4 L16 29.5 L13.6 18.4 L2.5 16 L13.6 13.6 Z" fill="currentColor" />
    </svg>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("lodestar.rail") === "1");
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [pinned, setPinned] = useState(() => localStorage.getItem("lodestar.tradepin") === "1");
  const [trades, setTrades] = useState(false);
  const [newTrades, setNewTrades] = useState(0);
  const status = useStatus();
  const acct = useAccount();
  const connected = useLive((s) => s.connected);
  const loc = useLocation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const main = useRef<HTMLElement>(null);

  useEffect(() => connectLive(), []);
  useEffect(() => { setDrawer(false); main.current?.scrollTo(0, 0); }, [loc.pathname]);
  useEffect(() => localStorage.setItem("lodestar.rail", collapsed ? "1" : "0"), [collapsed]);
  useEffect(() => { try { localStorage.setItem("lodestar.tradepin", pinned ? "1" : "0"); } catch { /* ignore */ } }, [pinned]);

  // Ctrl/Cmd+K or "/" opens search, "?" lists shortcuts, "g" then a letter jumps to a screen
  useEffect(() => {
    let g = false;
    let gt: number | undefined;
    const onKey = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette(true); return; }
      if (typing) return;
      if (e.key === "/") { e.preventDefault(); setPalette(true); return; }
      if (e.key === "?") { setShortcuts((v) => !v); return; }
      if (g) {
        if (GO_KEYS[e.key]) nav(GO_KEYS[e.key].path);
        g = false;
        return;
      }
      if (e.key === "g") { g = true; window.clearTimeout(gt); gt = window.setTimeout(() => (g = false), 900); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);

  // live events -> toasts + cache invalidation
  useEffect(() => onLive((type, data) => {
    if (type === "alert") {
      const ev = data as AlertEvent;
      toast(ev.level === "warn" ? "warn" : ev.level === "error" ? "error" : "info", ev.title, ev.body);
      qc.invalidateQueries({ queryKey: ["alerts-events"] });
      qc.invalidateQueries({ queryKey: ["status"] });
    }
    if (type === "paper_fill") { qc.invalidateQueries({ queryKey: ["paper"] }); setNewTrades((n) => n + 1); }
    if (type === "autopilot") {
      qc.invalidateQueries({ queryKey: ["paper"] });
      qc.invalidateQueries({ queryKey: ["ap-events"] });
      qc.invalidateQueries({ queryKey: ["autopilot"] });
      const a = data as { status?: string };
      if (a?.status === "done" || a?.status === "pending") setNewTrades((n) => n + 1);
    }
    if (type === "scan") qc.invalidateQueries({ queryKey: ["scanner"] });
    if (type === "news") qc.invalidateQueries({ queryKey: ["news"] });
  }), [qc]);

  const s = status.data;

  return (
    <div className={clsx("shell", collapsed && "collapsed", drawer && "drawer-open", pinned && "trades-pinned")}>
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="rail" aria-label="Main navigation">
        <div className="brand">
          <BrandMark />
          <span className="brand-name">Lodestar</span>
        </div>
        <nav className="nav">
          {NAV.map((g) => (
            <div className="nav-group" key={g.title}>
              <div className="nav-title">{g.title}</div>
              {g.items.map((it) => (
                <NavLink key={it.path} to={it.path} end={it.path === "/"} className={({ isActive }) => clsx(isActive && "active")}
                  title={collapsed ? it.label : undefined} onMouseEnter={() => prefetchPage(it.path)} onFocus={() => prefetchPage(it.path)}>
                  <it.icon size={16} strokeWidth={1.5} aria-hidden />
                  <span className="nav-label">{it.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="rail-foot desktop-only">
          <button className="btn ghost sm icon" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
            {collapsed ? <PanelLeftOpen size={16} strokeWidth={1.5} /> : <PanelLeftClose size={16} strokeWidth={1.5} />}
          </button>
          <button className="btn ghost sm icon nav-label" onClick={() => setShortcuts(true)} aria-label="Keyboard shortcuts"><Keyboard size={16} strokeWidth={1.5} /></button>
        </div>
      </aside>
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} aria-hidden />}

      <header className="topbar">
        <button className="btn ghost icon mobile-only" onClick={() => setDrawer(true)} aria-label="Open navigation"><Menu size={18} strokeWidth={1.5} /></button>
        <button className="btn search" onClick={() => setPalette(true)} aria-label="Search symbols and screens">
          <Search size={16} strokeWidth={1.5} />
          <span className="grow truncate">Search</span>
          <span className="kbd desktop-only">Ctrl K</span>
        </button>
        <div className="status-rail">
          {s && (
            <>
              <NavLink to="/trade" className="acct-chip" aria-label="Account value. Opens the Trade desk.">
                <span className="faint">Equity</span><b className="num">{acct.data ? money(acct.data.equity) : "—"}</b>
              </NavLink>
              <SandboxSwitch on={s.sandbox} />
              {(s.sandbox || s.replay?.active) && <ReplayChip r={s.replay} />}
              <AiControl s={s} />
              <TradingSwitch on={s.paper_trading_enabled} />
            </>
          )}
          <NavLink to="/alerts" className="btn ghost icon counted" aria-label={`Alerts${s?.unread_alerts ? `, ${s.unread_alerts} unread` : ""}`}>
            <Bell size={16} strokeWidth={1.5} />
            {!!s?.unread_alerts && <span className="count num">{s.unread_alerts > 99 ? "99+" : s.unread_alerts}</span>}
          </NavLink>
          <Tooltip text="Live trades: everything bought and sold, by whom and why">
            <button className={clsx("btn ghost icon counted", pinned && "active")} onClick={() => { if (pinned) setPinned(false); else setTrades((t) => !t); setNewTrades(0); }} aria-label={`Live trades${newTrades ? `, ${newTrades} new` : ""}`}>
              <ArrowLeftRight size={16} strokeWidth={1.5} />
              {newTrades > 0 && <span className="count num">{newTrades > 99 ? "99+" : newTrades}</span>}
            </button>
          </Tooltip>
        </div>
      </header>

      <main className="main" id="main" ref={main} tabIndex={-1}><div className="route" key={loc.pathname}>{children}</div></main>
      <StatusBar s={s} connected={connected} />
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      {shortcuts && <Shortcuts onClose={() => setShortcuts(false)} />}
      {pinned ? (
        <TradePanel pinned onPin={setPinned} onClose={() => setPinned(false)} />
      ) : trades && (
        <>
          <div className="scrim show" onClick={() => setTrades(false)} aria-hidden />
          <TradePanel pinned={false} onPin={(p) => { setPinned(p); setTrades(false); }} onClose={() => setTrades(false)} />
        </>
      )}
      <Toasts />
    </div>
  );
}
