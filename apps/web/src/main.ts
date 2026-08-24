import "./styles.css";

const commands = document.querySelectorAll<HTMLButtonElement>("[data-copy]");
for (const command of commands) {
  command.addEventListener("click", async () => {
    await navigator.clipboard.writeText(command.dataset.copy ?? "");
    const label = command.querySelector("span");
    if (label) label.textContent = "Copied";
    window.setTimeout(() => { if (label) label.textContent = "Copy"; }, 1400);
  });
}

const heroWidth = document.querySelector<HTMLElement>("#heroWidth");
if (heroWidth && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const started = performance.now();
  const animate = (now: number) => {
    heroWidth.textContent = String(Math.round(320 + ((Math.sin((now - started) / 1800) + 1) / 2) * 1120));
    requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
}

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting) entry.target.classList.add("visible");
}, { threshold: 0.18 });
document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));

const form = document.querySelector<HTMLFormElement>("#scanForm");
const state = document.querySelector<HTMLElement>("#scanState");
const message = document.querySelector<HTMLElement>("#scanMessage");
const timeline = document.querySelector<HTMLElement>("#miniTimeline");
const reportLink = document.querySelector<HTMLAnchorElement>("#reportLink");
form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const url = String(data.get("url") ?? "");
  if (!state || !message || !timeline) return;
  state.textContent = "● validating";
  message.textContent = "Checking URL and public network policy…";
  timeline.innerHTML = "";
  if (reportLink) reportLink.hidden = true;
  const apiUrl = import.meta.env.VITE_API_URL as string | undefined;
  const scanStarted = performance.now();
  try {
    if (apiUrl) {
      const response = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/scans`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
      if (!response.ok) throw new Error(response.status === 429 ? "The public demo limit has been reached. Try the local package." : "The scan could not be accepted.");
      const job = await response.json() as { id: string; status: string };
      state.textContent = `● ${job.status}`;
      message.textContent = job.status === "complete" ? "Scan complete. Preparing the interactive report…" : `Scan ${job.id.slice(0, 8)} accepted. Waiting for the bounded worker…`;
      for (let attempt = 0; attempt < 45; attempt += 1) {
        const statusResponse = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/scans/${job.id}`);
        if (!statusResponse.ok) throw new Error("The scan result is no longer available.");
        const result = await statusResponse.json() as { status: string; error?: string; reportUrl?: string; report?: { frames: Array<{ width: number; issues: Array<{ severity: string }> }>; summary: { errors: number; warnings: number } } };
        state.textContent = `● ${result.status}`;
        if (result.status === "failed") throw new Error(result.error ?? "The bounded scan could not complete.");
        if (result.status !== "complete" || !result.report) {
          message.textContent = `Scanning public page · ${Math.round((performance.now() - scanStarted) / 1_000)}s elapsed`;
          await new Promise((resolve) => window.setTimeout(resolve, 2_000));
          continue;
        }
        timeline.innerHTML = "";
        for (const frame of result.report.frames) {
          const mark = document.createElement("i");
          mark.style.left = `${(frame.width - 320) / 1120 * 100}%`;
          if (frame.issues.some((issue) => issue.severity === "error")) mark.className = "hot";
          timeline.append(mark);
        }
        message.textContent = `${result.report.summary.errors} errors and ${result.report.summary.warnings} warnings across ${result.report.frames.length} adaptive widths.`;
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
      mark.style.left = `${(width - 320) / 1120 * 100}%`;
      if (width === 853) mark.className = "hot";
      timeline.append(mark);
      message.textContent = `Sampling ${width}px · ${index + 1}/8`;
    }
    state.textContent = "● complete";
    message.textContent = "1 deterministic issue found near 853px.";
  } catch (error) {
    state.textContent = "● rejected";
    message.textContent = error instanceof Error ? error.message : "Unable to start the scan.";
  }
});
