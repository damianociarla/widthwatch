import { setTimeout as delay } from "node:timers/promises";
import type { WidthWatchReport } from "widthwatch";

export type HostedScanStatus = "queued" | "running" | "complete" | "failed";

export interface HostedScanJob {
  id: string;
  status: HostedScanStatus;
  report?: WidthWatchReport;
  error?: string;
}

export async function holdConnectionUntilSettled(job: HostedScanJob, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((job.status === "queued" || job.status === "running") && Date.now() < deadline) await delay(50);
}

export function scanStatusPayload(job: HostedScanJob): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    ...(job.report ? {
      report: {
        version: job.report.version,
        url: job.report.url,
        title: job.report.title,
        scannedAt: job.report.scannedAt,
        durationMs: job.report.durationMs,
        range: job.report.range,
        frames: job.report.frames.map((frame) => ({
          width: frame.width,
          issues: frame.issues.map((issue) => ({ severity: issue.severity })),
        })),
        summary: job.report.summary,
      },
      reportUrl: `/v1/reports/${job.id}`,
    } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}
