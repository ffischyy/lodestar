import { Copy, LayoutGrid, Pencil, Plus, RotateCcw, Save, Star, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Responsive, WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import { useApi } from "../api/hooks";
import type { DashboardT, Widget } from "../api/types";
import { WIDGETS } from "../components/widgets";
import { toast } from "../components/toast";
import { Confirm, ErrorState, Modal, PageHead, Skeleton } from "../components/ui";

const Grid = WidthProvider(Responsive);

export default function DashboardsPage() {
  const q = useApi<{ dashboards: DashboardT[]; widgets: string[]; default_layout: Widget[] }>(["dashboards"], "/dashboards");
  const qc = useQueryClient();
  const [activeId, setActiveId] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Widget[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [rename, setRename] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "restore" | null>(null);

  useEffect(() => {
    if (q.data && (activeId === null || !q.data.dashboards.find((d) => d.id === activeId)))
      setActiveId((q.data.dashboards.find((d) => d.is_default) ?? q.data.dashboards[0])?.id ?? null);
  }, [q.data, activeId]);
  const dash = q.data?.dashboards.find((d) => d.id === activeId);
  const layout = draft ?? dash?.layout ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["dashboards"] });

  const call = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast("success", ok); refresh(); } catch (e) { toast("error", "Dashboard not updated", errMsg(e)); }
  };
  const save = () => call(async () => { await api.put(`/dashboards/${dash!.id}`, { name: dash!.name, layout }); setEditing(false); setDraft(null); }, "Layout saved");
  const onLayout = (l: Layout[]) => {
    if (!editing) return;
    setDraft(layout.map((w) => {
      const n = l.find((x) => x.i === w.i);
      return n ? { ...w, x: n.x, y: n.y, w: n.w, h: n.h } : w;
    }));
  };
  const addWidget = (key: string) => {
    const d = WIDGETS[key].defaults;
    const id = `w${Date.now().toString(36)}`;
    const maxY = layout.reduce((m, w) => Math.max(m, w.y + w.h), 0);
    setDraft([...layout, { i: id, widget: key, x: 0, y: maxY, w: d.w, h: d.h, config: WIDGETS[key].configurable ? { symbol: "SPY" } : {} }]);
    setEditing(true);
    setAdding(false);
  };
  const gridLayout = useMemo(() => layout.map((w) => ({ i: w.i, x: w.x, y: w.y, w: w.w, h: w.h, minW: 2, minH: 3 })), [layout]);

  if (q.isLoading) return <div className="page"><Skeleton rows={10} /></div>;
  if (q.error) return <div className="page"><ErrorState error={q.error} retry={() => q.refetch()} /></div>;

  return (
    <div className="page">
      <PageHead title="Dashboards"
        sub={editing ? "Drag panels by their title bar, resize from the corner, then save" : "Your own arrangement of live panels"}
        actions={
          <>
            <select className="select" style={{ width: 200 }} value={activeId ?? ""} disabled={editing} onChange={(e) => setActiveId(+e.target.value)} aria-label="Dashboard">
              {q.data!.dashboards.map((d) => <option key={d.id} value={d.id}>{d.name}{d.is_default ? " (default)" : ""}</option>)}
            </select>
            {editing ? (
              <>
                <button className="btn" onClick={() => setAdding(true)}><Plus size={16} /> Add widget</button>
                <button className="btn" onClick={() => { setEditing(false); setDraft(null); }}><X size={16} /> Cancel</button>
                <button className="btn primary" onClick={save}><Save size={16} /> Save layout</button>
              </>
            ) : (
              <>
                <button className="btn" onClick={() => setEditing(true)} title="Edit layout"><Pencil size={16} /> Edit</button>
                <button className="btn ghost icon" aria-label="Rename" title="Rename" onClick={() => setRename(dash?.name ?? "")}><LayoutGrid size={16} /></button>
                <button className="btn ghost icon" aria-label="Duplicate" title="Duplicate" onClick={() => call(async () => { const d = await api.post<DashboardT>(`/dashboards/${dash!.id}/duplicate`); setActiveId(d.id); }, "Dashboard duplicated")}><Copy size={16} /></button>
                <button className="btn ghost icon" aria-label="Set as default" title="Set as default" disabled={dash?.is_default} onClick={() => call(() => api.post(`/dashboards/${dash!.id}/default`), `${dash!.name} is now the default`)}><Star size={16} /></button>
                <button className="btn ghost icon" aria-label="Restore original layout" title="Restore original layout" onClick={() => setConfirm("restore")}><RotateCcw size={16} /></button>
                <button className="btn ghost icon" aria-label="Delete dashboard" title="Delete" onClick={() => setConfirm("delete")} disabled={q.data!.dashboards.length <= 1}><Trash2 size={16} /></button>
                <button className="btn primary" onClick={() => call(async () => { const d = await api.post<DashboardT>("/dashboards", { name: "New dashboard", layout: [] }); setActiveId(d.id); setEditing(true); }, "Dashboard created")}><Plus size={16} /> New</button>
              </>
            )}
          </>
        } />
      <div className={editing ? "editing" : ""}>
        {layout.length === 0 && <div className="state center"><h3>This dashboard is empty</h3><button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> Add a widget</button></div>}
        <Grid className="layout" layouts={{ lg: gridLayout }} breakpoints={{ lg: 1100, md: 760, sm: 0 }} cols={{ lg: 12, md: 6, sm: 1 }}
          rowHeight={34} margin={[12, 12]} containerPadding={[0, 0]} isDraggable={editing} isResizable={editing} draggableHandle=".panel-head"
          onLayoutChange={(l) => onLayout(l as Layout[])} compactType="vertical">
          {layout.map((w) => {
            const def = WIDGETS[w.widget];
            return (
              <div key={w.i} className="widget">
                <section className="panel" style={{ height: "100%" }}>
                  <header className="panel-head">
                    <h2>{def?.title ?? w.widget}</h2>
                    {editing && def?.configurable === "symbol" && (
                      <input className="input sym" style={{ width: 80, height: 24 }} defaultValue={String(w.config?.symbol ?? "SPY")} aria-label="Widget symbol"
                        onMouseDown={(e) => e.stopPropagation()}
                        onBlur={(e) => setDraft(layout.map((x) => (x.i === w.i ? { ...x, config: { ...x.config, symbol: e.target.value.toUpperCase() } } : x)))} />
                    )}
                    {editing && (
                      <div className="actions">
                        <button className="btn ghost sm icon" aria-label={`Remove ${def?.title}`} onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => setDraft(layout.filter((x) => x.i !== w.i))}><X size={16} /></button>
                      </div>
                    )}
                  </header>
                  <div className="panel-body">{def ? def.render(w.config ?? {}) : <span className="faint">Unknown widget</span>}</div>
                </section>
              </div>
            );
          })}
        </Grid>
      </div>
      {adding && (
        <Modal title="Add a widget" onClose={() => setAdding(false)} wide>
          <div className="grid auto-fill">
            {Object.entries(WIDGETS).map(([k, w]) => (
              <button key={k} className="btn" style={{ height: "auto", padding: 12, justifyContent: "flex-start", flexDirection: "column", alignItems: "flex-start" }} onClick={() => addWidget(k)}>
                <b style={{ fontWeight: 500 }}>{w.title}</b>
                <span className="xs faint">{w.defaults.w} × {w.defaults.h}{w.configurable ? ", choose a symbol" : ""}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {rename !== null && (
        <Modal title="Rename dashboard" onClose={() => setRename(null)}
          foot={<><button className="btn" onClick={() => setRename(null)}>Cancel</button><button className="btn primary" disabled={!rename.trim()}
            onClick={() => call(async () => { await api.put(`/dashboards/${dash!.id}`, { name: rename.trim(), layout: dash!.layout }); setRename(null); }, "Dashboard renamed")}>Rename</button></>}>
          <label className="field"><span>Name</span><input className="input" value={rename} onChange={(e) => setRename(e.target.value)} maxLength={80} /></label>
        </Modal>
      )}
      {confirm === "delete" && <Confirm title={`Delete ${dash?.name}?`} danger confirmLabel="Delete dashboard" body="Its layout is removed. Other dashboards are unaffected."
        onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); call(async () => { await api.del(`/dashboards/${dash!.id}`); setActiveId(null); }, "Dashboard deleted"); }} />}
      {confirm === "restore" && <Confirm title="Restore the original layout?" confirmLabel="Restore" body="Replaces this dashboard's panels with the built-in default arrangement."
        onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); call(() => api.post(`/dashboards/${dash!.id}/restore`), "Original layout restored"); }} />}
    </div>
  );
}
