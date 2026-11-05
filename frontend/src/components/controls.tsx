import clsx from "clsx";
import { Bot, ChevronDown, FastForward, Pause, Play, Power, ShieldAlert, Square, Timer } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import type { ReplayBrief, Status } from "../api/types";
import { useApi } from "../api/hooks";
import { toast } from "./toast";
import { Seg, Toggle } from "./ui";

/* ---------------------------------------------------------------- popover */
/** A button that opens a small floating panel underneath it. Closes on outside click or Escape. */
export function Popover({ trigger, children, label, className, width = 320, open: controlled, onOpenChange }: {
  trigger: ReactNode; children: ReactNode | ((close: () => void) => ReactNode); label: string; className?: string; width?: number;
  open?: boolean; onOpenChange?: (o: boolean) => void;
}) {
  const [inner, setInner] = useState(false);
  const open = controlled ?? inner;
  const setOpen = (o: boolean) => { setInner(o); onOpenChange?.(o); };
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const place = () => {
      const r = btn.current!.getBoundingClientRect();
      const w = Math.min(width, window.innerWidth - 16);
      setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, width]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || btn.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  });
  const close = () => setOpen(false);
  return (
    <>
      <button ref={btn} type="button" className={className} aria-haspopup="dialog" aria-expanded={open} aria-label={label}
        onClick={() => setOpen(!open)}>
        {trigger}
      </button>
      {open && createPortal(
        <div ref={panel} className="popover" role="dialog" aria-label={label} style={{ top: pos.top, left: pos.left, width: Math.min(width, window.innerWidth - 16) }}>
          {typeof children === "function" ? children(close) : children}
        </div>,
        document.body,
      )}
    </>
  );
}

function useAction() {
  const qc = useQueryClient();
  return async (fn: () => Promise<unknown>, ok?: [string, string?]) => {
    try {
      await fn();
      if (ok) toast("success", ok[0], ok[1]);
      qc.invalidateQueries();
      return true;
    } catch (e) {
      toast("error", "That didn't work", errMsg(e));
      return false;
    }
  };
}

/* ---------------------------------------------------------------- trading switch */
/** Top-bar master switch: may any paper trade (yours or the AI's) be placed right now? */
export function TradingSwitch({ on }: { on: boolean }) {
  const run = useAction();
  const [cancelOrders, setCancelOrders] = useState(false);
  return (
    <Popover label={on ? "Trading is on. Open trading controls." : "Trading is off. Open trading controls."} width={340}
      className={clsx("status-item trade-switch", on ? "on" : "off")}
      trigger={<><span className="knob" aria-hidden /><span className="secondary">Trading</span><b>{on ? "On" : "Off"}</b><ChevronDown size={12} aria-hidden /></>}>
      {(close) => (
        <div className="stack">
          <div className="row" style={{ gap: 8 }}>
            <Power size={16} className={on ? "up" : "down"} />
            <strong>{on ? "Trading is on" : "Trading is off"}</strong>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {on
              ? "You and the AI autopilot can place paper trades. Switch off to stop all new buying and selling instantly."
              : "No new orders are placed or filled, by you or by the AI. Stop-loss and take-profit orders on positions you already hold keep protecting you, and you can still close positions."}
          </p>
          {on ? (
            <>
              <Toggle checked={cancelOrders} onChange={setCancelOrders} label="Also cancel orders that are waiting to fill" />
              <button className="btn danger" onClick={async () => {
                const ok = await run(async () => {
                  if (cancelOrders) await api.post("/paper/kill?flatten=false");
                  await api.post("/paper/trading", { enabled: false });
                }, ["Trading switched off", cancelOrders ? "Waiting orders were cancelled and the AI autopilot was switched off." : "The AI autopilot waits until you switch trading back on."]);
                if (ok) close();
              }}><Square size={16} /> Switch trading off</button>
            </>
          ) : (
            <button className="btn primary" onClick={async () => { if (await run(() => api.post("/paper/trading", { enabled: true }), ["Trading switched on"])) close(); }}>
              <Play size={16} /> Switch trading on
            </button>
          )}
          <Link to="/trade" className="xs" onClick={close}>Open the Trade desk →</Link>
        </div>
      )}
    </Popover>
  );
}

/* ---------------------------------------------------------------- AI control */
function fmtET(iso: string) {
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function aiLabel(s: Pick<Status, "autopilot_enabled" | "autopilot_mode" | "autopilot_paused_until" | "paper_trading_enabled">) {
  if (!s.autopilot_enabled) return "Off";
  if (s.autopilot_paused_until) return "Paused";
  if (!s.paper_trading_enabled) return "Waiting";
  return s.autopilot_mode === "approve" ? "Ask first" : "Full auto";
}

/** Top-bar AI trading control: start/stop at any moment, pause for a while, choose how much it may do alone. */
export function AiControl({ s }: { s: Status }) {
  const run = useAction();
  const nav = useNavigate();
  const [stopAt, setStopAt] = useState("");
  const label = aiLabel(s);
  const on = s.autopilot_enabled;
  return (
    <Popover label="AI trading controls" width={360}
      className={clsx("status-item ap-chip", on && label !== "Paused" && label !== "Waiting" && "on", (label === "Paused" || label === "Waiting") && "paused")}
      trigger={<><Bot size={16} aria-hidden /><span className="secondary">AI trading</span><b>{label}</b><ChevronDown size={12} aria-hidden /></>}>
      {(close) => (
        <div className="stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>AI trading</strong>
            <span className={clsx("xs", on ? "up" : "faint")}>{on ? "Switched on" : "Switched off"}</span>
          </div>
          <button className={clsx("btn", on ? "danger" : "primary")} onClick={() => run(() => api.post("/autopilot/enable", { enabled: !on }),
            [on ? "AI trading stopped" : "AI trading started", on ? "It will not place or propose any more trades." : (s.autopilot_mode === "approve" ? "It will propose trades for you to approve." : "It will buy and sell by itself within your limits.")])}>
            {on ? <><Square size={16} /> Stop AI trading</> : <><Play size={16} /> Start AI trading</>}
          </button>
          <div className="stack" style={{ gap: 8 }}>
            <span className="xs faint">How much may it do alone?</span>
            <Seg label="Autopilot mode" value={s.autopilot_mode} onChange={(m) => run(() => api.patch("/autopilot/settings", { mode: m }),
              [m === "auto" ? "Full auto" : "Ask me first", m === "auto" ? "The AI buys and sells by itself." : "The AI proposes; nothing is traded until you approve."])}
              options={[{ value: "auto", label: "Full auto" }, { value: "approve", label: "Ask me first" }]} />
          </div>
          <PickinessControl />
          {!s.paper_trading_enabled && on && (
            <p className="xs warn" style={{ margin: 0 }}>Trading is switched off in the top bar, so the AI is waiting. It continues when trading is switched on.</p>
          )}
          <div className="stack" style={{ gap: 8 }}>
            <span className="xs faint"><Timer size={11} /> Take a break {s.replay?.active ? "(practice market time)" : ""}</span>
            {s.autopilot_paused_until ? (
              <div className="row wrap" style={{ gap: 8 }}>
                <span className="small">Paused until {fmtET(s.autopilot_paused_until)} ET</span>
                <button className="btn sm" onClick={() => run(() => api.post("/autopilot/pause", { clear: true }), ["Resumed"])}>Resume now</button>
              </div>
            ) : (
              <div className="row wrap" style={{ gap: 8 }}>
                {[[15, "15 min"], [60, "1 hour"], [240, "4 hours"], [24 * 60, "1 day"]].map(([m, l]) => (
                  <button key={l} className="btn sm" disabled={!on} onClick={() => run(() => api.post("/autopilot/pause", { minutes: m }), [`Paused for ${l}`, "The switch stays on; it resumes by itself."])}>{l}</button>
                ))}
              </div>
            )}
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <span className="xs faint">Switch off automatically at (your local time)</span>
            <div className="row" style={{ gap: 8 }}>
              <input className="input" type="datetime-local" value={stopAt} onChange={(e) => setStopAt(e.target.value)} aria-label="Stop time" style={{ flex: 1 }} />
              <button className="btn sm" disabled={!stopAt} onClick={() => run(() => api.post("/autopilot/stop-at", { at: new Date(stopAt).toISOString() }), ["Stop time set"])}>Set</button>
            </div>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <button className="btn ghost sm" onClick={() => { close(); nav("/autopilot"); }}>All AI settings and activity →</button>
          </div>
        </div>
      )}
    </Popover>
  );
}

/* ---------------------------------------------------------------- replay chip */
export const SPEEDS = [1, 10, 25, 50, 75, 100];

/** Sandbox speed control in the top bar. Shows the replayed market clock while a replay runs. */
export function ReplayChip({ r }: { r: ReplayBrief }) {
  const run = useAction();
  const nav = useNavigate();
  if (!r.active && r.status !== "loading") {
    return (
      <Link to="/practice" className="status-item replay-chip" title="Practice trading: fake trades on real market data, sped up 10x to 100x">
        <FastForward size={16} aria-hidden /><span className="secondary">Practice</span>
      </Link>
    );
  }
  const playing = r.playing && r.status === "playing";
  const label = r.status === "loading" ? `Loading ${Math.round(r.progress * 100)}%`
    : r.status === "training" ? "Training…" : r.sim_time_et ? r.sim_time_et.replace(/^\w+ /, "") : "";
  return (
    <Popover label="Practice trading speed controls" width={330} className={clsx("status-item replay-chip on", playing && "playing")}
      trigger={<>{playing ? <Play size={12} aria-hidden /> : <Pause size={12} aria-hidden />}<b className="num">{r.speed}x</b><span className="num secondary">{label}</span></>}>
      {(close) => (
        <div className="stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>Practice trading · real past data</strong>
            <span className="xs faint">{r.status}</span>
          </div>
          <div className="small num">{r.sim_time_et ?? "—"} ET</div>
          <div className="meter" aria-label="Progress through the trading day"><i style={{ width: `${Math.round(r.day_progress * 100)}%` }} /></div>
          {r.simulated_history && <p className="xs warn" style={{ margin: 0 }}>Using simulated prices, not real history.</p>}
          <div className="row" style={{ gap: 8 }}>
            {playing
              ? <button className="btn" onClick={() => run(() => api.post("/replay/pause"))}><Pause size={16} /> Pause</button>
              : <button className="btn primary" disabled={r.status === "loading" || r.status === "ended"} onClick={() => run(() => api.post("/replay/play"))}><Play size={16} /> Play</button>}
            <button className="btn ghost" onClick={() => { close(); nav("/practice"); }}>Open practice screen</button>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <span className="xs faint">Speed</span>
            <div className="seg speed-seg" role="group" aria-label="Speed">
              {SPEEDS.map((x) => (
                <button key={x} type="button" aria-pressed={r.speed === x} onClick={() => run(() => api.post("/replay/speed", { speed: x }))}>{x}x</button>
              ))}
            </div>
            <span className="xs faint">At {r.speed}x one trading day takes about {fmtDur(390 * 60 / r.speed)}.</span>
          </div>
          <button className="btn ghost sm danger-text" onClick={() => run(() => api.post("/replay/stop"), ["Practice stopped", "Back to your normal paper account."]).then((ok) => ok && close())}>
            <ShieldAlert size={16} /> Stop practising and return to normal
          </button>
        </div>
      )}
    </Popover>
  );
}

export function fmtDur(sec: number) {
  if (sec < 90) return `${Math.round(sec)} seconds`;
  if (sec < 5400) return `${(sec / 60).toFixed(sec < 600 ? 1 : 0)} minutes`;
  return `${(sec / 3600).toFixed(1)} hours`;
}


function PickinessControl() {
  const ap = useApi<{ pickiness: string }>(["autopilot"], "/autopilot");
  const run = useAction();
  const v = (ap.data?.pickiness ?? "balanced") as "strict" | "balanced" | "active";
  return (
    <div className="stack" style={{ gap: 8 }}>
      <span className="xs faint">How picky? (more trades ← → fewer, higher-conviction)</span>
      <Seg label="How picky" value={v} onChange={(p) => run(() => api.patch("/autopilot/settings", { pickiness: p }), [`Pickiness: ${p}`])}
        options={[{ value: "active", label: "Active" }, { value: "balanced", label: "Balanced" }, { value: "strict", label: "Strict" }]} />
    </div>
  );
}
