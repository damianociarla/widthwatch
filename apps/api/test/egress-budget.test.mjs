import assert from "node:assert/strict";
import test from "node:test";
import { EgressBudgetExceededError, EgressTransferBudget } from "../dist/egress-budget.js";

test("egress budget validates every configured byte limit", () => {
  for (const limits of [
    { maxBytesPerResponse: 0, maxBytesPerTunnel: 10, maxTransferredBytes: 20 },
    { maxBytesPerResponse: 10, maxBytesPerTunnel: 1.5, maxTransferredBytes: 20 },
    { maxBytesPerResponse: 21, maxBytesPerTunnel: 10, maxTransferredBytes: 20 },
    { maxBytesPerResponse: 10, maxBytesPerTunnel: 21, maxTransferredBytes: 20 },
  ]) {
    assert.throws(() => new EgressTransferBudget(limits), /must be|cannot exceed/);
  }
});

test("egress budget rejects declared response sizes before transferring bytes", () => {
  const budget = new EgressTransferBudget({ maxBytesPerResponse: 10, maxBytesPerTunnel: 20, maxTransferredBytes: 30 });
  budget.openResponse(11);
  assert.equal(budget.signal.aborted, true);
  assert.equal(budget.transferredBytes, 0);
  assert.ok(budget.error instanceof EgressBudgetExceededError);
  assert.equal(budget.error.scope, "response");
  assert.throws(() => budget.assertAvailable(), EgressBudgetExceededError);
});

test("egress budget rejects declared responses that exceed the remaining job total", () => {
  const budget = new EgressTransferBudget({ maxBytesPerResponse: 10, maxBytesPerTunnel: 10, maxTransferredBytes: 10 });
  assert.equal(budget.addTransferredBytes(6), true);
  budget.openResponse(5);
  assert.equal(budget.error.scope, "total");
  assert.equal(budget.error.observedBytes, 11);
  assert.equal(budget.transferredBytes, 6);
});

test("egress budget rejects malformed declared lengths and transfer chunks", () => {
  for (const contentLength of [-1, 1.5]) {
    const budget = new EgressTransferBudget({ maxBytesPerResponse: 10, maxBytesPerTunnel: 10, maxTransferredBytes: 20 });
    assert.throws(() => budget.openResponse(contentLength), /Invalid upstream Content-Length/);
    assert.equal(budget.signal.aborted, false);
  }
  const budget = new EgressTransferBudget({ maxBytesPerResponse: 10, maxBytesPerTunnel: 10, maxTransferredBytes: 20 });
  assert.equal(budget.addTransferredBytes(-1), false);
  assert.equal(budget.transferredBytes, 0);
});

test("egress budget shares one total across response and tunnel meters and aborts once", () => {
  const budget = new EgressTransferBudget({ maxBytesPerResponse: 10, maxBytesPerTunnel: 10, maxTransferredBytes: 10 });
  const response = budget.openResponse();
  const tunnel = budget.openTunnel();
  let aborts = 0;
  budget.signal.addEventListener("abort", () => (aborts += 1));
  assert.equal(response.add(6), true);
  assert.equal(tunnel.add(5), false);
  assert.equal(response.add(1), false);
  assert.equal(budget.error.scope, "total");
  assert.equal(budget.transferredBytes, 11);
  assert.equal(aborts, 1);
});

test("egress byte meters reject invalid chunks without corrupting totals", () => {
  const budget = new EgressTransferBudget({ maxBytesPerResponse: 10, maxBytesPerTunnel: 10, maxTransferredBytes: 20 });
  const meter = budget.openResponse();
  assert.equal(meter.add(-1), false);
  assert.equal(meter.add(1.5), false);
  assert.equal(meter.bytes, 0);
  assert.equal(budget.transferredBytes, 0);
  assert.equal(meter.add(0), true);
});
