import { useState } from "react";
import { useApi } from "../api/hooks";
import type { PredictionRow } from "../api/types";
import { Reliability } from "../components/charts/svg";
import { Empty, Loadable, PageHead, Panel, Seg, Stat } from "../components/ui";
import { prob } from "../lib/format";
import { PredictionTable } from "./Research";

interface Calib {
  n: number; message?: string; brier_target_first?: number;
  target_first?: { ece: number; bins: { pred: number; obs: number; n: number }[]; hit_rate: number; mean_prob: number };
  positive_return?: { ece: number; bins: { pred: number; obs: number; n: number }[]; hit_rate: number; mean_prob: number };
}

export default function PredictionsPage() {
  const [filter, setFilter] = useState<"all" | "resolved" | "pending">("all");
  const [sym, setSym] = useState("");
  const q = useApi<{ total: number; items: PredictionRow[] }>(["predictions", filter, sym],
    `/predictions?limit=1000${filter === "all" ? "" : `&resolved=${filter === "resolved"}`}${sym ? `&symbol=${sym}` : ""}`, { refetchInterval: 60_000 });
  const cal = useApi<Calib>(["pred-cal"], "/predictions/calibration", { refetchInterval: 300_000 });
  return (
    <div className="page">
      <PageHead title="Prediction history"
        sub="Every forecast logged, then checked against what actually happened" />
      <div className="grid g-12">
        <Panel className="span-4" title="Live track record">
          <Loadable q={cal}>
            {(c) => c.n === 0 ? <Empty title="No outcomes yet">{c.message} Forecasts resolve about two weeks after they are made.</Empty> : (
              <div className="stack lg">
                <div className="stats">
                  <Stat label="Resolved" value={c.n} />
                  <Stat label="Target hit first" value={prob(c.target_first!.hit_rate)} note={`Predicted on average ${prob(c.target_first!.mean_prob)}`} />
                  <Stat label="Calibration error" value={prob(c.target_first!.ece, 1)} />
                </div>
                <Reliability bins={c.target_first!.bins} height={220} label="Calibration of live predictions" />
              </div>
            )}
          </Loadable>
        </Panel>
        <Panel className="span-8" title="Forecast log" flush hint={q.data ? `${q.data.total.toLocaleString()} logged` : undefined}
          actions={<>
            <input className="input" style={{ width: 100 }} placeholder="Symbol" value={sym} onChange={(e) => setSym(e.target.value.toUpperCase().replace(/[^A-Z0-9.\-]/g, ""))} aria-label="Symbol filter" />
            <Seg label="Status" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "resolved", label: "Resolved" }, { value: "pending", label: "Pending" }]} />
          </>}>
          <Loadable q={q}>{(d) => <PredictionTable rows={d.items} showSymbol />}</Loadable>
        </Panel>
      </div>
    </div>
  );
}
