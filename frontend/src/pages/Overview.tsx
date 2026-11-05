import { Link } from "react-router-dom";
import { engineMode } from "../api/client";
import { useStatus } from "../api/hooks";
import { ago } from "../lib/format";
import { BreadthWidget, ChartWidget, IndicesWidget, MoversWidget, NewsWidget, OpportunitiesWidget, RegimeWidget, SectorsWidget, StrongestWidget, useOverview } from "../components/widgets";
import { Notice, PageHead, Panel } from "../components/ui";
import { MarketTreemap } from "./MarketMap";

export function SimBanner() {
  const s = useStatus();
  if (!s.data?.simulated) return null;
  return (
    <Notice kind="sim">
      <strong>Simulated market.</strong> Prices, headlines and fundamentals here are synthetic.{" "}
      <Link to="/providers" className="sym-link">Connect real data</Link>
    </Notice>
  );
}

export default function OverviewPage() {
  const ov = useOverview();
  return (
    <div className="page">
      <PageHead title="Market overview"
        actions={ov.dataUpdatedAt ? <span className="faint small">Updated {ago(new Date(ov.dataUpdatedAt).toISOString())}</span> : null} />
      <div className="stack lg">
        <SimBanner />
        <Panel><IndicesWidget /></Panel>
        <Panel title="Market map" hint="Sized by market cap, coloured by today's move" flush actions={<Link to="/map" className="btn sm">Open map</Link>}><MarketTreemap height={380} /></Panel>
        <div className="grid g-12">
          <div className="span-4 stack lg">
            <Panel title="Market regime"><RegimeWidget /></Panel>
            <Panel title="Breadth"><BreadthWidget /></Panel>
          </div>
          {engineMode() === "server" || ov.data?.model ? (
            <Panel className="span-8" title="Top opportunities" hint="Ranked after costs and risk filters"
              actions={<Link to="/scanner" className="btn sm">Open scanner</Link>} flush>
              <OpportunitiesWidget />
            </Panel>
          ) : (
            <Panel className="span-8" title="Strongest this month" actions={<Link to="/screener" className="btn sm">Open screener</Link>} flush><StrongestWidget /></Panel>
          )}
          <Panel className="span-8" title="S&P 500 proxy (SPY)" actions={<Link to="/charts" className="btn sm">Chart workspace</Link>}><ChartWidget symbol="SPY" height={328} /></Panel>
          <Panel className="span-4" title="Sectors today"><SectorsWidget /></Panel>
          <Panel className="span-6" title="Leaders and laggards" hint="Today"><MoversWidget /></Panel>
          <Panel className="span-6" title="Headlines" actions={<Link to="/news" className="btn sm">All news</Link>}><NewsWidget /></Panel>
        </div>
      </div>
    </div>
  );
}
