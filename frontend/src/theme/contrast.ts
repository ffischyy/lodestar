/** WCAG 2.x relative luminance and contrast ratio for #rrggbb colours. */
export function luminance(hex: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la == null || lb == null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastCheck {
  label: string;
  fg: string;
  bg: string;
  ratio: number | null;
  min: number;
  pass: boolean;
}

/** The pairs that matter for reading financial data. Body text needs 4.5:1; large text and UI marks 3:1. */
export function checkTheme(t: Record<string, string>): ContrastCheck[] {
  const pairs: [string, string, string, number][] = [
    ["Primary text on panel", "text", "surface", 4.5],
    ["Primary text on background", "text", "bg", 4.5],
    ["Secondary text on panel", "text-2", "surface", 4.5],
    ["Muted text on panel", "text-3", "surface", 3],
    ["Gains on panel", "up", "surface", 3],
    ["Losses on panel", "down", "surface", 3],
    ["Text on accent buttons", "accent-contrast", "accent", 4.5],
    ["Accent on panel", "accent", "surface", 3],
    ["Focus ring on background", "focus", "bg", 3],
  ];
  return pairs.map(([label, f, b, min]) => {
    const r = contrast(t[f], t[b]);
    return { label, fg: f, bg: b, ratio: r, min, pass: r != null && r >= min };
  });
}
