// Behaviour of the ops that the shared fixtures do not pin down.

import { beforeEach, describe, expect, it } from "vitest";
import { OpError, type Tracker } from "../src/ops/io";
import { archiveIssues, commentIssue, createIssue, createTracker, deleteIssue, moveIssue, recreateNote, setProps } from "../src/ops/issues";
import { lint } from "../src/ops/lint";
import { listIssues } from "../src/ops/tracker";
import { parseEmbed } from "../src/view/embed-options";
import { MemoryIO } from "./memory-io";

let io: MemoryIO;
let t: Tracker;
const index = () => io.files.get("T/RedBolt/RedBolt.md")!;
const ids = async () => (await listIssues(t)).map((i) => i.id);

beforeEach(async () => {
  io = new MemoryIO();
  const indexPath = await createTracker(io, "T/RedBolt", "RB");
  t = { io, dir: "T/RedBolt", indexPath };
});

describe("createTracker", () => {
  it("names the index after the folder", () => {
    expect(t.indexPath).toBe("T/RedBolt/RedBolt.md");
    expect(index().startsWith("---\nbilinear: tracker\nprefix: RB\nnext: 1\n")).toBe(true);
  });

  it("refuses a bad prefix, an existing tracker and a foreign note", async () => {
    await expect(createTracker(io, "T/Other", "rb")).rejects.toThrow(OpError);
    await expect(createTracker(io, "T/RedBolt", "RB")).rejects.toThrow(/already contains a tracker/);
    io.files.set("T/Plain/Plain.md", "just a note\n");
    await expect(createTracker(io, "T/Plain", "PL")).rejects.toThrow(/not a tracker index/);
    await expect(createTracker(io, "", "RB")).rejects.toThrow(OpError);
  });
});

describe("ID allocation", () => {
  it("is sequential", async () => {
    expect(await createIssue(t, { title: "A" }, "2026-10-01")).toBe("RB-1");
    expect(await createIssue(t, { title: "B" }, "2026-10-01")).toBe("RB-2");
    expect(index()).toContain("next: 3\n");
  });

  it("skips numbers seen in the index, the folder and archive/", async () => {
    io.files.set("T/RedBolt/RB-7.md", "stray");
    expect(await createIssue(t, { title: "A" }, "2026-10-01")).toBe("RB-8");
    io.files.set("T/RedBolt/archive/RB-12.md", "stray");
    expect(await createIssue(t, { title: "B" }, "2026-10-01")).toBe("RB-13");
    io.files.set(t.indexPath, index().replace("next: 14", "next: 2").replace("- [[RB-13]] B", "- [[RB-13]] B\n- [[RB-30]] no note"));
    expect(await createIssue(t, { title: "C" }, "2026-10-01")).toBe("RB-31");
    expect(index()).toContain("next: 32\n");
    expect(io.files.get("T/RedBolt/RB-7.md")).toBe("stray");
  });

  it("retries when the name is taken between looking and creating", async () => {
    const real = io.listNotes.bind(io);
    let raced = false;
    io.listNotes = async (folder) => {
      const found = await real(folder);
      if (!raced) {
        raced = true;
        io.files.set("T/RedBolt/RB-1.md", "theirs");
        io.files.set("T/RedBolt/archive/RB-2.md", "theirs");
      }
      return found;
    };
    expect(await createIssue(t, { title: "Mine" }, "2026-10-01")).toBe("RB-3");
    expect(io.files.get("T/RedBolt/RB-1.md")).toBe("theirs");
    expect(index()).toContain("next: 4\n");
  });

  it("works with a tracker at the vault root", async () => {
    const root = new MemoryIO();
    root.files.set("Board.md", index());
    const rt: Tracker = { io: root, dir: "", indexPath: "Board.md" };
    expect(await createIssue(rt, { title: "A" }, "2026-10-01")).toBe("RB-1");
    await archiveIssues(rt, ["RB-1"]);
    expect([...root.files.keys()].sort()).toEqual(["Board.md", "archive/RB-1.md"]);
  });
});

describe("the index write is the commit point", () => {
  it("re-applies the change to what the index holds at write time", async () => {
    await createIssue(t, { title: "A" }, "2026-10-01");
    io.beforeProcess = (path) => {
      if (path !== t.indexPath) return;
      io.beforeProcess = null;
      io.files.set(path, index().replace("\n## Issues\n", "\nEdited meanwhile.\n\n## Issues\n"));
    };
    expect(await createIssue(t, { title: "B" }, "2026-10-01")).toBe("RB-2");
    expect(index()).toContain("Edited meanwhile.");
    expect(index()).toContain("- [[RB-1]] A\n- [[RB-2]] B\n");
  });

  it("an interrupted create leaves a stray note that lint reports", async () => {
    io.beforeProcess = () => {
      throw new Error("interrupted");
    };
    await expect(createIssue(t, { title: "A" }, "2026-10-01")).rejects.toThrow("interrupted");
    io.beforeProcess = null;
    expect(await ids()).toEqual([]);
    expect((await lint(t, false)).map((p) => p.code)).toEqual(["orphan", "next-low"]);
    expect(await createIssue(t, { title: "B" }, "2026-10-01")).toBe("RB-2");
  });
});

describe("validation", () => {
  beforeEach(async () => {
    await createIssue(t, { title: "A" }, "2026-10-01");
    await createIssue(t, { title: "B", parent: "RB-1" }, "2026-10-01");
  });

  it("refuses bad values on create and leaves nothing behind", async () => {
    for (const bad of [{ status: "nope" }, { priority: "p0" }, { due: "soon" }, { parent: "RB-99" }, { title: "  " }]) {
      await expect(createIssue(t, { title: "X", ...bad }, "2026-10-01"), JSON.stringify(bad)).rejects.toThrow(OpError);
    }
    expect(await ids()).toEqual(["RB-1", "RB-2"]);
    expect(io.files.size).toBe(3);
  });

  it("refuses bad edits and leaves the note alone", async () => {
    const before = io.files.get("T/RedBolt/RB-1.md");
    const bad: Array<Record<string, string | string[] | null>> = [
      { status: "nope" }, { status: null }, { priority: "p0" }, { due: "soon" }, { parent: "RB-1" }, { parent: "RB-99" },
      { "blocked-by": ["RB-1"] }, { title: "" },
    ];
    for (const edits of bad) {
      await expect(setProps(t, "RB-1", { assignee: "x", ...edits }), JSON.stringify(edits)).rejects.toThrow(OpError);
      expect(io.files.get("T/RedBolt/RB-1.md")).toBe(before);
    }
    await expect(setProps(t, "RB-99", { status: "todo" })).rejects.toThrow(/no such issue/);
  });

  it("refuses to reorder archived issues or around itself", async () => {
    await archiveIssues(t, ["RB-2"]);
    await expect(moveIssue(t, "RB-2", "top")).rejects.toThrow(/archived/);
    await expect(moveIssue(t, "RB-1", "after", "RB-2")).rejects.toThrow(/archived/);
    await expect(moveIssue(t, "RB-1", "before", "RB-1")).rejects.toThrow(/itself/);
    await expect(moveIssue(t, "RB-1", "before")).rejects.toThrow(OpError);
  });

  it("empty text removes optional keys; comments need text", async () => {
    await setProps(t, "RB-1", { assignee: "rk", estimate: "3" });
    await setProps(t, "RB-1", { assignee: "", estimate: null });
    expect(io.files.get("T/RedBolt/RB-1.md")).toBe("---\ntitle: A\nstatus: backlog\npriority: none\ncreated: 2026-10-01\n---\n");
    await expect(commentIssue(t, "RB-1", "  ", "rk", "2026-10-01")).rejects.toThrow(OpError);
  });
});

describe("missing notes", () => {
  beforeEach(async () => {
    await createIssue(t, { title: "A" }, "2026-10-01");
    await createIssue(t, { title: "B" }, "2026-10-01");
    io.files.delete("T/RedBolt/RB-2.md");
  });

  it("can be recreated from the index line", async () => {
    expect(await recreateNote(t, "RB-2", "2026-10-05")).toBe("T/RedBolt/RB-2.md");
    expect(io.files.get("T/RedBolt/RB-2.md")).toBe("---\ntitle: B\nstatus: backlog\npriority: none\ncreated: 2026-10-05\n---\n");
    await expect(recreateNote(t, "RB-2", "2026-10-05")).rejects.toThrow(/exists/);
    expect(await lint(t, false)).toEqual([]);
  });

  it("can be removed without a note to trash", async () => {
    await deleteIssue(t, "RB-2");
    expect(await ids()).toEqual(["RB-1"]);
    expect(io.trashed).toEqual([]);
  });

  it("cannot be edited or commented on", async () => {
    await expect(setProps(t, "RB-2", { status: "todo" })).rejects.toThrow(/note missing/);
    await expect(commentIssue(t, "RB-2", "hi", "rk", "2026-10-01")).rejects.toThrow(/note missing/);
  });
});

describe("embed options", () => {
  it("parses key: value lines", () => {
    expect(parseEmbed("tracker: Trackers/RedBolt\nstatus: todo, in-progress\nlabel: bug\nassignee: rk, none\nlimit: 10\narchived: yes\nsearch: cache\nnonsense\n")).toEqual({
      tracker: "Trackers/RedBolt",
      filter: { text: "cache", status: ["todo", "in-progress"], priority: [], labels: ["bug"], assignee: ["rk", ""] },
      archived: true,
      limit: 10,
    });
    expect(parseEmbed("")).toMatchObject({ tracker: null, archived: false, limit: 0 });
  });
});
