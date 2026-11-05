/**
 * Thin fetch wrapper with three possible targets, decided once at boot:
 *   same-origin engine → engine at a saved or build-time URL → the in-browser engine.
 */
export class ApiError extends Error {
  status: number;
  violations: string[];
  constructor(status: number, message: string, violations: string[] = []) {
    super(message);
    this.status = status;
    this.violations = violations;
  }
}

export type EngineMode = "server" | "browser";
export interface EngineTarget { url: string; token: string }

const TARGET_KEY = "lodestar.engine";

export function savedTarget(): EngineTarget {
  let saved: Partial<EngineTarget> = {};
  try { saved = JSON.parse(localStorage.getItem(TARGET_KEY) ?? "{}"); } catch { /* private mode: fall through to defaults */ }
  return { url: (saved.url ?? (import.meta.env.VITE_API_URL as string | undefined) ?? "").replace(/\/$/, ""), token: saved.token ?? "" };
}

export function saveTarget(t: EngineTarget) {
  try { localStorage.setItem(TARGET_KEY, JSON.stringify(t)); } catch { /* nothing to persist to */ }
}

let mode: EngineMode = "server";
let target = savedTarget();
export const engineMode = () => mode;
export const engineTarget = () => target;

/** True when the URL answers like a Lodestar engine. Static hosts return their HTML page for /api/status, which fails this. */
export async function probeEngine(t: EngineTarget, timeoutMs = 1800): Promise<boolean> {
  try {
    const res = await fetch(`${t.url}/api/status`, {
      headers: t.token ? { Authorization: `Bearer ${t.token}` } : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return false;
    return "provider" in (await res.json());
  } catch {
    return false;
  }
}

let local: Promise<typeof import("../engine")> | null = null;
const browserEngine = () => (local ??= import("../engine"));

/** Called once before the app mounts. */
export async function bootEngine() {
  target = savedTarget();
  mode = (await probeEngine(target)) ? "server" : "browser";
  if (mode === "browser") (await browserEngine()).start();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (mode === "browser") return (await browserEngine()).handle(method, path, body) as Promise<T>;
  let res: Response;
  try {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (target.token) headers.Authorization = `Bearer ${target.token}`;
    res = await fetch(`${target.url}/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, "Cannot reach the Lodestar engine. Check that it is still running.");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const d = (data as { detail?: unknown })?.detail ?? data;
    if (d && typeof d === "object" && "message" in (d as object)) {
      const o = d as { message: string; violations?: string[] };
      throw new ApiError(res.status, o.message, o.violations ?? []);
    }
    throw new ApiError(res.status, typeof d === "string" ? d : `Request failed (HTTP ${res.status})`);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {}),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b ?? {}),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b ?? {}),
  del: <T>(p: string) => request<T>("DELETE", p),
};

export function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.violations.length ? `${e.message}: ${e.violations.join(" ")}` : e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
