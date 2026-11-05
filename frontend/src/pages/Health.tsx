import { RefreshCw } from "lucide-react";
import { Fragment } from "react";
import { useApi } from "../api/hooks";
import { useLive } from "../api/live";
import { DataTable } from "../components/DataTable";
import { Loadable, Notice, PageHead, Panel, Stat } from "../components/ui";
import { ago, compact } from "../lib/format";

interface H {
  time: string; version: string;
  data: { provider: { label: string; quote_status: string; rate_limit_per_min: number }; clock: { now_et: string; session: string };
    health: Record<string, { calls: number; errors: number; rate_limited: number; calls_last_min: number; last_success: string | null; last_error: string | null; latency_p50_ms: number | null; latency_p95_ms: number | null; events: { ts: string; level: string; msg: string }[] }> };
  loops: Record<string, { runs: number; errors: number; last_run: string | null; last_duration_s: number | null; last_error: string | null }>;
  ws_clients: number; db: { path: string; size_bytes: number | null; rows: Record<string, number> };
  model: { run_id: number; champion: string; passed: boolean } | null; training: boolean;
  scanner: { running: boolean; last: string | null; last_duration_s: number | null; errors: { symbol: string; error: string }[] | null };
  versions: Record<string, string>; paths: Record<string, string>; log_tail: string[];
}

export default function HealthPage() {
  const q = useApi<H>(["health"], "/health", { refetchInterval: 10_000 });
  const connected = useLive((s) => s.connected);
  return (
    <div className="page">
      <PageHead title="Diagnostics" sub="Background jobs, data provider health, storage and recent logs"
        actions={<button className="btn" onClick={() => q.refetch()}><RefreshCw size={16} /> Refresh</button>} />
      <Loadable q={q} rows={10}>
        {(h) => {
          const loopRows = Object.entries(h.loops);
          const problems = loopRows.filter(([, l]) => l.errors > 0 && l.last_error);
          const prov = Object.entries(h.data.health);
          return (
            <div className="stack lg">
              {problems.length > 0 && <Notice kind="warn">{problems.map(([n, l]) => `${n}: ${l.last_error}`).join("; ")}</Notice>}
              <div className="stats">
                <Stat label="Version" value={h.version} />
                <Stat label="Data source" value={h.data.provider.label} note={`Session: ${h.data.clock.session}`} />
                <Stat label="Live connection" value={connected ? "Connected" : "Down"} tone={connected ? undefined : "down"} note={`${h.ws_clients} client(s)`} />
                <Stat label="Model" value={h.model ? `#${h.model.run_id} ${h.model.champion}` : h.training ? "Training" : "None"} />
                <Stat label="Last scan" value={h.scanner.last ? ago(h.scanner.last) : "Never"} note={h.scanner.last_duration_s ? `${h.scanner.last_duration_s}s` : undefined} />
                <Stat label="Database" value={h.db.size_bytes ? `${(h.db.size_bytes / 1e6).toFixed(1)} MB` : "—"} />
              </div>
              <div className="grid g-12">
                <Panel className="span-6" title="Background jobs" flush>
                  <DataTable label="Background loops" rows={loopRows} rowKey={(r) => r[0]}
                    columns={[
                      { key: "n", header: "Job", cell: (r) => r[0] },
                      { key: "r", header: "Runs", num: true, cell: (r) => r[1].runs },
                      { key: "e", header: "Errors", num: true, cell: (r) => <span className={r[1].errors ? "down" : ""}>{r[1].errors}</span> },
                      { key: "l", header: "Last run", cell: (r) => <span className="muted">{ago(r[1].last_run)}</span> },
                      { key: "d", header: "Duration", num: true, cell: (r) => (r[1].last_duration_s != null ? `${r[1].last_duration_s}s` : "—") },
                    ]} />
                </Panel>
                <Panel className="span-6" title="Data provider calls" flush>
                  <DataTable label="Provider health" rows={prov} rowKey={(r) => r[0]}
                    columns={[
                      { key: "n", header: "Provider", cell: (r) => r[0] },
                      { key: "c", header: "Calls", num: true, cell: (r) => compact(r[1].calls) },
                      { key: "m", header: "Last min", num: true, cell: (r) => `${r[1].calls_last_min} / ${h.data.provider.rate_limit_per_min}` },
                      { key: "e", header: "Errors", num: true, cell: (r) => <span className={r[1].errors ? "down" : ""}>{r[1].errors}</span> },
                      { key: "p", header: "p50 / p95", num: true, cell: (r) => `${r[1].latency_p50_ms ?? "—"} / ${r[1].latency_p95_ms ?? "—"} ms` },
                    ]} />
                </Panel>
                <Panel className="span-6" title="Storage">
                  <dl className="kv small">
                    {Object.entries(h.db.rows).map(([k, v]) => <Fragment key={k}><dt>{k.replace(/_/g, " ")}</dt><dd className="num">{v.toLocaleString()}</dd></Fragment>)}
                    <dt>Data folder</dt><dd className="truncate" title={h.paths.data_dir}>{h.paths.data_dir}</dd>
                    <dt>Keys file</dt><dd className="truncate" title={h.paths.env_file}>{h.paths.env_file}</dd>
                  </dl>
                </Panel>
                <Panel className="span-6" title="Versions">
                  <dl className="kv small">{Object.entries(h.versions).map(([k, v]) => <Fragment key={k}><dt>{k.replace(/_/g, " ")}</dt><dd className="num truncate">{v}</dd></Fragment>)}</dl>
                </Panel>
                <Panel className="span-12" title="Recent events" flush>
                  <DataTable label="Provider events" rows={prov.flatMap(([n, p]) => p.events.map((e) => ({ ...e, n }))).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 40)}
                    rowKey={(e) => `${e.ts}${e.msg}`}
                    columns={[
                      { key: "t", header: "Time", cell: (e) => <span className="num muted">{e.ts.slice(11, 19)}</span> },
                      { key: "p", header: "Source", cell: (e) => e.n },
                      { key: "l", header: "Level", cell: (e) => <span className={`badge ${e.level === "error" ? "error" : e.level === "warn" ? "warn" : ""}`}>{e.level}</span> },
                      { key: "m", header: "Message", cell: (e) => <span style={{ whiteSpace: "normal" }}>{e.msg}</span> },
                    ]} />
                </Panel>
                <Panel className="span-12" title="Log" hint="data/logs/lodestar.log">
                  <pre className="xs" style={{ margin: 0, maxHeight: 340, overflow: "auto", fontFamily: "'IBM Plex Mono', ui-monospace, monospace", color: "var(--text-2)", whiteSpace: "pre-wrap" }}>
                    {h.log_tail.join("\n") || "No log lines yet."}
                  </pre>
                </Panel>
              </div>
            </div>
          );
        }}
      </Loadable>
    </div>
  );
}
