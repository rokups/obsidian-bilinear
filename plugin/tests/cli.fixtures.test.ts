// The shared cases of spec/fixtures, through the command line and on disk.
// tests/ops.fixtures.test.ts runs the same cases against the plugin's ops.

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../cli/src/cli";
import { cases, type Op } from "./fixtures";

function argvFor(op: Op): string[] {
  const a = op.args ?? {};
  const clear = (v: string | null) => v ?? "none";
  switch (op.op) {
    case "create": {
      const argv = ["new", a.title];
      for (const key of ["status", "priority", "assignee", "due", "parent"]) if (a[key]) argv.push(`--${key}`, a[key]);
      for (const label of a.labels ?? []) argv.push("--label", label);
      if (a.top) argv.push("--top");
      return argv;
    }
    case "set":
      return ["set", a.id, ...Object.entries(a.props as Record<string, string | string[] | null>).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : (value ?? "")}`)];
    case "move":
      return ["move", a.id, ...(a.before ? ["--before", a.before] : a.after ? ["--after", a.after] : a.top ? ["--top"] : ["--bottom"])];
    case "archive":
    case "unarchive":
      return [op.op, ...(a.closed ? ["--closed"] : a.ids)];
    case "delete":
      return ["rm", a.id];
    case "comment":
      return ["--author", op.author ?? "rk", "comment", a.id, a.text];
    case "adopt":
      return ["adopt", a.id];
    case "label":
      return ["label", a.name, ...("color" in a ? ["--color", clear(a.color)] : [])];
    case "labels":
      return ["label", "--json"];
    case "state":
      return ["state", a.name, ...("icon" in a ? ["--icon", clear(a.icon)] : []), ...("color" in a ? ["--color", clear(a.color)] : [])];
    case "states":
      return ["state", "--json"];
    case "lint":
      return ["lint", "--json", ...(a.fix ? ["--fix"] : [])];
    case "list":
      return ["list", "--all", "--json"];
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

/** Every file under a folder, by relative path. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else out[child] = fs.readFileSync(join(dir, child), "utf8");
    }
  };
  walk("");
  return out;
}

/** With --fix, only problems that cannot be fixed keep the exit code at 2. */
const FIXABLE = ["duplicate-id", "line-format", "wrong-location", "title-mismatch", "next-low"];

describe("fixtures through the CLI", () => {
  it.each(cases().map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const root = fs.mkdtempSync(join(tmpdir(), "bilinear-fixture-"));
    try {
      const tracker = join(root, "vault", "Tracker");
      fs.mkdirSync(join(root, "vault", ".obsidian"), { recursive: true });
      fs.cpSync(join(c.dir, "before"), tracker, { recursive: true });
      let out = "";
      let err = "";
      const code = await main(["--tracker", tracker, ...argvFor(c.op)], {
        env: { BILINEAR_TODAY: c.op.today ?? "2026-01-01" },
        cwd: root,
        stdout: (s) => (out += s),
        stderr: (s) => (err += s),
      });
      expect(snapshot(tracker)).toEqual(snapshot(join(c.dir, "after")));
      const expected = c.op.expect ?? {};
      if (expected.id !== undefined) expect(out.trim()).toBe(expected.id);
      if (expected.problems !== undefined) {
        const problems = (JSON.parse(out).problems as Array<{ code: string; id: string | null }>).map((p) => `${p.code}:${p.id ?? "-"}`).sort();
        expect(problems).toEqual(expected.problems);
        const open = problems.map((p) => p.split(":")[0]).filter((code) => !(c.op.args.fix && FIXABLE.includes(code)));
        expect(code).toBe(open.length ? 2 : 0);
      }
      if (expected.labels !== undefined) expect(JSON.parse(out)).toEqual(expected.labels);
      if (expected.states !== undefined) expect(JSON.parse(out)).toEqual(expected.states);
      if (expected.issues !== undefined) {
        const issues = JSON.parse(out) as Array<Record<string, unknown>>;
        expect(issues.map((i) => i["id"])).toEqual(expected.issues.map((i) => i["id"]));
        expected.issues.forEach((want, n) => expect(issues[n]).toMatchObject(want));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
