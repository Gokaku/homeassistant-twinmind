/** All URLs are relative to the page, which lives under the ingress path. */
export const apiUrl = (p: string) => new URL(`api/${p.replace(/^\//, "")}`, document.baseURI).toString();

export function wsUrl(): string {
  const u = new URL("api/ws", document.baseURI);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? (init.json !== undefined ? "POST" : "GET")).toUpperCase();
  if (method !== "GET" && method !== "HEAD") headers.set("X-Twinmind", "1");
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(apiUrl(path), { ...init, method, headers, body, credentials: "same-origin" });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export async function uploadFile(blob: Blob, name: string) {
  const res = await api<{ upload: import("./protocol").UploadInfo }>("uploads", {
    method: "POST",
    body: blob,
    headers: { "Content-Type": blob.type || "application/octet-stream", "X-File-Name": encodeURIComponent(name) },
  });
  return res.upload;
}

export const uploadUrl = (id: string) => apiUrl(`uploads/${encodeURIComponent(id)}`);
