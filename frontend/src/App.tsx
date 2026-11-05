import { Component, type ComponentType, lazy, type ReactNode, Suspense, useEffect } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api/client";
import { AppShell } from "./components/AppShell";
import { Empty, Skeleton } from "./components/ui";
import { pages, type PagePath } from "./routes";
import { applyTokens, resolveTokens, useTheme, type CustomTheme } from "./theme/store";

const L = Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, lazy(v)])) as unknown as Record<PagePath, ComponentType>;

/** Applies the resolved theme tokens to :root whenever the theme, preferences or preview change. */
export function ThemeApplier() {
  const st = useTheme();
  useEffect(() => {
    api.get<CustomTheme[]>("/themes").then(st.setCustom).catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const r = resolveTokens(st);
    applyTokens(r.tokens, r.scheme);
  }, [st.active, st.prefs, st.custom, st.preview]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

const page = (p: PagePath) => { const C = L[p]; return <C />; };

/** One broken screen shows a message instead of blanking the whole site. */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="page"><Empty title="This screen could not load">Open another screen from the menu, or reload the page.</Empty></div> : this.props.children;
  }
}
function PageBoundary({ children }: { children: ReactNode }) {
  return <Boundary key={useLocation().pathname}>{children}</Boundary>;
}

export default function App() {
  useEffect(() => {
    const load = () => Object.values(pages).forEach((p) => p());
    if (typeof requestIdleCallback === "function") { const id = requestIdleCallback(load); return () => cancelIdleCallback(id); }
    const t = window.setTimeout(load, 1500);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <BrowserRouter>
      <ThemeApplier />
      <AppShell>
        <PageBoundary><Suspense fallback={<div className="page"><Skeleton rows={10} /></div>}>
          <Routes>
            <Route path="/" element={page("/")} />
            <Route path="/map" element={page("/map")} />
            <Route path="/monitor" element={page("/monitor")} />
            <Route path="/screener" element={page("/screener")} />
            <Route path="/calendar" element={page("/calendar")} />
            <Route path="/journal" element={page("/journal")} />
            <Route path="/scanner" element={page("/scanner")} />
            <Route path="/research" element={page("/research")} />
            <Route path="/research/:symbol" element={page("/research")} />
            <Route path="/charts" element={page("/charts")} />
            <Route path="/ai" element={page("/ai")} />
            <Route path="/news" element={page("/news")} />
            <Route path="/watchlists" element={page("/watchlists")} />
            <Route path="/strategies" element={page("/strategies")} />
            <Route path="/models" element={page("/models")} />
            <Route path="/backtest" element={page("/backtest")} />
            <Route path="/predictions" element={page("/predictions")} />
            <Route path="/trade" element={page("/trade")} />
            <Route path="/paper" element={<Navigate to="/trade" replace />} />
            <Route path="/autopilot" element={page("/autopilot")} />
            <Route path="/turbo" element={page("/turbo")} />
            <Route path="/practice" element={page("/practice")} />
            <Route path="/replay" element={<Navigate to="/practice" replace />} />
            <Route path="/portfolio" element={page("/portfolio")} />
            <Route path="/alerts" element={page("/alerts")} />
            <Route path="/dashboards" element={page("/dashboards")} />
            <Route path="/themes" element={page("/themes")} />
            <Route path="/settings" element={page("/settings")} />
            <Route path="/providers" element={page("/providers")} />
            <Route path="/health" element={page("/health")} />
            <Route path="*" element={<div className="page"><Empty title="That screen does not exist" action={<Link className="btn" to="/">Go to the overview</Link>} /></div>} />
          </Routes>
        </Suspense></PageBoundary>
      </AppShell>
    </BrowserRouter>
  );
}
