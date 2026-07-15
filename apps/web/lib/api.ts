const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("assetflow_token");
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem("assetflow_token", token);
  else localStorage.removeItem("assetflow_token");
}

export class ApiError extends Error {
  status: number;
  currentHolder?: { id: string; name: string; email?: string };
  constructor(status: number, message: string, extra?: Record<string, any>) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export async function api<T = any>(
  path: string,
  options: { method?: string; body?: any; query?: Record<string, string | number | undefined> } = {}
): Promise<T> {
  const { method = "GET", body, query } = options;

  const url = new URL(API_URL + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const token = getToken();
  const res = await fetch(url.toString(), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data);
  }

  return data as T;
}
