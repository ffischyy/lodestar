import {
  Activity, Bell, BookOpen, Bot, Brain, BriefcaseBusiness, CalendarDays, CandlestickChart, Compass, Database, FastForward, FlaskConical, Gauge, History, LayoutDashboard, LayoutGrid,
  ListChecks, ListFilter, MessageSquareText, Newspaper, NotebookPen, Palette, Radar, Settings, Stethoscope, Target, Zap, type LucideIcon,
} from "lucide-react";

export interface NavItem { path: string; label: string; icon: LucideIcon; keywords?: string }
export interface NavGroup { title: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  { title: "Markets", items: [
    { path: "/", label: "Overview", icon: Compass, keywords: "home indices sectors regime" },
    { path: "/map", label: "Market map", icon: LayoutGrid, keywords: "heatmap treemap sectors finviz" },
    { path: "/monitor", label: "Live monitor", icon: Activity, keywords: "quotes streaming tape" },
    { path: "/charts", label: "Charts", icon: CandlestickChart, keywords: "candles indicators multi chart levels compare" },
    { path: "/news", label: "News", icon: Newspaper, keywords: "headlines sentiment" },
    { path: "/calendar", label: "Calendar", icon: CalendarDays, keywords: "earnings fed fomc expiry holidays events" },
  ] },
  { title: "Trade", items: [
    { path: "/trade", label: "Trade desk", icon: BriefcaseBusiness, keywords: "buy sell order money cash deposit withdraw positions paper" },
    { path: "/journal", label: "Trade journal", icon: NotebookPen, keywords: "r multiple expectancy notes review pnl calendar" },
    { path: "/portfolio", label: "Portfolio analytics", icon: Gauge, keywords: "exposure risk equity" },
    { path: "/alerts", label: "Alerts", icon: Bell, keywords: "notifications rules" },
    { path: "/autopilot", label: "AI autopilot", icon: Bot, keywords: "automatic auto trading robot ai trades" },
    { path: "/practice", label: "Practice trading", icon: FastForward, keywords: "practice fake trades real data live speed up fast forward history replay 10x 100x sandbox simulation past" },
  ] },
  { title: "Research", items: [
    { path: "/screener", label: "Screener", icon: ListFilter, keywords: "filter stocks rsi volume presets" },
    { path: "/scanner", label: "Opportunity scanner", icon: Radar, keywords: "ideas rank signals candidates" },
    { path: "/research", label: "Stock research", icon: BookOpen, keywords: "symbol fundamentals forecast" },
    { path: "/ai", label: "AI explanations", icon: MessageSquareText, keywords: "narrative evidence llm claude" },
    { path: "/watchlists", label: "Watchlists", icon: ListChecks, keywords: "lists favorites" },
  ] },
  { title: "AI lab", items: [
    { path: "/turbo", label: "Turbo simulator", icon: Zap, keywords: "fast simulation monte carlo trades per minute speed" },
    { path: "/models", label: "Models and methods", icon: Brain, keywords: "ml training validation calibration prediction methods" },
    { path: "/backtest", label: "Backtesting", icon: FlaskConical, keywords: "historical simulation" },
    { path: "/strategies", label: "Strategies", icon: Target, keywords: "momentum mean reversion trend breakout" },
    { path: "/predictions", label: "Prediction history", icon: History, keywords: "forecast log outcomes" },
  ] },
  { title: "Workspace", items: [
    { path: "/dashboards", label: "Dashboards", icon: LayoutDashboard, keywords: "custom widgets layout" },
    { path: "/themes", label: "Theme studio", icon: Palette, keywords: "colors fonts appearance" },
    { path: "/settings", label: "Settings", icon: Settings, keywords: "risk costs universe preferences" },
    { path: "/providers", label: "Data providers", icon: Database, keywords: "api keys alpaca yahoo simulation engine" },
    { path: "/health", label: "Diagnostics", icon: Stethoscope, keywords: "health logs status" },
  ] },
];

export const ALL_NAV = NAV.flatMap((g) => g.items);

/** Single-key jumps after pressing g. Also the source for the shortcuts overlay. */
export const GO_KEYS: Record<string, { path: string; label: string }> = {
  o: { path: "/", label: "Overview" }, h: { path: "/map", label: "Market map" }, c: { path: "/charts", label: "Charts" }, t: { path: "/trade", label: "Trade desk" },
  j: { path: "/journal", label: "Trade journal" }, f: { path: "/screener", label: "Screener" }, s: { path: "/scanner", label: "Opportunity scanner" }, a: { path: "/autopilot", label: "AI autopilot" },
  n: { path: "/news", label: "News" }, l: { path: "/calendar", label: "Calendar" }, d: { path: "/dashboards", label: "Dashboards" }, m: { path: "/models", label: "Models and methods" },
  b: { path: "/backtest", label: "Backtesting" }, z: { path: "/turbo", label: "Turbo simulator" },
};
