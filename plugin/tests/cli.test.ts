// The command line: what the shared fixtures do not cover.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { NodeIO } from "../../cli/src/node-io";
import { withFileLock } from "../src/ops/lock-file";
import { sandbox } from "./cli";

const CLEAN = { code: 0, out: "no problems found\n" };
const PLUGIN_LOCK = '{"by": "plugin", "pid": 1, "token": "abc"}\n';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("init", () => {
  const s = sandbox();

  it("lays out the tracker", async () => {
    expect(fs.statSync(join(s().dir, "issues")).isDirectory()).toBe(true);
    expect(fs.statSync(join(s().dir, "archive")).isDirectory()).toBe(true);
    const text = s().read(s().index);
    expect(text.startsWith("---\nbilinear: tracker\nprefix: BL\nnext: 1\n")).toBe(true);
    expect(text).toContain("## Issues\n\n## Archive\n");
    expect(await s().run("lint")).toMatchObject(CLEAN);
  });

  it("refuses an existing tracker and a bad prefix", async () => {
    expect(await s().code("init", s().dir, "--prefix", "BL")).toBe(1);
    expect(await s().code("init", join(s().vault, "X"), "--prefix", "bl")).toBe(1);
    expect(await s().code("init", join(s().vault, "X"))).toBe(1);
    expect(fs.existsSync(join(s().vault, "X"))).toBe(false);
  });

  it("takes a relative folder", async () => {
    s().cwd = s().vault;
    expect(await s().ok("init", "Other", "--prefix", "OT")).toBe(`${join("Other", "Other.md")}\n`);
    expect(await s().ok("--tracker", "Other", "new", "A")).toBe("OT-1\n");
  });
});

describe("finding the tracker", () => {
  const s = sandbox();

  it("searches upward, then the environment, then the flag", async () => {
    await s().ok("new", "One");
    s().cwd = join(s().dir, "archive");
    expect(await s().ids()).toEqual(["BL-1"]);
    s().cwd = s().vault;
    expect(await s().code("list")).toBe(1);
    expect(await s().ids("--tracker", s().dir)).toEqual(["BL-1"]);
    expect(await s().ids("--tracker", s().index)).toEqual(["BL-1"]);
    expect(await s().ids("--tracker", join("Trackers", "Bilinear"))).toEqual(["BL-1"]);
    s().env["BILINEAR_TRACKER"] = s().dir;
    expect(await s().ids()).toEqual(["BL-1"]);
    expect(await s().code("--tracker", s().index, "list", "--json")).toBe(0);
    expect(await s().code("--tracker", s().vault, "list")).toBe(1);
    expect(await s().code("--tracker", s().note("BL-1"), "list")).toBe(1);
  });

  it("knows the index note by its frontmatter, not its name", async () => {
    fs.renameSync(s().index, join(s().dir, "Board.md"));
    expect(await s().ok("new", "One")).toBe("BL-1\n");
  });
});

describe("ID allocation", () => {
  const s = sandbox();
  const stray = "---\ntitle: stray\n---\n";

  it("counts up", async () => {
    expect([await s().ok("new", "A"), await s().ok("new", "B")]).toEqual(["BL-1\n", "BL-2\n"]);
    expect(s().read(s().index)).toContain("next: 3\n");
  });

  it("skips numbers seen in the index, the folder and the archive", async () => {
    await s().ok("new", "A");
    fs.writeFileSync(s().note("BL-7"), stray);
    expect(await s().ok("new", "B")).toBe("BL-8\n");
    fs.writeFileSync(s().note("BL-12", "archive"), stray);
    expect(await s().ok("new", "C")).toBe("BL-13\n");
    s().edit(s().index, "next: 14", "next: 2");
    s().edit(s().index, "- [[BL-13]] C", "- [[BL-13]] C\n- [[BL-30]] line without a note");
    expect(await s().ok("new", "D")).toBe("BL-31\n");
    expect(s().read(s().index)).toContain("next: 32\n");
    expect(s().read(s().note("BL-7"))).toBe(stray);
  });

  it("tries the next number when another writer takes one after it looked", async () => {
    const real = NodeIO.prototype.listNotes;
    let raced = false;
    const spy = vi.spyOn(NodeIO.prototype, "listNotes").mockImplementation(async function (this: NodeIO, folder: string) {
      const found = await real.call(this, folder);
      if (!raced) {
        raced = true;
        fs.writeFileSync(s().note("BL-1"), "theirs");
        fs.writeFileSync(s().note("BL-2", "archive"), "theirs");
      }
      return found;
    });
    try {
      expect(await s().ok("new", "Mine")).toBe("BL-3\n");
    } finally {
      spy.mockRestore();
    }
    expect(s().read(s().note("BL-1"))).toBe("theirs");
    expect(s().read(s().index)).toContain("next: 4\n");
  });

  it("counts numbers in the tracker folder itself", async () => {
    fs.writeFileSync(join(s().dir, "BL-40.md"), "---\ntitle: old layout\n---\n");
    expect(await s().ok("new", "A")).toBe("BL-41\n");
    expect(fs.existsSync(s().note("BL-41"))).toBe(true);
  });

  it("makes issues/ when it is missing", async () => {
    fs.rmdirSync(join(s().dir, "issues"));
    expect(await s().ok("new", "A")).toBe("BL-1\n");
    expect(fs.existsSync(s().note("BL-1"))).toBe(true);
  });

  it("ignores other prefixes", async () => {
    fs.writeFileSync(s().note("XY-50"), "---\ntitle: other\n---\n");
    expect(await s().ok("new", "A")).toBe("BL-1\n");
  });
});

describe("writers that take no lock", () => {
  const s = sandbox();

  /** Write a file from another thread after a delay, while this thread is busy in the CLI. */
  async function writeLater(path: string, text: string, delay: number): Promise<void> {
    const worker = new Worker(
      `const { parentPort } = require("node:worker_threads");
       parentPort.on("message", (m) => setTimeout(() => { require("node:fs").writeFileSync(m.path, m.text); process.exit(0); }, m.delay));
       parentPort.postMessage("ready");`,
      { eval: true },
    );
    await new Promise((resolve) => worker.once("message", resolve));
    worker.postMessage({ path, text, delay });
  }

  it("redoes the operation on fresh content when the file changed", async () => {
    await s().ok("new", "A");
    let hit = false;
    NodeIO.beforeWrite = (path) => {
      // The CLI's paths have forward slashes on every platform.
      if (resolve(path) === s().index && !hit) {
        hit = true;
        s().edit(path, "\n## Issues\n", "\nEdited meanwhile.\n\n## Issues\n");
      }
    };
    expect(await s().ok("new", "B")).toBe("BL-2\n");
    const text = s().read(s().index);
    expect(text).toContain("Edited meanwhile.");
    expect(text).toContain("- [[BL-1]] A\n- [[BL-2]] B\n");
    expect(text).toContain("next: 3\n");
  });

  it("gives up with exit code 3 when the file keeps changing", async () => {
    await s().ok("new", "A");
    const before = s().read(s().note("BL-1"));
    let count = 0;
    NodeIO.beforeWrite = (path) => {
      count++;
      fs.appendFileSync(path, "x");
    };
    const r = await s().run("set", "BL-1", "status=todo");
    expect(r.code).toBe(3);
    expect(count).toBe(3);
    expect(r.err).toContain("kept changing");
    expect(s().read(s().note("BL-1"))).toBe(`${before}xxx`);
    NodeIO.beforeWrite = null;
    expect(s().entries()).toEqual(["Bilinear.md", "issues/BL-1.md"]);
  });

  it("exits with code 3 when a note vanishes", async () => {
    await s().ok("new", "A");
    const before = s().read(s().index);
    for (const argv of [
      ["set", "BL-1", "title=B"],
      ["comment", "BL-1", "x"],
    ]) {
      const text = s().read(s().note("BL-1"));
      NodeIO.beforeWrite = (path) => fs.unlinkSync(path);
      const r = await s().run(...argv);
      NodeIO.beforeWrite = null;
      expect(r).toMatchObject({ code: 3, out: "" });
      expect(r.err).toContain("BL-1.md was moved or deleted while the command ran");
      expect(s().read(s().index)).toBe(before);
      expect(s().entries()).toEqual(["Bilinear.md"]);
      fs.writeFileSync(s().note("BL-1"), text);
    }
    await s().ok("set", "BL-1", "title=B");
  });

  it("reads a note again that it caught empty in the middle of a write", async () => {
    await s().ok("new", "A");
    const text = s().read(s().note("BL-1"));
    fs.writeFileSync(s().note("BL-1"), "");
    await writeLater(s().note("BL-1"), text, 20);
    await s().ok("set", "BL-1", "status=todo");
    expect(s().read(s().note("BL-1"))).toBe(text.replace("status: backlog", "status: todo"));
  });

  it("reads the index again that it caught empty in the middle of a write", async () => {
    await s().ok("new", "A");
    const text = s().read(s().index);
    fs.writeFileSync(s().index, "");
    await writeLater(s().index, text, 20);
    expect(await s().ids()).toEqual(["BL-1"]);
  });

  it("leaves no temporary files behind", async () => {
    await s().ok("new", "A");
    await s().ok("set", "BL-1", "status=todo");
    expect(s().entries()).toEqual(["Bilinear.md", "issues/BL-1.md"]);
  });

  it("keeps the file's permissions", async () => {
    await s().ok("new", "A");
    fs.chmodSync(s().note("BL-1"), 0o640);
    await s().ok("set", "BL-1", "status=todo");
    if (process.platform !== "win32") expect(fs.statSync(s().note("BL-1")).mode & 0o777).toBe(0o640);
  });
});

describe("the lock", () => {
  const s = sandbox();
  const held = <T>(fn: () => Promise<T>) => withFileLock(fs, s().dir, fn);

  beforeEach(async () => {
    await s().ok("new", "A");
    s().env["BILINEAR_LOCK_TIMEOUT"] = "0.2";
  });

  it("makes writers wait, and give up with exit code 3", async () => {
    const before = s().read(s().index);
    await held(async () => {
      for (const argv of [["new", "B"], ["set", "BL-1", "status=todo"], ["comment", "BL-1", "x"], ["move", "BL-1", "--top"], ["archive", "BL-1"], ["rm", "BL-1"], ["lint", "--fix"]]) {
        const r = await s().run(...argv);
        expect(r.code, argv.join(" ")).toBe(3);
        expect(r.err).toContain("locked by another bilinear process or by Obsidian; gave up after 0.2s");
      }
      expect(s().read(s().index)).toBe(before);
      expect(s().entries()).toEqual([".bilinear.lock", "Bilinear.md", "issues/BL-1.md"]);
    });
    expect(await s().ok("new", "B")).toBe("BL-2\n");
  });

  it("makes readers wait too", async () => {
    await held(async () => {
      for (const argv of [["list"], ["show", "BL-1"], ["lint"], ["label"], ["state"]]) {
        expect(await s().run(...argv), argv.join(" ")).toMatchObject({ code: 3, out: "" });
      }
    });
    expect(await s().ids()).toEqual(["BL-1"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("lets readers work in a folder that cannot be written to", async () => {
    fs.chmodSync(s().dir, 0o555);
    expect(await s().ids()).toEqual(["BL-1"]);
    expect(await s().ok("show", "BL-1")).toContain("BL-1  A");
    expect(await s().code("lint")).toBe(0);
    const r = await s().run("set", "BL-1", "title=B");
    expect(r.code).toBe(1);
    expect(r.err).toContain("permission denied");
  });

  it("is released after a command that failed", async () => {
    expect(await s().code("set", "BL-1", "status=nope")).toBe(1);
    expect(await s().code("set", "BL-99", "status=todo")).toBe(1);
    await s().ok("set", "BL-1", "status=todo");
  });

  it("lets a waiting writer go ahead once it is free", async () => {
    s().env["BILINEAR_LOCK_TIMEOUT"] = "5";
    const holding = held(() => sleep(300));
    await sleep(20);
    expect(await s().ok("new", "B")).toBe("BL-2\n");
    await holding;
  });

  it("leaves no lock file in the vault", async () => {
    await s().ok("new", "B");
    await s().ok("list");
    expect(await s().code("set", "BL-1", "status=nope")).toBe(1);
    expect(s().entries()).toEqual(["Bilinear.md", "issues/BL-1.md", "issues/BL-2.md"]);
  });

  it("waits for a lock file that its holder keeps touching", async () => {
    s().env["BILINEAR_LOCK_TIMEOUT"] = "5";
    NodeIO.lockTimes = { ...NodeIO.lockTimes, stale: 300 };
    fs.writeFileSync(s().lockFile, PLUGIN_LOCK);
    let beats = 0;
    const beat = setInterval(() => {
      if (++beats < 6) fs.utimesSync(s().lockFile, new Date(), new Date());
      else {
        clearInterval(beat);
        fs.unlinkSync(s().lockFile);
      }
    }, 100);
    expect(await s().ok("new", "B")).toBe("BL-2\n");
    expect(beats).toBe(6);
    expect(fs.existsSync(s().lockFile)).toBe(false);
  });

  it("takes over a lock file that was abandoned", async () => {
    s().env["BILINEAR_LOCK_TIMEOUT"] = "5";
    NodeIO.lockTimes = { ...NodeIO.lockTimes, stale: 300 };
    fs.writeFileSync(s().lockFile, PLUGIN_LOCK);
    const started = Date.now();
    expect(await s().ok("new", "B")).toBe("BL-2\n");
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(fs.existsSync(s().lockFile)).toBe(false);
  });

  it("does not take over a fresh lock file", async () => {
    fs.writeFileSync(s().lockFile, PLUGIN_LOCK);
    expect(await s().code("new", "B")).toBe(3);
    expect(s().read(s().lockFile)).toBe(PLUGIN_LOCK);
  });
});

describe("several processes at once", () => {
  const s = sandbox();
  const BIN = join(__dirname, "..", "..", "cli", "dist", "bilinear.js");

  it.skipIf(!fs.existsSync(BIN))(
    "lose nothing",
    async () => {
      await s().ok("new", "A");
      const procs = 6;
      const per = 4;
      const env = { ...process.env, BILINEAR_LOCK_TIMEOUT: "60", BILINEAR_USER: "w", BILINEAR_TODAY: "2026-10-01" };
      const cli = (...argv: string[]) => promisify(execFile)(process.execPath, [BIN, "--tracker", s().dir, ...argv], { env });
      const failures: string[] = [];
      await Promise.all(
        Array.from({ length: procs }, async (_, n) => {
          for (let i = 0; i < per; i++) {
            for (const argv of [
              ["new", `w${n}-${i}`],
              ["comment", "BL-1", `w${n}-${i}`],
              ["set", "BL-1", `k${n}x${i}=1`],
            ]) {
              await cli(...argv).catch((e) => failures.push(`${argv.join(" ")}: ${e.stderr}`));
            }
          }
        }),
      );
      expect(failures).toEqual([]);
      const total = procs * per;
      const issues = JSON.parse(await s().ok("list", "--json")) as Array<{ id: string; title: string }>;
      expect(issues.length).toBe(total + 1);
      expect(new Set(issues.map((i) => i.id)).size).toBe(total + 1);
      const titles = Array.from({ length: procs }, (_, n) => Array.from({ length: per }, (_, i) => `w${n}-${i}`)).flat();
      expect(issues.slice(1).map((i) => i.title).sort()).toEqual(titles.sort());
      const note = s().read(s().note("BL-1"));
      expect(note.split("- 2026-10-01 w: w").length - 1).toBe(total);
      expect(note.split("\n").filter((line) => line.startsWith("k")).length).toBe(total);
      expect(s().read(s().index)).toContain(`next: ${total + 2}\n`);
      expect(await s().run("lint")).toMatchObject(CLEAN);
      expect(s().entries().length).toBe(total + 2);
    },
    60_000,
  );
});

describe("a tracker from before issues/ existed", () => {
  const s = sandbox();

  beforeEach(async () => {
    await s().ok("new", "A");
    await s().ok("new", "B", "--status", "done");
    for (const id of ["BL-1", "BL-2"]) fs.renameSync(s().note(id), join(s().dir, `${id}.md`));
    fs.rmdirSync(join(s().dir, "issues"));
  });

  it("works in place", async () => {
    expect(await s().ids()).toEqual(["BL-1", "BL-2"]);
    expect(JSON.parse(await s().ok("list", "--json"))[0].missing).toBe(false);
    await s().ok("set", "BL-1", "status=todo");
    await s().ok("comment", "BL-1", "still here");
    expect(s().read(join(s().dir, "BL-1.md"))).toContain("status: todo");
    expect(s().entries()).toEqual(["BL-1.md", "BL-2.md", "Bilinear.md"]);
  });

  it("has its notes moved into issues/ by lint --fix", async () => {
    const r = await s().run("lint");
    expect(r.code).toBe(2);
    expect(r.out.split("[wrong-location]").length - 1).toBe(2);
    expect(r.out).toContain("the note is in the tracker folder, not issues/");
    expect(await s().code("lint", "--fix")).toBe(0);
    expect(s().entries()).toEqual(["Bilinear.md", "issues/BL-1.md", "issues/BL-2.md"]);
    expect(await s().run("lint")).toMatchObject(CLEAN);
  });

  it("uses the new layout for archive, unarchive and new", async () => {
    await s().ok("archive", "--closed");
    await s().ok("unarchive", "BL-2");
    expect(await s().ok("new", "C")).toBe("BL-3\n");
    expect(s().entries()).toEqual(["BL-1.md", "Bilinear.md", "issues/BL-2.md", "issues/BL-3.md"]);
  });

  it("reports duplicates, and rm takes every copy", async () => {
    fs.writeFileSync(s().note("BL-1", "archive"), "copy");
    expect((await s().run("lint")).out).toContain("note exists in more than one place (archive/, the tracker folder) [note-duplicate]");
    expect(await s().code("archive", "BL-1")).toBe(1);
    await s().ok("rm", "BL-1");
    expect(s().entries()).toEqual(["BL-2.md", "Bilinear.md"]);
    expect(fs.readdirSync(join(s().vault, ".trash")).sort()).toEqual(["BL-1 2.md", "BL-1.md"]);
  });
});

describe("label", () => {
  const s = sandbox();

  it("adds, colours, lists and clears", async () => {
    expect(await s().ok("label")).toBe("");
    await s().ok("label", "bug", "--color", "RED");
    await s().ok("label", "ui");
    await s().ok("label", "perf", "--color", "#0af");
    const text = s().read(s().index);
    expect(text).toContain("labels: [bug, ui, perf]\n");
    expect(text).toContain("label-colors: [bug=red, perf=#0af]\n");
    expect(await s().ok("label")).toBe("bug   red\nui\nperf  #0af\n");
    expect(JSON.parse(await s().ok("label", "--json"))).toEqual([
      { name: "bug", color: "red" },
      { name: "ui", color: null },
      { name: "perf", color: "#0af" },
    ]);
    await s().ok("label", "bug", "--color", "none");
    await s().ok("label", "perf", "--color", "auto");
    expect(s().read(s().index)).not.toContain("label-colors");
    expect(s().read(s().index)).toContain("labels: [bug, ui, perf]\n");
    expect(await s().run("lint")).toMatchObject(CLEAN);
  });

  it("refuses bad colours", async () => {
    const before = s().read(s().index);
    for (const argv of [["bug", "--color", "mauve"], ["bug", "--color", "#12"], ["  ", "--color", "red"], ["--color", "red"]]) {
      expect(await s().code("label", ...argv), argv.join(" ")).toBe(1);
    }
    expect(s().read(s().index)).toBe(before);
  });

  it("stops the warning once the label is known", async () => {
    expect((await s().run("new", "A", "--label", "bug")).err).toContain("label 'bug'");
    await s().ok("label", "bug", "--color", "red");
    expect((await s().run("new", "B", "--label", "bug")).err).toBe("");
  });
});

describe("state", () => {
  const s = sandbox();

  it("sets, lists and clears", async () => {
    await s().ok("state", "in-review", "--icon", "lucide-eye", "--color", "Purple");
    await s().ok("state", "done", "--color", "#2da44e");
    await s().ok("state", "backlog", "--icon", "dashed");
    const text = s().read(s().index);
    expect(text).toContain("state-icons: [in-review=eye, backlog=dashed]\n");
    expect(text).toContain("state-colors: [in-review=purple, done=#2da44e]\n");
    expect(await s().ok("state")).toBe(
      "triage       (triage)\nbacklog      icon=dashed\ntodo\nin-progress\nin-review    icon=eye  color=purple\ndone         color=#2da44e  (closed)\ncanceled     (closed)\n",
    );
    const rows = JSON.parse(await s().ok("state", "--json"));
    expect(rows[0]).toEqual({ name: "triage", icon: null, color: null, closed: false, triage: true });
    expect(rows[4]).toEqual({ name: "in-review", icon: "eye", color: "purple", closed: false, triage: false });
    await s().ok("state", "in-review", "--icon", "none");
    await s().ok("state", "in-review", "--color", "auto");
    await s().ok("state", "done", "--color", "none");
    await s().ok("state", "backlog", "--icon", "none");
    expect(s().read(s().index)).not.toContain("state-");
    expect(await s().run("lint")).toMatchObject(CLEAN);
  });

  it("refuses unknown states and bad values", async () => {
    const before = s().read(s().index);
    for (const argv of [["nope", "--icon", "check"], ["done"], ["done", "--icon", "two words"], ["done", "--color", "mauve"], ["--icon", "check"]]) {
      expect(await s().code("state", ...argv), argv.join(" ")).toBe(1);
    }
    expect(s().read(s().index)).toBe(before);
  });

  it("keeps new issues out of the triage state unless it is asked for", async () => {
    expect(s().read(s().index)).toContain("states: [triage, backlog, todo, in-progress, in-review, done, canceled]\nclosed-states: [done, canceled]\ntriage-state: triage\n");
    await s().ok("new", "A");
    await s().ok("new", "B", "--status", "triage");
    expect(await s().ok("list")).toBe("BL-1  backlog  none  A\nBL-2  triage   none  B\n");
    fs.unlinkSync(s().note("BL-1"));
    s().edit(s().index, "- [[BL-1]] A", "- [[BL-1]] A\n- [[BL-9]] gone");
    expect(await s().run("lint")).toMatchObject({ code: 2 });
  });

  it("makes a state the triage state, adding it if the tracker lacks it", async () => {
    s().edit(s().index, "states: [triage, backlog,", "states: [backlog,");
    s().edit(s().index, "triage-state: triage\n", "");
    expect(await s().ok("state")).not.toContain("triage");
    await s().ok("new", "A");

    await s().ok("state", "inbox", "--triage", "--color", "orange");
    const text = s().read(s().index);
    expect(text).toContain("states: [inbox, backlog, todo, in-progress, in-review, done, canceled]\n");
    expect(text).toContain("triage-state: inbox\n");
    expect(text).toContain("state-colors: [inbox=orange]\n");
    expect(await s().ok("state")).toContain("inbox        color=orange  (triage)\n");
    expect(await s().ok("new", "B")).toBe("BL-2\n");
    expect(JSON.parse(await s().ok("show", "BL-2", "--json")).status).toBe("backlog");

    // An existing open state can take over; a closed one cannot.
    await s().ok("state", "todo", "--triage");
    expect(s().read(s().index)).toContain("triage-state: todo\n");
    expect(s().read(s().index)).toContain("states: [inbox, backlog, todo,");
    const before = s().read(s().index);
    for (const argv of [["done", "--triage"], ["--triage"], ["  ", "--triage"]]) expect(await s().code("state", ...argv), argv.join(" ")).toBe(1);
    expect(s().read(s().index)).toBe(before);
    expect(await s().run("lint")).toMatchObject(CLEAN);
  });

  it("has a triage state that is no open state reported by lint", async () => {
    s().edit(s().index, "triage-state: triage", "triage-state: done");
    let r = await s().run("lint");
    expect(r.code).toBe(2);
    expect(r.out).toContain("triage-state 'done' is not one of the open states [triage-state-invalid]");
    s().edit(s().index, "triage-state: done", "triage-state: nope");
    r = await s().run("lint");
    expect(r.out).toContain("triage-state 'nope' is not one of the open states [triage-state-invalid]");
    // An unusable triage state is no triage state: new issues take the first state.
    await s().ok("new", "A");
    expect(await s().ok("list")).toBe("BL-1  triage  none  A\n");
  });

  it("has unusable entries reported by lint", async () => {
    s().edit(s().index, "labels: []", "labels: []\nstate-icons: [gone=check]\nstate-colors: [done=mauve]");
    const r = await s().run("lint");
    expect(r.code).toBe(2);
    expect(r.out).toContain("state-icons names 'gone', which is not one of the states [state-style-invalid]");
    expect(r.out).toContain("state-colors entry 'done=mauve' is not of the form name=color [state-style-invalid]");
  });
});

describe("for LLM agents", () => {
  const s = sandbox();
  const skill = (...under: string[]) => join(...under, "bilinear", "SKILL.md");

  it("installs the skill for the project, the user or a named skills folder", async () => {
    s().cwd = s().root;
    s().env["HOME"] = join(s().root, "home");
    const project = skill(s().root, ".agents", "skills");
    expect(await s().ok("skill")).toBe(`created ${project}\n`);
    expect(await s().ok("skill")).toBe(`unchanged ${project}\n`);
    fs.writeFileSync(project, "an older version");
    expect(await s().ok("skill")).toBe(`updated ${project}\n`);
    expect(await s().ok("skill", "--global")).toBe(`created ${skill(s().root, "home", ".agents", "skills")}\n`);
    expect(await s().ok("skill", "--dir", join(".claude", "skills"))).toBe(`created ${skill(s().root, ".claude", "skills")}\n`);
    expect(await s().code("skill", "--global", "--dir", "x")).toBe(1);
    expect(await s().ok("skill", "--print")).toBe(s().read(project));
  });

  it("writes a skill whose frontmatter is valid and whose commands exist", async () => {
    const text = await s().ok("skill", "--print");
    const frontmatter = parse(text.split("---\n")[1]) as { name: string; description: string };
    expect(frontmatter.name).toBe("bilinear");
    expect(frontmatter.description.length).toBeGreaterThan(80);
    expect(frontmatter.description.length).toBeLessThan(1024);
    const commands = [...text.matchAll(/^- `([a-z]+) ?[^`]*`[^:]*: /gm)].map((m) => m[1]);
    expect(commands.length).toBeGreaterThan(8);
    for (const command of commands) expect(await s().code(command, "--help"), command).toBe(0);
  });

  it("writes a skill that requires the whole life of an issue to be tracked", async () => {
    const text = await s().ok("skill", "--print");
    expect(text).toContain("## Tracking work");
    for (const step of ["Before starting", "On starting", "While working", "When the work waits for review", "On finishing", "On stopping before the work is finished"]) {
      expect(text, step).toContain(`**${step}**`);
    }
    expect(text).toContain("Do not start work\n   that has no issue.");
    expect(text).toContain("`set <ID> assignee=<your name> status=<state>`");
    expect(text).toContain("`--author <your name> comment <ID> \"text\"`");
    expect(text).toContain("is the name of the agent you are");
    expect(text).not.toContain(s().dir);
    expect(text).not.toContain("Trackers/Bilinear");
  });

  const block = (path: string, where = "Its path, from the root of the repository:") =>
    `<!-- bilinear:start -->\n## Issue tracking\n\nWork on this project is tracked in a Bilinear issue tracker. ${where}\n\n    ${path}\n\n` +
    "Track every piece of work there, from before it starts until it is finished,\nas the `bilinear` skill says. If the skill is not installed, read it with\n" +
    "`npx --yes obsidian-bilinear skill --print`.\n<!-- bilinear:end -->\n";

  it("adds instructions that name the tracker, and refreshes them in place", async () => {
    s().cwd = s().vault;
    const agents = join(s().vault, "AGENTS.md");
    fs.writeFileSync(agents, "# Project\n\nSome rules.\n");
    expect(await s().ok("--tracker", s().dir, "instructions")).toBe(`updated ${agents}\n`);
    expect(s().read(agents)).toBe(`# Project\n\nSome rules.\n\n${block("Trackers/Bilinear")}`);
    expect(await s().ok("--tracker", s().dir, "instructions")).toBe(`unchanged ${agents}\n`);

    // An older block, wherever it is in the file, is replaced; the rest stays.
    fs.writeFileSync(agents, "# Project\n\n<!-- bilinear:start -->\nold text\n<!-- bilinear:end -->\n\n## After\n");
    await s().ok("--tracker", s().dir, "instructions");
    expect(s().read(agents)).toBe(`# Project\n\n${block("Trackers/Bilinear")}\n## After\n`);
  });

  it("adds the rule about follow-ups, naming the tracker's triage state", async () => {
    s().cwd = s().vault;
    const plain = await s().ok("--tracker", s().dir, "instructions", "--print");
    const text = await s().ok("--tracker", s().dir, "instructions", "--followups", "--print");
    expect(plain).not.toContain("follow-up");
    expect(text.startsWith(plain.replace("<!-- bilinear:end -->\n", ""))).toBe(true);
    expect(text.endsWith("<!-- bilinear:end -->\n")).toBe(true);
    expect(text).toContain("becomes a\nfollow-up issue before you close the task");
    expect(text).toContain('(`new "Title" --status triage`)');
    expect(text).toContain("Do not work on an issue that is in `triage`.");

    await s().ok("--tracker", s().dir, "state", "inbox", "--triage");
    expect(await s().ok("--tracker", s().dir, "instructions", "--followups", "--print")).toContain('(`new "Title" --status inbox`)');

    // Writing it replaces a block that had no such rule, and the other way round.
    const agents = join(s().vault, "AGENTS.md");
    await s().ok("--tracker", s().dir, "instructions");
    expect(s().read(agents)).toBe(plain);
    expect(await s().ok("--tracker", s().dir, "instructions", "--followups")).toBe(`updated ${agents}\n`);
    expect(s().read(agents)).toContain("--status inbox");

    s().edit(s().index, "triage-state: inbox\n", "");
    const r = await s().run("--tracker", s().dir, "instructions", "--followups");
    expect(r.code).toBe(1);
    expect(r.err).toContain("bilinear state triage --triage");
  });

  it("picks the agents file that is there, or the one that is named", async () => {
    s().cwd = s().vault;
    const claude = join(s().vault, "CLAUDE.md");
    fs.writeFileSync(claude, "Rules.\r\n");
    expect(await s().ok("--tracker", s().dir, "instructions")).toBe(`updated ${claude}\n`);
    expect(s().read(claude)).toBe(`Rules.\r\n\r\n${block("Trackers/Bilinear").replace(/\n/g, "\r\n")}`);
    fs.unlinkSync(claude);
    expect(await s().ok("--tracker", s().dir, "instructions")).toBe(`created ${join(s().vault, "AGENTS.md")}\n`);
    expect(await s().ok("--tracker", s().dir, "instructions", "CLAUDE.md")).toBe(`created ${claude}\n`);
    s().cwd = s().root;
    expect(await s().code("instructions")).toBe(1);
  });

  it("names the tracker from the root of the repository when it is in it or beside it, else in full", async () => {
    const repo = join(s().vault, "code", "repo");
    fs.mkdirSync(join(repo, ".git"), { recursive: true });
    fs.mkdirSync(join(repo, "docs", "deep"), { recursive: true });
    const printed = async (cwd: string, tracker: string) => {
      s().cwd = cwd;
      return s().ok("--tracker", tracker, "instructions", "--print");
    };
    const make = async (folder: string) => {
      s().cwd = s().root;
      await s().ok("init", folder, "--prefix", "IN");
      return folder;
    };

    // Inside the repository: from its root, wherever the command or the file is.
    const inside = await make(join(repo, "docs", "Tracker"));
    expect(await printed(repo, inside)).toBe(block("docs/Tracker"));
    expect(await printed(join(repo, "docs", "deep"), inside)).toBe(block("docs/Tracker"));
    s().cwd = repo;
    await s().ok("--tracker", inside, "instructions", join("docs", "deep", "AGENTS.md"));
    expect(s().read(join(repo, "docs", "deep", "AGENTS.md"))).toBe(block("docs/Tracker"));
    expect(await printed(inside, inside)).toBe(block("docs/Tracker"));

    // One level above the repository: still relative.
    const beside = await make(join(s().vault, "code", "Notes", "Tracker"));
    expect(await printed(repo, beside)).toBe(block("../Notes/Tracker"));

    // Further away: the absolute path.
    expect(await printed(repo, s().dir)).toBe(block(s().dir, "Its path:"));

    // The tracker folder is the repository.
    fs.mkdirSync(join(beside, ".git"));
    expect(await printed(beside, beside)).toBe(block("."));

    // No repository: the folder of the file stands in for its root.
    expect(await printed(s().vault, s().dir)).toBe(block("Trackers/Bilinear"));
  });
});

describe("commands", () => {
  const s = sandbox();
  const show = async (id: string) => JSON.parse(await s().ok("show", id, "--json"));

  beforeEach(async () => {
    s().edit(s().index, "labels: []", "labels: [bug, ui]");
    await s().ok("new", "Alpha", "--priority", "high", "--label", "bug", "--assignee", "rk");
    await s().ok("new", "Beta", "--status", "done", "--parent", "BL-1");
    await s().ok("new", "Gamma", "--label", "ui,bug", "--due", "2026-10-10");
  });

  it("new validates", async () => {
    for (const argv of [["--status", "nope"], ["--priority", "p0"], ["--due", "tomorrow"], ["--parent", "BL-99"]]) {
      expect(await s().code("new", "X", ...argv), argv.join(" ")).toBe(1);
    }
    expect(await s().code("new", "  ")).toBe(1);
    expect(await s().ids()).toEqual(["BL-1", "BL-2", "BL-3"]);
    expect(fs.readdirSync(join(s().dir, "issues")).sort()).toEqual(["BL-1.md", "BL-2.md", "BL-3.md"]);
    const r = await s().run("new", "X", "--label", "odd");
    expect(r).toMatchObject({ code: 0, out: "BL-4\n" });
    expect(r.err).toContain("label 'odd'");
  });

  it("new takes a description and blockers, so the issue is whole from the start", async () => {
    expect(await s().ok("new", "Delta", "--description", "\r\nFirst line.\r\n\r\n- a list\n\n", "--blocked-by", "BL-1, BL-2", "--blocked-by", "BL-3")).toBe("BL-4\n");
    expect(s().read(s().note("BL-4"))).toBe('---\ntitle: Delta\nstatus: backlog\npriority: none\nblocked-by: ["[[BL-1]]", "[[BL-2]]", "[[BL-3]]"]\ncreated: 2026-10-01\n---\n\nFirst line.\n\n- a list\n');
    await s().ok("comment", "BL-4", "after the body");
    expect(s().read(s().note("BL-4")).endsWith("- a list\n\n## Comments\n- 2026-10-01 rk: after the body\n")).toBe(true);
    expect(await s().run("lint")).toMatchObject(CLEAN);
    for (const argv of [["--blocked-by", "BL-99"], ["--blocked-by", "nope"]]) expect(await s().code("new", "X", ...argv), argv.join(" ")).toBe(1);
    await s().ok("new", "Empty", "--description", "  \n ");
    expect(s().read(s().note("BL-5")).endsWith("created: 2026-10-01\n---\n")).toBe(true);
  });

  it("new --json gives the ID and the path", async () => {
    expect(JSON.parse(await s().ok("new", "X", "--json"))).toEqual({ id: "BL-4", path: s().note("BL-4") });
  });

  it("list filters", async () => {
    expect(await s().ids("--status", "done")).toEqual(["BL-2"]);
    expect(await s().ids("--status", "backlog,todo")).toEqual(["BL-1", "BL-3"]);
    expect(await s().ids("--label", "bug")).toEqual(["BL-1", "BL-3"]);
    expect(await s().ids("--label", "ui")).toEqual(["BL-3"]);
    expect(await s().ids("--assignee", "rk")).toEqual(["BL-1"]);
    expect(await s().ids("--priority", "high", "--priority", "urgent")).toEqual(["BL-1"]);
    await s().ok("archive", "BL-2");
    expect(await s().ids()).toEqual(["BL-1", "BL-3"]);
    expect(await s().ids("--archived")).toEqual(["BL-2"]);
    expect(await s().ids("--all")).toEqual(["BL-1", "BL-3", "BL-2"]);
  });

  it("list prints aligned columns", async () => {
    expect(await s().ok("list")).toBe("BL-1  backlog  high  Alpha  [1/1]  @rk  #bug\nBL-2  done     none  Beta\nBL-3  backlog  none  Gamma  #ui #bug\n");
    await s().ok("archive", "BL-2");
    fs.unlinkSync(s().note("BL-3"));
    expect(await s().ok("list", "--all")).toBe("BL-1  backlog  high  Alpha  [1/1]  @rk  #bug\nBL-3  -        none  Gamma  (note missing)\nBL-2  done     none  Beta  [archived]\n");
  });

  it("list --json has the documented keys in order", async () => {
    const first = JSON.parse(await s().ok("list", "--json"))[0];
    expect(Object.keys(first)).toEqual(["id", "title", "status", "priority", "labels", "assignee", "due", "parent", "blocked-by", "created", "links", "progress", "archived", "missing"]);
    expect(first).toMatchObject({ id: "BL-1", title: "Alpha", status: "backlog", priority: "high", labels: ["bug"], assignee: "rk", due: null, created: "2026-10-01" });
  });

  it("progress follows the linked issues", async () => {
    fs.appendFileSync(s().note("BL-3"), "\nDepends on [[BL-1]] and [[BL-2]].\n\n## Comments\n- 2026-10-01 rk: unlike [[BL-9]]\n");
    const byId = Object.fromEntries((JSON.parse(await s().ok("list", "--json")) as Array<{ id: string }>).map((i) => [i.id, i])) as Record<string, any>;
    expect(byId["BL-1"].progress).toEqual({ done: 1, total: 1, issues: ["BL-2"] });
    expect(byId["BL-2"].progress).toBeNull();
    expect(byId["BL-3"].links).toEqual(["BL-1", "BL-2"]);
    expect(byId["BL-3"].progress).toEqual({ done: 1, total: 2, issues: ["BL-1", "BL-2"] });
    expect(await s().ok("show", "BL-3")).toContain("progress:    1/2  (BL-1 backlog, BL-2 done)\n");
    await s().ok("set", "BL-1", "status=canceled");
    expect(await s().ok("list", "--status", "backlog")).toContain("  [2/2]");
    await s().ok("archive", "--closed");
    expect((await show("BL-3")).progress).toEqual({ done: 2, total: 2, issues: ["BL-1", "BL-2"] });
  });

  it("show", async () => {
    expect(await s().ok("show", "BL-2")).toBe("BL-2  Beta\nstatus:      done\npriority:    none\nparent:      [[BL-1]]\ncreated:     2026-10-01\n");
    fs.appendFileSync(s().note("BL-2"), "\nThe body.\n\n");
    expect(await s().ok("show", "BL-2")).toContain("created:     2026-10-01\n\nThe body.\n");
    const data = await show("BL-2");
    expect(data.parent).toBe("BL-1");
    expect(data.properties.parent).toBe("[[BL-1]]");
    expect(data.path).toBe(s().note("BL-2"));
    expect(data.body).toBe("\nThe body.\n\n");
    expect(await s().code("show", "BL-99")).toBe(1);
    fs.unlinkSync(s().note("BL-2"));
    expect(await s().ok("show", "BL-2")).toBe("BL-2  Beta\n(note missing)\n");
    expect(await show("BL-2")).toMatchObject({ missing: true, path: null, properties: {}, body: "" });
  });

  it("set", async () => {
    await s().ok("set", "BL-1", "status=in-progress", "labels+=ui", "estimate=3", "blocked-by=BL-2, BL-3");
    let data = await show("BL-1");
    expect(data.status).toBe("in-progress");
    expect(data.labels).toEqual(["bug", "ui"]);
    expect(data["blocked-by"]).toEqual(["BL-2", "BL-3"]);
    expect(data.properties.estimate).toBe("3");
    await s().ok("set", "BL-1", "labels-=bug", "blocked-by-=BL-2", "estimate=", "assignee=");
    data = await show("BL-1");
    expect(data.labels).toEqual(["ui"]);
    expect(data["blocked-by"]).toEqual(["BL-3"]);
    expect(data.properties).not.toHaveProperty("estimate");
    expect(data.assignee).toBeNull();
    await s().ok("set", "BL-1", "labels+=bug", "labels+=ui", "tags+=a,b", "tags-=a", "labels=");
    data = await show("BL-1");
    expect(data.labels).toEqual([]);
    expect(data.properties.tags).toEqual(["b"]);
  });

  it("set adds a blocker next to one that no longer exists", async () => {
    await s().ok("set", "BL-1", "blocked-by=BL-2");
    await s().ok("rm", "BL-2");
    await s().ok("set", "BL-1", "blocked-by+=BL-3");
    expect((await show("BL-1")).properties["blocked-by"]).toEqual(["[[BL-2]]", "[[BL-3]]"]);
  });

  it("set validates and leaves the note alone", async () => {
    const before = s().read(s().note("BL-1"));
    for (const assignment of ["status=nope", "priority=p0", "due=soon", "parent=BL-1", "parent=BL-99", "blocked-by=BL-1", "blocked-by+=nope", "title=", "status=", "nonsense"]) {
      expect(await s().code("set", "BL-1", "assignee=x", assignment), assignment).toBe(1);
      expect(s().read(s().note("BL-1"))).toBe(before);
    }
  });

  it("a new title reaches the index line", async () => {
    await s().ok("set", "BL-2", "title=Beta:  two");
    expect(s().read(s().index)).toContain("- [[BL-2]] Beta: two\n");
    expect(s().read(s().note("BL-2"))).toContain('title: "Beta: two"\n');
  });

  it("comment takes its author from the flag, the environment or the user", async () => {
    await s().ok("comment", "BL-1", "from user");
    s().env["BILINEAR_USER"] = "env";
    await s().ok("comment", "BL-1", "from env");
    await s().ok("--author", "flag", "comment", "BL-1", "from flag");
    await s().ok("comment", "BL-1", "from flag after", "--author", "late");
    expect(s().read(s().note("BL-1")).endsWith("\n## Comments\n- 2026-10-01 rk: from user\n- 2026-10-01 env: from env\n- 2026-10-01 flag: from flag\n- 2026-10-01 late: from flag after\n")).toBe(true);
    expect(await s().code("comment", "BL-1", " ")).toBe(1);
  });

  it("move", async () => {
    await s().ok("move", "BL-3", "--top");
    expect(await s().ids()).toEqual(["BL-3", "BL-1", "BL-2"]);
    await s().ok("move", "BL-3", "--after", "BL-1");
    expect(await s().ids()).toEqual(["BL-1", "BL-3", "BL-2"]);
    await s().ok("move", "BL-2", "--before", "BL-3");
    expect(await s().ids()).toEqual(["BL-1", "BL-2", "BL-3"]);
    await s().ok("move", "BL-1", "--bottom");
    expect(await s().ids()).toEqual(["BL-2", "BL-3", "BL-1"]);
    await s().ok("archive", "BL-3");
    for (const argv of [["BL-1", "--before", "BL-1"], ["BL-3", "--top"], ["BL-1", "--after", "BL-3"], ["BL-9", "--top"], ["BL-1"], ["BL-1", "--top", "--bottom"]]) {
      expect(await s().code("move", ...argv), argv.join(" ")).toBe(1);
    }
  });

  it("archive and unarchive", async () => {
    expect(await s().ok("archive", "--closed")).toBe("BL-2\n");
    expect(fs.existsSync(s().note("BL-2", "archive"))).toBe(true);
    expect(fs.existsSync(s().note("BL-2"))).toBe(false);
    expect(await s().ok("archive", "--closed")).toBe("");
    expect(await s().ok("archive", "BL-2")).toBe("");
    expect(await s().ok("unarchive", "BL-2")).toBe("BL-2\n");
    expect(await s().ids()).toEqual(["BL-1", "BL-3", "BL-2"]);
    expect(fs.existsSync(s().note("BL-2"))).toBe(true);
    expect(await s().code("archive")).toBe(1);
    expect(await s().code("archive", "BL-1", "--closed")).toBe(1);
    expect(await s().code("archive", "BL-1", "BL-99")).toBe(1);
    expect(await s().ids()).toEqual(["BL-1", "BL-3", "BL-2"]);
  });

  it("rm moves the note to the vault's trash", async () => {
    await s().ok("rm", "BL-2");
    expect(await s().ids("--all")).toEqual(["BL-1", "BL-3"]);
    expect(fs.existsSync(join(s().vault, ".trash", "BL-2.md"))).toBe(true);
    fs.writeFileSync(s().note("BL-2"), "---\ntitle: again\nstatus: todo\n---\n");
    await s().ok("adopt", "BL-2");
    await s().ok("rm", "BL-2");
    expect(fs.existsSync(join(s().vault, ".trash", "BL-2 2.md"))).toBe(true);
  });

  it("rm without a vault needs --force", async () => {
    fs.rmdirSync(join(s().vault, ".obsidian"));
    const r = await s().run("rm", "BL-2");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--force");
    expect(fs.existsSync(s().note("BL-2"))).toBe(true);
    expect(await s().ids()).toEqual(["BL-1", "BL-2", "BL-3"]);
    await s().ok("rm", "BL-2", "--force");
    expect(fs.existsSync(s().note("BL-2"))).toBe(false);
    expect(fs.existsSync(join(s().vault, ".trash"))).toBe(false);
  });

  it("rm of a line without a note needs no vault", async () => {
    fs.rmdirSync(join(s().vault, ".obsidian"));
    fs.unlinkSync(s().note("BL-2"));
    await s().ok("rm", "BL-2");
    expect(await s().ids()).toEqual(["BL-1", "BL-3"]);
  });

  it("adopt", async () => {
    expect(await s().code("adopt", "BL-1")).toBe(1);
    expect(await s().code("adopt", "BL-40")).toBe(1);
    fs.writeFileSync(s().note("BL-40"), "---\ntitle: Found\nstatus: todo\n---\n");
    await s().ok("adopt", "BL-40");
    const text = s().read(s().index);
    expect(text).toContain("- [[BL-3]] Gamma\n- [[BL-40]] Found\n");
    expect(text).toContain("next: 41\n");
  });

  it("lint exits with 2 on problems, and prints JSON", async () => {
    expect(await s().code("lint")).toBe(0);
    fs.unlinkSync(s().note("BL-2"));
    const r = await s().run("lint");
    expect(r.code).toBe(2);
    expect(r.out).toContain("error: BL-2: note missing [note-missing]\n");
    const data = JSON.parse((await s().run("lint", "--json")).out);
    expect(data.problems).toEqual([{ severity: "error", code: "note-missing", id: "BL-2", message: "note missing", fixable: false, fixed: false }]);
  });

  it("lint --fix reports what it fixed and exits clean", async () => {
    s().edit(s().index, "- [[BL-1]] Alpha", "* [[BL-1]] Alfa");
    s().edit(s().index, "next: 4", "next: 1");
    const r = await s().run("lint", "--fix");
    expect(r.code).toBe(0);
    expect(r.out.split("fixed: ").length - 1).toBe(3);
    expect(await s().run("lint")).toMatchObject(CLEAN);
  });

  it("lint never writes without --fix", async () => {
    s().edit(s().index, "- [[BL-1]] Alpha", "* [[BL-1]] Alfa");
    const before = s().read(s().index);
    expect(await s().code("lint")).toBe(2);
    expect(s().read(s().index)).toBe(before);
  });

  it("a broken index is an error, but lint reports it", async () => {
    s().edit(s().index, "prefix: BL", "prefix: bl");
    expect(await s().code("list")).toBe(1);
    const r = await s().run("lint");
    expect(r.code).toBe(2);
    expect(r.out).toContain("[index-key]");
  });

  it("a second index note is reported", async () => {
    fs.writeFileSync(join(s().dir, "Other.md"), "---\nbilinear: tracker\nprefix: OT\nnext: 1\nstates: [todo]\n---\n");
    const r = await s().run("lint");
    expect(r.code).toBe(2);
    expect(r.out).toContain("[multiple-trackers]");
    expect(await s().ids()).toEqual(["BL-1", "BL-2", "BL-3"]);
  });

  it("usage errors exit with 1", async () => {
    for (const argv of [[], ["bogus"], ["new"], ["new", "a", "b"], ["list", "--nope"], ["list", "x"], ["show"], ["set", "BL-1"]]) {
      const r = await s().run(...argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err).toContain("usage: bilinear");
      expect(r.out).toBe("");
    }
  });

  it("help and version", async () => {
    expect(await s().ok("--version")).toMatch(/^bilinear \d+\.\d+\.\d+\n$/);
    expect(await s().ok("--help")).toContain("commands:\n  init ");
    expect(await s().ok("set", "--help")).toContain("usage: bilinear [--tracker PATH] [--author NAME] set <id> <key=value>...");
  });
});
