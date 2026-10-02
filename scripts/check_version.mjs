#!/usr/bin/env node
// Check that the version is the same everywhere, and equals the one given.
//
//   node scripts/check_version.mjs           all version numbers agree
//   node scripts/check_version.mjs 0.2.0     ... and are 0.2.0 (used by the release workflow)

import { readFileSync } from "node:fs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const manifest = read("manifest.json");
const wanted = process.argv[2] ?? manifest.version;
const problems = ["manifest.json", "plugin/package.json", "cli/package.json"]
  .map((path) => [path, read(path).version])
  .filter(([, version]) => version !== wanted)
  .map(([path, version]) => `${path} has ${version}, expected ${wanted}`);
if (read("versions.json")[wanted] !== manifest.minAppVersion) problems.push(`versions.json should map ${wanted} to ${manifest.minAppVersion}`);
for (const problem of problems) console.error(problem);
process.exit(problems.length ? 1 : 0);
