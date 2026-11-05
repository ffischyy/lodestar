import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import { useApi } from "../api/hooks";
import { useLive } from "../api/live";
import type { Quote } from "../api/types";
import { DataTable } from "../components/DataTable";
import { LivePrice, OrderTicket, SymbolLink } from "../components/domain";
import { toast } from "../components/toast";
import { ContextMenu, Delta, Empty, PageHead, Panel, Seg, StatusPill, type MenuItem } from "../components/ui";
import { ago, compact, isNum, price } from "../lib/format";

interface Meta { symbol: string; name: string; sector: string }
type Scope = "universe" | "indexes" | "watchlists" | "all";

export default function MonitorPage() {
  const quotes = useLive((s) => s.quotes);
  const last = useLive((s) => s.lastMessage);
  const connected = useLive((s) => s.connected);
  const meta = useApi<Meta[]>(["search-all"], "/market/search?q=&limit=1000");
  const lists = useApi<{ id: number; name: string; symbols: string[] }[]>(["watchlists"], "/watchlists");
  const [scope, setScope] = useState<Scope>("universe");
  const [filter, setFilter] = useState("");
  const [sector, setSector] = useState("all");
  const [menu, setMenu] = useState<{ x: number; y: number; sym: string } | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  const nav = useNavigate();
  const qc = useQueryClient();

  const metaMap = useMemo(() => Object.fromEntries((meta.data ?? []).map((m) => [m.symbol, m])), [meta.data]);
  const wlSyms = useMemo(() => new Set((lists.data ?? []).flatMap((w) => w.symbols)), [lists.data]);
  const sectors = useMemo(() => Array.from(new Set((meta.data ?? []).map((m) => m.sector))).sort(), [meta.data]);

  const rows = useMemo(() => {
    return Object.values(quotes).filter((q) => {
      const m = metaMap[q.symbol];
      const isIx = m?.sector === "Index" || m?.sector === "Sector ETF";
      if (scope === "universe" && (isIx || !m)) return false;
      if (scope === "indexes" && !isIx) return false;
      if (scope === "watchlists" && !wlSyms.has(q.symbol)) return false;
      if (sector !== "all" && m?.sector !== sector) return false;
      if (filter && !q.symbol.includes(filter.toUpperCase()) && !m?.name.toLowerCase().includes(filter.toLowerCase())) return false;
      return true;
    });
  }, [quotes, metaMap, scope, wlSyms, sector, filter]);

  const addTo = async (sym: string, id: number) => {
    const wl = lists.data?.find((w) => w.id === id);
    if (!wl) return;
    try {
      await api.put(`/watchlists/${id}`, { name: wl.name, symbols: [...wl.symbols, sym] });
      toast("success", `Added ${sym} to ${wl.name}`);
      qc.invalidateQueries({ queryKey: ["watchlists"] });
    } catch (e) {
      toast("error", "Could not update watchlist", errMsg(e));
    }
  };

  const menuItems = (sym: string): MenuItem[] => [
    { label: "Open research", onClick: () => nav(`/research/${sym}`) },
    { label: "Open in chart workspace", onClick: () => nav(`/charts?s=${sym}`) },
    { label: "Paper order…", onClick: () => setTicket(sym) },
    ...(lists.data ?? []).map((w) => ({ label: `Add to ${w.name}`, icon: <Plus size={16} />, onClick: () => addTo(sym, w.id) })),
  ];

  return (
    <div className="page">
      <PageHead title="Live monitor" sub="Streaming quotes for everything you track. Right-click a row for actions"
        actions={<span className="small muted">{connected ? `Last update ${last ? ago(new Date(last).toISOString()) : "—"}` : "Reconnecting…"}</span>} />
      <Panel flush
        title={`${rows.length} instruments`}
        actions={
          <>
            <input className="input" style={{ width: 160 }} placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by symbol or name" />
            <select className="select" style={{ width: 150 }} value={sector} onChange={(e) => setSector(e.target.value)} aria-label="Sector">
              <option value="all">All sectors</option>
              {sectors.map((s) => <option key={s}>{s}</option>)}
            </select>
            <Seg label="Scope" value={scope} onChange={setScope}
              options={[{ value: "universe", label: "Stocks" }, { value: "indexes", label: "ETFs" }, { value: "watchlists", label: "Watchlists" }, { value: "all", label: "All" }]} />
          </>
        }>
        <DataTable<Quote> label="Live quotes" rows={rows} rowKey={(q) => q.symbol} maxHeight="calc(100vh - 210px)" initialSort={{ key: "chg", desc: true }}
          onRowClick={(q) => nav(`/research/${q.symbol}`)} onRowContext={(q, e) => setMenu({ x: e.clientX, y: e.clientY, sym: q.symbol })}
          empty={<Empty title={connected ? "No quotes match these filters" : "Waiting for the first quote update"}>{scope === "watchlists" ? "Add symbols to a watchlist to see them here." : "Clear the filter or choose another scope."}</Empty>}
          columns={[
            { key: "sym", header: "Symbol", sticky: true, sort: (q) => q.symbol, cell: (q) => <SymbolLink symbol={q.symbol} /> },
            { key: "name", header: "Name", sort: (q) => metaMap[q.symbol]?.name, cell: (q) => <span className="muted truncate" style={{ maxWidth: 190, display: "inline-block" }}>{metaMap[q.symbol]?.name ?? "—"}</span> },
            { key: "sec", header: "Sector", sort: (q) => metaMap[q.symbol]?.sector, cell: (q) => <span className="faint truncate" style={{ maxWidth: 130, display: "inline-block" }}>{metaMap[q.symbol]?.sector ?? "—"}</span> },
            { key: "px", header: "Last", num: true, sort: (q) => q.price, cell: (q) => <LivePrice symbol={q.symbol} fallback={q.price} /> },
            { key: "chg", header: "Change %", num: true, sort: (q) => q.change_pct, cell: (q) => <Delta value={q.change_pct} /> },
            { key: "abs", header: "Change", num: true, sort: (q) => q.change, cell: (q) => <Delta value={q.change} kind="abs" bare /> },
            { key: "ba", header: "Bid / ask", num: true, cell: (q) => <span className="muted">{price(q.bid)} / {price(q.ask)}</span> },
            { key: "spr", header: "Spread", num: true, sort: (q) => q.spread_bps, cell: (q) => (isNum(q.spread_bps) ? `${q.spread_bps.toFixed(1)} bps` : "—"), title: "Bid-ask spread in basis points" },
            { key: "rng", header: "Day range", num: true, cell: (q) => <span className="muted">{price(q.low)} – {price(q.high)}</span> },
            { key: "vol", header: "Volume", num: true, sort: (q) => q.volume, cell: (q) => compact(q.volume) },
            { key: "st", header: "Data", sort: (q) => q.status, cell: (q) => <StatusPill status={q.status} note={`${q.venue_note} Updated ${ago(q.ts)}.`} /> },
          ]} />
      </Panel>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.sym)} onClose={() => setMenu(null)} />}
      {ticket && <OrderTicket defaults={{ symbol: ticket }} onClose={() => setTicket(null)} />}
    </div>
  );
}
