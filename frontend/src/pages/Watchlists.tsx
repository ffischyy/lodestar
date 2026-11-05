import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import { useApi } from "../api/hooks";
import { useLive } from "../api/live";
import { DataTable } from "../components/DataTable";
import { LivePrice, SymbolLink } from "../components/domain";
import { toast } from "../components/toast";
import { Confirm, Delta, Empty, Loadable, Modal, PageHead, Panel, StatusPill } from "../components/ui";
import { compact, price } from "../lib/format";

interface WL { id: number; name: string; symbols: string[] }

export default function WatchlistsPage() {
  const q = useApi<WL[]>(["watchlists"], "/watchlists");
  const [active, setActive] = useState<number | null>(null);
  const [edit, setEdit] = useState<WL | "new" | null>(null);
  const [del, setDel] = useState<WL | null>(null);
  const [add, setAdd] = useState("");
  const quotes = useLive((s) => s.quotes);
  const qc = useQueryClient();
  const nav = useNavigate();

  useEffect(() => {
    if (q.data?.length && (active === null || !q.data.find((w) => w.id === active))) setActive(q.data[0].id);
  }, [q.data, active]);
  const wl = q.data?.find((w) => w.id === active);

  const save = async (w: WL) => {
    try {
      await api.put(`/watchlists/${w.id}`, { name: w.name, symbols: w.symbols });
      qc.invalidateQueries({ queryKey: ["watchlists"] });
    } catch (e) { toast("error", "Watchlist not saved", errMsg(e)); }
  };
  const addSymbols = async () => {
    if (!wl || !add.trim()) return;
    const syms = add.toUpperCase().split(/[\s,]+/).filter(Boolean);
    await save({ ...wl, symbols: Array.from(new Set([...wl.symbols, ...syms])) });
    setAdd("");
  };

  return (
    <div className="page">
      <PageHead title="Watchlists" sub="Symbols you follow, streamed in the live monitor"
        actions={<button className="btn primary" onClick={() => setEdit("new")}><Plus size={16} /> New watchlist</button>} />
      <Loadable q={q} empty={(d) => (d.length ? null : (
        <Panel><Empty title="No watchlists yet" action={<button className="btn primary" onClick={() => setEdit("new")}>Create your first watchlist</button>}>
          Group the stocks you care about, for example by theme or by trade idea.
        </Empty></Panel>
      ))}>
        {(lists) => (
          <div className="grid g-12">
            <Panel className="span-3" title="Lists" flush>
              <div role="listbox" aria-label="Watchlists">
                {lists.map((w) => (
                  <div key={w.id} role="option" aria-selected={w.id === active} tabIndex={0} className="row between"
                    style={{ padding: "8px var(--pad)", cursor: "pointer", borderBottom: "var(--line)", background: w.id === active ? "var(--accent-soft)" : undefined }}
                    onClick={() => setActive(w.id)} onKeyDown={(e) => e.key === "Enter" && setActive(w.id)}>
                    <span className="truncate">{w.name}</span><span className="faint small num">{w.symbols.length}</span>
                  </div>
                ))}
              </div>
            </Panel>
            {wl && (
              <Panel className="span-9" title={wl.name} flush
                actions={<>
                  <form className="row" onSubmit={(e) => { e.preventDefault(); addSymbols(); }}>
                    <input className="input" style={{ width: 200 }} placeholder="Add symbols: NVDA, AMD" value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Symbols to add" />
                    <button className="btn" type="submit" disabled={!add.trim()}><Plus size={16} /> Add</button>
                  </form>
                  <button className="btn ghost sm icon" onClick={() => setEdit(wl)} aria-label="Rename watchlist"><Pencil size={16} /></button>
                  <button className="btn ghost sm icon" onClick={() => setDel(wl)} aria-label="Delete watchlist"><Trash2 size={16} /></button>
                </>}>
                <DataTable label={wl.name} rows={wl.symbols} rowKey={(s) => s} onRowClick={(s) => nav(`/research/${s}`)}
                  empty={<Empty title="This list is empty">Add symbols with the field above.</Empty>}
                  columns={[
                    { key: "s", header: "Symbol", sticky: true, sort: (s) => s, cell: (s) => <SymbolLink symbol={s} /> },
                    { key: "p", header: "Last", num: true, sort: (s) => quotes[s]?.price, cell: (s) => <LivePrice symbol={s} /> },
                    { key: "c", header: "Change", num: true, sort: (s) => quotes[s]?.change_pct, cell: (s) => <Delta value={quotes[s]?.change_pct} /> },
                    { key: "r", header: "Day range", num: true, cell: (s) => <span className="muted">{price(quotes[s]?.low)} – {price(quotes[s]?.high)}</span> },
                    { key: "v", header: "Volume", num: true, cell: (s) => compact(quotes[s]?.volume) },
                    { key: "st", header: "Data", cell: (s) => <StatusPill status={quotes[s]?.status ?? "unavailable"} /> },
                    { key: "x", header: "", cell: (s) => (
                      <button className="btn ghost sm icon" aria-label={`Remove ${s}`} onClick={(e) => { e.stopPropagation(); save({ ...wl, symbols: wl.symbols.filter((x) => x !== s) }); }}><X size={16} /></button>
                    ) },
                  ]} />
                <div className="panel-foot">Symbols outside the built-in universe start streaming within one quote cycle.</div>
              </Panel>
            )}
          </div>
        )}
      </Loadable>
      {edit && <EditDialog wl={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={(id) => { setActive(id); qc.invalidateQueries({ queryKey: ["watchlists"] }); }} />}
      {del && <Confirm title={`Delete ${del.name}?`} danger confirmLabel="Delete watchlist" body="Alerts that reference these symbols are not affected."
        onCancel={() => setDel(null)} onConfirm={async () => { await api.del(`/watchlists/${del.id}`); setDel(null); qc.invalidateQueries({ queryKey: ["watchlists"] }); toast("info", `Deleted ${del.name}`); }} />}
    </div>
  );
}

function EditDialog({ wl, onClose, onSaved }: { wl: WL | null; onClose: () => void; onSaved: (id: number) => void }) {
  const [name, setName] = useState(wl?.name ?? "");
  const [syms, setSyms] = useState(wl?.symbols.join(", ") ?? "");
  const submit = async () => {
    const symbols = syms.toUpperCase().split(/[\s,]+/).filter(Boolean);
    try {
      const r = wl ? await api.put<WL>(`/watchlists/${wl.id}`, { name, symbols }) : await api.post<WL>("/watchlists", { name, symbols });
      toast("success", wl ? "Watchlist renamed" : `Created ${r.name}`);
      onSaved(r.id);
      onClose();
    } catch (e) { toast("error", "Watchlist not saved", errMsg(e)); }
  };
  return (
    <Modal title={wl ? "Edit watchlist" : "New watchlist"} onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={submit} disabled={!name.trim()}>{wl ? "Save" : "Create watchlist"}</button></>}>
      <div className="stack lg">
        <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        <label className="field"><span>Symbols</span><textarea className="input" rows={3} value={syms} onChange={(e) => setSyms(e.target.value)} placeholder="AAPL, MSFT, NVDA" />
          <span className="help">Separate with commas or spaces.</span></label>
      </div>
    </Modal>
  );
}
