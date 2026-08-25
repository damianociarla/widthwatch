import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicUrl, isPublicAddress, resolvePublicTarget, UnsafeUrlError } from "../dist/network-policy.js";
import { consumeRateLimits, SlidingWindowLimiter } from "../dist/security.js";

test("network policy blocks private and metadata ranges", () => {
  for (const value of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "::1"]) assert.equal(isPublicAddress(value), false, value);
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("not-an-address"), false);
});

test("network policy normalizes public targets through an injected DNS adapter", async () => {
  const lookups = [];
  const target = await resolvePublicTarget("https://example.com/path", async (hostname) => {
    lookups.push(hostname);
    return [{ address: "93.184.216.34" }];
  });
  assert.equal(target.url.toString(), "https://example.com/path");
  assert.deepEqual(target.addresses, ["93.184.216.34"]);
  assert.deepEqual(lookups, ["example.com"]);
  assert.equal((await assertPublicUrl("1.1.1.1")).toString(), "https://1.1.1.1/");
});

test("network policy rejects invalid URL forms and mixed DNS answers", async () => {
  const cases = [
    "not a url",
    "ftp://example.com",
    "https://user:pass@example.com",
    "https://example.com:8080",
    "https://localhost./",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://[::ffff:127.0.0.1]/",
  ];
  for (const value of cases) await assert.rejects(() => resolvePublicTarget(value), UnsafeUrlError, value);
  await assert.rejects(() => resolvePublicTarget("https://example.com", async () => [{ address: "93.184.216.34" }, { address: "10.0.0.1" }]), UnsafeUrlError);
  await assert.rejects(() => resolvePublicTarget("https://missing.example", async () => Promise.reject(new Error("DNS unavailable"))), UnsafeUrlError);
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
