import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "../components/DataTable";
import { Delta, StatusPill } from "../components/ui";
import { frac, money, pct, price, prob } from "../lib/format";
import { checkTheme, contrast } from "../theme/contrast";
import { resolveTokens, DEFAULT_PREFS } from "../theme/store";
import { THEMES, type TokenKey } from "../theme/themes";

describe("formatting", () => {
  it("signs and units", () => {
    expect(pct(1.234)).toBe("+1.23%");
    expect(pct(-0.5)).toBe("−0.50%");
    expect(frac(0.0123)).toBe("+1.23%");
    expect(money(-1234.5)).toBe("−$1,234.50");
    expect(money(12, true)).toBe("+$12.00");
    expect(prob(0.456)).toBe("46%");
    expect(price(null)).toBe("—");
    expect(price(NaN)).toBe("—");
  });
});

describe("Delta", () => {
  it("does not rely on colour alone: shows sign and arrow", () => {
    const { container } = render(<Delta value={-2.5} />);
    expect(container.textContent).toContain("−2.50%");
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".down")).not.toBeNull();
  });
});

describe("StatusPill", () => {
  it("labels simulated data explicitly", () => {
    render(<StatusPill status="simulated" />);
    expect(screen.getByLabelText("Data status: Simulated")).toBeInTheDocument();
  });
});

describe("DataTable", () => {
  const rows = [{ s: "AAA", v: 3 }, { s: "BBB", v: 1 }, { s: "CCC", v: 2 }];
  const cols = [
    { key: "s", header: "Sym", cell: (r: (typeof rows)[0]) => r.s, sort: (r: (typeof rows)[0]) => r.s },
    { key: "v", header: "Val", cell: (r: (typeof rows)[0]) => r.v, sort: (r: (typeof rows)[0]) => r.v, num: true },
  ];
  it("sorts descending then ascending then off", () => {
    render(<DataTable label="t" rows={rows} columns={cols} rowKey={(r) => r.s} />);
    const order = () => screen.getAllByRole("row").slice(1).map((r) => r.textContent?.slice(0, 3));
    fireEvent.click(screen.getByText("Val"));
    expect(order()).toEqual(["AAA", "CCC", "BBB"]);
    fireEvent.click(screen.getByText("Val"));
    expect(order()).toEqual(["BBB", "CCC", "AAA"]);
    fireEvent.click(screen.getByText("Val"));
    expect(order()).toEqual(["AAA", "BBB", "CCC"]);
  });
  it("shows the empty state", () => {
    render(<DataTable label="t" rows={[]} columns={cols} rowKey={(r) => r.s} empty={<p>nothing here</p>} />);
    expect(screen.getByText("nothing here")).toBeInTheDocument();
  });
});

describe("themes", () => {
  const required: TokenKey[] = ["bg", "surface", "text", "text-2", "accent", "up", "down", "chart-grid", "font-ui", "radius", "row-h"];
  it.each(THEMES.map((t) => [t.id, t] as const))("%s defines every token", (_, t) => {
    for (const k of required) expect(t.tokens[k]).toBeTruthy();
  });
  it.each(THEMES.map((t) => [t.id, t] as const))("%s passes body-text contrast", (_, t) => {
    const failing = checkTheme(t.tokens).filter((c) => !c.pass);
    expect(failing.map((f) => f.label)).toEqual([]);
  });
  it("contrast math matches WCAG reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });
  it("preferences scale tokens", () => {
    const r = resolveTokens({ active: "meridian", prefs: { ...DEFAULT_PREFS, fontScale: 1.2, density: "compact", radiusScale: 0 }, custom: [], preview: null });
    expect(r.tokens["fs-base"]).toBe("16.80px");
    expect(r.tokens["row-h"]).toBe("24px");
    expect(r.tokens.radius).toBe("0.0px");
  });
});
