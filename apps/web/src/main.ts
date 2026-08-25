import "./styles.css";

const commands = document.querySelectorAll<HTMLButtonElement>("[data-copy]");
for (const command of commands) {
  command.addEventListener("click", async () => {
    const label = command.querySelector("span");
    try {
      await copyText(command.dataset.copy ?? "");
      if (label) label.textContent = "Copied";
    } catch {
      if (label) label.textContent = "Select text";
      command.querySelector("code")?.setAttribute("data-copy-failed", "true");
    }
    window.setTimeout(() => {
      if (label) label.textContent = "Copy";
    }, 1400);
  });
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Clipboard access is unavailable.");
}

const navToggle = document.querySelector<HTMLButtonElement>("#navToggle");
const primaryNav = document.querySelector<HTMLElement>("#primaryNav");
const closeNavigation = (returnFocus = false) => {
  navToggle?.setAttribute("aria-expanded", "false");
  primaryNav?.removeAttribute("data-open");
  if (returnFocus) navToggle?.focus();
};
navToggle?.addEventListener("click", () => {
  const expanded = navToggle.getAttribute("aria-expanded") === "true";
  navToggle.setAttribute("aria-expanded", String(!expanded));
  primaryNav?.toggleAttribute("data-open", !expanded);
  if (!expanded) primaryNav?.querySelector<HTMLAnchorElement>("a")?.focus();
});
primaryNav?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => closeNavigation());
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && navToggle?.getAttribute("aria-expanded") === "true") closeNavigation(true);
});
document.addEventListener("pointerdown", (event) => {
  const target = event.target as Node;
  if (navToggle?.getAttribute("aria-expanded") === "true" && !navToggle.contains(target) && !primaryNav?.contains(target)) closeNavigation();
});
matchMedia("(min-width: 901px)").addEventListener("change", (event) => {
  if (event.matches) closeNavigation();
});

const heroWidth = document.querySelector<HTMLElement>("#heroWidth");
if (heroWidth && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const started = performance.now();
  const animate = (now: number) => {
    heroWidth.textContent = String(Math.round(320 + ((Math.sin((now - started) / 1800) + 1) / 2) * 1120));
    requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
}

const form = document.querySelector<HTMLFormElement>("#scanForm");
const state = document.querySelector<HTMLElement>("#scanState");
const message = document.querySelector<HTMLElement>("#scanMessage");
const timeline = document.querySelector<HTMLElement>("#miniTimeline");
const reportLink = document.querySelector<HTMLAnchorElement>("#reportLink");
const submitButton = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
let activeScan: AbortController | undefined;
let scanRun = 0;
form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const run = ++scanRun;
  activeScan?.abort();
  const controller = new AbortController();
  activeScan = controller;
  const data = new FormData(form);
  const url = String(data.get("url") ?? "");
  if (!state || !message || !timeline) return;
  state.textContent = "● validating";
  message.textContent = "Checking URL and public network policy…";
  timeline.innerHTML = "";
  if (reportLink) reportLink.hidden = true;
  const apiUrl = import.meta.env.VITE_API_URL as string | undefined;
  const scanStarted = performance.now();
  if (submitButton) submitButton.disabled = true;
  try {
    if (apiUrl) {
      const response = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/scans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
      if (run !== scanRun) return;
      if (!response.ok)
        throw new Error(response.status === 429 ? "The public demo limit has been reached. Try the local package." : "The scan could not be accepted.");
      const job = (await response.json()) as { id: string; status: string };
      if (run !== scanRun) return;
      state.textContent = `● ${job.status}`;
      message.textContent =
        job.status === "complete" ? "Scan complete. Preparing the interactive report…" : `Scan ${job.id.slice(0, 8)} accepted. Waiting for the bounded worker…`;
      for (let attempt = 0; attempt < 45; attempt += 1) {
        const statusResponse = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/scans/${job.id}`, { signal: controller.signal });
        if (run !== scanRun) return;
        if (!statusResponse.ok) throw new Error("The scan result is no longer available.");
        const result = (await statusResponse.json()) as {
          status: string;
          error?: string;
          reportUrl?: string;
          report?: {
            probes?: Array<{ width: number; severities: string[] }>;
            frames: Array<{ width: number; issues: Array<{ severity: string }> }>;
            summary: { errors: number; warnings: number; sampledWidths: number };
          };
        };
        if (run !== scanRun) return;
        state.textContent = `● ${result.status}`;
        if (result.status === "failed") throw new Error(result.error ?? "The bounded scan could not complete.");
        if (result.status !== "complete" || !result.report) {
          message.textContent = `Scanning public page · ${Math.round((performance.now() - scanStarted) / 1_000)}s elapsed`;
          await new Promise((resolve) => window.setTimeout(resolve, 2_000));
          continue;
        }
        timeline.innerHTML = "";
        const capturedWidths = new Set(result.report.frames.map((frame) => frame.width));
        const markers =
          result.report.probes ?? result.report.frames.map((frame) => ({ width: frame.width, severities: frame.issues.map((issue) => issue.severity) }));
        for (const marker of markers) {
          const mark = document.createElement("i");
          mark.style.left = `${((marker.width - 320) / 1120) * 100}%`;
          if (!capturedWidths.has(marker.width)) mark.classList.add("probe");
          if (marker.severities.includes("error")) mark.classList.add("hot");
          timeline.append(mark);
        }
        message.textContent = `${result.report.summary.errors} errors and ${result.report.summary.warnings} warnings · ${result.report.summary.sampledWidths} probes · ${result.report.frames.length} captures.`;
        if (reportLink && result.reportUrl) {
          reportLink.href = `${apiUrl.replace(/\/$/, "")}${result.reportUrl}`;
          reportLink.hidden = false;
        }
        return;
      }
      throw new Error("The public scan exceeded its result window. Use the local package for larger pages.");
    }
    state.textContent = "● demo";
    message.textContent = "Previewing adaptive sampling. Hosted workers are connected at deploy time.";
    for (const [index, width] of [320, 480, 640, 768, 853, 1024, 1280, 1440].entries()) {
      await new Promise((resolve) => window.setTimeout(resolve, 110));
      const mark = document.createElement("i");
      mark.style.left = `${((width - 320) / 1120) * 100}%`;
      if (width === 853) mark.className = "hot";
      timeline.append(mark);
      message.textContent = `Sampling ${width}px · ${index + 1}/8`;
    }
    state.textContent = "● complete";
    message.textContent = "1 deterministic issue found near 853px.";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    state.textContent = "● rejected";
    message.textContent = error instanceof Error ? error.message : "Unable to start the scan.";
  } finally {
    if (run === scanRun) {
      activeScan = undefined;
      if (submitButton) submitButton.disabled = false;
    }
  }
});
