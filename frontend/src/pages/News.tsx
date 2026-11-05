import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import { useApi } from "../api/hooks";
import type { NewsItem } from "../api/types";
import { BarList } from "../components/charts/svg";
import { NewsList } from "../components/domain";
import { toast } from "../components/toast";
import { Empty, Loadable, PageHead, Panel, Seg } from "../components/ui";

interface Summary { symbol: string; articles: number; avg_sentiment: number; positive: number; negative: number; latest: string }

export default function NewsPage() {
  const [symbol, setSymbol] = useState("");
  const [applied, setApplied] = useState("");
  const [sent, setSent] = useState<"all" | "positive" | "negative" | "neutral">("all");
  const [days, setDays] = useState("7");
  const qc = useQueryClient();
  const news = useApi<NewsItem[]>(["news", applied, sent, days], `/news?limit=150&days=${days}${applied ? `&symbol=${applied}` : ""}${sent !== "all" ? `&sentiment=${sent}` : ""}`, { refetchInterval: 60_000 });
  const sum = useApi<Summary[]>(["news-summary", days], `/news/summary?days=${days}`, { refetchInterval: 120_000 });

  const refresh = async () => {
    try {
      const r = await api.post<{ new: number }>("/news/refresh");
      toast("info", r.new ? `${r.new} new headline(s)` : "No new headlines");
      qc.invalidateQueries({ queryKey: ["news"] });
      qc.invalidateQueries({ queryKey: ["news-summary"] });
    } catch (e) { toast("error", "News refresh failed", errMsg(e)); }
  };

  return (
    <div className="page">
      <PageHead title="News"
        sub="Headlines scored with a finance lexicon. Hover a score for the words behind it"
        actions={<button className="btn" onClick={refresh}><RefreshCw size={16} /> Fetch latest</button>} />
      <div className="grid g-12">
        <Panel className="span-8" title="Headlines"
          actions={<>
            <form onSubmit={(e) => { e.preventDefault(); setApplied(symbol.trim().toUpperCase()); }} className="row">
              <input className="input" style={{ width: 110 }} placeholder="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} aria-label="Filter by symbol" />
              {applied && <button type="button" className="btn ghost sm" onClick={() => { setSymbol(""); setApplied(""); }}>Clear</button>}
            </form>
            <Seg label="Sentiment" value={sent} onChange={setSent} options={[{ value: "all", label: "All" }, { value: "positive", label: "Positive" }, { value: "negative", label: "Negative" }, { value: "neutral", label: "Neutral" }]} />
            <select className="select" style={{ width: 100 }} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Period">
              <option value="1">24 hours</option><option value="3">3 days</option><option value="7">7 days</option><option value="30">30 days</option>
            </select>
          </>}>
          <Loadable q={news} empty={(d) => (d.length ? null : <Empty title="No headlines match">Try a longer period, another symbol, or fetch the latest news.</Empty>)}>
            {(d) => <NewsList items={d} />}
          </Loadable>
        </Panel>
        <div className="span-4 stack lg">
          <Panel title="Sentiment by stock" hint="Average lexicon score">
            <Loadable q={sum} empty={(d) => (d.length ? null : <Empty title="No scored headlines yet" />)}>
              {(d) => (
                <BarList format={(v) => (v >= 0 ? "+" : "") + v.toFixed(2)}
                  items={d.slice(0, 18).map((s) => ({ label: `${s.symbol} (${s.articles})`, value: s.avg_sentiment }))} />
              )}
            </Loadable>
          </Panel>
          <Panel title="How sentiment is scored">
            <p className="small muted">Each headline is matched against finance-specific positive and negative terms (for example "beats", "raises guidance", "downgraded", "probe"), with simple negation ("did not beat") and intensifiers. Scores range from −1 to +1.</p>
            <p className="small muted" style={{ marginTop: 8 }}>It is a lexicon, not a language model: fast, auditable and blind to sarcasm or context. It feeds the scanner as one weak input.</p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
