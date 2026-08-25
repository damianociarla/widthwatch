import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { compareReports, generateHtmlReport, scanAtWidths, scanResponsive } from "../packages/widthwatch/dist/index.js";

const origin = "http://127.0.0.1:4174";
const preview = spawn(resolve("node_modules/.bin/vite"), ["preview", "--host", "127.0.0.1", "--port", "4174"], {
  cwd: resolve("apps/web"),
  stdio: "ignore",
});

try {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${origin}/widthwatch/proof-baseline.html`);
      if (response.ok) break;
    } catch {
      // The preview server is still starting.
    }
    if (attempt === 49) throw new Error("Vite preview did not become ready.");
    await wait(100);
  }
  const widths = [720, 742, 768, 811, 832];
  const options = { mode: "visual", viewportHeight: 720, reloadPerWidth: true, scrollSweep: false, settleMs: 0 };
  const baseline = await scanAtWidths(`${origin}/widthwatch/proof-baseline.html`, widths, options);
  const candidate = await scanAtWidths(`${origin}/widthwatch/proof-candidate.html`, widths, options);
  baseline.url = "https://damianociarla.github.io/widthwatch/proof-baseline.html";
  candidate.url = "https://damianociarla.github.io/widthwatch/proof-candidate.html";
  const comparison = compareReports(baseline, candidate, { maxDiffRatio: 0.001, includeDiffImages: true });
  if (comparison.passed || !comparison.regressionRanges?.some((range) => range.from === 742 && range.to === 811)) {
    throw new Error("The proof fixture did not produce the expected 742–811px regression.");
  }
  const html = generateHtmlReport(comparison);
  const probeWidths = [640, 700, 720, 742, 755, 768, 790, 811, 820, 832, 900, 960];
  const captureWidths = [640, 742, 832, 960];
  const twoPassOptions = { mode: "visual", exactWidths: captureWidths, probeWidths, viewportHeight: 720, reloadPerWidth: true, scrollSweep: false, settleMs: 0 };
  const twoPassBaseline = await scanResponsive(`${origin}/widthwatch/proof-baseline.html`, twoPassOptions);
  const twoPassCandidate = await scanResponsive(`${origin}/widthwatch/proof-candidate.html`, twoPassOptions);
  twoPassBaseline.url = "https://damianociarla.github.io/widthwatch/proof-baseline.html";
  twoPassCandidate.url = "https://damianociarla.github.io/widthwatch/proof-candidate.html";
  const twoPassComparison = compareReports(twoPassBaseline, twoPassCandidate, { maxDiffRatio: 0.001, includeDiffImages: true });
  if (twoPassComparison.passed || twoPassCandidate.probes?.length !== 12 || twoPassCandidate.frames.length !== 4 || !twoPassComparison.regressions.some((issue) => issue.width === 768 && issue.evidence === "discovery")) {
    throw new Error("The two-pass proof did not preserve its discovery-only regression across a 12-probe / 4-capture schedule.");
  }
  const twoPassHtml = generateHtmlReport(twoPassComparison);
  await mkdir(resolve("apps/web/public"), { recursive: true });
  await mkdir(resolve("apps/web/dist"), { recursive: true });
  await Promise.all([
    writeFile(resolve("apps/web/public/proof.html"), html, "utf8"),
    writeFile(resolve("apps/web/dist/proof.html"), html, "utf8"),
    writeFile(resolve("apps/web/public/proof-two-pass.html"), twoPassHtml, "utf8"),
    writeFile(resolve("apps/web/dist/proof-two-pass.html"), twoPassHtml, "utf8"),
  ]);
  console.log(`Generated exact proof and two-pass proof with ${twoPassCandidate.probes.length} probes, ${twoPassCandidate.frames.length} captures and preserved discovery-only findings.`);
} finally {
  preview.kill("SIGTERM");
}
