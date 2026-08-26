import { EgressBudgetExceededError, type EgressBudgetScope } from "./egress-budget.js";

export type JobFailureCode = "transfer_limit" | "request_limit" | "timeout" | "browser_failure" | "network_failure" | "internal_failure";
export type JobFailurePhase = "scan" | "report";
export type AdmissionRejectionCode = "capacity_limit" | "rate_limit";

export interface JobFailureEvent {
  event: "hosted_scan_failed";
  jobId: string;
  failureCode: JobFailureCode;
  phase: JobFailurePhase;
  durationMs: number;
  queueMs: number;
  transfer?: {
    scope: EgressBudgetScope;
    limitBytes: number;
    observedBytes: number;
  };
}

export interface JobCompletedEvent {
  event: "hosted_scan_completed";
  jobId: string;
  durationMs: number;
  queueMs: number;
  scanMs: number;
  reportMs: number;
  probes: number;
  captures: number;
}

export interface AdmissionRejectedEvent {
  event: "hosted_scan_rejected";
  rejectionCode: AdmissionRejectionCode;
}

export type OperationalEvent = JobFailureEvent | JobCompletedEvent | AdmissionRejectedEvent;
export type OperationalEventObserver = (event: OperationalEvent) => void;

export function createJobFailureEvent(input: { jobId: string; phase: JobFailurePhase; durationMs: number; queueMs?: number; error: unknown }): JobFailureEvent {
  const base = {
    event: "hosted_scan_failed" as const,
    jobId: input.jobId,
    failureCode: classifyFailure(input.error),
    phase: input.phase,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    queueMs: Math.max(0, Math.round(input.queueMs ?? 0)),
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

export function createJobCompletedEvent(input: Omit<JobCompletedEvent, "event">): JobCompletedEvent {
  return {
    event: "hosted_scan_completed",
    jobId: input.jobId,
    durationMs: boundedInteger(input.durationMs),
    queueMs: boundedInteger(input.queueMs),
    scanMs: boundedInteger(input.scanMs),
    reportMs: boundedInteger(input.reportMs),
    probes: boundedInteger(input.probes),
    captures: boundedInteger(input.captures),
  };
}

export function createAdmissionRejectedEvent(rejectionCode: AdmissionRejectionCode): AdmissionRejectedEvent {
  return { event: "hosted_scan_rejected", rejectionCode };
}

export function createJsonOperationalEventObserver(write: (line: string) => void = console.log): OperationalEventObserver {
  return (event) => {
    write(JSON.stringify(event));
  };
}

function boundedInteger(value: number): number {
  return Math.max(0, Math.round(value));
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
