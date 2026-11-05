import clsx from "clsx";
import { AlertTriangle, ArrowDown, ArrowUp, Info, Minus, RefreshCw, X } from "lucide-react";
import { createPortal } from "react-dom";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { DataStatus } from "../api/types";
import { errMsg } from "../api/client";
import { dir, frac, isNum, pct } from "../lib/format";

/* ---------------------------------------------------------------- panel */
export function Panel({ title, hint, actions, children, className, flush, foot, id }: {
  title?: ReactNode; hint?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; flush?: boolean; foot?: ReactNode; id?: string;
}) {
  return (
    <section className={clsx("panel", className)} aria-labelledby={title ? `${id ?? ""}h` : undefined} id={id}>
      {(title || actions) && (
        <header className="panel-head">
          {title && <h2 id={`${id ?? ""}h`}>{title}</h2>}
          {hint && <span className="hint">{hint}</span>}
          {actions && <div className="actions">{actions}</div>}
        </header>
      )}
      <div className={clsx("panel-body", flush && "flush")}>{children}</div>
      {foot && <footer className="panel-foot">{foot}</footer>}
    </section>
  );
}

export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {actions && <div className="row wrap actions">{actions}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- data provenance */
const STATUS_TEXT: Record<string, { label: string; tip: string }> = {
  live: { label: "Live", tip: "Real-time from an exchange feed. On Alpaca's free plan this is the IEX venue only." },
  delayed: { label: "Delayed", tip: "Real market data that may be delayed (typically up to 15 minutes)." },
  cached: { label: "Cached", tip: "The provider is unreachable, so this is the last stored value." },
  stale: { label: "Stale", tip: "Older than the freshness threshold. Do not trade on it." },
  historical: { label: "Close", tip: "Last end-of-day value; markets are closed or no current quote exists." },
  simulated: { label: "Simulated", tip: "Synthetic price from the built-in simulator. Not real market data." },
  replay: { label: "Real (past)", tip: "Practice trading: real past daily prices played back on a sped-up clock with play money. Minute-by-minute moves inside each day are synthetic." },
  unavailable: { label: "No data", tip: "No quote available." },
};

export function StatusPill({ status, note }: { status: DataStatus | string | undefined | null; note?: string }) {
  const s = STATUS_TEXT[status ?? "unavailable"] ?? STATUS_TEXT.unavailable;
  return (
    <Tooltip text={note ? `${s.tip} ${note}` : s.tip}>
      <span className={clsx("pill", status)} aria-label={`Data status: ${s.label}`}>
        <span className="dot" aria-hidden />
        {s.label}
      </span>
    </Tooltip>
  );
}

/** Signed change with arrow glyph + sign + colour, so colour is never the only cue. */
export function Delta({ value, kind = "pct", digits = 2, className, bare }: {
  value: number | null | undefined; kind?: "pct" | "frac" | "abs"; digits?: number; className?: string; bare?: boolean;
}) {
  const d = dir(value);
  const txt = kind === "pct" ? pct(value, digits) : kind === "frac" ? frac(value, digits) : isNum(value) ? `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}` : "—";
  const Icon = d === "up" ? ArrowUp : d === "down" ? ArrowDown : Minus;
  return (
    <span className={clsx("num", d, className)} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
      {!bare && isNum(value) && <Icon size={11} strokeWidth={2.5} aria-hidden />}
      {txt}
    </span>
  );
}

export function Stat({ label, value, note, tone, lead }: { label: ReactNode; value: ReactNode; note?: ReactNode; tone?: "up" | "down"; lead?: boolean }) {
  return (
    <div className={clsx("stat", lead && "lead")}>
      <div className="label">{label}</div>
      <div className={clsx("value num", tone)}>{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- states */
export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" role="status">
      <span className="spinner" aria-hidden />
      {label && <span className="muted small">{label}</span>}
    </span>
  );
}

export function Skeleton({ rows = 4, height = 14 }: { rows?: number; height?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height, width: `${92 - ((i * 17) % 35)}%` }} />
      ))}
    </div>
  );
}

export function Empty({ title, children, action, center }: { title: string; children?: ReactNode; action?: ReactNode; center?: boolean }) {
  return (
    <div className={clsx("state", center && "center")}>
      <h3>{title}</h3>
      {children && <div className="small">{children}</div>}
      {action}
    </div>
  );
}

export function ErrorState({ error, retry, title = "This data could not be loaded" }: { error: unknown; retry?: () => void; title?: string }) {
  return (
    <div className="state error" role="alert">
      <h3 className="row"><AlertTriangle size={16} /> {title}</h3>
      <div className="small">{errMsg(error)}</div>
      {retry && (
        <button className="btn sm" onClick={retry}>
          <RefreshCw size={16} /> Try again
        </button>
      )}
    </div>
  );
}

/** Standard loading / error / empty wrapper around a query result. */
export function Loadable<T>({ q, children, empty, rows = 5 }: {
  q: { data?: T; isLoading: boolean; error: unknown; refetch: () => unknown };
  children: (d: T) => ReactNode; empty?: (d: T) => ReactNode | null; rows?: number;
}) {
  if (q.isLoading) return <Skeleton rows={rows} />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (q.data === undefined) return null;
  const e = empty?.(q.data);
  return <>{e ?? children(q.data)}</>;
}

export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "error" | "sim"; children: ReactNode }) {
  return (
    <div className={clsx("notice", kind)} role={kind === "error" ? "alert" : undefined}>
      {kind === "info" ? <Info size={16} /> : <AlertTriangle size={16} />}
      <div>{children}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- controls */
export function Seg<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.value === value);
    if (e.key === "ArrowRight") onChange(tabs[(i + 1) % tabs.length].value);
    if (e.key === "ArrowLeft") onChange(tabs[(i - 1 + tabs.length) % tabs.length].value);
  };
  return (
    <div className="tabs" role="tablist" ref={ref} onKeyDown={onKey}>
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={t.value === value} tabIndex={t.value === value ? 0 : -1} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, help, error, children }: { label: ReactNode; help?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error ? <span className="err">{error}</span> : help ? <span className="help">{help}</span> : null}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <span className="check">
      <button type="button" role="switch" className="toggle" aria-checked={checked} aria-label={label} disabled={disabled}
        onClick={() => onChange(!checked)} />
      <span>{label}</span>
    </span>
  );
}

export function NumberInput({ value, onChange, step = 1, min, max, invalid, ...rest }: {
  value: number | null | undefined; onChange: (v: number | null) => void; step?: number; min?: number; max?: number; invalid?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [txt, setTxt] = useState(value == null ? "" : String(value));
  useEffect(() => setTxt(value == null ? "" : String(value)), [value]);
  return (
    <input {...rest} className={clsx("input num", invalid && "invalid")} inputMode="decimal" value={txt} step={step} min={min} max={max}
      onChange={(e) => {
        setTxt(e.target.value);
        const v = e.target.value.trim() === "" ? null : Number(e.target.value);
        if (v === null || Number.isFinite(v)) onChange(v);
      }} />
  );
}

/* ---------------------------------------------------------------- overlays */
export function Modal({ title, onClose, children, foot, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not([data-close])");
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && ref.current) {
        const els = ref.current.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])");
        if (!els.length) return;
        const f = els[0], l = els[els.length - 1];
        if (e.shiftKey && document.activeElement === f) { l.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === l) { f.focus(); e.preventDefault(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={clsx("modal", wide && "wide")} role="dialog" aria-modal="true" ref={ref} tabIndex={-1}>
        <div className="modal-head">
          <h2 className="grow">{title}</h2>
          <button className="btn ghost sm icon" onClick={onClose} aria-label="Close" data-close>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Confirm({ title, body, confirmLabel, danger, onConfirm, onCancel }: {
  title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}
      foot={<>
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className={clsx("btn", danger ? "danger" : "primary")} onClick={onConfirm}>{confirmLabel}</button>
      </>}>
      <div className="small muted">{body}</div>
    </Modal>
  );
}

export function Tooltip({ text, children }: { text: ReactNode; children: ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: r.left + r.width / 2, y: r.bottom + 6 });
  };
  useLayoutEffect(() => {
    if (!pos || !boxRef.current) return;
    const b = boxRef.current.getBoundingClientRect();
    let x = pos.x - b.width / 2;
    x = Math.max(8, Math.min(window.innerWidth - b.width - 8, x));
    let y = pos.y;
    if (y + b.height > window.innerHeight - 8) y = (ref.current?.getBoundingClientRect().top ?? 0) - b.height - 6;
    boxRef.current.style.left = `${x}px`;
    boxRef.current.style.top = `${y}px`;
  }, [pos]);
  return (
    <span className="tip" ref={ref} onMouseEnter={show} onMouseLeave={() => setPos(null)} onFocus={show} onBlur={() => setPos(null)}
      aria-describedby={pos ? id : undefined}>
      {children}
      {pos && createPortal(<div className="tip-box" role="tooltip" id={id} ref={boxRef}>{text}</div>, document.body)}
    </span>
  );
}

export interface MenuItem { label: string; icon?: ReactNode; onClick: () => void; danger?: boolean }

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const els = Array.from(ref.current?.querySelectorAll<HTMLElement>("button") ?? []);
        const i = els.indexOf(document.activeElement as HTMLElement);
        els[(i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length]?.focus();
        e.preventDefault();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - items.length * 30 - 16);
  return createPortal(
    <div className="menu" role="menu" style={{ left, top }} ref={ref}>
      {items.map((it) => (
        <button key={it.label} role="menuitem" onClick={() => { it.onClick(); onClose(); }} style={it.danger ? { color: "var(--down)" } : undefined}>
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <i style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function ScoreBar({ value, max = 1, tone }: { value: number; max?: number; tone?: string }) {
  return (
    <span className="bar-cell" aria-hidden>
      <i style={{ width: `${Math.max(0, Math.min(1, value / max)) * 100}%`, background: tone }} />
    </span>
  );
}
