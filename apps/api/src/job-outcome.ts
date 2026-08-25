import { EgressBudgetExceededError, type EgressBudgetScope } from "./egress-budget.js";

export type JobFailureCode = "transfer_limit" | "request_limit" | "timeout" | "browser_failure" | "network_failure" | "internal_failure";
export type JobFailurePhase = "scan" | "report";

export interface JobFailureEvent {
  event: "hosted_scan_failed";
  jobId: string;
  failureCode: JobFailureCode;
  phase: JobFailurePhase;
  durationMs: number;
  transfer?: {
    scope: EgressBudgetScope;
    limitBytes: number;
    observedBytes: number;
  };
}

export type JobFailureObserver = (event: JobFailureEvent) => void;

export function createJobFailureEvent(input: { jobId: string; phase: JobFailurePhase; durationMs: number; error: unknown }): JobFailureEvent {
  const base = {
    event: "hosted_scan_failed" as const,
    jobId: input.jobId,
    failureCode: classifyFailure(input.error),
    phase: input.phase,
    durationMs: Math.max(0, Math.round(input.durationMs)),
  };
  return input.error instanceof EgressBudgetExceededError
    ? {
        ...base,
        transfer: {
          scope: input.error.scope,
          limitBytes: input.error.limit,
          observedBytes: input.error.observedBytes,
        },
      }
    : base;
}

export function createJsonJobFailureObserver(write: (line: string) => void = console.error): JobFailureObserver {
  return (event) => {
    write(JSON.stringify(event));
  };
}

function classifyFailure(error: unknown): JobFailureCode {
  if (error instanceof EgressBudgetExceededError) return "transfer_limit";
  if (!(error instanceof Error)) return "internal_failure";
  const message = error.message.toLowerCase();
  if (message.includes("request budget exceeded")) return "request_limit";
  if (error.name === "TimeoutError" || message.includes("timeout") || /exceeded \d+ms/.test(message)) return "timeout";
  if (/browser|target page|context.*closed|page crashed|crash/.test(message)) return "browser_failure";
  if (/net::|dns|enotfound|econn|socket|proxy|public address/.test(message)) return "network_failure";
  return "internal_failure";
}
