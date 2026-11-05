import clsx from "clsx";
import { Check, Play, Save, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, engineMode, errMsg } from "../api/client";
import { useApi } from "../api/hooks";
import type { AutopilotEventT, AutopilotSettings, AutopilotStatus } from "../api/types";
import { DataTable } from "../components/DataTable";
import { LivePrice, SymbolLink } from "../components/domain";
import { toast } from "../components/toast";
import { etStamp, TradeFeed } from "../components/TradeFeed";
import { Empty, ErrorState, Field, Notice, NumberInput, PageHead, Panel, Seg, Skeleton, Spinner, Stat, Tabs, Toggle } from "../components/ui";
import { ago, dateTime, money, price } from "../lib/format";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PICK_HELP: Record<string, string> = {
  strict: "Only ideas that pass every one of the scanner's quality thresholds. Very few trades; it can wait days.",
  balanced: "Ideas the model rates positive after costs (expected return above 0.1%, edge above 0.5 points). Minimum score is capped at 45.",
  active: "Any idea with a positive expected result after costs and a better-than-base-rate chance of hitting its target. Most trades, lowest conviction. Minimum score capped at 30.",
};

export default function AutopilotPage() {
  const q = useApi<AutopilotStatus>(["autopilot"], "/autopilot", { refetchInterval: 5000 });
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["autopilot"] }); qc.invalidateQueries({ queryKey: ["ap-events"] }); qc.invalidateQueries({ queryKey: ["status"] }); qc.invalidateQueries({ queryKey: ["paper"] }); };

  if (q.isLoading) return <div className="page"><Skeleton rows={12} /></div>;
  if (q.error) return <div className="page"><ErrorState error={q.error} retry={() => q.refetch()} /></div>;
  const s = q.data!;

  const toggle = async () => {
    setBusy(true);
    try {
      await api.post("/autopilot/enable", { enabled: !s.enabled });
      toast(s.enabled ? "info" : "success", s.enabled ? "Autopilot off" : "Autopilot on",
        s.enabled ? "The AI will not place any more trades. Its open positions stay open." :
          s.settings.mode === "approve" ? "The AI will propose trades for you to approve." : "The AI will place paper trades by itself within your rules.");
      refresh();
    } catch (e) { toast("error", "Could not change the autopilot", errMsg(e)); } finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ summary: string }>("/autopilot/run");
      toast("info", "Autopilot cycle finished", r.summary);
      refresh();
    } catch (e) { toast("error", "Cycle failed", errMsg(e)); } finally { setBusy(false); }
  };

  const modelOk = !!s.model?.passed;
  return (
    <div className="page">
      <PageHead title="AI autopilot"
        sub="The AI trades your paper account by itself, only when you allow it and inside your rules" />
      <div className="stack lg">
        {engineMode() === "browser" && <Notice kind="sim">The autopilot runs inside this browser tab, so it only works while the site is open.</Notice>}
        <section className="panel">
          <div className="ap-hero">
            <button type="button" role="switch" className="big-switch" aria-checked={s.enabled} aria-label="Allow the AI to trade" onClick={toggle} disabled={busy} />
            <div className="stack" style={{ gap: 4 }}>
              <span className={clsx("ap-state", s.enabled ? "up" : "muted")}>
                {s.enabled ? (s.pause_until ? "On, but paused by you" : s.mode === "approve" ? "On: proposes trades for you to approve" : "On: full auto, buying and selling by itself") : "Off: the AI will not trade"}
              </span>
              <span className="small muted">
                {s.enabled ? (s.paused_reason ?? (s.schedule_ok ? s.schedule_note : `Waiting. ${s.schedule_note}`)) : "Switch it on when you want the AI to act. You can switch it off at any time, from here or from the AI trading menu in the top bar."}
              </span>
              {s.last_cycle && <span className="xs faint">Last check {ago(s.last_cycle)}: {s.last_summary}</span>}
            </div>
            <div className="row wrap">
              <Seg label="How it trades" value={s.settings.mode} onChange={async (v) => { await api.patch("/autopilot/settings", { mode: v }); refresh(); }}
                options={[{ value: "auto", label: "Full auto" }, { value: "approve", label: "Ask me first" }]} />
              <button className="btn" onClick={runNow} disabled={busy}>{busy ? <Spinner /> : <Play size={16} />} Check now</button>
            </div>
          </div>
          <Timing s={s} onChange={refresh} />
        </section>
        {!modelOk && !s.practice_mode && <Notice kind="warn"><strong>No validated model.</strong> The autopilot only trades when the active model has passed its validation checks. See <Link className="sym-link" to="/models">Models and methods</Link>.{s.sandbox ? " In Sandbox you can switch on Practice mode under Your rules to let it trade anyway." : ""}</Notice>}
        {!modelOk && s.practice_mode && <Notice kind="sim"><strong>Practice mode.</strong> The model has not passed validation, but Sandbox practice mode lets the AI trade anyway. Treat the results as a demonstration, not evidence.</Notice>}
        {s.enabled && modelOk && s.pickiness === "strict" && s.last_summary.includes("nothing that passes") && <LoosenHint onDone={refresh} />}
        {s.enabled && modelOk && s.pickiness !== "strict" && /^Found 0 /.test(s.last_summary) && (
          <Notice kind="info"><strong>No trade right now.</strong> At "{s.pickiness_options?.[s.pickiness]?.label}" nothing currently has a positive expected result after costs. It checks again every {s.settings.interval_seconds} seconds{s.pickiness === "balanced" ? '; switch "How picky" to Active under Your rules for more trades' : ""}.</Notice>
        )}
        {!s.paper_trading_enabled && <Notice kind="error"><strong>Trading is switched off</strong> (Trading switch, top right). The AI waits and carries on as soon as you switch trading back on.</Notice>}
        <div className="stats">
          <Stat label="Trades today" value={`${s.trades_today} / ${s.max_trades_per_day}`} note="Daily limit" />
          <Stat label="Positions it holds" value={`${s.open_positions} / ${s.max_open_positions}`} />
          <Stat label="Money it has invested" value={money(s.invested)} />
          <Stat lead label="Open profit" value={<span className={s.unrealized >= 0 ? "up" : "down"}>{money(s.unrealized, true)}</span>} />
          <Stat label="Locked-in profit" value={<span className={s.realized >= 0 ? "up" : "down"}>{money(s.realized, true)}</span>} note="From the AI's closed trades" />
          <Stat label="Waiting for you" value={s.pending} note={s.mode === "approve" ? "Proposals to review" : "Only in ask-first mode"} />
        </div>
        <div className="grid g-12">
          <div className="span-7 stack lg">
            <Proposals onChange={refresh} />
            <Panel title="Positions the AI opened" flush>
              <DataTable label="Autopilot positions" rows={s.positions} rowKey={(p) => p.symbol}
                empty={<Empty title="None right now">When the AI buys something it appears here, with the stop-loss and take-profit it set.</Empty>}
                columns={[
                  { key: "s", header: "Stock", sticky: true, cell: (p) => <SymbolLink symbol={p.symbol} /> },
                  { key: "q", header: "Shares", num: true, cell: (p) => Math.abs(p.qty) },
                  { key: "a", header: "Paid", num: true, cell: (p) => price(p.avg_price) },
                  { key: "m", header: "Now", num: true, cell: (p) => <LivePrice symbol={p.symbol} fallback={p.mark} /> },
                  { key: "u", header: "Profit", num: true, cell: (p) => <span className={p.unrealized >= 0 ? "up" : "down"}>{money(p.unrealized, true)}</span> },
                  { key: "t", header: "Bought", cell: (p) => <span className="muted num">{etStamp(p.entered_at)} ET</span> },
                ]} />
            </Panel>
            <Panel title="Trades the AI made" hint="Including its automatic stop-loss and take-profit exits">
              <div className="feed-scroll"><TradeFeed limit={60} filter={(f) => f.source === "ai" || /AI trade/.test(f.reason ?? "")} /></div>
            </Panel>
            <ActivityLog />
          </div>
          <div className="span-5"><Rules s={s.settings} onSaved={refresh} sandbox={s.sandbox} /></div>
        </div>
        <p className="xs faint">The autopilot only ever trades the simulated paper account. It cannot connect to a broker or move real money. Its decisions are statistical estimates that can be wrong; watch it in Sandbox mode before trusting it.</p>
      </div>
    </div>
  );
}

function Proposals({ onChange }: { onChange: () => void }) {
  const q = useApi<AutopilotEventT[]>(["ap-events", "pending"], "/autopilot/events?kind=pending", { refetchInterval: 5000 });
  const [busy, setBusy] = useState<number | null>(null);
  const items = q.data ?? [];
  if (!items.length) return null;
  const decide = async (id: number, approve: boolean) => {
    setBusy(id);
    try {
      const r = await api.post<{ status: string }>(`/autopilot/proposals/${id}?approve=${approve}`);
      toast(approve ? (r.status === "done" ? "success" : "warn") : "info", approve ? (r.status === "done" ? "Trade placed" : "Blocked by risk checks") : "Proposal rejected");
      onChange();
    } catch (e) { toast("error", "Could not decide", errMsg(e)); } finally { setBusy(null); }
  };
  return (
    <Panel title={`Waiting for your approval (${items.length})`} flush>
      {items.map((e) => (
        <div key={e.id} className="proposal">
          <div className="stack" style={{ gap: 2 }}>
            <span><b className={e.payload.side === "buy" ? "up" : "down"}>{String(e.payload.side).toUpperCase()}</b> <b>{e.qty}</b> <SymbolLink symbol={e.symbol ?? ""} /> at about {price(e.price)} <span className="faint">({money((e.qty ?? 0) * (e.price ?? 0))})</span></span>
            <span className="small muted">{e.reason}</span>
            {e.payload.stop ? <span className="xs faint">Stop-loss {price(e.payload.stop as number)}, take-profit {price(e.payload.target as number)}. Proposed {etStamp(e.ts)} ET.</span> : null}
          </div>
          <div className="row">
            <button className="btn sm" onClick={() => decide(e.id, false)} disabled={busy === e.id}><X size={16} /> Reject</button>
            <button className="btn buy sm" onClick={() => decide(e.id, true)} disabled={busy === e.id}><Check size={16} /> Approve</button>
          </div>
        </div>
      ))}
    </Panel>
  );
}

function ActivityLog() {
  const [kind, setKind] = useState<"all" | "trades">("all");
  const q = useApi<AutopilotEventT[]>(["ap-events", kind], `/autopilot/events?limit=300${kind === "trades" ? "&kind=trades" : ""}`, { refetchInterval: 5000 });
  return (
    <Panel title={<Tabs value={kind} onChange={setKind} tabs={[{ value: "all", label: "Everything it decided" }, { value: "trades", label: "Trades only" }]} />} flush>
      <DataTable<AutopilotEventT> label="Autopilot activity" rows={q.data ?? []} rowKey={(e) => e.id} maxHeight={460}
        empty={<Empty title="No activity yet">Each check is logged here: what it bought or sold and why, and what it skipped.</Empty>}
        columns={[
          { key: "t", header: "When", cell: (e) => <span className="num muted small">{dateTime(e.ts)}</span> },
          { key: "k", header: "Action", cell: (e) => (
            <span className={clsx("badge", e.kind === "buy" ? "up" : e.kind === "sell" ? "down" : e.kind === "skip" ? "warn" : e.kind === "proposal" ? "accent" : "")}>
              {e.kind === "proposal" ? `proposal (${e.status})` : e.kind}
            </span>) },
          { key: "s", header: "Stock", cell: (e) => (e.symbol ? <SymbolLink symbol={e.symbol} /> : <span className="faint">—</span>) },
          { key: "q", header: "Shares", num: true, cell: (e) => e.qty ?? "—" },
          { key: "r", header: "Why", cell: (e) => <span className="small" style={{ whiteSpace: "normal", display: "block", minWidth: 280 }}>{e.reason}</span> },
        ]} />
    </Panel>
  );
}

function Rules({ s, onSaved, sandbox }: { s: AutopilotSettings; onSaved: () => void; sandbox: boolean }) {
  const [f, setF] = useState(s);
  const lists = useApi<{ id: number; name: string; symbols: string[] }[]>(["watchlists"], "/watchlists");
  useEffect(() => setF(s), [s]);
  const set = <K extends keyof AutopilotSettings>(k: K, v: AutopilotSettings[K]) => setF({ ...f, [k]: v });
  const dirty = JSON.stringify({ ...f, enabled: s.enabled, mode: s.mode, pause_until: s.pause_until, stop_at: s.stop_at }) !== JSON.stringify(s);
  const save = async () => {
    try {
      const { enabled: _e, mode: _m, pause_until: _p, stop_at: _s, ...rest } = f;
      await api.patch("/autopilot/settings", rest);
      toast("success", "Autopilot rules saved", "They apply from the next check.");
      onSaved();
    } catch (e) { toast("error", "Rules not saved", errMsg(e)); }
  };
  return (
    <Panel title={<span className="row"><ShieldCheck size={16} /> Your rules</span>} hint="The AI can never go beyond these"
      actions={<button className="btn primary sm" onClick={save} disabled={!dirty}><Save size={16} /> Save rules</button>}>
      <div className="stack lg">
        <div>
          <div className="section-title">When it may trade</div>
          <div className="stack">
            <select className="select" value={f.schedule} onChange={(e) => set("schedule", e.target.value as AutopilotSettings["schedule"])} aria-label="Schedule">
              <option value="auto">Automatic: market hours on real data, any time on simulated data</option>
              <option value="market_hours">Only during market hours (9:30–16:00 ET)</option>
              <option value="always">Any time</option>
              <option value="custom">Only in my own time window</option>
            </select>
            {f.schedule === "custom" && (
              <>
                <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                  <Field label="From (ET)"><input className="input num" type="time" value={f.custom_start} onChange={(e) => set("custom_start", e.target.value)} /></Field>
                  <Field label="Until (ET)"><input className="input num" type="time" value={f.custom_end} onChange={(e) => set("custom_end", e.target.value)} /></Field>
                </div>
                <div className="chip-row" role="group" aria-label="Days">
                  {DAYS.map((d, i) => (
                    <button key={d} aria-pressed={f.days.includes(i)} onClick={() => set("days", f.days.includes(i) ? f.days.filter((x) => x !== i) : [...f.days, i].sort())}>{d}</button>
                  ))}
                </div>
              </>
            )}
            <Field label="Check for trades every (seconds)"><NumberInput value={f.interval_seconds} onChange={(v) => set("interval_seconds", Math.max(10, Math.round(v ?? 60)))} /></Field>
          </div>
        </div>
        <div>
          <div className="section-title">What it may buy</div>
          <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Field label="Minimum scanner score" help="0–100. Higher = pickier"><NumberInput value={f.min_score} onChange={(v) => set("min_score", v ?? 60)} /></Field>
            <Field label="Stocks">
              <select className="select" value={f.symbols_mode === "watchlist" ? String(f.watchlist_id ?? "") : "universe"}
                onChange={(e) => e.target.value === "universe" ? setF({ ...f, symbols_mode: "universe", watchlist_id: null }) : setF({ ...f, symbols_mode: "watchlist", watchlist_id: +e.target.value })}>
                <option value="universe">Whole universe</option>
                {(lists.data ?? []).map((w) => <option key={w.id} value={w.id}>Watchlist: {w.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="stack" style={{ marginTop: 8 }}>
            <Toggle checked={f.allow_short} onChange={(v) => set("allow_short", v)} label="Allow short selling (betting on a fall)" />
          </div>
        </div>
        <div>
          <div className="section-title">Picking the best trades</div>
          <div className="stack">
            <Field label="How picky" help={PICK_HELP[f.pickiness ?? "balanced"]}>
              <Seg label="How picky" value={f.pickiness ?? "balanced"} onChange={(v) => set("pickiness", v)}
                options={[{ value: "strict", label: "Strict" }, { value: "balanced", label: "Balanced" }, { value: "active", label: "Active" }]} />
            </Field>
            <p className="xs faint" style={{ margin: 0 }}>The AI ranks ideas by score (expected return after costs, probability edge, reward-to-risk, data quality) and takes the best first. Ideas whose expected result after costs is not positive are never traded, at any setting. Safety rules (stale prices, thin trading, wide spreads, earnings days) always apply.</p>
            <Toggle checked={f.rotate_for_better} onChange={(v) => set("rotate_for_better", v)} label="When all slots are full, swap the weakest AI position for a clearly better idea" />
            {sandbox && (
              <Toggle checked={f.practice_mode} onChange={(v) => set("practice_mode", v)}
                label="Practice mode (Sandbox only): trade even if the model has not passed validation" />
            )}
            {sandbox && f.practice_mode && <p className="xs warn" style={{ margin: 0 }}>Practice mode is for watching how the AI behaves. A model that failed validation has not shown a real edge; its trades are not evidence that it works.</p>}
            {f.rotate_for_better && (
              <Field label="Only swap if the new idea scores at least this many points higher"><NumberInput value={f.rotate_margin} onChange={(v) => set("rotate_margin", v ?? 15)} /></Field>
            )}
          </div>
        </div>
        <div>
          <div className="section-title">How much</div>
          <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Field label="Max trades per day"><NumberInput value={f.max_trades_per_day} onChange={(v) => set("max_trades_per_day", Math.round(v ?? 0))} /></Field>
            <Field label="Max positions at once"><NumberInput value={f.max_open_positions} onChange={(v) => set("max_open_positions", Math.round(v ?? 0))} /></Field>
            <Field label="Max per position (% of account)"><NumberInput value={f.max_position_pct} onChange={(v) => set("max_position_pct", v ?? 10)} /></Field>
            <Field label="Max total invested by the AI (%)"><NumberInput value={f.max_capital_pct} onChange={(v) => set("max_capital_pct", v ?? 50)} /></Field>
          </div>
        </div>
        <div>
          <div className="section-title">Selling and safety</div>
          <div className="stack">
            <Toggle checked={f.use_brackets} onChange={(v) => set("use_brackets", v)} label="Attach a stop-loss and take-profit to every buy" />
            <Toggle checked={f.exit_on_signal_flip} onChange={(v) => set("exit_on_signal_flip", v)} label="Sell early when the forecast turns against the position" />
            <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <Field label="Sell after (trading days)" help="0 = no time limit"><NumberInput value={f.max_hold_days} onChange={(v) => set("max_hold_days", Math.round(v ?? 0))} /></Field>
              <Field label="Pause for the day after losing (%)"><NumberInput value={f.stop_on_daily_loss_pct} onChange={(v) => set("stop_on_daily_loss_pct", v ?? 2)} /></Field>
              {f.mode === "approve" && <Field label="Proposals expire after (min)"><NumberInput value={f.proposal_ttl_minutes} onChange={(v) => set("proposal_ttl_minutes", Math.round(v ?? 30))} /></Field>}
            </div>
          </div>
        </div>
        <Notice>Every trade still has to pass the normal risk checks (buying power, position, sector and exposure limits in Settings). If a check fails, the trade is skipped and logged.</Notice>
      </div>
    </Panel>
  );
}


/** Shown when the scanner has no qualified ideas: explains why, and offers practice-level filters. */
function LoosenHint({ onDone }: { onDone: () => void }) {
  const st = useApi<{ settings: { scanner: { min_prob_edge: number; min_net_expected_return_pct: number }; paper: { sandbox: boolean } } }>(["settings"], "/settings");
  const [busy, setBusy] = useState(false);
  if (!st.data) return null;
  const sc = st.data.settings.scanner;
  const loose = sc.min_prob_edge <= 0.01;
  const apply = async (practice: boolean) => {
    setBusy(true);
    try {
      await api.patch("/settings", { scanner: practice ? { min_prob_edge: 0.01, min_net_expected_return_pct: 0.1 } : { min_prob_edge: 0.03, min_net_expected_return_pct: 0.25 } });
      await api.post("/scanner/run");
      toast("info", practice ? "Practice filters on" : "Standard filters restored", "The scanner is re-checking every stock now; the autopilot uses the new list at its next check.");
      window.setTimeout(onDone, 4000);
    } catch (e) { toast("error", "Not changed", errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Notice>
      <strong>Nothing qualifies right now, so the AI is waiting.</strong> Every stock failed at least one of the scanner's rules, usually because the
      model's edge over the base rate is below {Math.round(sc.min_prob_edge * 100)} points. Holding off is often the right call.{" "}
      {loose ? (
        <>Practice filters are on (1-point edge). <button className="btn sm" disabled={busy} onClick={() => apply(false)}>Restore standard filters</button></>
      ) : st.data.settings.paper.sandbox ? (
        <>To see the autopilot in action while practising, you can lower the bar to a 1-point edge; expect more trades and weaker ones.{" "}
          <button className="btn sm" disabled={busy} onClick={() => apply(true)}>Use practice filters</button></>
      ) : <>You can change the thresholds under Opportunity scanner, Filters and weights.</>}
    </Notice>
  );
}


/** Start/stop timing: pause for a while (the switch stays on) or switch off automatically at a set time. */
function Timing({ s, onChange }: { s: AutopilotStatus; onChange: () => void }) {
  const [stopAt, setStopAt] = useState("");
  const call = async (path: string, body: unknown, ok: string) => {
    try { await api.post(path, body); toast("success", ok); onChange(); } catch (e) { toast("error", "That didn't work", errMsg(e)); }
  };
  const et = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="ap-timing">
      <div className="stack" style={{ gap: 8 }}>
        <span className="xs faint">Take a break (it resumes by itself)</span>
        {s.pause_until ? (
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="small warn">Paused until {et(s.pause_until)} ET</span>
            <button className="btn sm" onClick={() => call("/autopilot/pause", { clear: true }, "Resumed")}>Resume now</button>
          </div>
        ) : (
          <div className="row wrap" style={{ gap: 8 }}>
            {([[15, "15 min"], [60, "1 hour"], [240, "4 hours"], [1440, "1 day"]] as const).map(([m, l]) => (
              <button key={l} className="btn sm" disabled={!s.enabled} onClick={() => call("/autopilot/pause", { minutes: m }, `Paused for ${l}`)}>{l}</button>
            ))}
          </div>
        )}
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <span className="xs faint">Switch off automatically at</span>
        {s.stop_at ? (
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="small">Stops at {et(s.stop_at)} ET</span>
            <button className="btn sm" onClick={() => call("/autopilot/stop-at", { at: null }, "Stop time cleared")}>Clear</button>
          </div>
        ) : (
          <div className="row" style={{ gap: 8 }}>
            <input className="input" type="datetime-local" value={stopAt} onChange={(e) => setStopAt(e.target.value)} aria-label="Stop time" />
            <button className="btn sm" disabled={!stopAt} onClick={() => call("/autopilot/stop-at", { at: new Date(stopAt).toISOString() }, "Stop time set")}>Set</button>
          </div>
        )}
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <span className="xs faint">Next check</span>
        <span className="small num">{s.enabled && s.next_cycle ? et(s.next_cycle) + " ET" : "—"}</span>
      </div>
    </div>
  );
}
