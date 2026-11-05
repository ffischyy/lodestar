import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { api } from "./client";
import type { Account, BarsResponse, Research, ScanResult, Status } from "./types";

type Opts<T> = Omit<UseQueryOptions<T>, "queryKey" | "queryFn">;

export function useApi<T>(key: unknown[], path: string | null, opts: Opts<T> = {}) {
  return useQuery<T>({ queryKey: key, queryFn: () => api.get<T>(path!), enabled: path !== null && (opts.enabled ?? true), ...opts });
}

export const useStatus = () => useApi<Status>(["status"], "/status", { refetchInterval: 5000 });
export const useAccount = () => useApi<Account>(["paper"], "/paper/account", { refetchInterval: 5000 });
export const useScan = () =>
  useApi<{ running: boolean; result: ScanResult | null; has_model: boolean }>(["scanner"], "/scanner", { refetchInterval: 10000 });
export const useResearch = (sym: string | null) =>
  useApi<Research>(["research", sym], sym ? `/research/${encodeURIComponent(sym)}` : null, { staleTime: 60_000 });
export const useBars = (sym: string | null, tf: string, indicators: string[]) =>
  useApi<BarsResponse>(["bars", sym, tf, indicators.join(",")],
    sym ? `/market/bars/${encodeURIComponent(sym)}?tf=${tf}&indicators=${indicators.join(",")}` : null,
    { staleTime: tf === "1D" ? 60_000 : 20_000, refetchInterval: tf === "1D" ? 120_000 : 30_000 });
