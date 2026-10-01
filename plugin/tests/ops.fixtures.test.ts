// The shared cases of spec/fixtures, also run by cli/tests against the CLI.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Index } from "../src/format/index-note";
import { splitLines } from "../src/format/lines";
import { Doc } from "../src/format/yaml";
import { FIXTURES, TRACKER_DIR, apply, cases, openTracker } from "./fixtures";
import { MemoryIO } from "./memory-io";

describe("fixtures", () => {
  const all = cases();

  it("are present", () => {
    expect(all.length).toBeGreaterThan(40);
  });

  it.each(all.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const io = MemoryIO.fromDisk(join(c.dir, "before"), TRACKER_DIR);
    const result = await apply(await openTracker(io), c.op);
    expect(io.snapshot(TRACKER_DIR)).toEqual(MemoryIO.fromDisk(join(c.dir, "after"), TRACKER_DIR).snapshot(TRACKER_DIR));
    const expected = c.op.expect ?? {};
    if (expected.id !== undefined) expect(result.id).toBe(expected.id);
    if (expected.problems !== undefined) expect(result.problems).toEqual(expected.problems);
    if (expected.issues !== undefined) {
      expect(result.issues!.map((i) => i.id)).toEqual(expected.issues.map((i) => i.id));
      expected.issues.forEach((want, n) => expect(result.issues![n]).toMatchObject(want));
    }
  });
});

describe("round trip", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".md")) files.push(p);
    }
  };
  walk(FIXTURES);

  it("parse then serialize is the identity on every fixture file", () => {
    expect(files.length).toBeGreaterThan(200);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(new Doc(text).text(), file).toBe(text);
      expect(new Index(text).text(), file).toBe(text);
      expect(splitLines(text).join(""), file).toBe(text);
    }
  });
});
