import { randomUUID } from "node:crypto";
import { scanResponsive } from "widthwatch";
import { startPinnedEgressProxy } from "./egress-proxy.js";
import { createHttpAdmissionServer, httpAdmissionConfig } from "./http-admission.js";
import { assertPublicUrl, resolvePublicTarget } from "./network-policy.js";
import { ReportStore } from "./report-store.js";

const proxy = await startPinnedEgressProxy();
const server = createHttpAdmissionServer(
  {
    proxyUrl: proxy.url,
    scan: scanResponsive,
    acceptTarget: assertPublicUrl,
    allowResource: async (url) =>
      resolvePublicTarget(url).then(
        () => true,
        () => false,
      ),
    reports: new ReportStore(),
    createId: randomUUID,
    now: Date.now,
  },
  httpAdmissionConfig(),
);

const port = Number(process.env.PORT ?? 8080);
server.listen(port, "0.0.0.0", () => console.log(`WidthWatch API listening on ${port}`));

let closing = false;
const cleanup = () => {
  if (closing) return;
  closing = true;
  server.close(() => void proxy.close().finally(() => process.exit(0)));
};
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
