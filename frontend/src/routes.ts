export const pages = {
  "/": () => import("./pages/Overview"), "/map": () => import("./pages/MarketMap"), "/monitor": () => import("./pages/Monitor"), "/scanner": () => import("./pages/Scanner"),
  "/screener": () => import("./pages/Screener"), "/calendar": () => import("./pages/Calendar"), "/journal": () => import("./pages/Journal"), "/research": () => import("./pages/Research"),
  "/charts": () => import("./pages/Charts"), "/ai": () => import("./pages/AIResearch"), "/news": () => import("./pages/News"), "/watchlists": () => import("./pages/Watchlists"),
  "/strategies": () => import("./pages/Strategies"), "/models": () => import("./pages/Models"), "/backtest": () => import("./pages/Backtest"), "/predictions": () => import("./pages/Predictions"),
  "/trade": () => import("./pages/Trade"), "/autopilot": () => import("./pages/Autopilot"), "/turbo": () => import("./pages/Turbo"), "/practice": () => import("./pages/Practice"),
  "/portfolio": () => import("./pages/Portfolio"), "/alerts": () => import("./pages/Alerts"), "/dashboards": () => import("./pages/Dashboards"), "/themes": () => import("./pages/ThemeStudio"),
  "/settings": () => import("./pages/Settings"), "/providers": () => import("./pages/Providers"), "/health": () => import("./pages/Health"),
} as const;
export type PagePath = keyof typeof pages;

/** Loads a screen's code ahead of the click, so navigating never shows a blank page. */
export const prefetchPage = (path: string) => { pages[path as PagePath]?.(); };
