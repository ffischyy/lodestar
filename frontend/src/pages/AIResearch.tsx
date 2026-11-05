import { Bot, FileText } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, errMsg } from "../api/client";
import { useResearch } from "../api/hooks";
import { EvidenceList, ForecastBlock, SignalTable } from "../components/domain";
import { Empty, ErrorState, Notice, PageHead, Panel, Seg, Skeleton, Spinner } from "../components/ui";

interface Narr { kind: "rules" | "llm"; label: string; text: string }

export default function AIResearchPage() {
  const [params, setParams] = useSearchParams();
  const [input, setInput] = useState(params.get("s") ?? "");
  const symbol = params.get("s")?.toUpperCase() ?? null;
  const r = useResearch(symbol);
  const [dir, setDir] = useState<"long" | "short">("long");
  const [narr, setNarr] = useState<Narr | null>(null);
  const [busy, setBusy] = useState<"rules" | "llm" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const gen = async (llm: boolean) => {
    if (!symbol) return;
    setBusy(llm ? "llm" : "rules");
    setErr(null);
    try {
      setNarr(await api.post<Narr>(`/research/${symbol}/narrative?direction=${dir}&use_llm=${llm}`));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <PageHead title="AI explanations"
        sub="Rule-based summary of the evidence, with an optional language-model narrative that only restates the numbers" />
      <div className="grid g-12">
        <Panel className="span-4" title="Choose a stock">
          <form className="stack" onSubmit={(e) => { e.preventDefault(); if (input.trim()) { setParams({ s: input.trim().toUpperCase() }); setNarr(null); } }}>
            <div className="row">
              <input className="input sym" placeholder="Ticker, e.g. MSFT" value={input} onChange={(e) => setInput(e.target.value.toUpperCase())} aria-label="Ticker" />
              <button className="btn primary" type="submit">Analyse</button>
            </div>
            <Seg label="Direction to explain" value={dir} onChange={(v) => { setDir(v); setNarr(null); }} options={[{ value: "long", label: "Long case" }, { value: "short", label: "Short case" }]} />
          </form>
          <div className="divider" />
          <dl className="kv small">
            <dt>Indicators</dt><dd>Computed formulas</dd>
            <dt>Statistical signals</dt><dd>Rules on price history</dd>
            <dt>ML forecasts</dt><dd>Validated models</dd>
            <dt>Narratives</dt><dd>Wording only</dd>
          </dl>
          <p className="xs faint" style={{ marginTop: 8 }}>A narrative never adds information. If it contradicts the numbers, trust the numbers.</p>
        </Panel>
        <div className="span-8 stack lg">
          {!symbol ? <Panel><Empty title="Enter a ticker to build an explanation">The analysis uses the same evidence as the scanner and research screens.</Empty></Panel>
            : r.isLoading ? <Panel><Skeleton rows={8} /></Panel>
            : r.error ? <Panel><ErrorState error={r.error} retry={() => r.refetch()} /></Panel>
            : r.data && (
              <>
                <Panel title={`Explanation for ${symbol}`} hint={r.data.name}
                  actions={<>
                    <button className="btn" onClick={() => gen(false)} disabled={!!busy}>{busy === "rules" ? <Spinner /> : <FileText size={16} />} Rule-based summary</button>
                    <button className="btn primary" onClick={() => gen(true)} disabled={!!busy || !r.data.llm_available}
                      title={r.data.llm_available ? "" : "Enable AI narratives and add an Anthropic API key under Data providers"}>
                      {busy === "llm" ? <Spinner /> : <Bot size={16} />} AI narrative
                    </button>
                  </>}>
                  {!r.data.llm_available && (
                    <Notice>AI narratives are off. Turn them on and add an Anthropic API key in <Link className="sym-link" to="/providers">Data providers</Link>. The rule-based summary works without a key.</Notice>
                  )}
                  {err && <Notice kind="error">{err}</Notice>}
                  {(narr ?? { kind: "rules", label: "Rule-generated summary — deterministic template over the computed signals", text: r.data.narrative }) && (
                    <article className="stack lg" style={{ marginTop: 12 }}>
                      <span className={`badge ${narr?.kind === "llm" ? "accent" : ""}`} style={{ alignSelf: "flex-start" }}>{narr?.label ?? "Rule-generated summary"}</span>
                      {(narr?.text ?? r.data.narrative).split("\n\n").map((para, i) => <p key={i} style={{ maxWidth: "74ch", lineHeight: 1.6 }}>{para}</p>)}
                    </article>
                  )}
                </Panel>
                <div className="grid cols-2">
                  <Panel title="Supporting evidence"><EvidenceList items={r.data.plans[dir].evidence.supporting} kind="support" /></Panel>
                  <Panel title="Contradicting evidence"><EvidenceList items={r.data.plans[dir].evidence.contradicting} kind="against" /></Panel>
                </div>
                <Panel title="Statistical forecast"><ForecastBlock f={r.data.forecast} direction={dir} /></Panel>
                <Panel title="Signals used"><SignalTable signals={r.data.signals} /></Panel>
              </>
            )}
        </div>
      </div>
    </div>
  );
}
