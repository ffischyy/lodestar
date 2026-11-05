import { FlaskConical, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import { useApi } from "../api/hooks";
import { toast } from "../components/toast";
import { Field, Loadable, NumberInput, PageHead, Panel, Toggle } from "../components/ui";

interface Strat { key: string; name: string; description: string; params: Record<string, number>; default_params: Record<string, number>; exit_rule: string; long_short: string; tags: string[]; enabled: boolean }

const PARAM_LABELS: Record<string, string> = {
  top_pct: "Top/bottom fraction of universe", lookback: "Lookback (days)", rsi2_entry: "RSI(2) entry threshold", rsi2_exit: "RSI(2) exit threshold",
  adx_min: "Minimum ADX", channel: "Channel length (days)", volume_mult: "Volume multiple", min_prob_edge: "Minimum probability edge",
};

export default function StrategiesPage() {
  const q = useApi<Strat[]>(["strategies"], "/strategies");
  return (
    <div className="page">
      <PageHead title="Strategies"
        sub="The rule sets behind backtests and scanner labels" />
      <Loadable q={q}>
        {(d) => <div className="grid cols-2">{d.map((s) => <StrategyCard key={s.key} s={s} />)}</div>}
      </Loadable>
    </div>
  );
}

function StrategyCard({ s }: { s: Strat }) {
  const [params, setParams] = useState(s.params);
  const qc = useQueryClient();
  const dirty = JSON.stringify(params) !== JSON.stringify(s.params);
  const save = async (patch: { enabled?: boolean; params?: Record<string, number> }) => {
    try {
      await api.put(`/strategies/${s.key}`, patch);
      qc.invalidateQueries({ queryKey: ["strategies"] });
      toast("success", `${s.name} updated`);
    } catch (e) { toast("error", "Strategy not updated", errMsg(e)); }
  };
  return (
    <Panel title={s.name} hint={s.tags.join(", ")}
      actions={<Toggle checked={s.enabled} onChange={(v) => save({ enabled: v })} label={s.enabled ? "Enabled" : "Disabled"} />}>
      <div className="stack lg">
        <p className="small muted" style={{ maxWidth: "70ch" }}>{s.description}</p>
        <dl className="kv small">
          <dt>Exits</dt><dd>{s.exit_rule}</dd>
          <dt>Direction</dt><dd>{s.long_short}</dd>
        </dl>
        <div className="form-grid">
          {Object.entries(params).map(([k, v]) => (
            <Field key={k} label={PARAM_LABELS[k] ?? k} help={`Default ${s.default_params[k]}`}>
              <NumberInput value={v} onChange={(x) => setParams({ ...params, [k]: x ?? 0 })} />
            </Field>
          ))}
        </div>
        <div className="row">
          <button className="btn primary sm" disabled={!dirty} onClick={() => save({ params })}>Save parameters</button>
          <button className="btn ghost sm" onClick={() => { setParams(s.default_params); save({ params: s.default_params }); }}><RotateCcw size={16} /> Defaults</button>
          <Link className="btn sm" to={`/backtest?strategy=${s.key}`} style={{ marginLeft: "auto" }}><FlaskConical size={16} /> Backtest</Link>
        </div>
      </div>
    </Panel>
  );
}
