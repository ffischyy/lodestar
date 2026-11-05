import { useMemo, useState } from "react";
import { useAccount, useApi } from "../api/hooks";
import { useSnapshot } from "../api/snapshot";
import { SymbolLink } from "../components/domain";
import { Empty, Loadable, PageHead, Panel, Seg } from "../components/ui";
import { marketEvents } from "../lib/calendar";

const DAY = 86_400_000;
const fmt = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

type Row = { key: string; date: string; label: string; symbol?: string; mine?: boolean };

export default function CalendarPage() {
  const snap = useSnapshot();
  const acct = useAccount();
  const lists = useApi<{ id: number; symbols: string[] }[]>(["watchlists"], "/watchlists");
  const [scope, setScope] = useState<"all" | "mine">("all");

  const days = useMemo(() => {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 60 * DAY).toISOString().slice(0, 10);
    const mine = new Set([...(acct.data?.positions ?? []).map((p) => p.symbol), ...(lists.data ?? []).flatMap((l) => l.symbols)]);
    const rows: Row[] = marketEvents(from, to).map((e) => ({ key: `${e.date}${e.kind}`, date: e.date, label: e.label }));
    for (const r of snap.data ?? []) {
      const d = r.next_earnings?.slice(0, 10);
      if (d && d >= from && d <= to && (scope === "all" || mine.has(r.symbol))) rows.push({ key: `${d}${r.symbol}`, date: d, label: r.name, symbol: r.symbol, mine: mine.has(r.symbol) });
    }
    const grouped = new Map<string, Row[]>();
    for (const r of rows.sort((a, b) => a.date.localeCompare(b.date))) grouped.set(r.date, [...(grouped.get(r.date) ?? []), r]);
    return [...grouped.entries()];
  }, [snap.data, acct.data, lists.data, scope]);

  return (
    <div className="page">
      <PageHead title="Calendar" sub="Earnings, Fed decisions, options expiry and market holidays for the next 60 days"
        actions={<Seg label="Scope" value={scope} onChange={setScope} options={[{ value: "all", label: "All stocks" }, { value: "mine", label: "Holdings and watchlists" }]} />} />
      <Panel flush>
        <Loadable q={snap} rows={10}>
          {() => days.length ? (
            <ul className="agenda">
              {days.map(([d, rows]) => (
                <li key={d}>
                  <div className="agenda-date num">{fmt(d)}</div>
                  <ul>
                    {rows.map((r) => (
                      <li key={r.key} className="row">
                        {r.symbol ? <><SymbolLink symbol={r.symbol} /><span className="muted truncate">{r.label} earnings</span></> : <span>{r.label}</span>}
                        {r.mine && <span className="faint xs">On your list</span>}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : <Empty title="Nothing scheduled" />}
        </Loadable>
      </Panel>
    </div>
  );
}
