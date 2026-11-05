import { CornerDownLeft, LineChart } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { ALL_NAV } from "../nav";

interface Hit { kind: "symbol" | "page"; key: string; label: string; sub: string; go: string }

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [syms, setSyms] = useState<{ symbol: string; name: string; sector: string }[]>([]);
  const [sel, setSel] = useState(0);
  const nav = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const t = window.setTimeout(() => {
      api.get<typeof syms>(`/market/search?q=${encodeURIComponent(q)}`).then(setSyms).catch(() => setSyms([]));
    }, 120);
    return () => window.clearTimeout(t);
  }, [q]);

  const hits: Hit[] = useMemo(() => {
    const ql = q.toLowerCase().trim();
    const pages = ALL_NAV.filter((p) => !ql || p.label.toLowerCase().includes(ql) || p.keywords?.includes(ql))
      .map((p) => ({ kind: "page" as const, key: p.path, label: p.label, sub: "Screen", go: p.path }));
    const s = syms.slice(0, 8).map((x) => ({ kind: "symbol" as const, key: x.symbol, label: x.symbol, sub: `${x.name}, ${x.sector}`, go: `/research/${x.symbol}` }));
    return ql ? [...s, ...pages] : [...pages.slice(0, 6), ...s];
  }, [q, syms]);

  useEffect(() => setSel(0), [q]);
  const go = (h: Hit) => {
    nav(h.go);
    onClose();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "ArrowDown") { setSel((s) => Math.min(hits.length - 1, s + 1)); e.preventDefault(); }
    if (e.key === "ArrowUp") { setSel((s) => Math.max(0, s - 1)); e.preventDefault(); }
    if (e.key === "Enter" && hits[sel]) go(hits[sel]);
  };

  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label="Search">
        <input ref={inputRef} className="input" placeholder="Type a ticker or a screen name" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey} role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={hits[sel] ? `ph-${sel}` : undefined} />
        <div className="palette-list" id="palette-list" role="listbox">
          {hits.length === 0 && <div className="state small">No matches. Tickers use letters only, like MSFT.</div>}
          {hits.map((h, i) => {
            const Icon = h.kind === "page" ? ALL_NAV.find((n) => n.path === h.key)?.icon ?? LineChart : LineChart;
            return (
              <div key={`${h.kind}${h.key}`} id={`ph-${i}`} role="option" aria-selected={i === sel} className="palette-item"
                onMouseEnter={() => setSel(i)} onClick={() => go(h)}>
                <Icon size={16} className="faint" />
                <span className={h.kind === "symbol" ? "sym" : ""}>{h.label}</span>
                <span className="muted small truncate">{h.sub}</span>
                {i === sel && <CornerDownLeft size={16} className="k" />}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
