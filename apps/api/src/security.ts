export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  canConsume(key: string, now = Date.now()): boolean {
    const recent = (this.buckets.get(key) ?? []).filter((value) => now - value < this.windowMs);
    return recent.length < this.limit;
  }
  commit(key: string, now = Date.now()): void {
    const recent = (this.buckets.get(key) ?? []).filter((value) => now - value < this.windowMs);
    recent.push(now); this.buckets.set(key, recent);
    if (this.buckets.size > 10_000) this.buckets.clear();
  }
}

export function consumeRateLimits(requests: Array<{ limiter: SlidingWindowLimiter; key: string }>, now = Date.now()): boolean {
  if (requests.some(({ limiter, key }) => !limiter.canConsume(key, now))) return false;
  for (const { limiter, key } of requests) limiter.commit(key, now);
  return true;
}
