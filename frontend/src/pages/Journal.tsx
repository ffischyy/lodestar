import clsx from "clsx";
import { ChevronLeft, ChevronRight, Download, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useAccount, useApi } from "../api/hooks";
import type { Activity } from "../api/types";
import { DataTable, type Column } from "../components/DataTable";
import { SymbolLink } from "../components/domain";
import { toast } from "../components/toast";
import { Empty, Field, Loadable, Modal, PageHead, Panel, Stat } from "../components/ui";
import { download, toCsv } from "../lib/csv";
import { dateTime, isNum, money, num, pct, price, prob } from "../lib/format";
import { buildTrades, byKey, dailyPnl, loadNotes, saveNotes, tradeStats, type JournalNote, type Trade } from "../lib/journal";

const SETUPS = ["Breakout", "Pullback", "Mean reversion", "Trend follow", "News", "AI idea"];
const GRADES = ["Followed my plan", "Early exit", "Late entry", "Oversized", "No plan"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function JournalPage() {
  const q = useApi<Activity>(["paper", "activity", "journal"], "/paper/activity?limit=2000", { refetchInterval: 15_000 });
  const acct = useAccount();
  const [notes, setNotes] = useState(loadNotes);
  const [edit, setEdit] = useState<Trade | null>(null);
  const [setup, setSetup] = useState("");
  const file = useRef<HTMLInputElement>(null);

  const trades = useMemo(() => buildTrades(q.data?.fills ?? [], acct.data?.orders ?? []), [q.data, acct.data?.orders]);
  const view = useMemo(() => (setup ? trades.filter((t) => notes[t.id]?.setup === setup) : trades), [trades, notes, setup]);
  const stats = useMemo(() => tradeStats(view), [view]);
  const bySetup = useMemo(() => byKey(trades, (t) => notes[t.id]?.setup ?? "No setup"), [trades, notes]);
  const byDay = useMemo(() => byKey(view, (t) => DAYS[new Date(t.closed!).getDay()]), [view]);

  const update = (id: number, n: JournalNote) => {
    const next = { ...notes, [id]: n };
    setNotes(next);
    saveNotes(next);
  };
  const exportCsv = () => download("lodestar-journal.csv", toCsv(view.map((t) => ({
    opened: t.opened, closed: t.closed, symbol: t.symbol, side: t.side, qty: t.qty, entry: t.entry, exit: t.exit, pnl: t.pnl, return_pct: t.returnPct, r: t.r, fees: t.fees, who: t.source,
    setup: notes[t.id]?.setup, grade: notes[t.id]?.grade, notes: notes[t.id]?.notes,
  }))));
  const importNotes = async (f: File) => {
    try {
      const parsed = JSON.parse(await f.text());
      if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a notes file");
      const next = { ...notes, ...parsed };
      setNotes(next);
      saveNotes(next);
      toast("success", "Journal notes restored");
    } catch { toast("error", "Could not read that file", "Choose a backup saved from this page."); }
  };

  const columns: Column<Trade>[] = [
    { key: "closed", header: "Closed", cell: (t) => <span className="muted">{t.closed ? dateTime(t.closed) : "Open"}</span>, sort: (t) => t.closed ?? "9" },
    { key: "sym", header: "Symbol", cell: (t) => <SymbolLink symbol={t.symbol} />, sort: (t) => t.symbol },
    { key: "side", header: "Side", cell: (t) => <span className="muted">{t.side === "long" ? "Long" : "Short"}</span> },
    { key: "qty", header: "Qty", num: true, cell: (t) => t.qty, sort: (t) => t.qty },
    { key: "entry", header: "Entry", num: true, cell: (t) => price(t.entry) },
    { key: "exit", header: "Exit", num: true, cell: (t) => price(t.exit) },
    { key: "pnl", header: "P&L", num: true, cell: (t) => (t.closed ? <span className={t.pnl > 0 ? "up" : "down"}>{money(t.pnl, true)}</span> : "—"), sort: (t) => t.pnl },
    { key: "ret", header: "Return", num: true, cell: (t) => pct(t.returnPct), sort: (t) => t.returnPct },
    { key: "r", header: "R", num: true, cell: (t) => (isNum(t.r) ? `${t.r > 0 ? "+" : ""}${t.r.toFixed(2)}R` : "—"), sort: (t) => t.r, title: "Result as a multiple of the risk to your initial stop" },
    { key: "setup", header: "Setup", cell: (t) => <span className="muted">{notes[t.id]?.setup ?? "—"}</span>, sort: (t) => notes[t.id]?.setup },
    { key: "who", header: "By", cell: (t) => <span className="muted">{t.source === "ai" ? "AI" : "You"}</span> },
  ];

  return (
    <div className="page">
      <PageHead title="Trade journal" sub="Every round trip, with what worked and what cost you"
        actions={<>
          <button className="btn" onClick={() => download("lodestar-journal-notes.json", JSON.stringify(notes, null, 2), "application/json")}><Download size={16} /> Back up notes</button>
          <button className="btn" onClick={() => file.current?.click()}><Upload size={16} /> Restore</button>
          <input ref={file} type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importNotes(f); e.target.value = ""; }} />
          <button className="btn" disabled={!view.length} onClick={exportCsv}><Download size={16} /> Export CSV</button>
        </>} />
      <Loadable q={q} rows={8}>
        {() => !trades.length ? (
          <Panel><Empty title="No trades yet" center>Round trips appear here as you buy and sell on the Trade desk.</Empty></Panel>
        ) : (
          <div className="stack lg">
            <div className="stats">
              <Stat lead label="Net P&L" value={money(stats.net, true)} tone={stats.net >= 0 ? "up" : "down"} note={`${stats.count} closed trades`} />
              <Stat label="Win rate" value={prob(stats.winRate)} />
              <Stat label="Profit factor" value={num(stats.profitFactor)} note="Gross wins over gross losses" />
              <Stat label="Expectancy" value={money(stats.expectancy, true)} note="Average per trade" />
              <Stat label="Average R" value={isNum(stats.avgR) ? `${stats.avgR.toFixed(2)}R` : "—"} note="Trades with a stop" />
              <Stat label="Average win / loss" value={<>{money(stats.avgWin)} / {money(stats.avgLoss)}</>} />
              <Stat label="Losing streak" value={stats.worstStreak} note="Longest in a row" />
            </div>
            <div className="grid g-12">
              <Panel className="span-8" title="Daily P&L"><PnlCalendar days={dailyPnl(view)} /></Panel>
              <div className="span-4 stack lg">
                <Panel title="By setup" flush><Breakdown rows={bySetup} /></Panel>
                <Panel title="By weekday" flush><Breakdown rows={byDay} /></Panel>
              </div>
            </div>
            <Panel title="Trades" flush actions={
              <select className="select" style={{ width: 180 }} value={setup} onChange={(e) => setSetup(e.target.value)} aria-label="Filter by setup">
                <option value="">All setups</option>
                {SETUPS.map((s) => <option key={s}>{s}</option>)}
              </select>}>
              <DataTable label="Trades" rows={view} columns={columns} rowKey={(t) => t.id} onRowClick={setEdit} maxHeight={560} initialSort={{ key: "closed", desc: true }}
                empty={<p className="state small">No trades with this setup.</p>} />
            </Panel>
          </div>
        )}
      </Loadable>
      {edit && <NoteDialog trade={edit} note={notes[edit.id] ?? {}} onClose={() => setEdit(null)} onSave={(n) => { update(edit.id, n); setEdit(null); }} />}
    </div>
  );
}

function Breakdown({ rows }: { rows: ReturnType<typeof byKey> }) {
  if (!rows.length) return <p className="state small">Nothing closed yet.</p>;
  return (
    <table className="dt">
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td className="num muted">{r.count}</td>
            <td className="num muted">{prob(r.winRate)}</td>
            <td className={clsx("num", r.net >= 0 ? "up" : "down")}>{money(r.net, true)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PnlCalendar({ days }: { days: Record<string, number> }) {
  const [offset, setOffset] = useState(0);
  const now = new Date();
  const first = new Date(Date.UTC(now.getFullYear(), now.getMonth() + offset, 1));
  const label = first.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const cells = Array.from({ length: count }, (_, i) => new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), i + 1)).toISOString().slice(0, 10));
  const total = cells.reduce((s, d) => s + (days[d] ?? 0), 0);
  return (
    <div className="stack">
      <div className="row between">
        <div className="row">
          <button className="btn ghost sm icon" aria-label="Previous month" onClick={() => setOffset((o) => o - 1)}><ChevronLeft size={16} /></button>
          <span style={{ minWidth: 128, textAlign: "center" }}>{label}</span>
          <button className="btn ghost sm icon" aria-label="Next month" disabled={offset >= 0} onClick={() => setOffset((o) => o + 1)}><ChevronRight size={16} /></button>
        </div>
        <span className={clsx("num", total > 0 ? "up" : total < 0 ? "down" : "muted")}>{money(total, true)}</span>
      </div>
      <div className="pnl-cal">
        {DAYS.map((d) => <span key={d} className="faint xs">{d}</span>)}
        {Array.from({ length: first.getUTCDay() }, (_, i) => <span key={i} />)}
        {cells.map((d, i) => {
          const v = days[d];
          return (
            <div key={d} className={clsx("pnl-day", isNum(v) && (v >= 0 ? "pos" : "neg"))}>
              <span className="faint xs">{i + 1}</span>
              {isNum(v) && <span className="num small">{money(v, true)}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NoteDialog({ trade, note, onClose, onSave }: { trade: Trade; note: JournalNote; onClose: () => void; onSave: (n: JournalNote) => void }) {
  const [n, setN] = useState(note);
  return (
    <Modal title={`${trade.symbol} ${trade.side}, ${trade.qty} shares`} onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onSave(n)}>Save</button></>}>
      <div className="stack lg">
        <Field label="Setup">
          <select className="select" value={n.setup ?? ""} onChange={(e) => setN({ ...n, setup: e.target.value })}>
            <option value="">No setup</option>
            {SETUPS.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Execution">
          <select className="select" value={n.grade ?? ""} onChange={(e) => setN({ ...n, grade: e.target.value })}>
            <option value="">Not graded</option>
            {GRADES.map((g) => <option key={g}>{g}</option>)}
          </select>
        </Field>
        <Field label="Notes"><textarea className="input" rows={5} value={n.notes ?? ""} onChange={(e) => setN({ ...n, notes: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
