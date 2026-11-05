import { create } from "zustand";
import { engineMode, engineTarget } from "./client";
import type { Quote } from "./types";

type Listener = (type: string, data: unknown) => void;

interface LiveState {
  connected: boolean;
  lastMessage: number | null;
  quotes: Record<string, Quote>;
  prev: Record<string, number>;
}

export const useLive = create<LiveState>(() => ({ connected: false, lastMessage: null, quotes: {}, prev: {} }));

const listeners = new Set<Listener>();
export function onLive(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Quote bursts collapse into one store write per frame, so a full universe update is one render.
let pending: Record<string, Quote> | null = null;
let frame = 0;
function flushQuotes() {
  frame = 0;
  const incoming = pending;
  pending = null;
  if (!incoming) return;
  const cur = useLive.getState().quotes;
  const prev: Record<string, number> = {};
  for (const s of Object.keys(incoming)) if (cur[s]) prev[s] = cur[s].price;
  useLive.setState({ quotes: { ...cur, ...incoming }, prev, lastMessage: Date.now() });
}

/** Single entry point for live events, from the WebSocket or the browser engine. */
export function publish(type: string, data: unknown) {
  if (type === "quotes") {
    pending = { ...pending, ...(data as Record<string, Quote>) };
    if (!frame) frame = document.hidden ? (setTimeout(flushQuotes, 0) as unknown as number) : requestAnimationFrame(flushQuotes);
  } else {
    useLive.setState({ lastMessage: Date.now() });
  }
  listeners.forEach((fn) => fn(type, data));
}

let ws: WebSocket | null = null;
let retry = 0;
let pingTimer: number | undefined;

/** Single shared socket with exponential-backoff reconnect (1s .. 20s). The browser engine publishes directly instead. */
export function connectLive() {
  if (engineMode() === "browser") {
    useLive.setState({ connected: true });
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const { url, token } = engineTarget();
  const origin = url ? new URL(url) : location;
  const proto = origin.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${origin.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`);
  ws.onopen = () => {
    retry = 0;
    useLive.setState({ connected: true });
    window.clearInterval(pingTimer);
    pingTimer = window.setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 25_000);
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as { type: string; data: unknown };
      publish(msg.type, msg.data);
    } catch { /* ignore a malformed frame */ }
  };
  ws.onclose = () => {
    useLive.setState({ connected: false });
    window.clearInterval(pingTimer);
    const delay = Math.min(20_000, 1000 * 2 ** retry++);
    window.setTimeout(connectLive, delay);
  };
  ws.onerror = () => ws?.close();
}

export function useQuote(symbol: string | undefined | null): Quote | undefined {
  return useLive((s) => (symbol ? s.quotes[symbol.toUpperCase()] : undefined));
}

export function useTick(symbol: string): "up" | "down" | null {
  return useLive((s) => {
    const q = s.quotes[symbol];
    const p = s.prev[symbol];
    if (!q || p === undefined || p === q.price) return null;
    return q.price > p ? "up" : "down";
  });
}
