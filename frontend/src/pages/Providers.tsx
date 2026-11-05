import { CheckCircle2, ExternalLink, KeyRound, PlugZap, XCircle } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import { useApi } from "../api/hooks";
import { EngineConnect } from "../components/EngineConnect";
import { toast } from "../components/toast";
import { Field, Loadable, Notice, PageHead, Panel, Spinner, StatusPill, Toggle } from "../components/ui";

const KEY_LABELS: Record<string, string> = { ALPACA_API_KEY_ID: "API key ID", ALPACA_API_SECRET_KEY: "API secret key", ANTHROPIC_API_KEY: "Anthropic API key" };

interface Prov { name: string; label: string; kind: string; keys: string[]; signup: string | null; limits: string; caveats: string }
interface P {
  active: string; effective: string; providers: Prov[]; keys: Record<string, { set: boolean; masked: string | null }>; alpaca_feed: string;
  status: { provider: { quote_status: string }; health: Record<string, { calls: number; errors: number; calls_last_min: number; last_error: string | null; latency_p50_ms: number | null }> };
}

export default function ProvidersPage() {
  const q = useApi<P>(["providers"], "/providers", { refetchInterval: 15_000 });
  const llm = useApi<{ settings: { explanations: { llm_enabled: boolean; llm_model: string } } }>(["settings"], "/settings");
  const qc = useQueryClient();
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [test, setTest] = useState<Record<string, { ok: boolean; message: string } | "busy">>({});

  const saveKeys = async (names: string[]) => {
    const body = Object.fromEntries(names.filter((n) => keys[n] !== undefined).map((n) => [n, keys[n]]));
    if (!Object.keys(body).length) return;
    try {
      await api.put("/providers/keys", body);
      setKeys({});
      toast("success", "Keys saved", "Stored in the .env file in your Lodestar folder, never in the database.");
      qc.invalidateQueries();
    } catch (e) { toast("error", "Keys not saved", errMsg(e)); }
  };
  const runTest = async (name: string) => {
    setTest({ ...test, [name]: "busy" });
    try { setTest({ ...test, [name]: await api.post(`/providers/test?name=${name}`) }); }
    catch (e) { setTest({ ...test, [name]: { ok: false, message: errMsg(e) } }); }
  };
  const activate = async (name: string) => {
    try {
      await api.patch("/settings", { data: { provider: name } });
      toast("success", `Data source switched to ${name}`, "Models are specific to each source; training starts automatically if needed.");
      qc.invalidateQueries();
    } catch (e) { toast("error", "Could not switch", errMsg(e)); }
  };

  return (
    <div className="page">
      <PageHead title="Data providers" sub="Where prices, history and news come from" />
      <div style={{ marginBottom: 16 }}><EngineConnect /></div>
      <Loadable q={q} rows={8}>
        {(d) => (
          <div className="stack lg">
            {d.active !== d.effective && <Notice kind="error"><strong>{d.active} is selected but not usable</strong> (missing or rejected keys), so Lodestar is running on {d.effective}. Add keys below and test the connection.</Notice>}
            <div className="grid cols-3">
              {d.providers.map((p) => {
                const t = test[p.name];
                const h = d.status.health[p.name];
                const active = d.effective === p.name;
                return (
                  <Panel key={p.name} title={p.label}
                    actions={active ? <span className="badge accent">In use</span> : <button className="btn sm primary" onClick={() => activate(p.name)}>Use this source</button>}>
                    <div className="stack lg">
                      <span className="badge" style={{ alignSelf: "flex-start" }}>{p.kind}</span>
                      <p className="small muted">{p.limits}</p>
                      <p className="small muted">{p.caveats}</p>
                      {p.keys.map((k) => (
                        <Field key={k} label={KEY_LABELS[k] ?? k}
                          help={d.keys[k]?.set ? `Saved (${d.keys[k].masked}). Enter a new value to replace it.` : "Not set"}>
                          <input className="input" type="password" autoComplete="off" value={keys[k] ?? ""} onChange={(e) => setKeys({ ...keys, [k]: e.target.value })}
                            placeholder={d.keys[k]?.set ? "••••••••" : "Paste key"} />
                        </Field>
                      ))}
                      <div className="row wrap">
                        {p.keys.length > 0 && <button className="btn sm" onClick={() => saveKeys(p.keys)} disabled={!p.keys.some((k) => keys[k])}><KeyRound size={16} /> Save keys</button>}
                        <button className="btn sm" onClick={() => runTest(p.name)} disabled={t === "busy"}>{t === "busy" ? <Spinner /> : <PlugZap size={16} />} Test connection</button>
                        {p.signup && <a className="btn ghost sm" href={p.signup} target="_blank" rel="noreferrer noopener">Get a free account <ExternalLink size={12} /></a>}
                      </div>
                      {t && t !== "busy" && (
                        <div className={`row small ${t.ok ? "up" : "down"}`} role="status">{t.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}<span>{t.message}</span></div>
                      )}
                      {h && (
                        <dl className="kv xs">
                          <dt>Calls (last minute / total)</dt><dd className="num">{h.calls_last_min} / {h.calls}</dd>
                          <dt>Errors</dt><dd className={`num ${h.errors ? "down" : ""}`}>{h.errors}</dd>
                          <dt>Median latency</dt><dd className="num">{h.latency_p50_ms ? `${h.latency_p50_ms} ms` : "—"}</dd>
                          {h.last_error && <><dt>Last error</dt><dd className="down" style={{ whiteSpace: "normal" }}>{h.last_error.slice(0, 160)}</dd></>}
                        </dl>
                      )}
                      {active && <div className="row small"><span className="muted">Quotes are labelled</span><StatusPill status={d.status.provider.quote_status} /></div>}
                    </div>
                  </Panel>
                );
              })}
            </div>
            <Panel title="Alpaca feed">
              <div className="stack">
                <p className="small muted">The free Basic plan streams the IEX exchange only. If you subscribe to Algo Trader Plus, switch to SIP for the full consolidated tape.</p>
                <select className="select" style={{ width: 260 }} value={d.alpaca_feed} aria-label="Alpaca feed"
                  onChange={async (e) => { await api.patch("/settings", { data: { alpaca_feed: e.target.value } }); qc.invalidateQueries(); }}>
                  <option value="iex">IEX (free plan)</option><option value="sip">SIP (paid plan)</option>
                </select>
              </div>
            </Panel>
            <Panel title="AI narratives (optional)" hint="Anthropic Claude API">
              <div className="stack lg">
                <p className="small muted">Writes plain-English explanations from the computed evidence on the AI explanations screen. Usage is billed by Anthropic to your API key. The structured analysis (signal names, forecasts, plan, risks and up to six headlines) is sent; nothing else.</p>
                <div className="form-grid">
                  <Field label="Anthropic API key" help={d.keys.ANTHROPIC_API_KEY?.set ? `Saved (${d.keys.ANTHROPIC_API_KEY.masked})` : "Not set"}>
                    <input className="input" type="password" autoComplete="off" value={keys.ANTHROPIC_API_KEY ?? ""} onChange={(e) => setKeys({ ...keys, ANTHROPIC_API_KEY: e.target.value })} />
                  </Field>
                  <Field label="Model">
                    <input className="input" defaultValue={llm.data?.settings.explanations.llm_model} key={llm.data?.settings.explanations.llm_model}
                      onBlur={(e) => api.patch("/settings", { explanations: { llm_model: e.target.value.trim() } }).then(() => qc.invalidateQueries({ queryKey: ["settings"] }))} />
                  </Field>
                </div>
                <div className="row wrap">
                  <button className="btn sm" onClick={() => saveKeys(["ANTHROPIC_API_KEY"])} disabled={!keys.ANTHROPIC_API_KEY}><KeyRound size={16} /> Save key</button>
                  <Toggle checked={!!llm.data?.settings.explanations.llm_enabled} label="Enable AI narratives"
                    onChange={async (v) => { await api.patch("/settings", { explanations: { llm_enabled: v } }); qc.invalidateQueries({ queryKey: ["settings"] }); }} />
                </div>
              </div>
            </Panel>
          </div>
        )}
      </Loadable>
    </div>
  );
}
