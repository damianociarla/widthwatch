import type { ScanOptions, WidthWatchReport } from "widthwatch";
import { EgressTransferBudget, type EgressTransferLimits } from "./egress-budget.js";
import { type EgressConnector, type EgressTargetResolver, startPinnedEgressProxy } from "./egress-proxy.js";

const MEBIBYTE = 1024 * 1024;

export interface HostedScanAdapters {
  scan(url: string, options: ScanOptions): Promise<WidthWatchReport>;
  resolveTarget: EgressTargetResolver;
  connectTarget?: EgressConnector;
}

export type HostedScanConfig = EgressTransferLimits;

export function createHostedScanRunner(
  adapters: HostedScanAdapters,
  config: HostedScanConfig,
): (url: string, options: ScanOptions) => Promise<WidthWatchReport> {
  const limits = new EgressTransferBudget(config).limits;
  return async (url, options) => {
    const budget = new EgressTransferBudget(limits);
    const proxy = await startPinnedEgressProxy({
      budget,
      resolveTarget: adapters.resolveTarget,
      ...(adapters.connectTarget ? { connectTarget: adapters.connectTarget } : {}),
    });
    const signal = options.signal ? AbortSignal.any([options.signal, budget.signal]) : budget.signal;
    try {
      const report = await adapters.scan(url, { ...options, proxyServer: proxy.url, signal });
      budget.assertAvailable();
      return report;
    } catch (error) {
      if (budget.error) throw budget.error;
      throw error;
    } finally {
      await proxy.close();
    }
  };
}

export function hostedScanConfig(env: NodeJS.ProcessEnv = process.env): HostedScanConfig {
  return {
    maxBytesPerResponse: Number(env.MAX_BYTES_PER_RESPONSE ?? 10 * MEBIBYTE),
    maxBytesPerTunnel: Number(env.MAX_BYTES_PER_TUNNEL ?? 25 * MEBIBYTE),
    maxTransferredBytes: Number(env.MAX_TRANSFERRED_BYTES ?? 75 * MEBIBYTE),
  };
}
