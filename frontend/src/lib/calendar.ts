export interface MarketEvent { date: string; kind: "holiday" | "early-close" | "fed" | "options" | "jobs"; label: string }

// Same dates as backend/lodestar/market_hours.py.
const HOLIDAYS: Record<string, string> = {
  "2026-11-26": "Thanksgiving", "2026-12-25": "Christmas", "2027-01-01": "New Year's Day", "2027-01-18": "Martin Luther King Jr. Day", "2027-02-15": "Washington's Birthday",
  "2027-03-26": "Good Friday", "2027-05-31": "Memorial Day", "2027-06-18": "Juneteenth", "2027-07-05": "Independence Day", "2027-09-06": "Labor Day", "2027-11-25": "Thanksgiving", "2027-12-24": "Christmas",
};
const EARLY_CLOSES = ["2026-11-27", "2026-12-24", "2027-11-26"];
// shortcut: only the Fed's published 2026 meetings, add later years when the Fed publishes them.
const FED = ["2026-12-09"];

const isoOf = (d: Date) => d.toISOString().slice(0, 10);
const nthWeekday = (year: number, month: number, weekday: number, n: number) => {
  const first = new Date(Date.UTC(year, month, 1));
  return new Date(Date.UTC(year, month, 1 + ((weekday - first.getUTCDay() + 7) % 7) + (n - 1) * 7));
};

/** Scheduled market events between two ISO dates, inclusive. Options expiry and the jobs report are computed from their usual dates. */
export function marketEvents(from: string, to: string): MarketEvent[] {
  const out: MarketEvent[] = [
    ...Object.entries(HOLIDAYS).map(([date, name]) => ({ date, kind: "holiday" as const, label: `Market closed, ${name}` })),
    ...EARLY_CLOSES.map((date) => ({ date, kind: "early-close" as const, label: "Early close, 1:00 PM ET" })),
    ...FED.map((date) => ({ date, kind: "fed" as const, label: "Fed rate decision" })),
  ];
  const start = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); y < end.getUTCFullYear() || (y === end.getUTCFullYear() && m <= end.getUTCMonth()); m === 11 ? (y++, m = 0) : m++) {
    out.push({ date: isoOf(nthWeekday(y, m, 5, 3)), kind: "options", label: "Monthly options expiry" });
    out.push({ date: isoOf(nthWeekday(y, m, 5, 1)), kind: "jobs", label: "Jobs report, usual date" });
  }
  return out.filter((e) => e.date >= from && e.date <= to).sort((a, b) => a.date.localeCompare(b.date));
}
