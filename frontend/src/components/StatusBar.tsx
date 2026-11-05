import clsx from "clsx";
import { NavLink } from "react-router-dom";
import { engineMode } from "../api/client";
import { useLive } from "../api/live";
import type { Status } from "../api/types";
import { pct } from "../lib/format";

const STRIP = ["SPY", "QQQ", "IWM", "DIA"];
const SESSION: Record<string, string> = { pre: "Pre-market", regular: "Market open", post: "After hours", closed: "Market closed" };
const MIN = (h: number, m = 0) => h * 60 + m;
// the extended US session, 04:00 to 20:00 ET
const OPEN = MIN(4), CLOSE = MIN(20);

const W = 160, H = 12;
const STAR = "M0 -5.5 L1 -1 L5.5 0 L1 1 L0 5.5 L-1 1 L-5.5 0 L-1 -1 Z";

/** Lodestar's signature: the trading day as a horizon, with the brand star over where the market is now. */
function SessionHorizon({ nowEt, session }: { nowEt: string; session: string }) {
  const t = MIN(+nowEt.slice(11, 13), +nowEt.slice(14, 16));
  const x = (m: number) => ((Math.min(CLOSE, Math.max(OPEN, m)) - OPEN) / (CLOSE - OPEN)) * (W - 12) + 6;
  return (
    <svg className="horizon" viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <line x1={6} x2={W - 6} y1={6} y2={6} stroke="var(--border-strong)" strokeWidth="1" />
      <line x1={x(MIN(9, 30))} x2={x(MIN(16))} y1={6} y2={6} stroke="var(--text-3)" strokeWidth="2" />
      <path d={STAR} transform={`translate(${x(t)} 6)`} fill={session === "closed" ? "var(--text-3)" : "var(--accent)"} />
    </svg>
  );
}

function Strip() {
  const quotes = useLive((s) => s.quotes);
  return (
    <>
      {STRIP.map((s) => {
        const c = quotes[s]?.change_pct;
        return (
          <NavLink key={s} to={`/research/${s}`} className="strip-item">
            <span className="muted">{s}</span>
            <span className={clsx("num", c == null ? "faint" : c >= 0 ? "up" : "down")}>{pct(c)}</span>
          </NavLink>
        );
      })}
    </>
  );
}

export function StatusBar({ s, connected }: { s: Status | undefined; connected: boolean }) {
  const inReplay = s?.replay?.active;
  return (
    <footer className="statusbar">
      <Strip />
      <span className="grow" />
      {s && !inReplay && (
        <span className="strip-item" title={`${SESSION[s.clock.session] ?? s.clock.session}, ${s.clock.now_et.slice(11, 16)} ET`}>
          <span className="muted optional">{SESSION[s.clock.session] ?? s.clock.session}</span>
          <SessionHorizon nowEt={s.clock.now_et} session={s.clock.session} />
          <span className="num muted">{s.clock.now_et.slice(11, 16)} ET</span>
        </span>
      )}
      {s && (
        <NavLink to="/models" className="strip-item optional">
          <span className={s.model && !s.model.passed ? "down" : "muted"}>
            {s.training ? `Training ${Math.round((s.training_run?.progress ?? 0) * 100)}%` : s.model ? (s.model.passed ? "Model validated" : "Model unvalidated") : "No model"}
          </span>
        </NavLink>
      )}
      {s && <NavLink to="/providers" className="strip-item"><span className="muted">{s.provider_label}{engineMode() === "browser" ? ", in this browser" : ""}</span></NavLink>}
      {!connected && <span className="strip-item down">Reconnecting</span>}
    </footer>
  );
}
