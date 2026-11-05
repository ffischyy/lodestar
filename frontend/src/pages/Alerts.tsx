import { CheckCheck, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import { useApi } from "../api/hooks";
import type { AlertEvent } from "../api/types";
import { DataTable } from "../components/DataTable";
import { SymbolLink } from "../components/domain";
import { toast } from "../components/toast";
import { Empty, Field, Loadable, Modal, NumberInput, PageHead, Panel, Toggle } from "../components/ui";
import { ago, dateTime } from "../lib/format";

interface AlertRule { id: number; name: string; kind: string; kind_label: string; symbol: string | null; threshold: number | null; enabled: boolean; cooldown_minutes: number; last_fired_at: string | null }

const NEEDS_SYMBOL = new Set(["price_above", "price_below", "pct_change"]);
const THRESH_HELP: Record<string, string> = {
  price_above: "Price in dollars", price_below: "Price in dollars", pct_change: "Absolute % move from the prior close, e.g. 3",
  scanner_hit: "Minimum scanner score (0–100)", prob_above: "Probability between 0 and 1, e.g. 0.45", data_issue: "Not used",
};

export default function AlertsPage() {
  const rules = useApi<{ kinds: Record<string, string>; alerts: AlertRule[] }>(["alerts"], "/alerts");
  const events = useApi<{ unread: number; events: AlertEvent[] }>(["alerts-events"], "/alerts/events?limit=300", { refetchInterval: 15_000 });
  const [edit, setEdit] = useState<AlertRule | "new" | null>(null);
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries({ queryKey: ["alerts"] }); qc.invalidateQueries({ queryKey: ["alerts-events"] }); qc.invalidateQueries({ queryKey: ["status"] }); };

  useEffect(() => {   // reading this screen marks notifications as read
    if (events.data?.unread) {
      const t = window.setTimeout(() => api.post("/alerts/events/read").then(refresh), 2500);
      return () => window.clearTimeout(t);
    }
  }, [events.data?.unread]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (a: AlertRule, enabled: boolean) => {
    try { await api.put(`/alerts/${a.id}`, { ...a, enabled }); refresh(); } catch (e) { toast("error", "Alert not updated", errMsg(e)); }
  };

  return (
    <div className="page">
      <PageHead title="Alerts and notifications" sub="Rules run on every quote update and wait out their cool-down before firing again"
        actions={<button className="btn primary" onClick={() => setEdit("new")}><Plus size={16} /> New alert</button>} />
      <div className="grid g-12">
        <Panel className="span-6" title="Rules" flush>
          <Loadable q={rules}>
            {(d) => (
              <DataTable<AlertRule> label="Alert rules" rows={d.alerts} rowKey={(a) => a.id}
                empty={<Empty title="No alert rules" action={<button className="btn primary sm" onClick={() => setEdit("new")}>Create an alert</button>}>For example: notify me when NVDA moves more than 4% today.</Empty>}
                columns={[
                  { key: "on", header: "On", cell: (a) => <button type="button" role="switch" className="toggle" aria-checked={a.enabled} aria-label={`${a.name} enabled`} onClick={() => toggle(a, !a.enabled)} /> },
                  { key: "n", header: "Name", cell: (a) => a.name },
                  { key: "k", header: "Condition", cell: (a) => <span className="muted">{a.kind_label} {a.threshold ?? ""}</span> },
                  { key: "s", header: "Symbol", cell: (a) => (a.symbol ? <SymbolLink symbol={a.symbol} /> : <span className="faint">Any</span>) },
                  { key: "f", header: "Last fired", cell: (a) => <span className="faint small">{a.last_fired_at ? ago(a.last_fired_at) : "never"}</span> },
                  { key: "x", header: "", cell: (a) => (
                    <span className="row" style={{ gap: 2 }}>
                      <button className="btn ghost sm icon" aria-label={`Edit ${a.name}`} onClick={() => setEdit(a)}><Pencil size={16} /></button>
                      <button className="btn ghost sm icon" aria-label={`Delete ${a.name}`} onClick={async () => { await api.del(`/alerts/${a.id}`); refresh(); toast("info", "Alert deleted"); }}><Trash2 size={16} /></button>
                    </span>
                  ) },
                ]} />
            )}
          </Loadable>
        </Panel>
        <Panel className="span-6" title="Notifications" flush hint={events.data?.unread ? `${events.data.unread} unread` : undefined}
          actions={<button className="btn ghost sm" onClick={() => api.post("/alerts/events/read").then(refresh)}><CheckCheck size={16} /> Mark all read</button>}>
          <Loadable q={events}>
            {(d) => (
              <DataTable<AlertEvent> label="Notifications" rows={d.events} rowKey={(e) => e.id} maxHeight="70vh"
                empty={<Empty title="Nothing yet">Paper fills, alert hits and data problems appear here.</Empty>}
                columns={[
                  { key: "t", header: "Time", cell: (e) => <span className="num muted small">{dateTime(e.ts)}</span> },
                  { key: "l", header: "Level", cell: (e) => <span className={`badge ${e.level === "error" ? "error" : e.level === "warn" ? "warn" : "info"}`}>{e.level}</span> },
                  { key: "m", header: "Message", cell: (e) => <span style={{ whiteSpace: "normal" }}><b style={{ fontWeight: e.read ? 400 : 600 }}>{e.title}</b> <span className="muted">{e.body}</span></span> },
                ]} />
            )}
          </Loadable>
        </Panel>
      </div>
      {edit && rules.data && <AlertDialog rule={edit === "new" ? null : edit} kinds={rules.data.kinds} onClose={() => setEdit(null)} onSaved={refresh} />}
    </div>
  );
}

function AlertDialog({ rule, kinds, onClose, onSaved }: { rule: AlertRule | null; kinds: Record<string, string>; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: rule?.name ?? "", kind: rule?.kind ?? "price_above", symbol: rule?.symbol ?? "", threshold: rule?.threshold ?? null as number | null,
    enabled: rule?.enabled ?? true, cooldown_minutes: rule?.cooldown_minutes ?? 60 });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    const body = { ...f, symbol: f.symbol.trim() || null, name: f.name.trim() || `${kinds[f.kind]} ${f.threshold ?? ""} ${f.symbol}`.trim() };
    try {
      if (rule) await api.put(`/alerts/${rule.id}`, body); else await api.post("/alerts", body);
      toast("success", rule ? "Alert updated" : "Alert created");
      onSaved();
      onClose();
    } catch (e) { setErr(errMsg(e)); }
  };
  return (
    <Modal title={rule ? "Edit alert" : "New alert"} onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>{rule ? "Save alert" : "Create alert"}</button></>}>
      <div className="stack lg">
        <Field label="Condition">
          <select className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {Object.entries(kinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <div className="form-grid">
          <Field label={NEEDS_SYMBOL.has(f.kind) ? "Symbol" : "Symbol (optional)"}><input className="input sym" value={f.symbol} onChange={(e) => setF({ ...f, symbol: e.target.value.toUpperCase() })} /></Field>
          <Field label="Threshold" help={THRESH_HELP[f.kind]}><NumberInput value={f.threshold} onChange={(v) => setF({ ...f, threshold: v })} /></Field>
          <Field label="Cool-down (minutes)"><NumberInput value={f.cooldown_minutes} onChange={(v) => setF({ ...f, cooldown_minutes: Math.round(v ?? 60) })} /></Field>
        </div>
        <Field label="Name" help="Optional, shown in notifications"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} /></Field>
        <Toggle checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Enabled" />
        {err && <p className="small down" role="alert">{err}</p>}
      </div>
    </Modal>
  );
}
