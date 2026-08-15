const windows = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;

export function checkRateLimit(keyId: string, limit: number): boolean {
  if (limit <= 0) return true;

  const now = Date.now();
  let entry = windows.get(keyId);

  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    windows.set(keyId, entry);
  }

  entry.count++;
  return entry.count <= limit;
}

export function resetRateLimits(): void {
  windows.clear();
}

const interval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows) {
    if (now >= entry.resetAt) windows.delete(key);
  }
}, WINDOW_MS);
interval.unref();
