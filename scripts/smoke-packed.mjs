import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedVersion = JSON.parse(await readFile(join(root, "packages/widthwatch/package.json"), "utf8")).version;
const temporary = await mkdtemp(join(tmpdir(), "widthwatch-pack-"));
const project = join(temporary, "consumer");

try {
  const packed = run("npm", ["pack", "--workspace", "widthwatch", "--json", "--pack-destination", temporary], root);
  const [{ filename }] = JSON.parse(packed.stdout);
  await writeFile(join(temporary, "package.json"), JSON.stringify({ private: true }), "utf8");
  await mkdir(project);
  await writeFile(join(project, "package.json"), JSON.stringify({ private: true, type: "module" }), "utf8");
  run("npm", ["install", join(temporary, filename), "--ignore-scripts", "--no-audit", "--no-fund"], project);
  const cli = join(project, "node_modules/.bin/widthwatch");
  assert.equal(run(cli, ["--version"], project).stdout.trim(), expectedVersion);
  run(cli, ["init"], project);
  assert.match(await readFile(join(project, "widthwatch.config.ts"), "utf8"), /defineConfig/);
  assert.match(await readFile(join(project, ".github/workflows/widthwatch.yml"), "utf8"), /WidthWatch/);
  const loaded = run(process.execPath, ["-e", "import('./widthwatch.config.ts').then(({default:c})=>console.log(c.version))"], project);
  assert.equal(loaded.stdout.trim(), "1");
  console.log("Packed package installs, executes and initializes a clean consumer project.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr}`);
  return result;
}
