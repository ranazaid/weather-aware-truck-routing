import type { Heatmap, Meta, Place, Plan, PlanRequest } from "./types";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string[]>;

  constructor(status: number, code: string, message: string, fields: Record<string, string[]> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "network", "Can't reach the server. Check your connection and try again.");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body handled below */
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; fields?: Record<string, string[]> } } | null)
      ?.error;
    throw new ApiError(
      res.status,
      err?.code ?? "http_error",
      err?.message ?? `Request failed (HTTP ${res.status}).`,
      err?.fields ?? {},
    );
  }
  return data as T;
}

export const api = {
  meta: () => request<Meta>("/api/meta"),
  geocode: (q: string, signal?: AbortSignal) =>
    request<{ results: Place[] }>(`/api/geocode?q=${encodeURIComponent(q)}`, { signal }).then((r) => r.results),
  plan: (body: PlanRequest) => request<Plan>("/api/plan", { method: "POST", body: JSON.stringify(body) }),
  heatmap: (planId: string) => request<Heatmap>(`/api/plans/${encodeURIComponent(planId)}/heatmap`),
};
