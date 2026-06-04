export class SpendingCapError extends Error {
  constructor(msg: string) { super(msg); this.name = "SpendingCapError"; }
}

export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("spending cap") || (msg.includes("RESOURCE_EXHAUSTED") && msg.includes("monthly"))) {
        throw new SpendingCapError("월간 API 사용 한도 초과");
      }
      if (i < maxAttempts - 1) {
        // 네트워크 오류(fetch failed, reset 등)는 5초 후 빠르게 재시도
        const isNetworkError = msg.includes("fetch failed") || msg.includes("ECONNRESET") || msg.includes("ENOTFOUND") || msg.includes("ETIMEDOUT");
        const delay = isNetworkError ? 5000 : (i === 0 ? 30000 : 60000);
        console.warn(`[retry] attempt ${i + 1} failed, waiting ${delay / 1000}s:`, msg.slice(0, 120));
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}
