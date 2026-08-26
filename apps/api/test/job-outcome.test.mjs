import assert from "node:assert/strict";
import test from "node:test";
import { EgressBudgetExceededError } from "../dist/egress-budget.js";
import { createAdmissionRejectedEvent, createJobCompletedEvent, createJobFailureEvent, createJsonOperationalEventObserver } from "../dist/job-outcome.js";

test("job outcomes classify failures without retaining sensitive error details", () => {
  const cases = [
    [new EgressBudgetExceededError("tunnel", 25, 26), "transfer_limit"],
    [new Error("WidthWatch total request budget exceeded (10 allowed requests). https://secret.example/?token=private"), "request_limit"],
    [Object.assign(new Error("page.goto: exceeded 15000ms at https://secret.example"), { name: "TimeoutError" }), "timeout"],
    [new Error("Target page, context or browser has been closed"), "browser_failure"],
    [new Error("net::ERR_CONNECTION_RESET at https://secret.example"), "network_failure"],
    [new Error("unexpected https://secret.example/?token=private"), "internal_failure"],
    ["not an error", "internal_failure"],
  ];
  for (const [error, expected] of cases) {
    const outcome = createJobFailureEvent({ jobId: "job-1", phase: "scan", durationMs: -2.4, error });
    assert.equal(outcome.failureCode, expected);
    assert.equal(outcome.durationMs, 0);
    assert.equal(JSON.stringify(outcome).includes("secret.example"), false);
    assert.equal(JSON.stringify(outcome).includes("private"), false);
  }
});

test("transfer outcomes expose only bounded numeric diagnostics", () => {
  const outcome = createJobFailureEvent({
    jobId: "job-transfer",
    phase: "scan",
    durationMs: 10.6,
    error: new EgressBudgetExceededError("response", 10, 20),
  });
  assert.deepEqual(outcome, {
    event: "hosted_scan_failed",
    jobId: "job-transfer",
    failureCode: "transfer_limit",
    phase: "scan",
    durationMs: 11,
    queueMs: 0,
    transfer: { scope: "response", limitBytes: 10, observedBytes: 20 },
  });
});

test("completed and rejected operational events expose only bounded metrics", () => {
  assert.deepEqual(createJobCompletedEvent({ jobId: "job-1", durationMs: 10.6, queueMs: -1, scanMs: 8.4, reportMs: 2.2, probes: 5.2, captures: 4.8 }), {
    event: "hosted_scan_completed",
    jobId: "job-1",
    durationMs: 11,
    queueMs: 0,
    scanMs: 8,
    reportMs: 2,
    probes: 5,
    captures: 5,
  });
  assert.deepEqual(createAdmissionRejectedEvent("capacity_limit"), {
    event: "hosted_scan_rejected",
    rejectionCode: "capacity_limit",
  });
});

test("JSON observer emits safe lines using the stable operational schema", () => {
  const lines = [];
  const observe = createJsonOperationalEventObserver((line) => lines.push(line));
  observe(
    createJobFailureEvent({
      jobId: "job-1",
      phase: "scan",
      durationMs: 5,
      error: new EgressBudgetExceededError("total", 75, 76),
    }),
  );
  observe(createJobFailureEvent({ jobId: "job-2", phase: "report", durationMs: 6, error: new Error("report failed") }));
  const transfer = JSON.parse(lines[0]);
  const internal = JSON.parse(lines[1]);
  assert.equal(transfer.event, "hosted_scan_failed");
  assert.equal(transfer.failureCode, "transfer_limit");
  assert.equal(internal.failureCode, "internal_failure");
  assert.equal(lines.length, 2);
});
