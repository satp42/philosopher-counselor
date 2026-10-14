export class HttpError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export const postJson = (path: string, body?: unknown, method = "POST") =>
  fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export async function fetchJson(path: string, body?: unknown, method?: "DELETE") {
  const res = body === undefined && !method ? await fetch(path) : await postJson(path, body, method);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(res.status, data);
  return data;
}
