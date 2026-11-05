/**
 * Design tokens. Every visual value in the app comes from these CSS custom properties;
 * components never hard-code colours, radii, fonts or spacing.
 */
export type TokenKey =
  | "bg" | "surface" | "surface-2" | "surface-3" | "border" | "border-strong"
  | "text" | "text-2" | "text-3" | "accent" | "accent-contrast" | "accent-soft"
  | "up" | "down" | "up-soft" | "down-soft" | "warn" | "error" | "info" | "sim"
  | "focus" | "overlay" | "chart-grid" | "chart-text" | "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5"
  | "shadow" | "radius-sm" | "radius" | "radius-lg" | "border-w"
  | "font-ui" | "font-num" | "fs-base" | "row-h" | "pad" | "gap" | "motion";

export type Tokens = Record<TokenKey, string>;

export interface ThemeDef {
  id: string;
  name: string;
  description: string;
  scheme: "dark" | "light";
  tokens: Tokens;
}

export const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: "IBM Plex Sans", value: "'IBM Plex Sans', system-ui, sans-serif" },
  { label: "Space Grotesk", value: "'Space Grotesk', 'IBM Plex Sans', system-ui, sans-serif" },
  { label: "IBM Plex Mono", value: "'IBM Plex Mono', ui-monospace, monospace" },
  { label: "System UI", value: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
];

const plex = FONT_OPTIONS[0].value;
const mono = FONT_OPTIONS[2].value;

const base = {
  "radius-sm": "4px", radius: "8px", "radius-lg": "12px", "border-w": "1px",
  "font-ui": plex, "font-num": mono, "fs-base": "14px", "row-h": "32px", pad: "16px", gap: "16px", motion: "1",
};

export const THEMES: ThemeDef[] = [
  {
    id: "meridian", name: "Meridian", scheme: "dark",
    description: "Graphite surfaces with a brass accent. The default trading desk.",
    tokens: {
      ...base,
      bg: "#141415", surface: "#19191b", "surface-2": "#232325", "surface-3": "#0f0f10",
      border: "#29292c", "border-strong": "#38383c", text: "#ededed", "text-2": "#a1a1a6", "text-3": "#85858b",
      accent: "#d4a84b", "accent-contrast": "#1a1405", "accent-soft": "rgba(212,168,75,0.14)",
      up: "#4cc38a", down: "#e5625e", "up-soft": "rgba(76,195,138,0.13)", "down-soft": "rgba(229,98,94,0.13)",
      warn: "#d9a648", error: "#e5625e", info: "#8fa8c4", sim: "#a1a1a6", focus: "#e9c46a",
      overlay: "rgba(8,8,9,0.66)", "chart-grid": "#222224", "chart-text": "#85858b",
      "chart-1": "#d4a84b", "chart-2": "#8fa8c4", "chart-3": "#4cc38a", "chart-4": "#a1a1a6", "chart-5": "#c98a5e",
      shadow: "0 8px 24px rgba(0,0,0,0.36)",
    },
  },
  {
    id: "daylight", name: "Daylight", scheme: "light",
    description: "Cool white analytics theme for bright rooms and long reading.",
    tokens: {
      ...base,
      bg: "#eef1f5", surface: "#ffffff", "surface-2": "#f4f6f9", "surface-3": "#f8f9fb",
      border: "#dbe1e9", "border-strong": "#c3ccd8", text: "#16202c", "text-2": "#4a5a6d", "text-3": "#6b7a8c",
      accent: "#1f5fbf", "accent-contrast": "#ffffff", "accent-soft": "rgba(31,95,191,0.10)",
      up: "#0b7f62", down: "#c2343a", "up-soft": "rgba(11,127,98,0.10)", "down-soft": "rgba(194,52,58,0.09)",
      warn: "#a86a00", error: "#c2343a", info: "#1f5fbf", sim: "#7a4cc2", focus: "#1f5fbf",
      overlay: "rgba(22,32,44,0.40)", "chart-grid": "#e8ecf1", "chart-text": "#66768a",
      "chart-1": "#1f5fbf", "chart-2": "#c27b12", "chart-3": "#0b7f62", "chart-4": "#7a4cc2", "chart-5": "#c2343a",
      shadow: "0 8px 24px rgba(22,32,44,0.12)",
    },
  },
  {
    id: "graphite", name: "Graphite", scheme: "dark",
    description: "Neutral grey workstation with a steel-blue accent and no colour cast.",
    tokens: {
      ...base,
      bg: "#18191b", surface: "#1f2023", "surface-2": "#26282b", "surface-3": "#1b1c1f",
      border: "#2e3034", "border-strong": "#3c3f44", text: "#e4e5e7", "text-2": "#a4a8ae", "text-3": "#7c8188",
      accent: "#8fb3c9", "accent-contrast": "#101418", "accent-soft": "rgba(143,179,201,0.13)",
      up: "#6cc08b", down: "#e2806f", "up-soft": "rgba(108,192,139,0.12)", "down-soft": "rgba(226,128,111,0.12)",
      warn: "#d9a648", error: "#e2806f", info: "#8fb3c9", sim: "#b39ddb", focus: "#b7d3e4",
      overlay: "rgba(8,8,10,0.62)", "chart-grid": "#26282b", "chart-text": "#868b92",
      "chart-1": "#8fb3c9", "chart-2": "#d9a648", "chart-3": "#6cc08b", "chart-4": "#b39ddb", "chart-5": "#e2806f",
      shadow: "0 8px 24px rgba(0,0,0,0.4)", radius: "4px", "radius-lg": "6px",
    },
  },
  {
    id: "aurora", name: "Aurora", scheme: "dark",
    description: "Restrained futuristic: indigo night, periwinkle accent, geometric type.",
    tokens: {
      ...base,
      bg: "#0b1022", surface: "#11172e", "surface-2": "#18203c", "surface-3": "#0e1428",
      border: "#232c4d", "border-strong": "#323d66", text: "#e3e7fb", "text-2": "#a3abd2", "text-3": "#7880ab",
      accent: "#8c9bff", "accent-contrast": "#0b1022", "accent-soft": "rgba(140,155,255,0.14)",
      up: "#4fd1c5", down: "#ff7f96", "up-soft": "rgba(79,209,197,0.13)", "down-soft": "rgba(255,127,150,0.12)",
      warn: "#f2c46d", error: "#ff7f96", info: "#8c9bff", sim: "#d59cff", focus: "#aab5ff",
      overlay: "rgba(4,6,16,0.68)", "chart-grid": "#1a2240", "chart-text": "#7d86b5",
      "chart-1": "#8c9bff", "chart-2": "#4fd1c5", "chart-3": "#f2c46d", "chart-4": "#d59cff", "chart-5": "#ff7f96",
      shadow: "0 0 0 1px rgba(140,155,255,0.06), 0 12px 32px rgba(0,0,0,0.45)",
      "font-ui": FONT_OPTIONS[1].value, radius: "7px", "radius-lg": "11px", "radius-sm": "4px",
    },
  },
  {
    id: "ticker", name: "Ticker", scheme: "dark",
    description: "Dense amber-on-black terminal. Square corners, monospace, maximum rows.",
    tokens: {
      ...base,
      bg: "#050607", surface: "#0a0c0e", "surface-2": "#13161a", "surface-3": "#070809",
      border: "#1f2328", "border-strong": "#30363d", text: "#ece3cc", "text-2": "#b9ad8f", "text-3": "#8a8168",
      accent: "#ffb000", "accent-contrast": "#140d00", "accent-soft": "rgba(255,176,0,0.12)",
      up: "#3ddc7a", down: "#ff5a52", "up-soft": "rgba(61,220,122,0.10)", "down-soft": "rgba(255,90,82,0.10)",
      warn: "#ffb000", error: "#ff5a52", info: "#57b5ff", sim: "#d08cff", focus: "#ffcf4d",
      overlay: "rgba(0,0,0,0.72)", "chart-grid": "#14171b", "chart-text": "#8a8168",
      "chart-1": "#ffb000", "chart-2": "#57b5ff", "chart-3": "#3ddc7a", "chart-4": "#d08cff", "chart-5": "#ff5a52",
      shadow: "none", "radius-sm": "0px", radius: "0px", "radius-lg": "0px",
      "font-ui": FONT_OPTIONS[2].value, "font-num": FONT_OPTIONS[2].value, "fs-base": "12px", "row-h": "24px", pad: "10px", gap: "8px",
      motion: "0.4",
    },
  },
];

export const TOKEN_GROUPS: { label: string; keys: TokenKey[]; kind: "color" | "size" | "font" | "text" }[] = [
  { label: "Surfaces", keys: ["bg", "surface", "surface-2", "surface-3", "border", "border-strong"], kind: "color" },
  { label: "Text", keys: ["text", "text-2", "text-3"], kind: "color" },
  { label: "Accent & focus", keys: ["accent", "accent-contrast", "focus"], kind: "color" },
  { label: "Market movement", keys: ["up", "down"], kind: "color" },
  { label: "Status", keys: ["warn", "error", "info", "sim"], kind: "color" },
  { label: "Chart series", keys: ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-grid", "chart-text"], kind: "color" },
];

export const TOKEN_LABELS: Partial<Record<TokenKey, string>> = {
  bg: "Background", surface: "Panel", "surface-2": "Raised / hover", "surface-3": "Inputs & wells", border: "Border",
  "border-strong": "Strong border", text: "Primary text", "text-2": "Secondary text", "text-3": "Muted text", accent: "Accent",
  "accent-contrast": "Text on accent", focus: "Focus ring", up: "Up / gain", down: "Down / loss", warn: "Warning", error: "Error",
  info: "Information", sim: "Simulated data", "chart-1": "Series 1", "chart-2": "Series 2", "chart-3": "Series 3",
  "chart-4": "Series 4", "chart-5": "Series 5", "chart-grid": "Chart grid", "chart-text": "Chart labels",
};

export function themeById(id: string): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** Translucent "soft" variants are derived from the solid colour so custom themes stay coherent. */
export function deriveSoft(tokens: Tokens): Tokens {
  const t = { ...tokens };
  const soft = (hex: string, a: number) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };
  t["up-soft"] = soft(t.up, 0.13);
  t["down-soft"] = soft(t.down, 0.13);
  t["accent-soft"] = soft(t.accent, 0.14);
  return t;
}
