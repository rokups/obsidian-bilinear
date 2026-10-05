// The command line: what the shared fixtures do not cover.

import { execFile, execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { instructions, shellWord } from "../../cli/src/agent";
import { NodeIO, slashed } from "../../cli/src/node-io";
import { contextView } from "../src/ops/context";
import { OpError } from "../src/ops/io";
import { withFileLock } from "../src/ops/lock-file";
import { Sandbox, sandbox } from "./cli";

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

  it("refuses an existing tracker, a bad prefix and a path that is not a note's", async () => {
    expect(await s().code(s().index, "init", "--prefix", "BL")).toBe(1);
    expect(await s().code(join(s().vault, "X", "X.md"), "init", "--prefix", "bl")).toBe(1);
    expect(await s().code(join(s().vault, "X", "X.md"), "init")).toBe(1);
    const r = await s().raw(join(s().vault, "X"), "init", "--prefix", "XX");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no board file");
    expect(fs.existsSync(join(s().vault, "X"))).toBe(false);
  });

  it("takes a relative path", async () => {
    s().cwd = s().vault;
    expect(await s().ok(join("Other", "Other.md"), "init", "--prefix", "OT")).toBe(`${join("Other", "Other.md")}\n`);
    expect(await s().ok(join("Other", "Other.md"), "new", "A")).toBe("OT-1\n");
  });

  it("puts a second tracker in a folder, with a prefix of its own", async () => {
    const other = join(s().dir, "Other.md");
    const taken = await s().run(other, "init", "--prefix", "BL");
    expect(taken.code).toBe(1);
    expect(taken.err).toContain("Bilinear, in the same folder, already has the prefix BL");
    expect(fs.existsSync(other)).toBe(false);
    expect(await s().ok(other, "init", "--prefix", "OT")).toBe(`${other}\n`);
    expect(s().entries()).toEqual(["Bilinear.md", "Other.md"]);
    expect(fs.existsSync(s().lockFile)).toBe(false);
  });
});

describe("finding the tracker", () => {
  const s = sandbox();

  it("works on the board file given first, from wherever it is run", async () => {
    await s().ok("new", "One");
    expect(await s().ids()).toEqual(["BL-1"]);
    s().cwd = s().vault;
    expect(await s().ids(join("Trackers", "Bilinear", "Bilinear.md"))).toEqual(["BL-1"]);
    s().cwd = join(s().dir, "archive");
    expect(await s().ids(s().index)).toEqual(["BL-1"]);
  });

  it("takes nothing from the working folder, a folder, a partial name or a note", async () => {
    const usage = "no board file; give the tracker's index note, ending in .md, as the first argument, or set BILINEAR_TRACKER to it";
    // The tracker around the working folder is not looked for.
    for (const cwd of [s().dir, s().vault]) {
      s().cwd = cwd;
      const r = await s().raw("list");
      expect(r.code).toBe(1);
      expect(r.err).toContain(usage);
      expect(r.err).toContain("usage: bilinear <board.md> <command> [options]");
    }
    expect((await s().raw()).code).toBe(1);
    expect((await s().raw("--json")).err).toContain(usage);
    // The first argument ends in .md or it is not a board file; the others are not looked for.
    for (const first of [s().dir, s().vault, join("Trackers", "Bilinear"), join(s().dir, "Bilinear"), "Bilinear"]) {
      const r = await s().raw(first, "list");
      expect(r.code, first).toBe(1);
      expect(r.err, first).toContain(usage);
    }
    // A file or folder named .md is a board file only if it is a tracker's index note.
    expect((await s().raw(s().note("BL-1"), "list")).err).toContain("no tracker index note");
    fs.mkdirSync(join(s().dir, "Folder.md"));
    expect((await s().raw(join(s().dir, "Folder.md"), "list")).err).toContain("is not a file; a tracker's index note is expected");
    fs.writeFileSync(join(s().dir, "Plain.md"), "A note.\n");
    expect((await s().raw(join(s().dir, "Plain.md"), "list")).err).toContain(`${join(s().dir, "Plain.md")} is not a tracker index note`);
    expect((await s().raw(join(s().dir, "Nope.md"), "list")).err).toContain(`no tracker index note ${join(s().dir, "Nope.md")}`);
  });

  it("does not take options or the command before the board file", async () => {
    for (const argv of [["--author", "me", s().index, "list"], ["--json", s().index, "list"], ["list", s().index]]) {
      const r = await s().raw(...argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err, argv.join(" ")).toContain("no board file");
    }
    expect((await s().raw(s().index, "--author", "me", "list")).err).toContain("unknown command '--author'");
  });

  it("has no --tracker option", async () => {
    const cases: [string[], string][] = [
      [["--tracker", s().index, "list"], "no board file"],
      [[s().index, "list", "--tracker", s().index], "Unknown option '--tracker'"],
      [[s().index, "list", `--tracker=${s().index}`], "Unknown option '--tracker'"],
    ];
    for (const [argv, error] of cases) {
      const r = await s().raw(...argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err, argv.join(" ")).toContain(error);
    }
    expect((await s().raw(s().index, "list", "--help")).out).not.toContain("--tracker");
  });

  it("prints a command's help with no board file, but still wants one for the command itself", async () => {
    delete s().env["BILINEAR_TRACKER"];
    for (const command of ["set", "init"]) {
      const r = await s().raw(command, "--help");
      expect(r.code, command).toBe(0);
      expect(r.out, command).toContain(`bilinear <board.md> ${command}`);
    }
    for (const argv of [["set"], ["set", "BL-1", "status=done"], ["list", "--bogus"], ["Trackers/Bilinear", "list"]]) {
      const r = await s().raw(...argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err, argv.join(" ")).toContain("no board file");
    }
  });

  it("quotes a board path in an example command only when a shell would split or expand it", () => {
    expect(shellWord("Trackers/My Board.md")).toBe('"Trackers/My Board.md"');
    expect(shellWord('a"$b`c\\.md')).toBe('"a\\"\\$b\\`c\\.md"');
    expect(shellWord("C:\\Notes\\Bilinear.md")).toBe("C:\\Notes\\Bilinear.md");
    expect(shellWord("\\\\server\\My Notes\\Bilinear.md")).toBe('"\\\\server\\My Notes\\Bilinear.md"');
    expect(shellWord("Trackers/Bilinear/Bilinear.md")).toBe("Trackers/Bilinear/Bilinear.md");
    expect(instructions("My Trackers/Board.md", "skill")).toContain('`bilinear "My Trackers/Board.md" <command> ...`');
    expect(instructions("Trackers/Board.md", "skill")).toContain("`bilinear Trackers/Board.md <command> ...`");
  });

  describe("BILINEAR_TRACKER", () => {
    const other = () => join(s().dir, "Other.md");
    beforeEach(async () => {
      await s().ok("new", "One");
      await s().ok(other(), "init", "--prefix", "OT");
    });

    it("names the board file when none is given first", async () => {
      s().env["BILINEAR_TRACKER"] = s().index;
      s().cwd = s().root;
      expect(JSON.parse((await s().raw("list", "--json")).out)).toHaveLength(1);
      expect((await s().raw("new", "Two")).out).toBe("BL-2\n");
      expect((await s().raw("--author", "me", "list")).err).toContain("unknown command '--author'");
    });

    it("loses to the board file given first", async () => {
      s().env["BILINEAR_TRACKER"] = s().index;
      expect(await s().ok(other(), "new", "Two")).toBe("OT-1\n");
      expect(await s().ids()).toEqual(["BL-1"]);
      expect(await s().ids(other())).toEqual(["OT-1"]);
    });

    it("does not guess a tracker from the prefix of the issues named", async () => {
      await s().ok(other(), "new", "Two");
      s().env["BILINEAR_TRACKER"] = s().index;
      expect((await s().raw("new", "Three", "--blocked-by", "OT-1")).out).toBe("BL-2\n");
      const r = await s().raw("show", "OT-1");
      expect(r.code).toBe(1);
      expect(r.err).toContain("OT-1: no such issue");
      s().env["BILINEAR_TRACKER"] = other();
      expect((await s().raw("show", "BL-1")).err).toContain("BL-1: no such issue");
    });

    it("must be the index note of a tracker, as a path ending in .md", async () => {
      for (const value of [s().dir, s().vault, join("Trackers", "Bilinear"), join(s().dir, "Other")]) {
        s().env["BILINEAR_TRACKER"] = value;
        const r = await s().raw("list");
        expect(r.code, value).toBe(1);
        expect(r.err, value).toContain(`$BILINEAR_TRACKER (${value}) is not the path of a tracker's index note, which ends in .md`);
      }
      s().env["BILINEAR_TRACKER"] = join(s().dir, "Nope.md");
      expect((await s().raw("list")).err).toContain(`no tracker index note $BILINEAR_TRACKER (${join(s().dir, "Nope.md")})`);
      fs.writeFileSync(join(s().dir, "Plain.md"), "A note.\n");
      s().env["BILINEAR_TRACKER"] = join(s().dir, "Plain.md");
      expect((await s().raw("list")).err).toContain("is not a tracker index note");
      s().env["BILINEAR_TRACKER"] = join(s().dir, "Nope");
      expect((await s().raw("--version")).code).toBe(0);
    });

    it("creates the index note with init", async () => {
      s().env["BILINEAR_TRACKER"] = join(s().vault, "New", "New.md");
      expect((await s().raw("init", "--prefix", "NW")).out).toBe(`${join(s().vault, "New", "New.md")}\n`);
      expect((await s().raw("new", "A")).out).toBe("NW-1\n");
    });
  });

  it("knows the index note by its frontmatter, not its name", async () => {
    fs.renameSync(s().index, join(s().dir, "Board.md"));
    expect(await s().ok(join(s().dir, "Board.md"), "new", "One")).toBe("BL-1\n");
  });

  describe("in a folder of several", () => {
    const other = () => join(s().dir, "Other.md");
    beforeEach(async () => {
      await s().ok(other(), "init", "--prefix", "OT");
      await s().ok(s().index, "new", "One");
      await s().ok(other(), "new", "Two");
    });

    it("works on the board file named, whatever prefix the issues have", async () => {
      expect(await s().ok(s().index, "new", "Three", "--blocked-by", "OT-1")).toBe("BL-2\n");
      expect(await s().ok("new", "Four", "--related-to", "[[OT-1]]")).toBe("BL-3\n");
      const r = await s().run(s().index, "show", "OT-1");
      expect(r.code).toBe(1);
      expect(r.err).toContain("OT-1: no such issue");
      expect((await s().run("set", "OT-1", "status=todo")).err).toContain("OT-1: no such issue");
      expect((await s().run(other(), "show", "BL-1")).err).toContain("BL-1: no such issue");
      expect(await s().ok(other(), "new", "Five", "--blocked-by", "BL-1")).toBe("OT-2\n");
      await s().ok("comment", "BL-1", "Seen.");
      expect(s().read(s().note("BL-1"))).toContain("rk: Seen.");
      await s().ok("move", "BL-3", "--before", "BL-1");
      expect(await s().ok("archive", "BL-3")).toBe("BL-3\n");
      expect(await s().ok("unarchive", "BL-3")).toBe("BL-3\n");
      await s().ok("rm", "BL-3");
      expect(await s().ids(s().index, "--all")).toEqual(["BL-1", "BL-2"]);
      expect(await s().ids(other(), "--all")).toEqual(["OT-1", "OT-2"]);
    });

    describe("with issues linked across trackers", () => {
      const bl = () => [s().index];
      beforeEach(async () => {
        // The other tracker closes only canceled issues: done ones are open there.
        fs.writeFileSync(other(), fs.readFileSync(other(), "utf8").replace("closed-states: [done, canceled]", "closed-states: [canceled]"));
      });

      it("takes the ID of another tracker's issue when an issue is made or set", async () => {
        expect(await s().ok(...bl(), "new", "Three", "--blocked-by", "OT-1")).toBe("BL-2\n");
        await s().ok("set", "BL-1", "related-to+=OT-1");
        expect(s().read(s().note("BL-2"))).toContain("[[OT-1]]");
        expect(s().read(s().note("BL-1"))).toContain("[[OT-1]]");
        for (const argv of [["new", "Four", "--blocked-by", "OT-99"], ["set", "BL-1", "blocked-by+=OT-99"], ["set", "BL-1", "related-to+=XX-1"]]) {
          const r = await s().run(...bl(), ...argv);
          expect(r.code, argv.join(" ")).toBe(1);
        }
        expect(await s().run(...bl(), "lint")).toMatchObject(CLEAN);
      });

      it("counts a blocker of another tracker open or closed by that tracker's states", async () => {
        await s().ok(...bl(), "new", "Three", "--blocked-by", "OT-1");
        expect(await s().ids(...bl(), "--blocked")).toEqual(["BL-2"]);
        await s().ok(other(), "set", "OT-1", "status=done");
        expect(await s().ids(...bl(), "--blocked")).toEqual(["BL-2"]);
        await s().ok(other(), "set", "OT-1", "status=canceled");
        expect(await s().ids(...bl(), "--blocked")).toEqual([]);
        expect(await s().ok(...bl(), "list", "--blocked-by", "OT-1")).toContain("BL-2");
      });

      it("lists the issues blocked by or related to one of another tracker", async () => {
        await s().ok(...bl(), "new", "Three", "--blocked-by", "OT-1");
        await s().ok("set", "BL-1", "related-to+=OT-1");
        expect(await s().ids(...bl(), "--blocked-by", "OT-1")).toEqual(["BL-2"]);
        expect(await s().ids(...bl(), "--blocked-by", "[[OT-1]]")).toEqual(["BL-2"]);
        expect(await s().ids(...bl(), "--related-to", "OT-1")).toEqual(["BL-1"]);
        expect(await s().ids(...bl(), "--related-to", "OT-1", "--blocked-by", "OT-1")).toEqual([]);
        // The other tracker's issues are not this one's to list.
        expect(await s().ids(other(), "--blocked-by", "OT-1")).toEqual([]);
        for (const flag of ["--blocked-by", "--related-to"]) {
          const r = await s().run(...bl(), "list", flag, "OT-99");
          expect(r.code, flag).toBe(1);
          expect(r.err, flag).toContain("OT-99: no such issue");
        }
      });

      it("shows the issues of another tracker among the links, with their status", async () => {
        await s().ok(...bl(), "new", "Three", "--blocked-by", "OT-1");
        await s().ok("set", "BL-1", "related-to+=OT-1");
        await s().ok(other(), "set", "OT-1", "status=in-progress");
        const text = await s().ok(...bl(), "show", "BL-2");
        expect(text).toContain("progress:    0/1  (OT-1 in-progress)\n");
        const related = await s().ok(...bl(), "show", "BL-1");
        expect(related).toContain("related:     OT-1 in-progress\n");
        const owner = await s().ok(other(), "show", "OT-1");
        expect(owner).toContain("blocks:      BL-2 backlog\n");
        expect(owner).toContain("related:     BL-1 backlog\n");
        const j = JSON.parse(await s().ok(...bl(), "show", "BL-2", "--json"));
        expect(j).toMatchObject({ "blocked-by": ["OT-1"], blocked: true, progress: { done: 0, total: 1, issues: ["OT-1"] } });
        expect(JSON.parse(await s().ok(...bl(), "show", "BL-1", "--json"))).toMatchObject({ related: ["OT-1"], blocked: false });
        expect(JSON.parse(await s().ok(other(), "show", "OT-1", "--json"))).toMatchObject({ blocks: ["BL-2"], related: ["BL-1"] });
        // An issue of the other tracker is not one to show here.
        expect((await s().run(...bl(), "show", "OT-1")).err).toContain("OT-1: no such issue");
      });
    });

    it("lints each on its own, and locks them as one", async () => {
      expect(await s().run(s().index, "lint")).toMatchObject(CLEAN);
      expect(await s().run(other(), "lint")).toMatchObject(CLEAN);
      fs.writeFileSync(s().lockFile, PLUGIN_LOCK);
      s().env["BILINEAR_LOCK_TIMEOUT"] = "0.05";
      const beat = setInterval(() => fs.utimesSync(s().lockFile, new Date(), new Date()), 10);
      try {
        expect(await s().code(other(), "new", "Held")).toBe(3);
      } finally {
        clearInterval(beat);
      }
    });
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
      for (const argv of [["new", "B"], ["set", "BL-1", "status=todo"], ["comment", "BL-1", "x"], ["move", "BL-1", "--top"], ["archive", "BL-1"], ["rm", "BL-1"], ["lint", "--fix"], ["context", "record", "BL-1", "--type", "decision", "--subject", "A"]]) {
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
      for (const argv of [["list"], ["show", "BL-1"], ["lint"], ["label"], ["state"], ["context", "get", "BL-1/D1"]]) {
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
      const cli = (...argv: string[]) => promisify(execFile)(process.execPath, [BIN, s().index, ...argv], { env });
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
  const CLAUDE = join(".claude", "skills", "bilinear", "SKILL.md");
  const AGENTS = join(".agents", "skills", "bilinear", "SKILL.md");
  const home = () => join(s().root, "home");
  const proj = () => join(s().vault, "proj");
  const setup = (...argv: string[]) => s().ok(s().index, "agent-setup", ...argv);
  const hasGit = spawnSync("git", ["--version"]).status === 0;
  beforeEach(() => {
    s().env["HOME"] = home();
    s().cwd = s().vault;
  });
  /** The skill, as agent-setup writes it. */
  const skillText = async () => {
    await setup(".", "--claude");
    return s().read(join(s().vault, CLAUDE));
  };
  /** The vault is the root of a repository, so that the tracker is named from it. */
  const repo = () => fs.mkdirSync(join(s().vault, ".git"));
  const block = (path: string, skill: string, triage = "") =>
    `<!-- bilinear:start -->\n${triage === "" ? "" : "<!-- bilinear:followups -->\n"}## Issue tracking\n\nWork on this project is tracked in a Bilinear issue tracker. ${isAbsolute(path) ? "Its path:" : "Its path, from the root of the repository:"}\n\n    ${path}\n\n` +
    `Run the CLI with it first, as in \`bilinear ${shellWord(path)} <command> ...\`, or set\n\`BILINEAR_TRACKER\` to it once and leave it out.\n\n` +
    `Track every piece of work there, from before it starts until it is finished,\nas the \`bilinear\` skill says. The skill is in\n\`${skill}\`.\n${triage}<!-- bilinear:end -->\n`;
  const claudeBlock = (path = s().index) => block(path, ".claude/skills/bilinear/SKILL.md");
  const codexBlock = (path = s().index) => block(path, ".agents/skills/bilinear/SKILL.md");

  it("sets a project up for Claude Code, and says what it did", async () => {
    const skill = join(proj(), CLAUDE);
    const claude = join(proj(), "CLAUDE.md");
    expect(await setup("proj", "--claude")).toBe(`created ${skill}\ncreated ${claude}\n`);
    expect(s().read(claude)).toBe(claudeBlock());
    expect(fs.existsSync(join(proj(), "AGENTS.md"))).toBe(false);
    expect(await setup(proj(), "--claude")).toBe(`unchanged ${skill}\nunchanged ${claude}\n`);
    fs.writeFileSync(skill, "an older version");
    expect(await setup("proj", "--claude")).toBe(`updated ${skill}\nunchanged ${claude}\n`);
    expect(s().read(skill)).toContain("name: bilinear");
    fs.writeFileSync(claude, "# Project\n");
    expect(await setup("proj", "--claude")).toBe(`unchanged ${skill}\nupdated ${claude}\n`);
    expect(await s().code(s().index, "agent-setup")).toBe(1);
    expect(await s().code(s().index, "agent-setup", "a", "b", "--claude")).toBe(1);
  });

  it("sets a project up for Codex", async () => {
    const skill = join(proj(), AGENTS);
    const agents = join(proj(), "AGENTS.md");
    expect(await setup("proj", "--codex")).toBe(`created ${skill}\ncreated ${agents}\n`);
    expect(s().read(agents)).toBe(codexBlock());
    expect(s().read(skill)).toContain("name: bilinear");
    expect(fs.existsSync(join(proj(), ".claude"))).toBe(false);
    expect(fs.existsSync(join(proj(), "CLAUDE.md"))).toBe(false);
  });

  it("sets a project up for both, Claude Code first", async () => {
    const [claudeSkill, claude, codexSkill, agents] = [join(proj(), CLAUDE), join(proj(), "CLAUDE.md"), join(proj(), AGENTS), join(proj(), "AGENTS.md")];
    expect(await setup("proj", "--codex", "--claude")).toBe(`created ${claudeSkill}\ncreated ${claude}\ncreated ${codexSkill}\ncreated ${agents}\n`);
    expect(s().read(claude)).toBe(claudeBlock());
    expect(s().read(agents)).toBe(codexBlock());
  });

  it("needs a harness for a project, and the project's folder rather than a folder of a harness", async () => {
    const r = await s().run(s().index, "agent-setup", "proj");
    expect(r.code).toBe(1);
    expect(r.err).toContain("give --codex, --claude or both");
    for (const folder of [".claude", ".codex", ".agents"]) {
      const bad = await s().run(s().index, "agent-setup", folder, "--claude");
      expect(bad.code, folder).toBe(1);
      expect(bad.err, folder).toContain(`give the project's folder, not its ${folder}`);
    }
    expect(await s().code(s().index, "agent-setup", join("proj", ".claude"), "--codex")).toBe(1);
    expect(fs.existsSync(proj())).toBe(false);
    expect(fs.existsSync(join(s().vault, ".claude"))).toBe(false);
  });

  it("sets up the folders in the home directory, which need no option", async () => {
    const claudeSkill = join(home(), CLAUDE);
    const codexSkill = join(home(), AGENTS);
    expect(await setup("~/.claude")).toBe(`created ${claudeSkill}\ncreated ${join(home(), ".claude", "CLAUDE.md")}\n`);
    expect(s().read(join(home(), ".claude", "CLAUDE.md"))).toBe(block(s().index, "~/.claude/skills/bilinear/SKILL.md"));
    expect(await setup(join(home(), ".claude"), "--claude")).toBe(`unchanged ${claudeSkill}\nunchanged ${join(home(), ".claude", "CLAUDE.md")}\n`);

    // Codex reads skills from ~/.agents, not from its own folder.
    expect(await setup("~/.codex")).toBe(`created ${codexSkill}\ncreated ${join(home(), ".codex", "AGENTS.md")}\n`);
    expect(s().read(join(home(), ".codex", "AGENTS.md"))).toBe(block(s().index, "~/.agents/skills/bilinear/SKILL.md"));
    expect(fs.existsSync(join(home(), ".codex", "skills"))).toBe(false);
    expect(await setup("~/.codex", "--codex", "--local")).toBe(`unchanged ${codexSkill}\nunchanged ${join(home(), ".codex", "AGENTS.md")}\n`);

    // ~ alone is a project like any other.
    expect(await setup("~", "--codex")).toBe(`unchanged ${codexSkill}\ncreated ${join(home(), "AGENTS.md")}\n`);
  });

  it("names the skill from ~ when HOME ends in a slash", async () => {
    s().env["HOME"] = `${home()}/`;
    await setup("~/.claude");
    expect(s().read(join(home(), ".claude", "CLAUDE.md"))).toBe(block(s().index, "~/.claude/skills/bilinear/SKILL.md"));
  });

  it("follows CLAUDE_CONFIG_DIR and CODEX_HOME", async () => {
    s().env["CLAUDE_CONFIG_DIR"] = join(s().root, "claude");
    s().env["CODEX_HOME"] = join(s().root, "codex");
    expect(await setup(join(s().root, "claude"))).toBe(`created ${join(s().root, "claude", "skills", "bilinear", "SKILL.md")}\ncreated ${join(s().root, "claude", "CLAUDE.md")}\n`);
    expect(s().read(join(s().root, "claude", "CLAUDE.md"))).toBe(block(s().index, join(s().root, "claude", "skills", "bilinear", "SKILL.md")));
    expect(await setup(join(s().root, "codex"))).toBe(`created ${join(home(), AGENTS)}\ncreated ${join(s().root, "codex", "AGENTS.md")}\n`);
    expect(await s().code(s().index, "agent-setup", join(s().root, "codex"), "--claude")).toBe(1);
  });

  it("refuses an option that does not belong to a folder of the home directory", async () => {
    for (const argv of [["~/.claude", "--codex"], ["~/.codex", "--claude"], ["~/.agents", "--claude"], ["~/.agents", "--followups"], ["~/.claude", "--codex", "--claude"]]) {
      expect(await s().code(s().index, "agent-setup", ...argv), argv.join(" ")).toBe(1);
    }
    expect(fs.existsSync(home())).toBe(false);
  });

  it("sets up ~/.agents with the skill alone, and without a tracker", async () => {
    s().cwd = s().root;
    const skill = join(home(), AGENTS);
    const bare = async (...argv: string[]) => (await s().raw("agent-setup", ...argv)).out;
    expect(await bare("~/.agents")).toBe(`created ${skill}\n`);
    expect(await bare("~/.agents", "--codex", "--local")).toBe(`unchanged ${skill}\n`);
    expect(fs.readdirSync(join(home(), ".agents"))).toEqual(["skills"]);
    for (const argv of [["~/.claude"], ["~/.codex"], ["proj", "--claude"], ["proj", "--codex"]]) {
      const r = await s().raw("agent-setup", ...argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err, argv.join(" ")).toContain("agent-setup needs a board file for this");
    }
    expect(fs.existsSync(join(home(), ".claude"))).toBe(false);
  });

  it("writes a skill whose frontmatter is valid and whose commands exist", async () => {
    const text = await skillText();
    const frontmatter = parse(text.split("---\n")[1]) as { name: string; description: string };
    expect(frontmatter.name).toBe("bilinear");
    expect(frontmatter.description.length).toBeGreaterThan(80);
    expect(frontmatter.description.length).toBeLessThan(1024);
    const commands = [...text.matchAll(/^- `([a-z]+) ?[^`]*`[^:]*: /gm)].map((m) => m[1]);
    expect(commands.length).toBeGreaterThan(8);
    for (const command of commands) expect(await s().code(command, "--help"), command).toBe(0);
  });

  it("writes a skill that requires the whole life of an issue to be tracked", async () => {
    const text = await skillText();
    expect(text).toContain("## Tracking work");
    for (const step of ["Before starting", "On choosing what to work on", "On starting", "While working", "When the work waits for review", "On finishing", "On stopping before the work is finished"]) {
      expect(text, step).toContain(`**${step}**`);
    }
    expect(text).toContain("Do not start work\n   that has no issue.");
    expect(text).toContain("`set <ID> assignee=<your name> status=<state>`");
    expect(text).toContain("`--author <your name> comment <ID> \"text\"`");
    expect(text).toContain("is the name of the agent you are");
    expect(text).toContain("An issue that needs the user to act is assigned to the user");
    expect(text).toContain("## Relations between issues");
    expect(text).toContain("## Writing issues");
    expect(text).toContain("- Prefer checklists to prose");
    expect(text).toContain("- Short-form technical English");
    expect(text).toContain("The triage state is only for decisions of high importance about the\n  architecture");
    expect(text).toContain("Before you put an issue in the triage state, search the tracker");
    for (const relation of ["Has to wait for another issue", "Made up of other issues", "Related in another way"]) {
      expect(text, relation).toContain(`- **${relation}**`);
    }
    expect(text).toContain("`set <ID> blocked-by+=<other ID>`");
    expect(text).toContain("As soon as you intend to work on\n   an issue, set it to the state for work that is up next, and assign it\n   to yourself: `set <ID> assignee=<your name> status=<state>`");
    expect(text).toContain("to the state for work that is up next, still assigned to you, if");
    expect(text).toContain("The user deletes the options they discard, leaves the one they\n  accept and moves the issue to the backlog.");
    expect(text).not.toContain(s().dir);
    expect(text).not.toContain("Trackers/Bilinear");
  });

  it("refreshes the instructions in place, and keeps the rest of the file", async () => {
    repo();
    const claude = join(s().vault, "CLAUDE.md");
    fs.writeFileSync(claude, "# Project\n\nSome rules.\n");
    expect(await setup(".", "--claude")).toBe(`created ${join(s().vault, CLAUDE)}\nupdated ${claude}\n`);
    expect(s().read(claude)).toBe(`# Project\n\nSome rules.\n\n${claudeBlock("Trackers/Bilinear/Bilinear.md")}`);
    expect(await setup(".", "--claude")).toBe(`unchanged ${join(s().vault, CLAUDE)}\nunchanged ${claude}\n`);

    // An older block, wherever it is in the file, is replaced; the rest stays.
    fs.writeFileSync(claude, "# Project\n\n<!-- bilinear:start -->\nold text\n<!-- bilinear:end -->\n\n## After\n");
    await setup(".", "--claude");
    expect(s().read(claude)).toBe(`# Project\n\n${claudeBlock("Trackers/Bilinear/Bilinear.md")}\n## After\n`);

    // A file with Windows line ends keeps them.
    fs.writeFileSync(claude, "Rules.\r\n");
    await setup(".", "--claude");
    expect(s().read(claude)).toBe(`Rules.\r\n\r\n${claudeBlock("Trackers/Bilinear/Bilinear.md").replace(/\n/g, "\r\n")}`);
  });

  it("adds the rule about follow-ups, naming the tracker's triage state", async () => {
    repo();
    const claude = join(s().vault, "CLAUDE.md");
    const skill = join(s().vault, CLAUDE);
    await setup(".", "--claude");
    const plain = s().read(claude);
    expect(await setup(".", "--claude", "--followups")).toBe(`unchanged ${skill}\nupdated ${claude}\n`);
    const text = s().read(claude);
    expect(plain).not.toContain("follow-up");
    expect(text.startsWith("<!-- bilinear:start -->\n<!-- bilinear:followups -->\n## Issue tracking")).toBe(true);
    expect(plain).not.toContain("bilinear:followups");
    expect(text.replace("<!-- bilinear:followups -->\n", "").startsWith(plain.replace("<!-- bilinear:end -->\n", ""))).toBe(true);
    expect(text.endsWith("<!-- bilinear:end -->\n")).toBe(true);
    expect(text).toContain("becomes a\nfollow-up issue before you close the task");
    expect(text).toContain('(`new "Title" --status triage`)');
    expect(text).toContain("Do not work on an issue\nthat is in `triage`.");
    expect(text).toContain("A follow-up is created like any issue, in the backlog");
    expect(text).toContain("Only a\nfollow-up that needs a decision of high importance about the architecture");
    expect(text).toContain("Before you create an issue in `triage`, search the tracker for the issues\nthat have to do with it");
    expect(text).toContain("Assign an issue for `triage` to the user (`--assignee <the user's name>`),");
    expect(text).toContain("write it so that the user can accept it\nwith as few edits as possible.");

    await s().ok(s().index, "state", "inbox", "--triage");
    await setup(".", "--claude", "--followups");
    expect(s().read(claude)).toContain('(`new "Title" --status inbox`)');
    await setup("~/.codex", "--followups");
    expect(s().read(join(home(), ".codex", "AGENTS.md"))).toContain('(`new "Title" --status inbox`)');

    // Running it without the option replaces a block that had the rule.
    await setup(".", "--claude");
    expect(s().read(claude)).toBe(plain);

    // Without a triage state it fails, and writes nothing.
    s().edit(s().index, "triage-state: inbox\n", "");
    const r = await s().run(s().index, "agent-setup", "none", "--claude", "--followups");
    expect(r.code).toBe(1);
    expect(r.err).toContain("state triage --triage");
    expect(fs.existsSync(join(s().vault, "none"))).toBe(false);
  });

  describe("with --update", () => {
    const update = (...argv: string[]) => s().ok(s().index, "agent-setup", ...argv, "--update");
    const stale = (path: string) => fs.writeFileSync(path, "an older version");

    it("refreshes what is there, and leaves a file that is the same as it was", async () => {
      repo();
      const claude = join(s().vault, "CLAUDE.md");
      const skill = join(s().vault, CLAUDE);
      await setup(".", "--claude", "--followups");
      const [before, skillBefore] = [s().read(claude), s().read(skill)];
      expect(before).toContain("<!-- bilinear:followups -->\n");
      expect(await update(".")).toBe(`unchanged ${skill}\nunchanged ${claude}\n`);
      expect(s().read(claude)).toBe(before);
      expect(s().read(skill)).toBe(skillBefore);
      expect(fs.existsSync(join(s().vault, "CLAUDE.local.md"))).toBe(false);
      expect(fs.existsSync(join(s().vault, "AGENTS.md"))).toBe(false);
    });

    it("reads the skills and sections of each harness, and ignores a file with no section", async () => {
      repo();
      const [local, agents] = [join(s().vault, "CLAUDE.local.md"), join(s().vault, "AGENTS.md")];
      const [claudeSkill, codexSkill, plain] = [join(s().vault, CLAUDE), join(s().vault, AGENTS), join(s().vault, "CLAUDE.md")];
      await setup(".", "--claude", "--local");
      await setup(".", "--codex");
      fs.writeFileSync(plain, "# Rules\n");
      stale(claudeSkill);
      stale(codexSkill);
      expect(await update(".")).toBe(`updated ${claudeSkill}\nunchanged ${local}\nupdated ${codexSkill}\nunchanged ${agents}\n`);
      expect(s().read(claudeSkill)).toContain("name: bilinear");
      expect(s().read(plain)).toBe("# Rules\n");
      expect(s().read(local)).toBe(claudeBlock("Trackers/Bilinear/Bilinear.md"));
    });

    it("creates a skill that is missing beside instructions that are there, and refreshes only a skill that is alone", async () => {
      repo();
      const [claudeSkill, claude] = [join(s().vault, CLAUDE), join(s().vault, "CLAUDE.md")];
      await setup(".", "--claude");
      fs.rmSync(join(s().vault, ".claude"), { recursive: true });
      expect(await update(".")).toBe(`created ${claudeSkill}\nunchanged ${claude}\n`);
      fs.rmSync(claude);
      stale(claudeSkill);
      expect(await update(".")).toBe(`updated ${claudeSkill}\n`);
    });

    it("works in the home folders without a tracker", async () => {
      await setup("~/.codex");
      const [skill, agents] = [join(home(), AGENTS), join(home(), ".codex", "AGENTS.md")];
      const before = s().read(agents);
      stale(skill);
      const r = await s().ok("agent-setup", "~/.codex", "--update");
      expect(r).toBe(`updated ${skill}\nunchanged ${agents}\n`);
      expect(s().read(agents)).toBe(before);

      fs.rmSync(agents);
      fs.writeFileSync(skill, "x");
      expect(await s().ok("agent-setup", "~/.agents", "--update")).toBe(`updated ${skill}\n`);
      expect(s().read(skill)).toContain("name: bilinear");
      expect(await s().code("agent-setup", "~/.claude", "--update")).toBe(1);
    });

    it("reads the triage state from a tracker named by its absolute path", async () => {
      await s().ok(s().index, "state", "triage", "--triage");
      await setup("~/.codex", "--followups");
      const agents = join(home(), ".codex", "AGENTS.md");
      expect(s().read(agents)).toContain("--status triage");
      await s().ok(s().index, "state", "inbox", "--triage");
      expect(await s().ok("agent-setup", "~/.codex", "--update")).toBe(`unchanged ${join(home(), AGENTS)}\nupdated ${agents}\n`);
      expect(s().read(agents)).toContain("--status inbox");
      expect(s().read(agents)).not.toContain("--status triage");
    });

    it("keeps the line endings of a file that has CRLF", async () => {
      repo();
      const claude = join(s().vault, "CLAUDE.md");
      const crlf = `# Rules\n\n${claudeBlock("Trackers/Bilinear/Bilinear.md")}`.replace(/\n/g, "\r\n");
      fs.writeFileSync(claude, crlf.replace("Track every piece", "Track some"));
      expect(await update(".")).toBe(`created ${join(s().vault, CLAUDE)}\nupdated ${claude}\n`);
      expect(s().read(claude)).toBe(crlf);
    });

    it("puts the marker back in a block from before there was one, and adds no rule to a block without it", async () => {
      repo();
      const [claude, local] = [join(s().vault, "CLAUDE.md"), join(s().vault, "CLAUDE.local.md")];
      await setup(".", "--claude", "--followups");
      const withRule = s().read(claude);
      fs.writeFileSync(claude, withRule.replace("<!-- bilinear:followups -->\n", ""));
      await setup(".", "--claude", "--local");
      const without = s().read(local);
      expect(without).not.toContain("follow-up");
      await update(".");
      expect(s().read(claude)).toBe(withRule);
      expect(s().read(local)).toBe(without);
    });

    it("keeps the tracker the section names, whatever else is found", async () => {
      repo();
      const claude = join(s().vault, "CLAUDE.md");
      await setup(".", "--claude", "--followups");
      const before = s().read(claude);
      const other = join(s().vault, "Other");
      await s().ok(join(other, "Other.md"), "init", "--prefix", "OT");
      expect(await s().ok(join(other, "Other.md"), "agent-setup", ".", "--update")).toContain(`unchanged ${claude}`);
      expect(s().read(claude)).toBe(before);
      s().cwd = other;
      await s().ok("agent-setup", s().vault, "--update");
      expect(s().read(claude)).toBe(before);
      expect(before).toContain("\n    Trackers/Bilinear/Bilinear.md\n");
    });

    it("does not read a section that names the tracker by its folder, as older versions wrote it", async () => {
      repo();
      const claude = join(s().vault, "CLAUDE.md");
      await setup(".", "--claude", "--followups");
      s().edit(claude, "    Trackers/Bilinear/Bilinear.md\n", "    Trackers/Bilinear\n");
      const before = s().read(claude);
      const r = await s().run("agent-setup", ".", "--update");
      expect(r.code).toBe(1);
      expect(r.err).toContain("names the tracker Trackers/Bilinear, which cannot be read");
      expect(s().read(claude)).toBe(before);
    });

    it("does not read a section without the follow-ups rule that names the tracker by its folder either", async () => {
      repo();
      const claude = join(s().vault, "CLAUDE.md");
      await setup(".", "--claude");
      s().edit(claude, "    Trackers/Bilinear/Bilinear.md\n", "    Trackers/Bilinear\n");
      const before = s().read(claude);
      const r = await s().run("agent-setup", ".", "--update");
      expect(r.code).toBe(1);
      expect(r.err).toContain("names the tracker Trackers/Bilinear, which cannot be read: it is not the path of a tracker's index note");
      expect(r.err).toContain("run agent-setup without --update");
      expect(s().read(claude)).toBe(before);
    });

    it("takes the triage state from the tracker the section names, not the one that was there when it was written", async () => {
      repo();
      const claude = join(s().vault, "CLAUDE.md");
      await setup(".", "--claude", "--followups");
      await s().ok(s().index, "state", "inbox", "--triage");
      await update(".");
      expect(s().read(claude)).toContain('(`new "Title" --status inbox`)');
    });

    it("fails, and writes nothing, when the tracker of a section with the rule cannot be read or has no triage state", async () => {
      repo();
      const [claude, skill] = [join(s().vault, "CLAUDE.md"), join(s().vault, CLAUDE)];
      await setup(".", "--claude", "--followups");
      stale(skill);
      s().edit(s().index, "triage-state: triage\n", "");
      let r = await s().run(s().index, "agent-setup", ".", "--update");
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${claude} names the tracker Trackers/Bilinear/Bilinear.md, which has no triage state`);
      expect(r.err).toContain("run agent-setup without --update");
      expect(s().read(skill)).toBe("an older version");
      s().edit(claude, "    Trackers/Bilinear/Bilinear.md\n", "    Trackers/Gone\n");
      r = await s().run("agent-setup", ".", "--update");
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${claude} names the tracker Trackers/Gone, which cannot be read`);
      expect(s().read(skill)).toBe("an older version");
    });

    it("fails when a section names no tracker", async () => {
      const claude = join(s().vault, "CLAUDE.md");
      fs.writeFileSync(claude, "<!-- bilinear:start -->\nold text\n<!-- bilinear:end -->\n");
      const r = await s().run("agent-setup", ".", "--update");
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${claude} names no tracker; run agent-setup without --update`);
    });

    it("fails where there is nothing to update, and with the options that say what to write", async () => {
      fs.writeFileSync(join(s().vault, "CLAUDE.md"), "# Rules\n");
      const r = await s().run(s().index, "agent-setup", ".", "--update");
      expect(r.code).toBe(1);
      expect(r.err).toContain("nothing to update in .: no bilinear skill or instructions section there");
      expect(fs.existsSync(join(s().vault, ".claude"))).toBe(false);
      for (const flag of ["--claude", "--codex", "--local", "--followups"]) {
        const bad = await s().run(s().index, "agent-setup", ".", "--update", flag);
        expect(bad.code, flag).toBe(1);
        expect(bad.err, flag).toContain(`${flag} does not go with --update: what is there decides`);
      }
      expect(await s().code(s().index, "agent-setup", join(".claude"), "--update")).toBe(1);
    });

    it("keeps the text around the section", async () => {
      repo();
      const claude = join(s().vault, "CLAUDE.md");
      await setup(".", "--claude");
      const text = `# Project\n\nBefore.\n\n${s().read(claude).replace("Track every piece", "Track every old piece")}\n## After\n\nAfter.\n`;
      fs.writeFileSync(claude, text);
      expect(await update(".")).toContain(`updated ${claude}`);
      expect(s().read(claude)).toBe(text.replace("Track every old piece", "Track every piece"));
    });
  });

  describe("with --global-skill", () => {
    const skill = (harness: string) => join(home(), harness, "skills", "bilinear", "SKILL.md");
    const globalBlock = (path: string, harness: string) => block(path, `~/${harness}/skills/bilinear/SKILL.md`);

    it("puts the skill in the home folder and only the instructions in the project", async () => {
      const claude = join(proj(), "CLAUDE.md");
      expect(await setup("proj", "--claude", "--global-skill")).toBe(`created ${skill(".claude")}\ncreated ${claude}\n`);
      expect(s().read(claude)).toBe(globalBlock(s().index, ".claude"));
      expect(s().read(skill(".claude"))).toContain("name: bilinear");
      expect(fs.readdirSync(proj())).toEqual(["CLAUDE.md"]);
      expect(await setup("proj", "--claude", "--global-skill")).toBe(`unchanged ${skill(".claude")}\nunchanged ${claude}\n`);
    });

    it("puts the skill for Codex in ~/.agents, and sets up both", async () => {
      const [claude, agents] = [join(proj(), "CLAUDE.md"), join(proj(), "AGENTS.md")];
      expect(await setup("proj", "--codex", "--claude", "--global-skill")).toBe(`created ${skill(".claude")}\ncreated ${claude}\ncreated ${skill(".agents")}\ncreated ${agents}\n`);
      expect(s().read(agents)).toBe(globalBlock(s().index, ".agents"));
      expect(fs.readdirSync(proj()).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
    });

    it("follows CLAUDE_CONFIG_DIR", async () => {
      s().env["CLAUDE_CONFIG_DIR"] = join(s().root, "claude");
      const there = join(s().root, "claude", "skills", "bilinear", "SKILL.md");
      expect(await setup("proj", "--claude", "--global-skill")).toBe(`created ${there}\ncreated ${join(proj(), "CLAUDE.md")}\n`);
      expect(s().read(join(proj(), "CLAUDE.md"))).toBe(block(s().index, there));
    });

    it("gives each project its own tracker of a folder, and one skill to all", async () => {
      const other = join(s().dir, "Other.md");
      await s().ok(other, "init", "--prefix", "OT");
      for (const [project, index] of [["one", s().index], ["two", other]]) {
        const dir = join(s().root, "code", project);
        fs.mkdirSync(join(dir, ".git"), { recursive: true });
        await s().ok(index, "agent-setup", dir, "--claude", "--global-skill");
        expect(s().read(join(dir, "CLAUDE.md")), project).toBe(globalBlock(index, ".claude"));
        expect(fs.readdirSync(dir).sort(), project).toEqual([".git", "CLAUDE.md"]);
      }
    });

    it("excludes only the instructions with --local", async () => {
      repo();
      const exclude = join(s().vault, ".git", "info", "exclude");
      expect(await setup(".", "--claude", "--codex", "--global-skill", "--local")).toBe(
        `created ${skill(".claude")}\ncreated ${join(s().vault, "CLAUDE.local.md")}\ncreated ${skill(".agents")}\ncreated ${join(s().vault, "AGENTS.md")}\n` +
          `excluded /CLAUDE.local.md in ${exclude}\nexcluded /AGENTS.md in ${exclude}\n`,
      );
      expect(s().read(exclude)).toBe("/CLAUDE.local.md\n/AGENTS.md\n");
      expect(s().read(join(s().vault, "CLAUDE.local.md"))).toBe(globalBlock("Trackers/Bilinear/Bilinear.md", ".claude"));
    });

    it("is refreshed by --update where the section says the skill is, and makes none in the project", async () => {
      repo();
      const [claude, agents] = [join(s().vault, "CLAUDE.md"), join(s().vault, "AGENTS.md")];
      await setup(".", "--claude", "--global-skill", "--followups");
      await setup(".", "--codex");
      const before = s().read(claude);
      fs.writeFileSync(skill(".claude"), "an older version");
      expect(await s().ok("agent-setup", ".", "--update")).toBe(`updated ${skill(".claude")}\nunchanged ${claude}\nunchanged ${join(s().vault, AGENTS)}\nunchanged ${agents}\n`);
      expect(s().read(skill(".claude"))).toContain("name: bilinear");
      expect(s().read(claude)).toBe(before);
      expect(fs.existsSync(join(s().vault, ".claude"))).toBe(false);

      // A skill that is gone is made again where the section says, and a section that names no skill gets the project's.
      fs.rmSync(join(home(), ".claude"), { recursive: true });
      expect(await s().ok("agent-setup", ".", "--update")).toContain(`created ${skill(".claude")}\n`);
      s().edit(claude, "`~/.claude/skills/bilinear/SKILL.md`", "`~/elsewhere/notes.md`");
      expect(await s().ok("agent-setup", ".", "--update")).toContain(`created ${join(s().vault, CLAUDE)}\nupdated ${claude}\n`);
      expect(s().read(claude)).toContain("`.claude/skills/bilinear/SKILL.md`");
      expect(fs.existsSync(join(home(), "elsewhere"))).toBe(false);
    });

    it("does nothing in the home folders, and does not go with --update", async () => {
      expect(await setup("~/.claude", "--global-skill")).toBe(`created ${skill(".claude")}\ncreated ${join(home(), ".claude", "CLAUDE.md")}\n`);
      expect(s().read(join(home(), ".claude", "CLAUDE.md"))).toBe(globalBlock(s().index, ".claude"));
      const r = await s().run("agent-setup", ".", "--update", "--global-skill");
      expect(r.code).toBe(1);
      expect(r.err).toContain("--global-skill does not go with --update: what is there decides");
    });
  });

  it("names the tracker of a folder of several by its index note", async () => {
    repo();
    const other = join(s().dir, "Other.md");
    await s().ok(other, "init", "--prefix", "OT");
    await s().ok(other, "agent-setup", ".", "--claude");
    expect(s().read(join(s().vault, "CLAUDE.md"))).toBe(claudeBlock("Trackers/Bilinear/Other.md"));
    expect(await s().ok("agent-setup", ".", "--update")).toContain(`unchanged ${join(s().vault, "CLAUDE.md")}`);
  });

  it("names the tracker from the root of the repository when it is in it or beside it, else in full", async () => {
    const repo = join(s().vault, "code", "repo");
    fs.mkdirSync(join(repo, ".git"), { recursive: true });
    fs.mkdirSync(join(repo, "docs", "deep"), { recursive: true });
    const written = async (cwd: string, board: string, dir = ".") => {
      s().cwd = cwd;
      await s().ok(board, "agent-setup", dir, "--codex");
      return s().read(join(cwd, dir, "AGENTS.md"));
    };
    const make = async (folder: string) => {
      s().cwd = s().root;
      await s().ok(join(folder, "Tracker.md"), "init", "--prefix", "IN");
      return folder;
    };

    // Inside the repository: from its root, wherever the command or the folder is.
    const inside = await make(join(repo, "docs", "Tracker"));
    expect(await written(repo, join(inside, "Tracker.md"))).toBe(codexBlock("docs/Tracker/Tracker.md"));
    expect(await written(join(repo, "docs", "deep"), join(inside, "Tracker.md"))).toBe(codexBlock("docs/Tracker/Tracker.md"));
    expect(await written(repo, join(inside, "Tracker.md"), "sub")).toBe(codexBlock("docs/Tracker/Tracker.md"));
    expect(await written(repo, join(inside, "Tracker.md"), join("docs", "deep"))).toBe(codexBlock("docs/Tracker/Tracker.md"));
    expect(await written(inside, join(inside, "Tracker.md"))).toBe(codexBlock("docs/Tracker/Tracker.md"));

    // One level above the repository: still relative.
    const beside = await make(join(s().vault, "code", "Notes", "Tracker"));
    expect(await written(repo, join(beside, "Tracker.md"))).toBe(codexBlock("../Notes/Tracker/Tracker.md"));

    // Further away: the absolute path.
    expect(await written(repo, s().index)).toBe(codexBlock(s().index));

    // The tracker folder is the repository.
    fs.mkdirSync(join(beside, ".git"));
    expect(await written(beside, join(beside, "Tracker.md"))).toBe(codexBlock("Tracker.md"));

    // No repository: the absolute path.
    expect(await written(s().vault, s().index)).toBe(codexBlock(s().index));
  });

  it("names the tracker in full in the home directory, even in a repository", async () => {
    fs.mkdirSync(join(home(), ".git"), { recursive: true });
    fs.mkdirSync(join(home(), "Notes", "Tracker"), { recursive: true });
    await s().ok(join(home(), "Notes", "Tracker", "Tracker.md"), "init", "--prefix", "HM");
    for (const [folder, file] of [[".claude", "CLAUDE.md"], [".codex", "AGENTS.md"]]) {
      await s().ok(join(home(), "Notes", "Tracker", "Tracker.md"), "agent-setup", `~/${folder}`);
      expect(s().read(join(home(), folder, file)), folder).toContain(`Its path:\n\n    ${join(home(), "Notes", "Tracker", "Tracker.md")}\n`);
    }
  });

  describe("with --local", () => {
    const exclude = () => join(s().vault, ".git", "info", "exclude");
    const skill = (dir: string, harness: string) => join(dir, harness, "skills", "bilinear", "SKILL.md");

    it("keeps Claude Code's instructions in CLAUDE.local.md, and excludes the files from git", async () => {
      repo();
      const local = join(s().vault, "CLAUDE.local.md");
      expect(await setup(".", "--claude", "--local")).toBe(
        `created ${join(s().vault, CLAUDE)}\ncreated ${local}\nexcluded /CLAUDE.local.md in ${exclude()}\nexcluded /.claude/skills/bilinear/ in ${exclude()}\n`,
      );
      expect(s().read(local)).toBe(claudeBlock("Trackers/Bilinear/Bilinear.md"));
      expect(fs.existsSync(join(s().vault, "CLAUDE.md"))).toBe(false);
      expect(s().read(exclude())).toBe("/CLAUDE.local.md\n/.claude/skills/bilinear/\n");
      expect(await setup(".", "--claude", "--local")).toBe(`unchanged ${join(s().vault, CLAUDE)}\nunchanged ${local}\n`);
      expect(s().read(exclude())).toBe("/CLAUDE.local.md\n/.claude/skills/bilinear/\n");
    });

    it("excludes AGENTS.md itself for Codex, which has no local file", async () => {
      repo();
      expect(await setup(".", "--codex", "--local")).toBe(
        `created ${skill(s().vault, ".agents")}\ncreated ${join(s().vault, "AGENTS.md")}\nexcluded /AGENTS.md in ${exclude()}\nexcluded /.agents/skills/bilinear/ in ${exclude()}\n`,
      );
      expect(s().read(exclude())).toBe("/AGENTS.md\n/.agents/skills/bilinear/\n");
    });

    it("keeps what the exclude file has, and adds only what is missing", async () => {
      repo();
      fs.mkdirSync(join(s().vault, ".git", "info"));
      fs.writeFileSync(exclude(), "# mine\n/CLAUDE.local.md\n*.log");
      const out = await setup(".", "--claude", "--codex", "--local");
      expect(out).not.toContain("excluded /CLAUDE.local.md");
      expect(out.split("\n").filter((l) => l.startsWith("excluded"))).toEqual([
        `excluded /.claude/skills/bilinear/ in ${exclude()}`,
        `excluded /AGENTS.md in ${exclude()}`,
        `excluded /.agents/skills/bilinear/ in ${exclude()}`,
      ]);
      expect(s().read(exclude())).toBe("# mine\n/CLAUDE.local.md\n*.log\n/.claude/skills/bilinear/\n/AGENTS.md\n/.agents/skills/bilinear/\n");
    });

    it("names a project below the root of the repository from the root", async () => {
      repo();
      expect(await setup("sub/deep", "--claude", "--local")).toContain(`excluded /sub/deep/CLAUDE.local.md in ${exclude()}\nexcluded /sub/deep/.claude/skills/bilinear/ in ${exclude()}\n`);
      expect(s().read(exclude())).toBe("/sub/deep/CLAUDE.local.md\n/sub/deep/.claude/skills/bilinear/\n");
    });

    it("says when nothing could be excluded", async () => {
      expect(await setup("proj", "--claude", "--local")).toBe(`created ${join(proj(), CLAUDE)}\ncreated ${join(proj(), "CLAUDE.local.md")}\nnot excluded: ${proj()} is in no git repository\n`);
      fs.writeFileSync(join(s().vault, ".git"), "gitdir: elsewhere\n");
      expect(await setup("proj", "--claude", "--local")).toBe(`unchanged ${join(proj(), CLAUDE)}\nupdated ${join(proj(), "CLAUDE.local.md")}\nnot excluded: ${join(s().vault, ".git")} is not a folder\n`);
    });

    it("has no effect on the folders of the home directory", async () => {
      repo();
      expect(await setup("~/.claude", "--local")).toBe(`created ${skill(home(), ".claude")}\ncreated ${join(home(), ".claude", "CLAUDE.md")}\n`);
      expect(fs.existsSync(exclude())).toBe(false);
    });

    it.skipIf(!hasGit)("refuses a file that is committed, and writes nothing", async () => {
      execFileSync("git", ["init", "-q"], { cwd: s().vault });
      fs.writeFileSync(join(s().vault, "AGENTS.md"), "# Rules\n");
      fs.writeFileSync(join(s().vault, "CLAUDE.local.md"), "# Mine\n");
      execFileSync("git", ["add", "AGENTS.md"], { cwd: s().vault });
      const r = await s().run(s().index, "agent-setup", ".", "--claude", "--codex", "--local");
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${join(s().vault, "AGENTS.md")} is committed to git, so it cannot be kept local`);
      expect(r.err).toContain("Codex has no local instructions file");
      expect(r.err).toContain("~/.codex");
      expect(fs.existsSync(join(s().vault, ".claude"))).toBe(false);
      expect(fs.existsSync(join(s().vault, ".agents"))).toBe(false);
      expect(s().read(join(s().vault, "CLAUDE.local.md"))).toBe("# Mine\n");
      expect(s().read(join(s().vault, "AGENTS.md"))).toBe("# Rules\n");

      // A file that is there but not committed is fine; so is the same file without --local.
      expect(await s().code(s().index, "agent-setup", ".", "--claude", "--local")).toBe(0);
      expect(await s().code(s().index, "agent-setup", ".", "--codex")).toBe(0);

      execFileSync("git", ["add", "-f", "CLAUDE.local.md"], { cwd: s().vault });
      const claude = await s().run(s().index, "agent-setup", ".", "--claude", "--local");
      expect(claude.code).toBe(1);
      expect(claude.err).toContain(`${join(s().vault, "CLAUDE.local.md")} is committed to git, so it cannot be kept local`);
    });
  });
});

describe("commands", () => {
  const s = sandbox();
  const show = async (id: string) => JSON.parse(await s().ok("show", id, "--json"));

  beforeEach(async () => {
    s().edit(s().index, "labels: []", "labels: [bug, ui]");
    await s().ok("new", "Alpha", "--priority", "high", "--label", "bug", "--assignee", "rk");
    await s().ok("new", "Beta", "--status", "done");
    await s().ok("new", "Gamma", "--label", "ui,bug", "--due", "2026-10-10");
  });

  it("new validates", async () => {
    for (const argv of [["--status", "nope"], ["--priority", "p0"], ["--due", "tomorrow"], ["--blocked-by", "BL-99"]]) {
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
    await s().ok("set", "BL-1", "blocked-by=BL-2");
    expect(await s().ok("list")).toBe("BL-1  backlog  high  Alpha  [1/1]  @rk  #bug\nBL-2  done     none  Beta\nBL-3  backlog  none  Gamma  #ui #bug\n");
    await s().ok("archive", "BL-2");
    fs.unlinkSync(s().note("BL-3"));
    expect(await s().ok("list", "--all")).toBe("BL-1  backlog  high  Alpha  [1/1]  @rk  #bug\nBL-3  -        none  Gamma  (note missing)\nBL-2  done     none  Beta  [archived]\n");
  });

  it("list --json has the documented keys in order", async () => {
    const first = JSON.parse(await s().ok("list", "--json"))[0];
    expect(Object.keys(first)).toEqual(["id", "title", "status", "priority", "labels", "assignee", "due", "blocked-by", "related", "blocks", "blocked", "created", "links", "progress", "archived", "missing"]);
    expect(first).toMatchObject({ id: "BL-1", title: "Alpha", status: "backlog", priority: "high", labels: ["bug"], assignee: "rk", due: null, created: "2026-10-01" });
  });

  it("progress follows the blockers, not description links", async () => {
    fs.appendFileSync(s().note("BL-3"), "\nDepends on [[BL-1]] and [[BL-2]].\n\n## Comments\n- 2026-10-01 rk: unlike [[BL-9]]\n");
    const progress = async () => Object.fromEntries((JSON.parse(await s().ok("list", "--json")) as Array<{ id: string }>).map((i) => [i.id, i])) as Record<string, any>;
    const first = await progress();
    expect(first["BL-3"].links).toEqual(["BL-1", "BL-2"]);
    expect([first["BL-1"].progress, first["BL-2"].progress, first["BL-3"].progress]).toEqual([null, null, null]);
    await s().ok("set", "BL-1", "blocked-by=BL-2");
    await s().ok("set", "BL-3", "blocked-by=BL-1, BL-2");
    const byId = await progress();
    expect(byId["BL-1"].progress).toEqual({ done: 1, total: 1, issues: ["BL-2"] });
    expect(byId["BL-2"].progress).toBeNull();
    expect(byId["BL-3"].progress).toEqual({ done: 1, total: 2, issues: ["BL-1", "BL-2"] });
    expect(await s().ok("show", "BL-3")).toContain("progress:    1/2  (BL-1 backlog, BL-2 done)\n");
    await s().ok("set", "BL-1", "status=canceled");
    expect(await s().ok("list", "--status", "backlog")).toContain("  [2/2]");
    await s().ok("archive", "--closed");
    expect((await show("BL-3")).progress).toEqual({ done: 2, total: 2, issues: ["BL-1", "BL-2"] });
  });

  describe("relations", () => {
    // BL-1 backlog blocked by BL-2 (done) and BL-3 (backlog); BL-2 related to BL-1; BL-3 related to BL-2.
    const relate = async () => {
      await s().ok("set", "BL-1", "blocked-by=BL-2, BL-3");
      await s().ok("set", "BL-2", "related-to=BL-1");
      await s().ok("set", "BL-3", "related-to=BL-2");
    };
    const ids = async (...argv: string[]) => (JSON.parse(await s().ok("list", "--json", ...argv)) as Array<{ id: string }>).map((i) => i.id);

    it("set related-to-= ends a relation that only the other note names", async () => {
      await relate();
      await s().ok("set", "BL-1", "related-to-=BL-2");
      expect(s().read(s().note("BL-2"))).not.toContain("related-to");
      expect(await ids("--related-to", "BL-1")).toEqual([]);
      await s().ok("set", "BL-2", "related-to-=BL-3, BL-99");
      expect(s().read(s().note("BL-3"))).not.toContain("related-to");
    });

    it("set compares links by the issue they name, and takes links as filters", async () => {
      s().edit(s().note("BL-1"), "created:", 'blocked-by: ["[[issues/BL-2|Two]]"]\ncreated:');
      await s().ok("set", "BL-1", "blocked-by+=BL-2");
      expect(s().read(s().note("BL-1")).match(/BL-2/g)).toHaveLength(1);
      expect(await ids("--blocked-by", "[[BL-2]]")).toEqual(["BL-1"]);
      await s().ok("set", "BL-1", "blocked-by-=BL-2");
      expect(s().read(s().note("BL-1"))).not.toContain("blocked-by");
      expect(await s().code("list", "--blocked-by", "nope")).toBe(1);
    });

    it("set warns once about a label the tracker does not list", async () => {
      const r = await s().run("set", "BL-1", "labels+=newlabel");
      expect(r.err.split("\n").filter((line) => line)).toEqual(["bilinear: warning: label 'newlabel' is not in the tracker's labels"]);
    });

    it("show prints what the issue blocks and what is related, with states", async () => {
      await relate();
      expect(await s().ok("show", "BL-3")).toContain("related-to:  [[BL-2]]\nblocks:      BL-1 backlog\nrelated:     BL-2 done\n");
      expect(await s().ok("show", "BL-2")).toContain("blocks:      BL-1 backlog\nrelated:     BL-1 backlog, BL-3 backlog\n");
      const plain = await s().ok("show", "BL-1");
      expect(plain).toContain("progress:    1/2  (BL-2 done, BL-3 backlog)\nrelated:     BL-2 done\n");
      expect(plain).not.toContain("blocks:");
      expect(plain).not.toContain("blocked:");
      fs.unlinkSync(s().note("BL-2"));
      expect(await s().ok("show", "BL-3")).toContain("blocks:      BL-1 backlog\nrelated:     BL-2 note missing\n");
      expect(await s().ok("show", "BL-2")).toBe("BL-2  Beta\n(note missing)\n");
    });

    it("show prints neither line without relations", async () => {
      const text = await s().ok("show", "BL-1");
      expect(text).not.toMatch(/blocks:|related:/);
    });

    it("json has related, blocks and blocked, and show keeps the stored related-to", async () => {
      await relate();
      const list = JSON.parse(await s().ok("list", "--json")) as Array<Record<string, any>>;
      expect(list.map((i) => [i.id, i.related, i.blocks, i.blocked])).toEqual([
        ["BL-1", ["BL-2"], [], true],
        ["BL-2", ["BL-1", "BL-3"], ["BL-1"], false],
        ["BL-3", ["BL-2"], ["BL-1"], false],
      ]);
      const data = await show("BL-2");
      expect([data.related, data.blocks, data.blocked]).toEqual([["BL-1", "BL-3"], ["BL-1"], false]);
      expect(data.properties["related-to"]).toEqual(["[[BL-1]]"]);
      expect(Object.keys(data).slice(7, 11)).toEqual(["blocked-by", "related", "blocks", "blocked"]);
    });

    it("list --blocked keeps the issues with an open blocker", async () => {
      await relate();
      expect(await ids("--blocked")).toEqual(["BL-1"]);
      expect(await ids("--blocked", "--status", "done")).toEqual([]);
      expect(await ids("--blocked", "--status", "backlog")).toEqual(["BL-1"]);
      expect(await s().ok("list", "--blocked")).toMatch(/^BL-1 /);
      await s().ok("set", "BL-3", "status=done");
      expect(await ids("--blocked")).toEqual([]);
    });

    it("list --blocked-by and --related-to keep the issues naming the ID", async () => {
      await relate();
      expect(await ids("--blocked-by", "BL-3")).toEqual(["BL-1"]);
      expect(await ids("--blocked-by", "BL-1")).toEqual([]);
      expect(await ids("--blocked-by", "BL-2", "--status", "done")).toEqual([]);
      expect(await ids("--related-to", "BL-2")).toEqual(["BL-1", "BL-3"]);
      expect(await ids("--related-to", "BL-1")).toEqual(["BL-2"]);
      expect(await ids("--related-to", "BL-2", "--status", "done")).toEqual([]);
      expect(await ids("--related-to", "BL-2", "--blocked")).toEqual(["BL-1"]);
      expect(await ids("--related-to", "BL-2", "--blocked-by", "BL-3")).toEqual(["BL-1"]);
    });

    it("list rejects an ID that is not an issue", async () => {
      for (const flag of ["--blocked-by", "--related-to"]) {
        for (const id of ["BL-99", "nope"]) {
          const r = await s().run("list", flag, id);
          expect(r.code, `${flag} ${id}`).toBe(1);
          expect(r.out).toBe("");
          expect(r.err).toContain(`${id}: no such issue`);
        }
      }
    });
  });

  it("show", async () => {
    expect(await s().ok("show", "BL-2")).toBe("BL-2  Beta\nstatus:      done\npriority:    none\ncreated:     2026-10-01\n");
    fs.appendFileSync(s().note("BL-2"), "\nThe body.\n\n");
    expect(await s().ok("show", "BL-2")).toContain("created:     2026-10-01\n\nThe body.\n");
    const data = await show("BL-2");
    expect(data.properties).toEqual({ title: "Beta", status: "done", priority: "none", created: "2026-10-01" });
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
    fs.writeFileSync(s().note("BL-1"), s().read(s().note("BL-1")).replace("[[BL-2]]", "[[BL-99]]"));
    await s().ok("set", "BL-1", "blocked-by+=BL-3");
    expect((await show("BL-1")).properties["blocked-by"]).toEqual(["[[BL-99]]", "[[BL-3]]"]);
  });

  it("rm clears the blockers that named the issue", async () => {
    await s().ok("set", "BL-1", "blocked-by=BL-2");
    await s().ok("rm", "BL-2");
    expect((await show("BL-1")).properties["blocked-by"]).toBeUndefined();
  });

  it("parent is an ordinary custom key", async () => {
    await s().ok("set", "BL-1", "parent=BL-99");
    expect(s().read(s().note("BL-1"))).toContain("\nparent: BL-99\n");
    await s().ok("set", "BL-1", "assignee=x");
    expect(s().read(s().note("BL-1"))).toContain("\nparent: BL-99\n");
    expect(await s().ok("show", "BL-1")).toContain("parent:      BL-99\n");
    const data = await show("BL-1");
    expect(data.properties.parent).toBe("BL-99");
    expect(Object.keys(data)).not.toContain("parent");
    expect(await s().ok("lint")).not.toMatch(/parent/);
    expect(await s().code("lint")).toBe(0);
  });

  it("set validates and leaves the note alone", async () => {
    const before = s().read(s().note("BL-1"));
    for (const assignment of ["status=nope", "priority=p0", "due=soon", "blocked-by=BL-1", "blocked-by+=nope", "title=", "status=", "nonsense"]) {
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
    await s().ok("comment", "BL-1", "from flag", "--author", "flag");
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

  it("a second index note with the same prefix is reported", async () => {
    fs.writeFileSync(join(s().dir, "Other.md"), "---\nbilinear: tracker\nprefix: BL\nnext: 1\nstates: [todo]\n---\n");
    const r = await s().run(s().index, "lint");
    expect(r.code).toBe(2);
    expect(r.out).toContain("error: Bilinear.md: Other, in the same folder, has the prefix BL too [prefix-shared]");
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
    expect(await s().raw("--version").then((r) => r.out)).toMatch(/^bilinear \d+\.\d+\.\d+\n$/);
    expect((await s().raw("--help")).out).toContain("commands:\n  init ");
    expect(await s().ok("set", "--help")).toContain("usage: bilinear <board.md> set <id> <key=value>...");
  });
});

describe("context", () => {
  const s = sandbox();
  beforeEach(async () => {
    await s().ok("new", "One");
    await s().ok("new", "Two");
  });

  it("record writes an entry from flags and prints one line", async () => {
    const r = await s().run("context", "record", "BL-1", "--type", "decision", "--subject", "Use X", "--content", "Because.", "--rationale", "Fast", "--evidence", "commit:abc", "--evidence", "url:http://x");
    expect(r).toEqual({ code: 0, out: "BL-1/D1 created\n", err: "" });
    const text = s().read(s().note("BL-1"));
    expect(text).toContain("### D1: Use X\n- status: active\n- author: rk\n- created: 2026-10-01\n- updated: 2026-10-01\n- evidence:\n  - commit:abc\n  - url:http://x\n");
    expect(text).toContain("Because.");
    expect(text).toContain("Rationale: Fast");
    expect(await s().run("lint")).toMatchObject({ code: 0 });
  });

  it("record takes its author like comment", async () => {
    await s().ok("context", "record", "BL-1", "--type", "finding", "--subject", "A");
    s().env["BILINEAR_USER"] = "env";
    await s().ok("context", "record", "BL-1", "--type", "finding", "--subject", "B");
    await s().ok("context", "record", "BL-1", "--type", "finding", "--subject", "C", "--author", "flag");
    const text = s().read(s().note("BL-1"));
    expect([...text.matchAll(/- author: (\w+)/g)].map((m) => m[1])).toEqual(["rk", "env", "flag"]);
  });

  it("record takes the type as a name or a letter, in any case, and refuses an unknown one", async () => {
    expect(await s().ok("context", "record", "BL-1", "--type", "D", "--subject", "A")).toBe("BL-1/D1 created\n");
    expect(await s().ok("context", "record", "BL-1", "--type", "Finding", "--subject", "B")).toBe("BL-1/F1 created\n");
    expect(await s().ok("context", "record", "BL-1", "--type", "c", "--subject", "C")).toBe("BL-1/C1 created\n");
    const before = s().read(s().note("BL-1"));
    for (const type of ["bogus", "x", "", "decisions"]) {
      const r = await s().run("context", "record", "BL-1", "--type", type, "--subject", "Z");
      expect(r.code, type).toBe(1);
      expect(r.err).toContain("is not a type");
    }
    expect(await s().code("context", "record", "BL-1", "--subject", "Z")).toBe(1);
    expect(await s().code("context", "record", "BL-1", "--type", "decision")).toBe(1);
    expect(s().read(s().note("BL-1"))).toBe(before);
  });

  it("record writes a rejected entry from five flags, and refuses without --failed", async () => {
    const flags = ["--type", "rejected", "--subject", "Polling", "--attempted", "Poll", "--promising", "Simple", "--happened", "Slow", "--applies", "Always"];
    const before = s().read(s().note("BL-1"));
    const bad = await s().run("context", "record", "BL-1", ...flags);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("--failed");
    expect(s().read(s().note("BL-1"))).toBe(before);
    expect(await s().ok("context", "record", "BL-1", ...flags, "--failed", "Too slow")).toBe("BL-1/R1 created\n");
    const text = s().read(s().note("BL-1"));
    for (const line of ["Attempted: Poll", "Promising: Simple", "Happened: Slow", "Failed: Too slow", "Applies: Always"]) expect(text).toContain(line);
    expect(await s().code("context", "record", "BL-1", "--type", "decision", "--subject", "D", "--failed", "x")).toBe(1);
  });

  it("record prints superseded, skips a duplicate and asks for --supersedes or --new", async () => {
    const rec = (...a: string[]) => s().run("context", "record", "BL-1", "--type", "decision", ...a);
    expect((await rec("--subject", "Use X", "--content", "One.")).out).toBe("BL-1/D1 created\n");
    const second = await rec("--subject", "Use Y", "--content", "Two.", "--supersedes", "D1");
    expect(second).toMatchObject({ code: 0, out: "BL-1/D2 created\n  superseded: BL-1/D1\n" });
    expect(s().read(s().note("BL-1"))).toContain("- superseded-by: D2");
    const before = s().read(s().note("BL-1"));
    expect(await rec("--subject", "Use Y", "--content", "Two.")).toMatchObject({ code: 0, out: "BL-1/D2 skipped (duplicate)\n" });
    expect(s().read(s().note("BL-1"))).toBe(before);
    const clash = await rec("--subject", "Use Y", "--content", "Other.");
    expect(clash.code).toBe(1);
    expect(clash.err).toContain("--supersedes");
    expect(clash.err).toContain("--new");
    expect(s().read(s().note("BL-1"))).toBe(before);
    expect((await rec("--subject", "Use Y", "--content", "Other.", "--new")).out).toBe("BL-1/D3 created\n  warning: similar active decision entries: BL-1/D2 (Use Y)\n");
  });

  it("record takes --supersedes repeated or as a comma list, and prints warnings", async () => {
    const rec = (...a: string[]) => s().ok("context", "record", "BL-1", "--type", "decision", ...a);
    await rec("--subject", "Alpha one", "--content", "a");
    await rec("--subject", "Beta two", "--content", "b");
    await rec("--subject", "Gamma three", "--content", "c");
    expect(await rec("--subject", "Delta four", "--supersedes", "D1,D2", "--supersedes", "BL-1/D3")).toBe("BL-1/D4 created\n  superseded: BL-1/D1 BL-1/D2 BL-1/D3\n");
    await rec("--subject", "Epsilon five", "--content", "e");
    const out = await rec("--subject", "Epsilon five today", "--content", "other");
    expect(out).toMatch(/^BL-1\/D6 created\n {2}warning: similar active decision entries: BL-1\/D5 \(Epsilon five\)\n$/);
  });

  it("record --file - reads a JSON array from the standard input", async () => {
    s().stdin = JSON.stringify([
      { type: "decision", subject: "Use X", content: "Because.", evidence: ["commit:abc"] },
      { type: "R", subject: "Polling", rejected: { attempted: "A", failed: "F" }, applies: "Never" },
      { type: "finding", subject: "Found", supersedes: [], new: true },
    ]);
    const r = await s().run("context", "record", "BL-1", "--file", "-");
    expect(r).toEqual({ code: 0, out: "BL-1/D1 created\nBL-1/R1 created\nBL-1/F1 created\n", err: "" });
    const text = s().read(s().note("BL-1"));
    expect(text).toContain("Applies: Never");
    expect(text).toContain("Failed: F");
  });

  it("record --file reads a path and accepts one object", async () => {
    const path = join(s().root, "entry.json");
    const entry = { type: "constraint", subject: "Limit", content: "No more." };
    fs.writeFileSync(path, JSON.stringify({ ...entry, supersedes: "D9" }));
    const missing = await s().run("context", "record", "BL-1", "--file", path);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("input 1 (Limit)");
    fs.writeFileSync(path, JSON.stringify(entry));
    expect(await s().ok("context", "record", "BL-1", "--file", path)).toBe("BL-1/C1 created\n");
    fs.writeFileSync(path, "\uFEFF" + JSON.stringify(entry));
    expect(await s().ok("context", "record", "BL-1", "--file", path)).toBe("BL-1/C1 skipped (duplicate)\n");
    const none = await s().run("context", "record", "BL-1", "--file", join(s().root, "none.json"));
    expect(none.code).toBe(1);
    expect(none.err).toContain("cannot read the file");
  });

  it("record --file names the item and the key of a bad input, and writes nothing", async () => {
    const before = s().read(s().note("BL-1"));
    const good = { type: "decision", subject: "Fine" };
    const cases: Array<[string, RegExp]> = [
      ["{not json", /not valid JSON/],
      ["[]", /no entries/],
      [JSON.stringify([good, { ...good, colour: "red" }]), /item 2: unknown key 'colour'/],
      [JSON.stringify([good, { ...good, content: 5 }]), /item 2: 'content' must be a string/],
      [JSON.stringify([{ ...good, evidence: "commit:a" }]), /item 1: 'evidence' must be an array of strings/],
      [JSON.stringify([{ ...good, new: "yes" }]), /item 1: 'new' must be true or false/],
      [JSON.stringify([good, { type: "bogus", subject: "S" }]), /item 2: 'bogus' is not a type in key 'type'/],
      [JSON.stringify([{ subject: "S" }]), /item 1: 'type' is required/],
      [JSON.stringify([good, 7]), /item 2: must be an object/],
      [JSON.stringify([{ type: "rejected", subject: "S", rejected: { attempted: "a", nope: "x" } }]), /item 1: unknown key 'nope' in 'rejected'/],
      [JSON.stringify([{ type: "rejected", subject: "S", failed: 1 }]), /item 1: 'failed' must be a string/],
      // Valid in shape, refused by the op in the second item: the first is not written either.
      [JSON.stringify([good, { type: "decision", subject: "Next", supersedes: ["D9"] }]), /input 2 \(Next\)/],
    ];
    for (const [text, expected] of cases) {
      s().stdin = text;
      const r = await s().run("context", "record", "BL-1", "--file", "-");
      expect(r.code, text).toBe(1);
      expect(r.err, text).toMatch(expected);
      expect(s().read(s().note("BL-1")), text).toBe(before);
    }
  });

  it("record refuses --file with an entry flag, a bad target and a missing note, each with a reason", async () => {
    s().stdin = JSON.stringify({ type: "decision", subject: "A" });
    const cases: Array<[string[], RegExp]> = [
      [["BL-1", "--file", "-", "--type", "decision"], /--file cannot go with --type/],
      [["BL-1", "--file", "-", "--new"], /--file cannot go with --new/],
      [["--file", "-"], /record needs one target/],
      [["BL-1", "BL-2", "--file", "-"], /record needs one target/],
      [["bogus!", "--file", "-"], /'bogus!' is not an issue ID/],
      [["BL-9", "--file", "-"], /BL-9/],
      [["XX", "--file", "-"], /XX/],
    ];
    for (const [argv, expected] of cases) {
      const r = await s().run("context", "record", ...argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err, argv.join(" ")).toMatch(expected);
    }
    expect(s().read(s().note("BL-1"))).not.toContain("###");
    expect(s().read(s().note("BL-2"))).not.toContain("###");
  });

  it("record checks the target before it reads the standard input", async () => {
    s().stdin = new OpError("the standard input is a terminal");
    const bad = await s().run("context", "record", "bogus!", "--file", "-");
    expect(bad.err).toContain("is not an issue ID");
    const tty = await s().run("context", "record", "BL-1", "--file", "-");
    expect(tty.code).toBe(1);
    expect(tty.err).toContain("the standard input is a terminal");
    s().stdin = "  \n";
    const empty = await s().run("context", "record", "BL-1", "--file", "-");
    expect(empty.code).toBe(1);
    expect(empty.err).toContain("the standard input is empty");
    expect(empty.err).not.toContain("not valid JSON");
  });

  it("record names the item and the key for each shape error", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [[{ type: "rejected", subject: "S", failed: "x", rejected: { failed: "y" } }], /item 1: key 'failed' is given twice/],
      [[{ type: "decision", subject: "S" }, { type: "decision", subject: "T", supersedes: 5 }], /item 2: 'supersedes' must be a string or an array of strings/],
      [[{ type: "decision", subject: "S", supersedes: ["D1", 2] }], /item 1: 'supersedes' must be/],
      [[{ type: "rejected", subject: "S", rejected: "no" }], /item 1: 'rejected' must be an object/],
      [[{ type: "rejected", subject: "S", rejected: ["a"] }], /item 1: 'rejected' must be an object/],
      [[{ type: "decision", content: "x" }], /item 1: 'subject' is required/],
      [[{ type: "decision", subject: 3 }], /item 1: 'subject' must be a string/],
      [[{ type: 4, subject: "S" }], /item 1: 'type' must be a string/],
      [[{ type: "rejected", subject: "S", rejected: { attempted: 1 } }], /item 1: 'rejected': 'attempted' must be a string/],
    ];
    const before = s().read(s().note("BL-1"));
    for (const [data, expected] of cases) {
      s().stdin = JSON.stringify(data);
      const r = await s().run("context", "record", "BL-1", "--file", "-");
      expect(r.code, s().stdin as string).toBe(1);
      expect(r.err, s().stdin as string).toMatch(expected);
    }
    expect(s().read(s().note("BL-1"))).toBe(before);
  });

  it("record refuses a value that starts with a dash and names the fix, and takes the equals form", async () => {
    const bad = await s().run("context", "record", "BL-1", "--type", "decision", "--subject", "A", "--content", "- first item");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("Option '--content' argument is ambiguous.");
    expect(bad.err).toContain("--content=VALUE");
    expect(bad.err).toContain("give the entry with --file");
    expect(s().read(s().note("BL-1"))).not.toContain("###");
    expect(await s().ok("context", "record", "BL-1", "--type", "decision", "--subject", "A", "--content=- first item")).toBe("BL-1/D1 created\n");
    const [e] = JSON.parse((await s().run("context", "get", "BL-1/D1", "--json")).out);
    expect(e.content).toBe("- first item");
    expect((await s().run("context", "--help")).out).toContain("--content=");
    const other = await s().run("new", "Title", "--description", "- step one");
    expect(other.code).toBe(1);
    expect(other.err).toContain("--description=VALUE");
    expect(other.err).not.toContain("give the entry with --file");
  });

  it("record refuses a flag with no value, and takes the last of a repeated single-value flag", async () => {
    const none = await s().run("context", "record", "BL-1", "--type", "decision", "--subject");
    expect(none.code).toBe(1);
    expect(none.err).toContain("argument missing");
    expect(s().read(s().note("BL-1"))).not.toContain("###");
    expect(await s().ok("context", "record", "BL-1", "--type", "decision", "--subject", "First", "--subject", "Last")).toBe("BL-1/D1 created\n");
    expect(s().read(s().note("BL-1"))).toContain("### D1: Last");
  });

  it("record --json prints the results", async () => {
    await s().ok("context", "record", "BL-1", "--type", "decision", "--subject", "Old", "--content", "o");
    const r = await s().run("context", "record", "BL-1", "--type", "decision", "--subject", "New", "--content", "n", "--supersedes", "D1", "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([{ id: "BL-1/D2", action: "created", superseded: ["BL-1/D1"], warnings: [] }]);
    s().stdin = JSON.stringify([{ type: "decision", subject: "New", content: "n" }]);
    expect(JSON.parse((await s().run("context", "record", "BL-1", "--file", "-", "--json")).out)).toEqual([{ id: "BL-1/D2", action: "skipped", superseded: [], warnings: [] }]);
  });

  it("record in the tracker scope writes to the index note", async () => {
    expect(await s().ok("context", "record", "BL", "--type", "constraint", "--subject", "House rule", "--content", "Always.")).toBe("BL/C1 created\n");
    const index = s().read(s().index);
    expect(index).toContain("### C1: House rule");
    expect(index).toContain("Always.");
    expect(s().read(s().note("BL-1"))).not.toContain("###");
    expect(await s().run("lint")).toMatchObject({ code: 0 });
    expect(await s().code("context", "record", "XX", "--type", "decision", "--subject", "A")).toBe(1);
  });

  it("get prints entries of an issue and of the tracker, as text and as JSON", async () => {
    await s().ok("context", "record", "BL-1", "--type", "decision", "--subject", "Use X", "--content", "Because.", "--rationale", "Fast", "--evidence", "commit:abc");
    await s().ok("context", "record", "BL", "--type", "constraint", "--subject", "House rule", "--content", "Always.");
    const r = await s().run("context", "get", "BL-1/D1", "BL/C1");
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toBe("## BL-1/D1");
    expect(lines[1]).toBe("### D1: Use X");
    expect(r.out).toContain("\n\n## BL/C1\n### C1: House rule\n");
    expect(r.out.endsWith("Always.\n")).toBe(true);
    expect(r.out).toContain("Rationale: Fast");
    expect((await s().run("context", "get", "BL-1/D1,BL/C1")).out).toBe(r.out);
    const j = JSON.parse((await s().run("context", "get", "BL-1/D1", "BL/C1", "--json")).out);
    expect(j).toHaveLength(2);
    expect(j[0]).toEqual({
      id: "BL-1/D1",
      type: "decision",
      number: 1,
      subject: "Use X",
      status: "active",
      author: "rk",
      created: "2026-10-01",
      updated: "2026-10-01",
      content: "Because.",
      rationale: "Fast",
      alternatives: "",
      evidence: ["commit:abc"],
      supersedes: [],
      supersededBy: null,
      rejected: null,
    });
    expect(j[1]).toMatchObject({ id: "BL/C1", type: "constraint", content: "Always." });
  });

  it("get returns a superseded entry with its evidence, and a rejected entry with its fields", async () => {
    await s().ok("context", "record", "BL-1", "--type", "decision", "--subject", "Old", "--content", "o", "--evidence", "commit:abc");
    await s().ok("context", "record", "BL-1", "--type", "decision", "--subject", "New", "--content", "n", "--supersedes", "D1");
    await s().ok("context", "record", "BL-1", "--type", "rejected", "--subject", "Polling", "--attempted", "Poll", "--failed", "Slow", "--applies", "Always");
    const [old, fresh, rej] = JSON.parse((await s().run("context", "get", "BL-1/D1", "BL-1/D2", "BL-1/R1", "--json")).out);
    expect(old).toMatchObject({ status: "superseded", evidence: ["commit:abc"], supersededBy: "BL-1/D2" });
    expect(fresh).toMatchObject({ status: "active", supersedes: ["BL-1/D1"] });
    expect(rej.rejected).toEqual({ attempted: "Poll", promising: "", happened: "", failed: "Slow", applies: "Always" });
    const text = (await s().run("context", "get", "BL-1/D1")).out;
    expect(text).toContain("- status: superseded");
    expect(text).toContain("  - commit:abc");
  });

  it("get trims the leading line break of a labelled value in JSON", async () => {
    await s().ok("context", "record", "BL-1", "--type", "decision", "--subject", "Fenced", "--rationale", "```\ncode\n```");
    const [e] = JSON.parse((await s().run("context", "get", "BL-1/D1", "--json")).out);
    expect(e.rationale).toBe("```\ncode\n```");
  });

  it("get refuses an unknown ID and no ID", async () => {
    await s().ok("context", "record", "BL-1", "--type", "decision", "--subject", "A");
    for (const id of ["BL-1/D9", "BL-9/D1", "XX/D1", "BL-1", "nonsense"]) {
      const r = await s().run("context", "get", id);
      expect(r.code, id).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toContain(id);
    }
    expect((await s().run("context", "get", "BL-1/D1", "BL-1/D9")).out).toBe("");
    const none = await s().run("context", "get");
    expect(none.code).toBe(1);
    expect(none.err).toContain("usage: bilinear <board.md> context");
  });

  it("an unknown or missing subcommand is a usage error that lists the subcommands", async () => {
    for (const argv of [["context"], ["context", "bogus"], ["context", "list", "BL-1"]]) {
      const r = await s().run(...argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err).toContain("record, get");
    }
    expect((await s().run("context", "--help")).out).toContain("context record");
    expect((await s().raw("--help")).out).toMatch(/\n {2}context +record context entries/);
  });
});

describe("show with context", () => {
  const s = sandbox();
  const L0_HEADER = /CONTEXT BL-1 \(L0, \d+ of 8000 chars; /;
  const record = (...argv: string[]) => s().ok("context", "record", ...argv);
  const rejected = ["BL-1", "--type", "rejected", "--subject", "Try A", "--attempted", "Used A", "--failed", "It broke", "--applies", "always"];
  const decision = (subject = "Use X") => ["BL-1", "--type", "decision", "--subject", subject, "--content", "Because."];
  const state = ["BL-1", "--type", "state", "--subject", "Doing it", "--content", "Half done."];
  const showJson = async (id = "BL-1") => JSON.parse(await s().ok("show", id, "--json"));

  beforeEach(async () => {
    await s().ok("new", "One", "--description", "Intro text.\n\n### Sub\n\nMore.");
    await s().ok("comment", "BL-1", "hello");
  });

  it("an issue without entries shows as before, with an empty context in json", async () => {
    expect(await s().ok("show", "BL-1")).toBe(
      "BL-1  One\nstatus:      backlog\npriority:    none\ncreated:     2026-10-01\n\nIntro text.\n\n### Sub\n\nMore.\n\n## Comments\n- 2026-10-01 rk: hello\n",
    );
    const j = await showJson();
    expect(j.context).toEqual({ l0: "", chars: 0, cap: 8000, counts: { active: 0, superseded: 0, resolved: 0, tracker: 0 }, shown: [], omitted: [] });
  });

  it("an empty Context section and a missing note change nothing", async () => {
    s().edit(s().note("BL-1"), "## Comments", "## Context\n\n## Comments");
    const text = await s().ok("show", "BL-1");
    expect(text).toContain("## Context\n");
    expect(text).not.toContain("CONTEXT BL-1");
    await s().ok("new", "Two");
    fs.rmSync(s().note("BL-2"));
    expect(await s().ok("show", "BL-2")).toBe("BL-2  Two\n(note missing)\n");
    expect((await showJson("BL-2")).context.l0).toBe("");
  });

  it("puts the L0 text after the properties and before the description, in place of the Context section", async () => {
    await record(...rejected);
    await record(...decision());
    await record(...state);
    const text = await s().ok("show", "BL-1");
    expect(text).toMatch(L0_HEADER);
    expect(text).toContain("Rejected (do not retry):\n  R1 Try A - failed: It broke\n");
    expect(text).toContain("Decisions:\n  D1 Use X - Because.\n");
    expect(text).toContain("State: S1");
    expect(text).not.toContain("- status: active");
    expect(text).not.toContain("## Context");
    expect(text).toContain("## Comments\n- 2026-10-01 rk: hello\n");
    expect(text).toMatch(/created: {5}2026-10-01\n\nCONTEXT BL-1 [^]*\n\nIntro text\.\n\n### Sub\n\nMore\.\n\n## Comments\n/);
    expect(text.indexOf("CONTEXT BL-1")).toBeLessThan(text.indexOf("Intro text.\n\n###"));
  });

  it("keeps the whole description, with its own headings, before the Context section", async () => {
    await record(...decision());
    const text = await s().ok("show", "BL-1");
    expect(text).toContain("\n\nIntro text.\n\n### Sub\n\nMore.\n\n## Comments\n");
  });

  it("shows a tracker constraint, with its full ID, in an issue that has no entry of its own", async () => {
    await record("BL", "--type", "constraint", "--subject", "No net", "--content", "Offline.");
    const text = await s().ok("show", "BL-1");
    expect(text).toMatch(L0_HEADER);
    expect(text).toContain("Tracker constraints:\n  BL/C1 No net - Offline.\n");
    expect(text).not.toContain("## Context");
    expect((await showJson()).context.counts).toMatchObject({ active: 0, tracker: 1 });
  });

  it("gives the same L0 text to a new process as to the first one", async () => {
    await record(...rejected);
    await record(...decision());
    await record("BL", "--type", "constraint", "--subject", "No net", "--content", "Offline.");
    const first = await s().ok("show", "BL-1");
    const l0 = (await showJson()).context.l0;
    const again = new Sandbox();
    try {
      fs.cpSync(s().vault, again.vault, { recursive: true });
      expect(await again.ok("show", "BL-1")).toBe(first);
      expect((JSON.parse(await again.ok("show", "BL-1", "--json")) as { context: unknown }).context).toEqual((await showJson()).context);
    } finally {
      fs.rmSync(again.root, { recursive: true, force: true });
    }
    expect(first).toContain(l0.replace(/\n+$/, ""));
  });

  it("does not list a superseded decision and counts it in the index", async () => {
    await record(...decision("Use X"));
    await record(...decision("Use Y"), "--supersedes", "D1");
    const text = await s().ok("show", "BL-1");
    expect(text).toContain("  D2 Use Y - Because.");
    expect(text).not.toContain("  D1 Use X");
    const j = await showJson();
    expect(j.context.counts).toMatchObject({ active: 1, superseded: 1 });
    expect(j.context.shown).toEqual(["BL-1/D2"]);
    expect(j.context.l0).toContain("superseded (1): D1");
  });

  it("adds a hint when a comment is newer than the last entry", async () => {
    await record(...decision());
    expect(await s().ok("show", "BL-1")).not.toContain("Hint:");
    s().env.BILINEAR_TODAY = "2026-10-03";
    await s().ok("comment", "BL-1", "later");
    const text = await s().ok("show", "BL-1");
    expect(text).toContain("Hint:");
    expect(text).toContain("context checkpoint BL-1");
  });

  it("json has the context and keeps the raw body", async () => {
    await record(...decision());
    const j = await showJson();
    expect(Object.keys(j.context).sort()).toEqual(["cap", "chars", "counts", "l0", "omitted", "shown"]);
    expect(j.context.l0).toMatch(L0_HEADER);
    expect(j.context.chars).toBe(j.context.l0.length);
    expect(j.context.cap).toBe(8000);
    expect(j.context.shown).toEqual(["BL-1/D1"]);
    expect(j.body).toContain("## Context");
    expect(j.body).toContain("- status: active");
  });

  it("shows the L0 text of an archived issue", async () => {
    await record(...decision());
    await s().ok("archive", "BL-1");
    const text = await s().ok("show", "BL-1");
    expect(text).toMatch(L0_HEADER);
    expect(text).toContain("archived:    yes");
    expect((await showJson()).context.shown).toEqual(["BL-1/D1"]);
  });

  it("keeps the L0 text within the cap for a note with 300 entries", async () => {
    const entries = Array.from(
      { length: 300 },
      (_, i) => `### D${i + 1}: Decision number ${i + 1} about topic ${i * 7}\n- status: active\n- author: rk\n- created: 2026-10-01\n- updated: 2026-10-01\n\n${"Long content. ".repeat(20)}\n`,
    );
    s().edit(s().note("BL-1"), "## Comments", `## Context\n\n${entries.join("\n")}\n## Comments`);
    const j = await showJson();
    expect(j.context.chars).toBe(j.context.l0.length);
    expect(j.context.chars).toBeLessThanOrEqual(8000);
    expect(j.context.counts.active).toBe(300);
    expect(j.context.shown.length + j.context.omitted.length).toBe(300);
    expect((await s().ok("show", "BL-1")).length).toBeLessThan(20000);
  });

  it("shows an issue without entries byte for byte as before: hand-written Context, archived", async () => {
    const plain = "BL-1  One\nstatus:      backlog\npriority:    none\ncreated:     2026-10-01\n\nIntro text.\n\n### Sub\n\nMore.\n\n";
    s().edit(s().note("BL-1"), "## Comments", "## Context\n\n## Comments");
    expect(await s().ok("show", "BL-1")).toBe(`${plain}## Context\n\n## Comments\n- 2026-10-01 rk: hello\n`);
    s().edit(s().note("BL-1"), "## Context\n\n## Comments", "## Context\n\nMy notes.\n\n## Comments");
    expect(await s().ok("show", "BL-1")).toBe(`${plain}## Context\n\nMy notes.\n\n## Comments\n- 2026-10-01 rk: hello\n`);
    await s().ok("archive", "BL-1");
    expect(await s().ok("show", "BL-1")).toBe(`${plain.replace("created:     2026-10-01\n", "created:     2026-10-01\narchived:    yes\n")}## Context\n\nMy notes.\n\n## Comments\n- 2026-10-01 rk: hello\n`);
  });

  it("does not turn the block on for a tracker with only superseded entries", async () => {
    await record("BL", "--type", "constraint", "--subject", "No net", "--content", "Offline.");
    s().edit(s().index, "status: active", "status: superseded");
    const text = await s().ok("show", "BL-1");
    expect(text).not.toContain("CONTEXT BL-1");
    expect((await showJson()).context.l0).toBe("");
  });

  it("shows no hint for an issue that has a comment and no entry of its own", async () => {
    await record("BL", "--type", "constraint", "--subject", "No net", "--content", "Offline.");
    const text = await s().ok("show", "BL-1");
    expect(text).toContain("Tracker constraints:");
    expect(text).not.toContain("Hint:");
  });

  it("keeps hand-written text of the Context section: (A) no entry, active tracker entry", async () => {
    await record("BL", "--type", "constraint", "--subject", "No net", "--content", "Offline.");
    s().edit(s().note("BL-1"), "## Comments", "## Context\n\nMy notes.\n\n## Comments");
    const text = await s().ok("show", "BL-1");
    expect(text).toContain("Tracker constraints:\n  BL/C1 No net");
    expect(text).toContain("## Context\n\nMy notes.\n");
  });

  it("keeps hand-written text of the Context section: (B) an entry, prose and a Notes block", async () => {
    await record(...decision());
    s().edit(s().note("BL-1"), "## Context\n\n", "## Context\n\nMy prose.\n\n");
    s().edit(s().note("BL-1"), "## Comments", "### Notes\n\nMy notes.\n\n## Comments");
    const text = await s().ok("show", "BL-1");
    expect(text).toMatch(L0_HEADER);
    expect(text).toContain("## Context\n\nMy prose.\n");
    expect(text).toContain("### Notes\n\nMy notes.\n");
    expect(text).not.toContain("### D1");
    expect(text).not.toContain("- status: active");
    expect(text).toContain("## Comments\n- 2026-10-01 rk: hello\n");
  });

  it("uses the same title rule as the op when the title line is missing", async () => {
    await record(...decision());
    const note = fs.readFileSync(s().note("BL-1"), "utf8").replace(/^title: .*\n/m, "");
    fs.writeFileSync(s().note("BL-1"), note);
    const t = { io: new NodeIO({ readOnly: true }), dir: slashed(s().dir), indexPath: slashed(s().index) };
    const view = await contextView(t, "BL-1");
    expect(view.text).toMatch(L0_HEADER);
    expect((await showJson()).context.l0).toBe(view.text);
  });
});
