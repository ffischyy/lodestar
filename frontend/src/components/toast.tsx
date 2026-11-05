import { X } from "lucide-react";
import { create } from "zustand";

export interface ToastT { id: number; kind: "info" | "success" | "error" | "warn"; title: string; body?: string }

interface S { toasts: ToastT[] }
const useToasts = create<S>(() => ({ toasts: [] }));
let n = 0;

export function toast(kind: ToastT["kind"], title: string, body?: string, ms = 5000) {
  const id = ++n;
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, title, body }] }));
  window.setTimeout(() => dismiss(id), kind === "error" ? Math.max(ms, 9000) : ms);
}

function dismiss(id: number) {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <div className="grow">
            <div className="t-title">{t.title}</div>
            {t.body && <div className="t-body">{t.body}</div>}
          </div>
          <button className="btn ghost sm icon" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
