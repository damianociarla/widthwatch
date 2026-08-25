import assert from "node:assert/strict";
import test from "node:test";
import { isPublicAddress } from "../dist/network-policy.js";
import { consumeRateLimits, SlidingWindowLimiter } from "../dist/security.js";

test("network policy blocks private and metadata ranges", () => {
  for (const value of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "::1"]) assert.equal(isPublicAddress(value), false, value);
  assert.equal(isPublicAddress("1.1.1.1"), true);
});

test("rate limits commit atomically", () => {
  const client = new SlidingWindowLimiter(1, 60_000);
  const global = new SlidingWindowLimiter(0, 60_000);
  assert.equal(
    consumeRateLimits(
      [
        { limiter: client, key: "client" },
        { limiter: global, key: "global" },
      ],
      1,
    ),
    false,
  );
  assert.equal(client.canConsume("client", 1), true);
});
