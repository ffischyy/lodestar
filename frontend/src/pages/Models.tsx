import { CheckCircle2, Play, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import { useApi } from "../api/hooks";
import type { MethodInfo, ModelInfo } from "../api/types";
import { BarList, LineChart, Reliability } from "../components/charts/svg";
import { DataTable } from "../components/DataTable";
import { Hint } from "../components/domain";
import { toast } from "../components/toast";
import { Empty, ErrorState, Notice, PageHead, Panel, Progress, Seg, Skeleton, Spinner } from "../components/ui";
import { dateTime, num, prob } from "../lib/format";

interface RunRow {
  id: number; created_at: string; status: string; source: string; champion: string | null; passed: boolean; active: boolean; progress: number;
  message: string; error: string | null; reliability: number | null; trained_through: string | null; horizon_days: number;
  baseline_comparison: Record<string, { brier_skill: number; auc: number; ic: number | null }> | null;
}
interface CM { n: number; auc: number; brier: number; brier_baseline: number; brier_skill: number; log_loss: number; ece: number; positive_rate: number; mean_prob: number; reliability: { pred: number; obs: number; n: number }[] }
interface Metrics {
  folds: { fold: number; train_end: string; test_start: string; test_end: string; train_rows: number; test_rows: number }[];
  models: Record<string, { target_first: CM; positive_return: CM; expected_return: { ic_mean: number | null; ic_t_stat: number | null; ic_positive_share: number | null; top_minus_bottom_quintile: number | null; sign_accuracy: number }; per_fold: { fold: number; test_start: string; auc: number; brier_skill: number }[] }>;
  champion: string; return_model: string; gates: Record<string, boolean>; passed: boolean; reliability: number; interval_80_coverage: number;
  feature_importance: { feature: string; importance: number }[]; oos_rows: number; oos_start: string; oos_end: string; train_rows: number; trained_through: string; duration_s: number;
  label_base_rates: Record<string, number>; data_problems: string[];
}

const GATE_LABEL: Record<string, string> = {
  "brier_skill_gt_0": "Beats the base-rate baseline (Brier skill > 0)", "auc_gt_0.52": "Ranks outcomes better than chance (AUC > 0.52)",
  "ece_lt_0.05": "Probabilities are calibrated (error < 5 points)", "oos_rows_ge_1000": "At least 1,000 out-of-sample cases",
};
const MODEL_LABEL: Record<string, string> = {
  base_rate: "Base rate (baseline)", logistic: "Logistic regression", gbm: "Gradient boosting", forest: "Random forest",
  knn: "Pattern analog (k-NN)", factor: "4-factor statistical", ensemble: "Ensemble (average)",
};

export default function ModelsPage() {
  const list = useApi<{ runs: RunRow[]; training: boolean; active: ModelInfo | null; provider: string }>(["models"], "/models", { refetchInterval: (q) => (q.state.data?.training ? 2000 : 15000) });
  const [sel, setSel] = useState<number | null>(null);
  const qc = useQueryClient();
  useEffect(() => {
    const runs = list.data?.runs ?? [];
    if (sel === null && runs.length) setSel((runs.find((r) => r.active) ?? runs.find((r) => r.status === "done") ?? runs[0]).id);
  }, [list.data, sel]);

  const train = async () => {
    try {
      const r = await api.post<{ id: number }>("/models/train");
      setSel(r.id);
      toast("info", "Training started", "Walk-forward validation takes roughly 30–90 seconds.");
      qc.invalidateQueries({ queryKey: ["models"] });
    } catch (e) { toast("error", "Could not start training", errMsg(e)); }
  };
  const activate = async (id: number) => {
    try {
      await api.post(`/models/${id}/activate`);
      toast("success", `Model #${id} is now active`);
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["status"] });
    } catch (e) { toast("error", "Model not activated", errMsg(e)); }
  };

  return (
    <div className="page">
      <PageHead title="Models and methods"
        sub="Trained with purged walk-forward validation, so a model only predicts periods it has not seen"
        actions={<button className="btn primary" onClick={train} disabled={list.data?.training}>{list.data?.training ? <Spinner /> : <Play size={16} />} Train new model</button>} />
      {list.isLoading ? <Skeleton rows={8} /> : list.error ? <ErrorState error={list.error} retry={() => list.refetch()} /> : (
        <div className="stack lg">
          <MethodsPanel />
          <Panel title="Training runs" hint={`Data source: ${list.data!.provider}`} flush>
            <DataTable<RunRow> label="Model runs" rows={list.data!.runs} rowKey={(r) => r.id} onRowClick={(r) => setSel(r.id)} selectedKey={sel} maxHeight={260}
              empty={<Empty title="No models trained yet">Training starts automatically on first launch, or press Train new model.</Empty>}
              columns={[
                { key: "id", header: "Run", cell: (r) => <span className="num">#{r.id}</span> },
                { key: "t", header: "Started", cell: (r) => <span className="num muted">{dateTime(r.created_at)}</span> },
                { key: "src", header: "Data", cell: (r) => r.source },
                { key: "st", header: "Status", cell: (r) => r.status === "running" ? <span className="row" style={{ minWidth: 160 }}><Progress value={r.progress} /><span className="xs faint">{Math.round(r.progress * 100)}%</span></span>
                  : <span className={`badge ${r.status === "failed" ? "error" : ""}`}>{r.status}</span> },
                { key: "ch", header: "Champion", cell: (r) => (r.champion ? MODEL_LABEL[r.champion] : "—") },
                { key: "v", header: "Validation", cell: (r) => r.status !== "done" ? "—" : r.passed ? <span className="up row" style={{ gap: 4 }}><CheckCircle2 size={16} /> Passed</span> : <span className="down row" style={{ gap: 4 }}><XCircle size={16} /> Failed</span> },
                { key: "rel", header: "Reliability", num: true, cell: (r) => num(r.reliability) },
                { key: "thr", header: "Trained through", num: true, cell: (r) => r.trained_through ?? "—" },
                { key: "a", header: "", cell: (r) => r.active ? <span className="badge accent">Active</span>
                  : r.status === "done" && r.source === list.data!.provider ? <button className="btn sm" onClick={(e) => { e.stopPropagation(); activate(r.id); }}>Activate</button> : null },
              ]} />
          </Panel>
          {sel !== null && <RunDetail id={sel} />}
        </div>
      )}
    </div>
  );
}

function RunDetail({ id }: { id: number }) {
  const q = useApi<RunRow & { metrics: Metrics; config: Record<string, unknown> }>(["model", id], `/models/${id}`, { refetchInterval: (x) => (x.state.data?.status === "running" ? 2000 : false) });
  const [target, setTarget] = useState<"target_first" | "positive_return">("target_first");
  if (q.isLoading) return <Skeleton rows={6} />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const r = q.data!;
  if (r.status === "running") return <Panel title={`Run #${id}`}><div className="stack"><Progress value={r.progress} /><span className="small muted">{r.message}</span></div></Panel>;
  if (r.status === "failed") return <Panel title={`Run #${id}`}><Notice kind="error"><strong>Training failed.</strong> {r.error}</Notice></Panel>;
  const m = r.metrics;
  const champ = m.models[m.champion];
  const cm = champ[target];
  const kinds = (m as Metrics & { methods?: string[] }).methods ?? Object.keys(m.models);
  return (
    <div className="grid g-12">
      <Panel className="span-12" title={`Run #${id}: ${MODEL_LABEL[m.champion]} selected`} hint={`${m.oos_rows.toLocaleString()} out-of-sample predictions, ${m.oos_start} to ${m.oos_end}`}>
        <div className="stack lg">
          {m.passed ? (
            <Notice>This model passed every validation gate. That shows past out-of-sample skill on {r.source} data; it does not guarantee future results.</Notice>
          ) : (
            <Notice kind="warn"><strong>Validation failed.</strong> The model did not demonstrate reliable skill, so the scanner treats its forecasts as unreliable and rejects trades that depend on them.</Notice>
          )}
          <div className="grid cols-2">
            <div className="stack">
              <div className="section-title">Validation gates</div>
              {Object.entries(m.gates).map(([g, ok]) => (
                <div key={g} className="row small">{ok ? <CheckCircle2 size={16} className="up" aria-label="pass" /> : <XCircle size={16} className="down" aria-label="fail" />}{GATE_LABEL[g] ?? g}</div>
              ))}
            </div>
            <dl className="kv small">
              <dt>Reliability score</dt><dd className="num">{num(m.reliability)}</dd>
              <dt>Return model</dt><dd>{MODEL_LABEL[m.return_model]}</dd>
              <dt><Hint tip="Share of real outcomes that fell inside the predicted 10th–90th percentile range. 80% is ideal.">80% interval coverage</Hint></dt>
              <dd className={`num ${Math.abs(m.interval_80_coverage - 0.8) > 0.07 ? "down" : ""}`}>{prob(m.interval_80_coverage, 1)}</dd>
              <dt>Training rows</dt><dd className="num">{m.train_rows.toLocaleString()}</dd>
              <dt>Horizon / barriers</dt><dd className="num">{String(r.config.horizon_days)}d, {String(r.config.barrier_target_atr)}×ATR target / {String(r.config.barrier_stop_atr)}×ATR stop</dd>
              <dt>Duration</dt><dd className="num">{m.duration_s}s</dd>
            </dl>
          </div>
        </div>
      </Panel>
      <Panel className="span-7" title="Baseline comparison" hint="Out-of-sample, all folds" flush
        actions={<Seg label="Target" value={target} onChange={setTarget} options={[{ value: "target_first", label: "Target before stop" }, { value: "positive_return", label: "Positive return" }]} />}>
        <DataTable label="Model comparison" rows={kinds} rowKey={(k) => k} initialSort={{ key: "bs", desc: true }}
          columns={[
            { key: "m", header: "Method", cell: (k) => <span className="row">{MODEL_LABEL[k] ?? k}{k === m.champion && <span className="badge accent">in use</span>}</span> },
            { key: "auc", header: <Hint tip="0.5 = no better than chance at ranking outcomes">AUC</Hint>, num: true, sort: (k) => m.models[k][target].auc, cell: (k) => num(m.models[k][target].auc, 3) },
            { key: "bs", header: <Hint tip="Improvement in Brier score over the base-rate baseline. Above 0 means better.">Brier skill</Hint>, num: true, sort: (k) => m.models[k][target].brier_skill,
              cell: (k) => <span className={m.models[k][target].brier_skill > 0 ? "up" : m.models[k][target].brier_skill < 0 ? "down" : ""}>{(m.models[k][target].brier_skill * 100).toFixed(2)}%</span> },
            { key: "ece", header: <Hint tip="Average gap between predicted and observed frequency">Calib. error</Hint>, num: true, cell: (k) => prob(m.models[k][target].ece, 1) },
            { key: "ll", header: "Log loss", num: true, cell: (k) => num(m.models[k][target].log_loss, 4) },
            { key: "ic", header: <Hint tip="Rank correlation between predicted and realised returns across stocks, averaged per day">Return IC</Hint>, num: true, cell: (k) => num(m.models[k].expected_return.ic_mean, 3) },
          ]} />
        <div className="panel-foot">Base rate for this target: {prob(cm.positive_rate, 1)} of cases. A model that only predicts that rate has Brier skill 0.</div>
      </Panel>
      <Panel className="span-5" title="Calibration" hint={`${MODEL_LABEL[m.champion]}, ${target === "target_first" ? "target before stop" : "positive return"}`}>
        <Reliability bins={cm.reliability} label="Reliability diagram" />
        <p className="xs faint">Dots on the dashed diagonal mean that when the model says 40%, it happens about 40% of the time.</p>
      </Panel>
      <Panel className="span-7" title="Stability across walk-forward folds" hint="Each fold is a later, unseen period">
        <LineChart labels={champ.per_fold.map((f) => f.test_start)} height={220} format={(v) => v.toFixed(3)}
          series={[
            { name: `${MODEL_LABEL[m.champion]} AUC`, values: champ.per_fold.map((f) => f.auc), color: "var(--chart-1)" },
            { name: "Chance (0.5)", values: champ.per_fold.map(() => 0.5), color: "var(--text-3)", dashed: true },
          ]} />
      </Panel>
      <Panel className="span-5" title="Most influential features" hint="Permutation importance, last fold">
        {m.feature_importance.length ? <BarList colorize format={(v) => v.toFixed(4)} items={m.feature_importance.slice(0, 12).map((f) => ({ label: f.feature, value: f.importance }))} />
          : <p className="small faint">Not available for this run.</p>}
      </Panel>
      <Panel className="span-12" title="Walk-forward folds" flush>
        <DataTable label="Folds" rows={m.folds} rowKey={(f) => f.fold}
          columns={[
            { key: "f", header: "Fold", cell: (f) => <span className="num">{f.fold}</span> },
            { key: "te", header: "Training ends", num: true, cell: (f) => f.train_end },
            { key: "ts", header: "Test starts", num: true, cell: (f) => f.test_start },
            { key: "tn", header: "Test ends", num: true, cell: (f) => f.test_end },
            { key: "tr", header: "Training rows", num: true, cell: (f) => f.train_rows.toLocaleString() },
            { key: "tt", header: "Test rows", num: true, cell: (f) => f.test_rows.toLocaleString() },
          ]} />
        {m.data_problems.length > 0 && <div className="panel-foot">Symbols skipped: {m.data_problems.join("; ")}</div>}
      </Panel>
    </div>
  );
}


/** Choose which prediction methods to train and how the one in use is picked. */
function MethodsPanel() {
  const methods = useApi<Record<string, MethodInfo>>(["methods"], "/methods", { staleTime: Infinity });
  const st = useApi<{ settings: { model: { methods: string[]; selection: string } } }>(["settings"], "/settings");
  const qc = useQueryClient();
  const [sel, setSel] = useState<string[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  if (!methods.data || !st.data) return null;
  const cur = sel ?? st.data.settings.model.methods;
  const choice = pick ?? st.data.settings.model.selection;
  const keys = Object.keys(methods.data).filter((k) => k !== "base_rate");
  const dirty = JSON.stringify(cur) !== JSON.stringify(st.data.settings.model.methods) || choice !== st.data.settings.model.selection;
  const toggle = (k: string) => {
    let next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
    if (k === "ensemble" && !cur.includes(k)) next = Array.from(new Set([...next, "logistic", "gbm", "forest"]));
    if (["logistic", "gbm", "forest"].includes(k) && cur.includes(k)) next = next.filter((x) => x !== "ensemble");
    setSel(keys.filter((x) => next.includes(x)));
  };
  const save = async (train: boolean) => {
    try {
      await api.patch("/settings", { model: { methods: cur, selection: cur.includes(choice) || choice === "auto" ? choice : "auto" } });
      qc.invalidateQueries({ queryKey: ["settings"] });
      setSel(null); setPick(null);
      if (train) {
        await api.post("/models/train");
        qc.invalidateQueries({ queryKey: ["models"] });
        toast("info", "Training started", `${cur.length} methods, compared against the baseline. This takes 1–3 minutes.`);
      } else toast("success", "Saved", "Applies at the next training run.");
    } catch (e) { toast("error", "Not saved", errMsg(e)); }
  };
  return (
    <Panel title="Prediction methods" hint="Different ways of reading the same data"
      actions={<>
        <button className="btn sm" disabled={!dirty} onClick={() => save(false)}>Save</button>
        <button className="btn primary sm" disabled={!cur.length} onClick={() => save(true)}><Play size={16} /> Save and train</button>
      </>}>
      <div className="stack lg">
        <div className="grid auto-fill" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
          {keys.map((k) => (
            <label key={k} className="method-card" data-on={cur.includes(k)}>
              <input type="checkbox" checked={cur.includes(k)} onChange={() => toggle(k)} />
              <span className="stack" style={{ gap: 2 }}>
                <b>{methods.data![k].name}</b>
                <span className="xs muted">{methods.data![k].about}</span>
                <span className="xs faint">Family: {methods.data![k].family}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="row wrap">
          <span className="small muted">Method used for trading decisions:</span>
          <select className="select" style={{ width: 320 }} value={choice} onChange={(e) => setPick(e.target.value)} aria-label="Method in use">
            <option value="auto">Automatic: the best validated method</option>
            {cur.map((k) => <option key={k} value={k}>Always use {methods.data![k].name}</option>)}
          </select>
        </div>
        <p className="xs faint">Every method is compared with the simple base rate. A method that cannot beat it out-of-sample is not trusted, however sophisticated it is.</p>
      </div>
    </Panel>
  );
}
