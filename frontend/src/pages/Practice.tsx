import clsx from "clsx";
import { FastForward, History, Pause, Play, Radio, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, engineMode, errMsg } from "../api/client";
import { useAccount, useApi, useStatus } from "../api/hooks";
import type { ReplayState } from "../api/types";
import { fmtDur, SPEEDS } from "../components/controls";
import { SandboxSwitch } from "../components/SandboxSwitch";
import { TradeFeed } from "../components/TradeFeed";
import { toast } from "../components/toast";
import { Field, Notice, NumberInput, PageHead, Panel, Seg, Skeleton, Stat } from "../components/ui";
import { isNum, money, pct } from "../lib/format";

type Source = "auto" | "yahoo" | "alpaca" | "simulation";

export default function PracticePage() {
  const q = useApi<ReplayState>(["replay"], "/replay", { refetchInterval: 1000 });
  const status = useStatus();
  if (q.isLoading || !status.data) return <div className="page"><Skeleton rows={10} /></div>;
  const r = q.data!;
  const sandbox = status.data.sandbox;
  return (
    <div className="page">
      <PageHead title="Practice trading"
        sub="Fake trades with play money on real prices, live or sped up 10x to 100x"
        actions={<SandboxSwitch on={sandbox} big />} />
      <div className="stack lg">
        {r.status === "error" && <Notice kind="error"><strong>The practice session could not start.</strong> {r.message}</Notice>}
        {r.active || r.status === "loading" ? <Live r={r} /> : (
          <>
            <LiveMarket provider={status.data.provider} />
            {!sandbox && (
              <Notice kind="sim"><strong>Sped-up practice uses play money, so it needs Sandbox mode.</strong> Switch Sandbox on (top right). Your normal paper account is never affected.</Notice>
            )}
            <Setup r={r} disabled={!sandbox} />
          </>
        )}
        <HowItWorks />
      </div>
    </div>
  );
}

function Setup({ r, disabled }: { r: ReplayState; disabled: boolean }) {
  const qc = useQueryClient();
  const acct = useAccount();
  const [start, setStart] = useState<string>(r.default_start);
  const [speed, setSpeed] = useState<number>(r.speed || 25);
  const [cash, setCash] = useState<number | null>(100000);
  const [source, setSource] = useState<Source>("auto");
  const [busy, setBusy] = useState(false);
  useEffect(() => setStart((s) => s || r.default_start), [r.default_start]);
  const go = async () => {
    setBusy(true);
    try {
      await api.post("/replay/start", { start_date: start || null, speed, starting_cash: cash ?? 100000, source });
      toast("success", "Preparing your practice session", "Loading real price history and training the model on the years before your start date.");
      qc.invalidateQueries();
    } catch (e) {
      toast("error", "Could not start practice trading", errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid g-12">
      <div className="span-7">
        <Panel title={<span className="row"><FastForward size={16} /> Real past market, sped up</span>} hint="Fake trades · real past prices · 1x to 100x">
          <div className="stack lg">
            <div className="grid cols-2">
              <Field label="Start from" help={`Any trading day from ${r.earliest_start} to ${r.latest_start}. The model is trained only on data before this date.`}>
                <input className="input" type="date" value={start} min={r.earliest_start} max={r.latest_start} onChange={(e) => setStart(e.target.value)} />
              </Field>
              <Field label="Practice account starting cash" help={acct.data ? `Separate from your normal account (${money(acct.data.equity)}).` : undefined}>
                <NumberInput value={cash} onChange={setCash} min={100} step={1000} />
              </Field>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <span className="field-label">Speed</span>
              <div className="seg speed-seg big" role="group" aria-label="Speed">
                {SPEEDS.map((x) => <button key={x} type="button" aria-pressed={speed === x} onClick={() => setSpeed(x)}>{x}x</button>)}
              </div>
              <span className="xs faint">At {speed}x one trading day (9:30 to 16:00) takes about {fmtDur(390 * 60 / speed)}; a month takes about {fmtDur(21 * 390 * 60 / speed)}. You can change speed or pause at any time.</span>
            </div>
            <Field label="Price history" help="Real history is downloaded once (about ten years, split- and dividend-adjusted) and cached on your computer.">
              <Seg label="History source" value={source} onChange={setSource} options={[
                { value: "auto", label: "Best available" }, ...(engineMode() === "server" ? [{ value: "yahoo" as const, label: "Yahoo" }] : []), { value: "alpaca", label: "Alpaca" },
                { value: "simulation", label: "Simulated" }]} />
            </Field>
            <div className="row wrap" style={{ gap: 12 }}>
              <button className="btn primary lg" disabled={disabled || busy} onClick={go}><FastForward size={16} /> Start practising at {speed}x</button>
              <span className="xs faint">The clock waits while the first model trains (usually under a minute).</span>
            </div>
          </div>
        </Panel>
      </div>
      <div className="span-5">
        {r.summary ? <LastResult s={r.summary} /> : (
          <Panel title="What you can do while practising">
            <ul className="small stack" style={{ margin: 0, paddingLeft: 16 }}>
              <li>Trade by hand on the <Link to="/trade">Trade desk</Link> while history unfolds.</li>
              <li>Let the <Link to="/autopilot">AI autopilot</Link> trade by itself and watch every decision in the live trade feed.</li>
              <li>Pause, change speed (1x to 100x) or stop whenever you like.</li>
              <li>Compare your result with simply holding the S&P 500 (SPY) over the same days.</li>
            </ul>
          </Panel>
        )}
      </div>
    </div>
  );
}

function Live({ r }: { r: ReplayState }) {
  const qc = useQueryClient();
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast("success", ok); qc.invalidateQueries(); } catch (e) { toast("error", "That didn't work", errMsg(e)); }
  };
  const playing = r.playing && r.status === "playing";
  const s = r.summary;
  const statusText: Record<string, string> = {
    loading: "Preparing", training: "Training model (clock paused)", playing: "Playing", paused: "Paused", ready: "Ready", ended: "Finished",
  };
  return (
    <>
      {r.simulated_history && r.active && (
        <Notice kind="warn"><strong>This session uses SIMULATED prices.</strong> {engineMode() === "browser" ? "Add free Alpaca keys under Data providers for real price history." : "Real price history could not be downloaded (check your internet connection)."} Results here say nothing about real markets.</Notice>
      )}
      <div className="grid g-12">
        <div className="span-7">
          <Panel title="Market clock" hint={`Price history: ${r.source_label}`}>
            {r.status === "loading" ? (
              <div className="stack">
                <div className="meter big"><i style={{ width: `${Math.round(r.progress * 100)}%` }} /></div>
                <span className="small muted">{r.message || "Preparing…"}</span>
              </div>
            ) : (
              <div className="stack lg">
                <div className="replay-clock">
                  <History size={18} aria-hidden />
                  <div>
                    <div className="replay-time num">{r.sim_time_et ?? "—"} <span className="faint">ET</span></div>
                    <div className={clsx("small", playing ? "up" : "muted")}>{statusText[r.status] ?? r.status}{r.message && r.status === "training" ? ` · ${r.message}` : ""}</div>
                  </div>
                </div>
                <div>
                  <div className="row xs faint" style={{ justifyContent: "space-between" }}><span>9:30 open</span><span>Trading day progress</span><span>16:00 close</span></div>
                  <div className="meter big"><i style={{ width: `${Math.round(r.day_progress * 100)}%` }} /></div>
                </div>
                <div className="row wrap" style={{ gap: 8 }}>
                  {playing
                    ? <button className="btn lg" onClick={() => run(() => api.post("/replay/pause"))}><Pause size={16} /> Pause</button>
                    : <button className="btn primary lg" disabled={r.status === "ended" || r.status === "loading"} onClick={() => run(() => api.post("/replay/play"))}><Play size={16} /> Play</button>}
                  <div className="seg speed-seg big" role="group" aria-label="Speed">
                    {SPEEDS.map((x) => <button key={x} type="button" aria-pressed={r.speed === x} onClick={() => run(() => api.post("/replay/speed", { speed: x }))}>{x}x</button>)}
                  </div>
                  <button className="btn ghost" onClick={() => run(() => api.post("/replay/stop"), "Practice session stopped. Back to your normal paper account.")}><Square size={16} /> Stop practising</button>
                </div>
                <span className="xs faint">At {r.speed}x a trading day takes about {fmtDur(r.real_seconds_per_day)}. Started {r.start_date}; history runs to {r.last_date}.</span>
              </div>
            )}
          </Panel>
        </div>
        <div className="span-5">
          <Panel title="Practice account" hint="Play money, separate from your normal account">
            <div className="stats cols-2">
              <Stat label="Account value" value={isNum(s?.equity) ? money(s!.equity) : "—"} />
              <Stat label="Profit" value={isNum(s?.profit) ? money(s!.profit, true) : "—"} tone={(s?.profit ?? 0) >= 0 ? "up" : "down"}
                note={isNum(s?.return_pct) ? pct(s!.return_pct) : undefined} />
              <Stat label="S&P 500 (SPY) same days" value={isNum(s?.spy_return_pct) ? pct(s!.spy_return_pct) : "—"} note="Buy-and-hold comparison" />
              <Stat label="Trades" value={s?.trades ?? 0} note={isNum(s?.win_rate_pct) ? `${s!.win_rate_pct!.toFixed(0)}% winners` : undefined} />
              <Stat label="Trading days so far" value={r.days_replayed} note={`${r.days_left} left in the history`} />
              <Stat label="Market date" value={r.current_date ?? "—"} note={`Started ${r.start_date ?? "—"}`} />
            </div>
            <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
              <Link to="/trade" className="btn sm">Trade by hand</Link>
              <Link to="/autopilot" className="btn sm">Let the AI trade</Link>
            </div>
          </Panel>
        </div>
      </div>
      <Panel title="Live trades in this session" hint="Every buy and sell, by you and by the AI">
        <TradeFeed limit={60} />
      </Panel>
    </>
  );
}

function LastResult({ s }: { s: NonNullable<ReplayState["summary"]> }) {
  return (
    <Panel title="Last practice session" hint={s.from && s.to ? `${s.from} → ${s.to}` : undefined}>
      <div className="stats cols-2">
        <Stat label="Final value" value={isNum(s.equity) ? money(s.equity) : "—"} />
        <Stat label="Return" value={isNum(s.return_pct) ? pct(s.return_pct) : "—"} tone={(s.return_pct ?? 0) >= 0 ? "up" : "down"} />
        <Stat label="S&P 500 same days" value={isNum(s.spy_return_pct) ? pct(s.spy_return_pct) : "—"} />
        <Stat label="Trades" value={s.trades ?? 0} note={isNum(s.win_rate_pct) ? `${s.win_rate_pct.toFixed(0)}% winners` : undefined} />
      </div>
    </Panel>
  );
}

function HowItWorks() {
  return (
    <Panel title="How sped-up practice works">
      <div className="grid cols-3 small muted">
        <p style={{ margin: 0 }}><strong className="text-2">Real daily prices.</strong> Each day's real open, high, low and close come from market history. Between them, the minute-by-minute path is a synthetic bridge that touches the real high and low and ends at the real close.</p>
        <p style={{ margin: 0 }}><strong className="text-2">No peeking.</strong> Charts, quotes, the scanner and the model only see data up to the practice clock. The model is trained on the years before your start date and retrained as time passes; the clock pauses while it trains.</p>
        <p style={{ margin: 0 }}><strong className="text-2">Its own account.</strong> Practice trades go to a separate practice account. Stopping (or switching Sandbox off) returns you to your normal paper account exactly as you left it. Past results do not predict future ones.</p>
      </div>
    </Panel>
  );
}


/** Real live prices right now (fake money): switches the data source to a real provider. */
function LiveMarket({ provider }: { provider: string }) {
  const qc = useQueryClient();
  const prov = useApi<{ keys: Record<string, { set: boolean }> }>(["providers"], "/providers");
  const hasAlpaca = !!prov.data?.keys?.ALPACA_API_KEY_ID?.set && !!prov.data?.keys?.ALPACA_API_SECRET_KEY?.set;
  const live = provider === "yahoo" || provider === "alpaca";
  const use = async (p: string) => {
    try {
      await api.patch("/settings", { data: { provider: p } });
      toast("success", p === "simulation" ? "Back to simulated prices" : "Using real live market data",
        p === "simulation" ? undefined : "Trades still use play money. A model for this data trains automatically (a few minutes the first time).");
      qc.invalidateQueries();
    } catch (e) { toast("error", "Could not switch data", errMsg(e)); }
  };
  return (
    <Panel title={<span className="row"><Radio size={16} /> Real live market, right now</span>} hint="Fake trades · real current prices · 1x">
      <div className="row wrap" style={{ gap: 12, justifyContent: "space-between" }}>
        <p className="small muted" style={{ margin: 0, maxWidth: 640 }}>
          {live
            ? <>You are already practising on <b className="text-2">real live prices</b> from {provider === "alpaca" ? "Alpaca (IEX, real-time)" : "Yahoo Finance (delayed about 15 minutes)"}. Every trade is fake money in your paper account. Prices only move while the market is open (9:30 to 16:00 ET, weekdays) and cannot be sped up.</>
            : <>Trade with play money on today's real prices as they happen. {hasAlpaca ? "Alpaca gives real-time prices (IEX venue)." : engineMode() === "server" ? "Yahoo Finance is free and needs no account; its prices can be about 15 minutes behind." : "Alpaca's free plan gives real-time prices (IEX venue). Your keys stay in this browser."} Real time cannot be sped up, so prices only move while the market is open.</>}
        </p>
        <div className="row wrap" style={{ gap: 8 }}>
          {live ? (
            <>
              <Link to="/trade" className="btn primary">Open the Trade desk</Link>
              <button className="btn ghost" onClick={() => use("simulation")}>Back to simulated prices</button>
            </>
          ) : (
            <>
              {hasAlpaca && <button className="btn primary" onClick={() => use("alpaca")}><Radio size={16} /> Use real live prices (Alpaca)</button>}
              {engineMode() === "server"
                ? <button className={clsx("btn", !hasAlpaca && "primary")} onClick={() => use("yahoo")}><Radio size={16} /> Use real live prices (Yahoo)</button>
                : !hasAlpaca && <Link to="/providers" className="btn primary"><Radio size={16} /> Add free Alpaca keys for real prices</Link>}
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}
