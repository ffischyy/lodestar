const nf = (min: number, max: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
const n0 = nf(0, 0), n2 = nf(2, 2), n1 = nf(1, 1);

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function price(v: number | null | undefined): string {
  if (!isNum(v)) return "—";
  return v >= 1000 ? n2.format(v) : v >= 1 ? n2.format(v) : nf(4, 4).format(v);
}
export function money(v: number | null | undefined, signed = false): string {
  if (!isNum(v)) return "—";
  const s = `$${n2.format(Math.abs(v))}`;
  if (v < 0) return `−${s}`;
  return signed && v > 0 ? `+${s}` : s;
}
export function moneyShort(v: number | null | undefined): string {
  if (!isNum(v)) return "—";
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1e12) return `${sign}$${n1.format(a / 1e12)}T`;
  if (a >= 1e9) return `${sign}$${n1.format(a / 1e9)}B`;
  if (a >= 1e6) return `${sign}$${n1.format(a / 1e6)}M`;
  if (a >= 1e3) return `${sign}$${n1.format(a / 1e3)}K`;
  return `${sign}$${n0.format(a)}`;
}
/** Percent from a percent number (e.g. 1.23 -> "+1.23%"). */
export function pct(v: number | null | undefined, digits = 2, signed = true): string {
  if (!isNum(v)) return "—";
  const s = nf(digits, digits).format(Math.abs(v));
  if (v < 0) return `−${s}%`;
  return `${signed && v > 0 ? "+" : ""}${s}%`;
}
/** Percent from a fraction (0.0123 -> "+1.23%"). */
export const frac = (v: number | null | undefined, digits = 2, signed = true) => pct(isNum(v) ? v * 100 : v, digits, signed);
export const prob = (v: number | null | undefined, digits = 0) => (isNum(v) ? `${nf(digits, digits).format(v * 100)}%` : "—");
export function num(v: number | null | undefined, digits = 2): string {
  return isNum(v) ? nf(digits, digits).format(v) : "—";
}
export function compact(v: number | null | undefined): string {
  if (!isNum(v)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
}
export const dir = (v: number | null | undefined): "up" | "down" | "flat" => (!isNum(v) || v === 0 ? "flat" : v > 0 ? "up" : "down");

export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 0) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function date(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
