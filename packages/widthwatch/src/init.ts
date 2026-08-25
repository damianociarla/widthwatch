import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const configTemplate = `import { defineConfig } from "widthwatch";

export default defineConfig({
  version: 1,
  url: process.env.WIDTHWATCH_URL,
  output: "artifacts/widthwatch.html",
  json: "artifacts/widthwatch.json",
  baseline: process.env.CI ? ".widthwatch/baseline.json" : undefined,
  failOnRegression: Boolean(process.env.CI),
  scan: {
    mode: "visual",
    reloadPerWidth: true,
    minWidth: 320,
    maxWidth: 1440,
    maxSamples: 24,
    maxCaptureSamples: 8,
    hideSelectors: ["[data-live-clock]"],
  },
  compare: {
    maxDiffRatio: 0.002,
    includeDiffImages: true,
  },
});
`;

const workflowTemplate = `name: WidthWatch
on:
  workflow_call:
    inputs:
      preview_url: { description: "Deployed candidate URL", required: true, type: string }
  workflow_dispatch:
    inputs:
      preview_url: { description: "Deployed candidate URL", required: true, type: string }
permissions: { contents: read }
jobs:
  responsive-regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - name: Compare responsive baseline
        run: npx widthwatch --config widthwatch.config.ts
        env:
          WIDTHWATCH_URL: \${{ inputs.preview_url }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: widthwatch-report
          path: artifacts/
          if-no-files-found: error
`;

export async function initializeProject(cwd = process.cwd()): Promise<string[]> {
  const files = [
    { path: resolve(cwd, "widthwatch.config.ts"), content: configTemplate },
    { path: resolve(cwd, ".github/workflows/widthwatch.yml"), content: workflowTemplate },
  ];
  for (const file of files) {
    try {
      await access(file.path);
      throw new Error(`Refusing to overwrite existing file: ${file.path}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
    }
  }
  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, { encoding: "utf8", flag: "wx" });
  }
  return files.map((file) => file.path);
}
