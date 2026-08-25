import { randomUUID } from "node:crypto";
import { scanResponsive } from "widthwatch";
import { createHostedScanRunner, hostedScanConfig } from "./hosted-scan.js";
import { createHttpAdmissionServer, httpAdmissionConfig } from "./http-admission.js";
import { createJsonJobFailureObserver } from "./job-outcome.js";
import { assertPublicUrl, resolvePublicTarget } from "./network-policy.js";
import { ReportStore } from "./report-store.js";

const hostedScan = createHostedScanRunner({ scan: scanResponsive, resolveTarget: resolvePublicTarget }, hostedScanConfig());
const server = createHttpAdmissionServer(
  {
    scan: hostedScan,
    acceptTarget: assertPublicUrl,
    allowResource: async (url) =>
      resolvePublicTarget(url).then(
        () => true,
        () => false,
      ),
    reports: new ReportStore(),
    createId: randomUUID,
    now: Date.now,
    onJobFailed: createJsonJobFailureObserver(),
  },
  httpAdmissionConfig(),
);

const port = Number(process.env.PORT ?? 8080);
server.listen(port, "0.0.0.0", () => console.log(`WidthWatch API listening on ${port}`));

let closing = false;
const cleanup = () => {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
};
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
