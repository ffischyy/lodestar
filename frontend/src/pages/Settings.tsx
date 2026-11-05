import { RotateCcw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import { useApi } from "../api/hooks";
import { toast } from "../components/toast";
import { Confirm, ErrorState, Field, Notice, NumberInput, PageHead, Panel, Skeleton, Tabs, Toggle } from "../components/ui";

type S = Record<string, Record<string, unknown>>;
type Section = "risk" | "costs" | "universe" | "model" | "general";

const RISK: [string, string, string][] = [
  ["risk_per_trade_pct", "Risk per trade (% of equity)", "Loss if the stop fills at its price. Gaps can make it larger."],
  ["max_position_pct", "Maximum position size (% of equity)", ""], ["max_gross_exposure_pct", "Maximum gross exposure (%)", "Sum of all long and short positions"],
  ["max_sector_pct", "Maximum sector exposure (%)", ""], ["max_correlation", "Correlation warning above", "0–1, using 60-day returns"],
  ["max_daily_loss_pct", "Daily loss halt (%)", "New entries blocked for the rest of the day"], ["max_drawdown_pct", "Drawdown halt (%)", "From the equity peak; cleared manually"],
  ["stop_atr_mult", "Default stop distance (× ATR)", "Used when no model is active"],
];
const COSTS: [string, string, string][] = [
  ["commission_per_share", "Commission per share ($)", "0 for most US retail brokers"], ["min_commission", "Minimum commission per order ($)", ""],
  ["default_spread_bps", "Assumed spread (bps)", "Used when no bid/ask is available"], ["slippage_bps", "Slippage per side (bps)", "Extra cost beyond the spread"],
];
const MODEL: [string, string, string][] = [
  ["horizon_days", "Forecast horizon (trading days)", ""], ["barrier_target_atr", "Target barrier (× ATR)", ""], ["barrier_stop_atr", "Stop barrier (× ATR)", ""],
  ["retrain_days", "Retrain automatically every (days)", ""], ["min_train_rows", "Minimum training rows", ""],
];

export default function SettingsPage() {
  const q = useApi<{ settings: S; defaults: S; default_universe: string[] }>(["settings"], "/settings");
  const qc = useQueryClient();
  const [tab, setTab] = useState<Section>("risk");
  const [draft, setDraft] = useState<S | null>(null);
  const [uni, setUni] = useState("");
  const [reset, setReset] = useState(false);
  useEffect(() => {
    if (q.data && !draft) {
      setDraft(structuredClone(q.data.settings));
      setUni(((q.data.settings.universe.symbols as string[]) ?? []).join(", "));
    }
  }, [q.data, draft]);
  if (q.isLoading || !draft) return <div className="page"><Skeleton rows={10} /></div>;
  if (q.error) return <div className="page"><ErrorState error={q.error} retry={() => q.refetch()} /></div>;
  const set = (sec: string, k: string, v: unknown) => setDraft({ ...draft, [sec]: { ...draft[sec], [k]: v } });
  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data!.settings) || uni !== ((q.data!.settings.universe.symbols as string[]) ?? []).join(", ");

  const save = async () => {
    const symbols = uni.toUpperCase().split(/[\s,]+/).filter(Boolean);
    const patch = { risk: draft.risk, costs: draft.costs, model: draft.model, general: draft.general, universe: { symbols } };
    try {
      await api.patch("/settings", patch);
      qc.invalidateQueries();
      setDraft(null);
      toast("success", "Settings saved", "Model settings take effect at the next training run.");
    } catch (e) { toast("error", "Settings not saved", errMsg(e)); }
  };
  const fields = (sec: string, list: [string, string, string][]) => (
    <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
      {list.map(([k, label, help]) => (
        <Field key={k} label={label} help={`${help}${help ? ". " : ""}Default ${String(q.data!.defaults[sec][k])}`}>
          <NumberInput value={draft[sec][k] as number} onChange={(v) => set(sec, k, v)} />
        </Field>
      ))}
    </div>
  );

  return (
    <div className="page">
      <PageHead title="Settings" sub="Risk limits, trading costs, the stock universe and model configuration"
        actions={<>
          <button className="btn ghost" onClick={() => setReset(true)}><RotateCcw size={16} /> Restore all defaults</button>
          <button className="btn primary" disabled={!dirty} onClick={save}><Save size={16} /> Save changes</button>
        </>} />
      <Panel flush title={<Tabs value={tab} onChange={setTab} tabs={[{ value: "risk", label: "Risk" }, { value: "costs", label: "Costs" }, { value: "universe", label: "Universe" }, { value: "model", label: "Model" }, { value: "general", label: "General" }]} />}>
        <div className="panel-body stack lg">
          {tab === "risk" && <>{fields("risk", RISK)}<Notice>Position size = (equity × risk per trade) ÷ (entry − stop + costs), then capped by maximum position size and buying power. Stops are not guaranteed: an overnight gap can fill far beyond the stop.</Notice></>}
          {tab === "costs" && <>{fields("costs", COSTS)}<p className="small muted">Costs are applied to the scanner's net expected return, paper fills, and default backtest settings.</p></>}
          {tab === "universe" && (
            <div className="stack lg">
              <Field label="Stocks to analyse" help={`Leave empty to use the built-in ${q.data!.default_universe.length}-stock universe. More symbols mean slower scans and, on Alpaca, more API calls.`}>
                <textarea className="input num" rows={6} value={uni} onChange={(e) => setUni(e.target.value)} placeholder={q.data!.default_universe.join(", ")} />
              </Field>
              <Notice kind="warn">Changing the universe changes what the model is trained on. Retrain on the Model evaluation screen afterwards.</Notice>
            </div>
          )}
          {tab === "model" && <>{fields("model", MODEL)}<Notice>Changing the horizon or barriers changes the question the model answers. Existing forecasts keep their original settings; train a new model to apply these.</Notice></>}
          {tab === "general" && (
            <div className="stack lg">
              <Toggle checked={!!draft.general.allow_short} onChange={(v) => set("general", "allow_short", v)} label="Allow short selling in the scanner and paper trading" />
              <div className="form-grid">
                <Field label="Account currency" help="Display only; prices stay in USD">
                  <select className="select" value={String(draft.general.base_currency)} onChange={(e) => set("general", "base_currency", e.target.value)}>
                    <option>USD</option><option>CAD</option><option>EUR</option><option>GBP</option>
                  </select>
                </Field>
                <Field label="USD to account currency rate" help="Enter today's rate yourself; not fetched automatically">
                  <NumberInput value={draft.general.fx_rate_to_base as number} onChange={(v) => set("general", "fx_rate_to_base", v)} step={0.0001} />
                </Field>
              </div>
              <Notice><strong>Real-money trading is not available</strong> in this version. Any future broker connection would require explicit opt-in, order previews, duplicate-order protection and the kill switch.</Notice>
            </div>
          )}
        </div>
      </Panel>
      {reset && <Confirm title="Restore every setting to its default?" danger confirmLabel="Restore defaults" body="Risk limits, costs, universe, model and scanner settings all revert. Paper history and dashboards are kept."
        onCancel={() => setReset(false)} onConfirm={async () => { setReset(false); await api.post("/settings/reset"); setDraft(null); qc.invalidateQueries(); toast("info", "Settings restored to defaults"); }} />}
    </div>
  );
}
