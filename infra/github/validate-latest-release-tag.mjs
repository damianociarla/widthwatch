#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const candidate = process.argv[2] ?? "";
const mainRef = process.argv[3] ?? "refs/remotes/origin/main";
const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parse(tag) {
  const match = stableTag.exec(tag);
  return match ? { tag, version: match.slice(1).map(BigInt) } : undefined;
}

const parsedCandidate = parse(candidate);
if (!parsedCandidate) {
  fail("Release requires a stable semantic-version tag such as v1.2.3.");
}

const result = spawnSync("git", ["tag", "--merged", mainRef, "--list", "v*"], {
  encoding: "utf8",
});
if (result.status !== 0) {
  fail(result.stderr.trim() || `Unable to list release tags reachable from ${mainRef}.`);
}

const reachable = result.stdout
  .split("\n")
  .map((tag) => parse(tag.trim()))
  .filter(Boolean);

if (!reachable.some(({ tag }) => tag === candidate)) {
  fail(`Release tag ${candidate} is not reachable from ${mainRef}.`);
}

reachable.sort((left, right) => {
  for (let index = 0; index < 3; index += 1) {
    if (left.version[index] < right.version[index]) return -1;
    if (left.version[index] > right.version[index]) return 1;
  }
  return 0;
});

const latest = reachable.at(-1)?.tag;
if (candidate !== latest) {
  fail(`Release refuses historical tag ${candidate}; latest stable tag on ${mainRef} is ${latest}.`);
}

console.log(`Release target verified as latest stable tag: ${candidate}.`);
