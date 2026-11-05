import { create } from "zustand";
import { deriveSoft, FONT_OPTIONS, themeById, type ThemeDef, type TokenKey, type Tokens } from "./themes";

export interface CustomTheme {
  id: number;
  name: string;
  base: string;
  tokens: Partial<Tokens>;
}

/** Interface preferences apply on top of any theme. */
export interface Prefs {
  fontScale: number;           // 0.85 .. 1.25 multiplier on the theme's base size
  density: "theme" | "compact" | "comfortable";
  radiusScale: number;         // 0 .. 2
  motion: "full" | "reduced" | "off";
  font: string | null;         // overrides theme UI font
  borders: "theme" | "subtle" | "strong";
  shadows: boolean;
  chartUp: string | null;
  chartDown: string | null;
}

export const DEFAULT_PREFS: Prefs = {
  fontScale: 1, density: "theme", radiusScale: 1, motion: "full", font: null, borders: "theme", shadows: true,
  chartUp: null, chartDown: null,
};

interface ThemeState {
  active: string;              // built-in id or "custom:<id>"
  prefs: Prefs;
  custom: CustomTheme[];
  preview: Partial<Tokens> | null;
  setActive: (id: string) => void;
  setPrefs: (p: Partial<Prefs>) => void;
  resetPrefs: () => void;
  setCustom: (c: CustomTheme[]) => void;
  setPreview: (t: Partial<Tokens> | null) => void;
}

const KEY = "lodestar.theme.v1";

function load(): { active: string; prefs: Prefs } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw);
      return { active: v.active ?? "meridian", prefs: { ...DEFAULT_PREFS, ...(v.prefs ?? {}) } };
    }
  } catch {
    /* storage unavailable: fall back to defaults */
  }
  return { active: "meridian", prefs: DEFAULT_PREFS };
}

function save(active: string, prefs: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ active, prefs }));
  } catch {
    /* ignore */
  }
}

const initial = load();

export const useTheme = create<ThemeState>((set, get) => ({
  active: initial.active,
  prefs: initial.prefs,
  custom: [],
  preview: null,
  setActive: (id) => {
    set({ active: id });
    save(id, get().prefs);
  },
  setPrefs: (p) => {
    const prefs = { ...get().prefs, ...p };
    set({ prefs });
    save(get().active, prefs);
  },
  resetPrefs: () => {
    set({ prefs: DEFAULT_PREFS });
    save(get().active, DEFAULT_PREFS);
  },
  setCustom: (custom) => set({ custom }),
  setPreview: (preview) => set({ preview }),
}));

export function baseThemeFor(active: string, custom: CustomTheme[]): { def: ThemeDef; custom?: CustomTheme } {
  if (active.startsWith("custom:")) {
    const c = custom.find((x) => `custom:${x.id}` === active);
    if (c) return { def: themeById(c.base), custom: c };
  }
  return { def: themeById(active) };
}

/** Saved themes carry the look settings (size, density, corners...) as "pref-*" entries next to the colours. */
export const PREF_KEYS: (keyof Prefs)[] = ["fontScale", "density", "radiusScale", "motion", "font", "borders", "shadows"];

export function prefsToTokens(p: Prefs): Record<string, string> {
  return {
    "pref-fontScale": String(p.fontScale), "pref-density": p.density, "pref-radiusScale": String(p.radiusScale),
    "pref-motion": p.motion, "pref-font": p.font ?? "", "pref-borders": p.borders, "pref-shadows": p.shadows ? "1" : "0",
  };
}

export function prefsFromTokens(t: Record<string, unknown> | undefined): Partial<Prefs> | null {
  if (!t || !Object.keys(t).some((k) => k.startsWith("pref-"))) return null;
  const g = (k: string) => (t[`pref-${k}`] as string | undefined);
  const out: Partial<Prefs> = {};
  if (g("fontScale")) out.fontScale = Math.min(1.25, Math.max(0.85, Number(g("fontScale")) || 1));
  if (g("density")) out.density = g("density") as Prefs["density"];
  if (g("radiusScale")) out.radiusScale = Math.min(2, Math.max(0, Number(g("radiusScale")) || 1));
  if (g("motion")) out.motion = g("motion") as Prefs["motion"];
  if (g("font") !== undefined) out.font = g("font") || null;
  if (g("borders")) out.borders = g("borders") as Prefs["borders"];
  if (g("shadows")) out.shadows = g("shadows") === "1";
  return out;
}

const colorsOnly = (t: Partial<Tokens> | Record<string, unknown> | undefined) =>
  Object.fromEntries(Object.entries(t ?? {}).filter(([k]) => !k.startsWith("pref-"))) as Partial<Tokens>;

export function resolveTokens(state: Pick<ThemeState, "active" | "prefs" | "custom" | "preview">): { tokens: Tokens; scheme: string; name: string } {
  const { def, custom } = baseThemeFor(state.active, state.custom);
  let t: Tokens = { ...def.tokens, ...colorsOnly(custom?.tokens) } as Tokens;
  if (state.preview) t = { ...t, ...colorsOnly(state.preview) } as Tokens;
  const p = state.prefs;
  const px = (v: string) => parseFloat(v) || 0;
  t["fs-base"] = `${(px(t["fs-base"]) * p.fontScale).toFixed(2)}px`;
  if (p.density === "compact") Object.assign(t, { "row-h": "24px", pad: "10px", gap: "8px" });
  if (p.density === "comfortable") Object.assign(t, { "row-h": "36px", pad: "18px", gap: "16px" });
  (["radius-sm", "radius", "radius-lg"] as TokenKey[]).forEach((k) => (t[k] = `${(px(t[k]) * p.radiusScale).toFixed(1)}px`));
  t.motion = p.motion === "off" ? "0" : p.motion === "reduced" ? String(Math.min(0.35, px(t.motion))) : t.motion;
  if (p.font) t["font-ui"] = p.font;
  if (p.borders === "subtle") t["border-w"] = "1px";
  if (p.borders === "strong") {
    t.border = t["border-strong"];
    t["border-w"] = "1px";
  }
  if (!p.shadows) t.shadow = "none";
  if (p.chartUp) t.up = p.chartUp;
  if (p.chartDown) t.down = p.chartDown;
  return { tokens: deriveSoft(t), scheme: def.scheme, name: custom?.name ?? def.name };
}

export function applyTokens(tokens: Tokens, scheme: string) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(`--${k}`, v);
  root.dataset.scheme = scheme;
  root.style.colorScheme = scheme;
  window.dispatchEvent(new CustomEvent("lodestar:theme"));
}

/** Read the current computed value of a token (used by canvas charts). */
export function token(name: TokenKey): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

export { FONT_OPTIONS };
