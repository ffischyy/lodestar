import { useApi } from "./hooks";

/** One stock's row from /market/snapshot, shared by the market map, screener and calendar. */
export interface SnapshotRow {
  symbol: string; name: string; sector: string; price: number; change_pct: number | null; volume: number | null; avg_volume: number; rel_volume: number | null; avg_dollar_volume: number;
  market_cap: number | null; pe_ratio: number | null; dividend_yield: number | null; beta: number | null; next_earnings: string | null; rsi14: number | null; atr_pct: number;
  ret_5d: number | null; ret_1m: number | null; ret_3m: number | null; ret_1y: number | null; dist_sma50: number | null; dist_sma200: number | null; dist_52w_high: number; dist_52w_low: number; status: string;
}

export const useSnapshot = () => useApi<SnapshotRow[]>(["snapshot"], "/market/snapshot", { refetchInterval: 30_000, staleTime: 20_000 });
