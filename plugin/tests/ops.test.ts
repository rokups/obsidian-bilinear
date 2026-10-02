// Behaviour of the ops that the shared fixtures do not pin down.

import { beforeEach, describe, expect, it } from "vitest";
import { OpError, type Tracker } from "../src/ops/io";
import { adoptIssue, archiveIssues, commentIssue, createIssue, createTracker, deleteIssue, moveIssue, recreateNote, setLabel, setProps, unarchiveIssues, unrelate } from "../src/ops/issues";
import { lint } from "../src/ops/lint";
import { listIssues } from "../src/ops/tracker";
import { parseEmbed } from "../src/view/embed-options";
import { MemoryIO } from "./memory-io";

let io: MemoryIO;
let t: Tracker;
const index = () => io.files.get("T/Bilinear/Bilinear.md")!;
const ids = async () => (await listIssues(t)).map((i) => i.id);

beforeEach(async () => {
  io = new MemoryIO();
  const indexPath = await createTracker(io, "T/Bilinear/Bilinear.md", "BL");
  t = { io, dir: "T/Bilinear", indexPath };
});

describe("createTracker", () => {
  it("makes the index note where it is told", () => {
    expect(t.indexPath).toBe("T/Bilinear/Bilinear.md");
    expect(index().startsWith("---\nbilinear: tracker\nprefix: BL\nnext: 1\n")).toBe(true);
  });

  it("refuses a bad prefix, an existing tracker, a foreign note and a name that is not a note's", async () => {
    await expect(createTracker(io, "T/Other/Other.md", "bl")).rejects.toThrow(OpError);
    await expect(createTracker(io, "T/Bilinear/Bilinear.md", "OT")).rejects.toThrow(/already a tracker/);
    io.files.set("T/Plain/Plain.md", "just a note\n");
    await expect(createTracker(io, "T/Plain/Plain.md", "PL")).rejects.toThrow(/not a tracker index/);
    await expect(createTracker(io, "T/Other", "OT")).rejects.toThrow(/must be a Markdown note/);
    await expect(createTracker(io, "T/Other/.md", "OT")).rejects.toThrow(/must be a Markdown note/);
    await expect(createTracker(io, "T/Other/OT-1.md", "OT")).rejects.toThrow(/reads as an issue ID/);
  });

  it("puts a tracker in the vault root", async () => {
    expect(await createTracker(io, "Root.md", "RT")).toBe("Root.md");
    expect(await createIssue({ io, dir: "", indexPath: "Root.md" }, { title: "A" }, "2026-10-01")).toBe("RT-1");
    expect(io.files.has("issues/RT-1.md")).toBe(true);
  });
});

describe("several trackers in one folder", () => {
  let other: Tracker;
  beforeEach(async () => {
    other = { io, dir: "T/Bilinear", indexPath: await createTracker(io, "T/Bilinear/Other.md", "OT") };
  });
  const problems = async (tracker: Tracker) => (await lint(tracker, false)).map((p) => `${p.severity}:${p.code}:${p.id ?? "-"}`);

  it("refuses a prefix that another tracker of the folder has", async () => {
    await expect(createTracker(io, "T/Bilinear/Third.md", "OT")).rejects.toThrow(/Other, in the same folder, already has the prefix OT/);
    expect(io.files.has("T/Bilinear/Third.md")).toBe(false);
    expect(await createTracker(io, "T/Elsewhere/Third.md", "OT")).toBe("T/Elsewhere/Third.md");
  });

  it("keeps the issues of each apart, in the folders they share", async () => {
    expect(await createIssue(t, { title: "A" }, "2026-10-01")).toBe("BL-1");
    expect(await createIssue(other, { title: "B" }, "2026-10-01")).toBe("OT-1");
    expect(await createIssue(other, { title: "C" }, "2026-10-01")).toBe("OT-2");
    expect(await createIssue(t, { title: "D" }, "2026-10-01")).toBe("BL-2");
    expect([...io.files.keys()].filter((p) => p.includes("/issues/")).sort()).toEqual(["BL-1", "BL-2", "OT-1", "OT-2"].map((id) => `T/Bilinear/issues/${id}.md`));
    expect(await ids()).toEqual(["BL-1", "BL-2"]);
    expect((await listIssues(other)).map((i) => i.id)).toEqual(["OT-1", "OT-2"]);
    await archiveIssues(other, ["OT-1"]);
    expect(io.files.has("T/Bilinear/archive/OT-1.md")).toBe(true);
    expect(await problems(t)).toEqual([]);
    expect(await problems(other)).toEqual([]);
  });

  it("does not take the notes of another tracker for orphans, nor let them be adopted", async () => {
    await createIssue(other, { title: "B" }, "2026-10-01");
    expect(await problems(t)).toEqual([]);
    await expect(adoptIssue(t, "OT-1")).rejects.toThrow(/OT-1 has the prefix of Other, another tracker in this folder/);
    await expect(setProps(t, "OT-1", { status: "done" })).rejects.toThrow(/no such issue/);
    io.files.set("T/Bilinear/issues/XX-1.md", "---\ntitle: Stray\nstatus: todo\n---\n");
    await adoptIssue(t, "XX-1");
    expect(await problems(t)).toEqual(["warning:prefix-mismatch:XX-1"]);
  });

  it("reports an issue listed in a tracker whose prefix is another's, and a prefix that two share", async () => {
    await createIssue(other, { title: "B" }, "2026-10-01");
    io.files.set(t.indexPath, index().replace("## Issues\n", "## Issues\n- [[OT-1]] B\n"));
    expect(await problems(t)).toEqual(["error:prefix-mismatch:OT-1"]);
    io.files.set(t.indexPath, index().replace("- [[OT-1]] B\n", ""));
    io.files.set(other.indexPath, io.files.get(other.indexPath)!.replace("prefix: OT", "prefix: BL"));
    expect(await problems(t)).toEqual(["error:prefix-shared:-"]);
    expect(await problems(other)).toContain("error:prefix-shared:-");
  });
});

describe("ID allocation", () => {
  it("is sequential", async () => {
    expect(await createIssue(t, { title: "A" }, "2026-10-01")).toBe("BL-1");
    expect(await createIssue(t, { title: "B" }, "2026-10-01")).toBe("BL-2");
    expect(index()).toContain("next: 3\n");
  });

  it("skips numbers seen in the index, the folder and archive/", async () => {
    io.files.set("T/Bilinear/issues/BL-7.md", "stray");
    expect(await createIssue(t, { title: "A" }, "2026-10-01")).toBe("BL-8");
    io.files.set("T/Bilinear/archive/BL-12.md", "stray");
    expect(await createIssue(t, { title: "B" }, "2026-10-01")).toBe("BL-13");
    io.files.set(t.indexPath, index().replace("next: 14", "next: 2").replace("- [[BL-13]] B", "- [[BL-13]] B\n- [[BL-30]] no note"));
    expect(await createIssue(t, { title: "C" }, "2026-10-01")).toBe("BL-31");
    expect(index()).toContain("next: 32\n");
    expect(io.files.get("T/Bilinear/issues/BL-7.md")).toBe("stray");
  });

  it("retries when the name is taken between looking and creating", async () => {
    const real = io.listNotes.bind(io);
    let raced = false;
    io.listNotes = async (folder) => {
      const found = await real(folder);
      if (!raced) {
        raced = true;
        io.files.set("T/Bilinear/issues/BL-1.md", "theirs");
        io.files.set("T/Bilinear/archive/BL-2.md", "theirs");
      }
      return found;
    };
    expect(await createIssue(t, { title: "Mine" }, "2026-10-01")).toBe("BL-3");
    expect(io.files.get("T/Bilinear/issues/BL-1.md")).toBe("theirs");
    expect(index()).toContain("next: 4\n");
  });

  it("works with a tracker at the vault root", async () => {
    const root = new MemoryIO();
    root.files.set("Board.md", index());
    const rt: Tracker = { io: root, dir: "", indexPath: "Board.md" };
    expect(await createIssue(rt, { title: "A" }, "2026-10-01")).toBe("BL-1");
    await archiveIssues(rt, ["BL-1"]);
    expect([...root.files.keys()].sort()).toEqual(["Board.md", "archive/BL-1.md"]);
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
    expect(await createIssue(t, { title: "B" }, "2026-10-01")).toBe("BL-2");
    expect(index()).toContain("Edited meanwhile.");
    expect(index()).toContain("- [[BL-1]] A\n- [[BL-2]] B\n");
  });

  it("an interrupted create leaves a stray note that lint reports", async () => {
    io.beforeProcess = () => {
      throw new Error("interrupted");
    };
    await expect(createIssue(t, { title: "A" }, "2026-10-01")).rejects.toThrow("interrupted");
    io.beforeProcess = null;
    expect(await ids()).toEqual([]);
    expect((await lint(t, false)).map((p) => p.code)).toEqual(["orphan", "next-low"]);
    expect(await createIssue(t, { title: "B" }, "2026-10-01")).toBe("BL-2");
  });
});

describe("validation", () => {
  beforeEach(async () => {
    await createIssue(t, { title: "A" }, "2026-10-01");
    await createIssue(t, { title: "B" }, "2026-10-01");
  });

  it("refuses bad values on create and leaves nothing behind", async () => {
    for (const bad of [{ status: "nope" }, { priority: "p0" }, { due: "soon" }, { blockedBy: ["BL-99"] }, { title: "  " }]) {
      await expect(createIssue(t, { title: "X", ...bad }, "2026-10-01"), JSON.stringify(bad)).rejects.toThrow(OpError);
    }
    expect(await ids()).toEqual(["BL-1", "BL-2"]);
    expect(io.files.size).toBe(3);
  });

  it("refuses bad edits and leaves the note alone", async () => {
    const before = io.files.get("T/Bilinear/issues/BL-1.md");
    const bad: Array<Record<string, string | string[] | null>> = [
      { status: "nope" }, { status: null }, { priority: "p0" }, { due: "soon" }, { "blocked-by": ["BL-99"] },
      { "blocked-by": ["BL-1"] }, { title: "" },
    ];
    for (const edits of bad) {
      await expect(setProps(t, "BL-1", { assignee: "x", ...edits }), JSON.stringify(edits)).rejects.toThrow(OpError);
      expect(io.files.get("T/Bilinear/issues/BL-1.md")).toBe(before);
    }
    await expect(setProps(t, "BL-99", { status: "todo" })).rejects.toThrow(/no such issue/);
  });

  it("refuses to reorder archived issues or around itself", async () => {
    await archiveIssues(t, ["BL-2"]);
    await expect(moveIssue(t, "BL-2", "top")).rejects.toThrow(/archived/);
    await expect(moveIssue(t, "BL-1", "after", "BL-2")).rejects.toThrow(/archived/);
    await expect(moveIssue(t, "BL-1", "before", "BL-1")).rejects.toThrow(/itself/);
    await expect(moveIssue(t, "BL-1", "before")).rejects.toThrow(OpError);
  });

  it("empty text removes optional keys; comments need text", async () => {
    await setProps(t, "BL-1", { assignee: "rk", estimate: "3" });
    await setProps(t, "BL-1", { assignee: "", estimate: null });
    expect(io.files.get("T/Bilinear/issues/BL-1.md")).toBe("---\ntitle: A\nstatus: backlog\npriority: none\ncreated: 2026-10-01\n---\n");
    await expect(commentIssue(t, "BL-1", "  ", "rk", "2026-10-01")).rejects.toThrow(OpError);
  });
});

describe("missing notes", () => {
  beforeEach(async () => {
    await createIssue(t, { title: "A" }, "2026-10-01");
    await createIssue(t, { title: "B" }, "2026-10-01");
    io.files.delete("T/Bilinear/issues/BL-2.md");
  });

  it("can be recreated from the index line", async () => {
    expect(await recreateNote(t, "BL-2", "2026-10-05")).toBe("T/Bilinear/issues/BL-2.md");
    expect(io.files.get("T/Bilinear/issues/BL-2.md")).toBe("---\ntitle: B\nstatus: backlog\npriority: none\ncreated: 2026-10-05\n---\n");
    await expect(recreateNote(t, "BL-2", "2026-10-05")).rejects.toThrow(/exists/);
    expect(await lint(t, false)).toEqual([]);
  });

  it("can be removed without a note to trash", async () => {
    await deleteIssue(t, "BL-2");
    expect(await ids()).toEqual(["BL-1"]);
    expect(io.trashed).toEqual([]);
  });

  it("cannot be edited or commented on", async () => {
    await expect(setProps(t, "BL-2", { status: "todo" })).rejects.toThrow(/note missing/);
    await expect(commentIssue(t, "BL-2", "hi", "rk", "2026-10-01")).rejects.toThrow(/note missing/);
  });
});

describe("notes in the tracker folder (the layout before issues/)", () => {
  beforeEach(async () => {
    await createIssue(t, { title: "A" }, "2026-10-01");
    await createIssue(t, { title: "B", status: "done" }, "2026-10-01");
    for (const id of ["BL-1", "BL-2"]) await io.rename(`T/Bilinear/issues/${id}.md`, `T/Bilinear/${id}.md`);
  });

  it("are read and edited in place", async () => {
    expect((await listIssues(t)).map((i) => [i.id, i.missing, i.path])).toEqual([
      ["BL-1", false, "T/Bilinear/BL-1.md"],
      ["BL-2", false, "T/Bilinear/BL-2.md"],
    ]);
    await setProps(t, "BL-1", { status: "todo" });
    expect(io.files.get("T/Bilinear/BL-1.md")).toContain("status: todo");
  });

  it("are moved to issues/ by lint --fix, and new notes go there", async () => {
    expect((await lint(t, false)).map((p) => p.code)).toEqual(["wrong-location", "wrong-location"]);
    expect(await createIssue(t, { title: "C" }, "2026-10-01")).toBe("BL-3");
    await lint(t, true);
    expect([...io.files.keys()].sort()).toEqual(["T/Bilinear/Bilinear.md", "T/Bilinear/issues/BL-1.md", "T/Bilinear/issues/BL-2.md", "T/Bilinear/issues/BL-3.md"]);
    expect(await lint(t, false)).toEqual([]);
  });

  it("go to archive/ when archived and to issues/ when restored", async () => {
    await archiveIssues(t, ["BL-2"]);
    expect(io.files.has("T/Bilinear/archive/BL-2.md")).toBe(true);
    await unarchiveIssues(t, ["BL-2"]);
    expect(io.files.has("T/Bilinear/issues/BL-2.md")).toBe(true);
  });

  it("refuse to move a note that exists twice", async () => {
    io.files.set("T/Bilinear/archive/BL-1.md", "copy");
    await expect(archiveIssues(t, ["BL-1"])).rejects.toThrow(/more than one place \(archive\/, the tracker folder\)/);
    await deleteIssue(t, "BL-1");
    expect(io.trashed.sort()).toEqual(["T/Bilinear/BL-1.md", "T/Bilinear/archive/BL-1.md"]);
  });
});

describe("deleting an issue", () => {
  const path = (n: number) => `T/Bilinear/issues/BL-${n}.md`;
  const note = (n: number) => io.files.get(path(n))!;
  const edit = (n: number, fn: (text: string) => string) => io.files.set(path(n), fn(note(n)));
  const front = (n: number, lines: string) => edit(n, (text) => text.replace("created:", `${lines}\ncreated:`));

  beforeEach(async () => {
    for (const title of ["A", "B", "C", "D", "E"]) await createIssue(t, { title }, "2026-10-01");
  });

  it("clears blocked-by and related-to entries naming it, keeping the others", async () => {
    front(1, 'blocked-by: ["[[BL-5]]", "[[BL-2]]"]');
    front(2, 'blocked-by: ["[[BL-5]]"]');
    front(3, 'blocked-by: ["[[BL-4]]", "[[archive/BL-5|e]]", "[[BL-1]]"]\nrelated-to: ["[[BL-5]]", "[[BL-2]]"]');
    front(4, 'related-to: ["[[BL-5]]"]');
    await deleteIssue(t, "BL-5");
    expect(note(1)).toContain('blocked-by: ["[[BL-2]]"]');
    expect(note(2)).not.toContain("blocked-by");
    expect(note(3)).toContain('blocked-by: ["[[BL-4]]", "[[BL-1]]"]\nrelated-to: ["[[BL-2]]"]');
    expect(note(4)).not.toContain("related-to");
    expect(await ids()).toEqual(["BL-1", "BL-2", "BL-3", "BL-4"]);
    expect(io.trashed).toEqual([path(5)]);
    expect(await lint(t, false)).toEqual([]);
  });

  it("leaves other notes untouched, and mentions in descriptions alone", async () => {
    front(1, 'blocked-by: ["[[BL-2]]"]');
    edit(3, (text) => text + "See [[BL-5]].\n");
    const before = [1, 2, 3, 4].map(note);
    const processed: string[] = [];
    io.beforeProcess = (p) => processed.push(p);
    // Only the index is written.
    await deleteIssue(t, "BL-5");
    expect([1, 2, 3, 4].map(note)).toEqual(before);
    expect(processed).toEqual(["T/Bilinear/Bilinear.md"]);
    expect(note(3)).toContain("See [[BL-5]].");
  });

  it("works for an issue nobody references, and for an archived one referencing it", async () => {
    await deleteIssue(t, "BL-4");
    expect(await ids()).toEqual(["BL-1", "BL-2", "BL-3", "BL-5"]);
    front(2, 'blocked-by: ["[[BL-3]]"]');
    await archiveIssues(t, ["BL-2"]);
    await deleteIssue(t, "BL-3");
    expect(io.files.get("T/Bilinear/archive/BL-2.md")).not.toContain("blocked-by");
  });

  it("skips a referencing issue whose note is missing", async () => {
    front(1, 'blocked-by: ["[[BL-5]]"]');
    front(2, 'related-to: ["[[BL-5]]"]');
    io.files.delete(path(1));
    await deleteIssue(t, "BL-5");
    expect(note(2)).not.toContain("related-to");
    expect(await ids()).toEqual(["BL-1", "BL-2", "BL-3", "BL-4"]);
  });
});

describe("lint of relations", () => {
  const path = (n: number) => `T/Bilinear/issues/BL-${n}.md`;
  const front = (n: number, lines: string) => io.files.set(path(n), io.files.get(path(n))!.replace("created:", `${lines}\ncreated:`));
  const codes = async (fix = false) => (await lint(t, fix)).map((p) => `${p.code}:${p.id}:${p.severity}:${p.fixable}`);

  beforeEach(async () => {
    for (const title of ["A", "B", "C", "D"]) await createIssue(t, { title }, "2026-10-01");
  });

  it("reports related-to entries that are not links to another issue or name no issue", async () => {
    front(1, 'related-to: ["x", "[[BL-1]]", "[[BL-99]]", "[[BL-3]]"]');
    expect(await codes()).toEqual(["related-to-invalid:BL-1:error:false", "related-to-invalid:BL-1:error:false", "related-to-unknown:BL-1:error:false"]);
    expect((await lint(t, false)).map((p) => p.message)).toEqual([
      "related-to 'x' is not a link to another issue",
      "related-to '[[BL-1]]' is not a link to another issue",
      "related-to BL-99 is not in the index",
    ]);
  });

  it("reports blocked-by-cycle once for each issue on a cycle, and not for those leading into it", async () => {
    front(1, 'blocked-by: ["[[BL-2]]"]');
    front(2, 'blocked-by: ["[[BL-3]]"]');
    front(3, 'blocked-by: ["[[BL-1]]"]');
    front(4, 'blocked-by: ["[[BL-1]]"]');
    const found = await lint(t, false);
    expect(found.map((p) => [p.code, p.id])).toEqual([["blocked-by-cycle", "BL-1"], ["blocked-by-cycle", "BL-2"], ["blocked-by-cycle", "BL-3"]]);
    expect(found[0]).toMatchObject({ severity: "error", fixable: false, message: "blocked-by leads back to the issue itself" });
  });

  it("does not call a blocked-by link to itself a cycle, and --fix leaves all of these", async () => {
    front(1, 'blocked-by: ["[[BL-1]]"]');
    front(2, 'blocked-by: ["[[BL-3]]"]\nrelated-to: ["[[BL-99]]"]');
    front(3, 'blocked-by: ["[[BL-2]]"]');
    const before = [1, 2, 3, 4].map((n) => io.files.get(path(n)));
    const fixed = await lint(t, true);
    expect(fixed.map((p) => `${p.code}:${p.id}:${p.fixed}`).sort()).toEqual([
      "blocked-by-cycle:BL-2:false", "blocked-by-cycle:BL-3:false", "blocked-by-invalid:BL-1:false", "related-to-unknown:BL-2:false",
    ]);
    expect([1, 2, 3, 4].map((n) => io.files.get(path(n)))).toEqual(before);
  });
});

describe("labels", () => {
  it("adds labels and sets, changes and clears colours", async () => {
    await setLabel(t, "bug", "RED");
    await setLabel(t, "ui");
    await setLabel(t, "perf", "#0af");
    expect(index()).toContain("labels: [bug, ui, perf]\n");
    expect(index()).toContain("label-colors: [bug=red, perf=#0af]\n");
    await setLabel(t, "bug", "blue");
    expect(index()).toContain("label-colors: [bug=blue, perf=#0af]\n");
    await setLabel(t, "bug", null);
    await setLabel(t, "perf", null);
    expect(index()).not.toContain("label-colors");
    expect(index()).toContain("labels: [bug, ui, perf]\n");
  });

  it("refuses unknown colours and empty names", async () => {
    const before = index();
    await expect(setLabel(t, "bug", "mauve")).rejects.toThrow(OpError);
    await expect(setLabel(t, "bug", "#12")).rejects.toThrow(OpError);
    await expect(setLabel(t, "  ", "red")).rejects.toThrow(OpError);
    expect(index()).toBe(before);
  });
});

describe("embed options", () => {
  it("parses key: value lines", () => {
    expect(parseEmbed("tracker: Trackers/Bilinear\nstatus: todo, in-progress\nlabel: bug\nassignee: rk, none\nlimit: 10\narchived: yes\nsearch: cache\nnonsense\n")).toEqual({
      tracker: "Trackers/Bilinear",
      filter: { text: "cache", status: ["todo", "in-progress"], priority: [], labels: ["bug"], assignee: ["rk", ""] },
      archived: true,
      limit: 10,
    });
    expect(parseEmbed("")).toMatchObject({ tracker: null, archived: false, limit: 0 });
  });
});

describe("relations", () => {
  const path = (n: number) => `T/Bilinear/issues/BL-${n}.md`;
  const note = (n: number) => io.files.get(path(n))!;
  const edit = (n: number, fn: (text: string) => string) => io.files.set(path(n), fn(note(n)));

  beforeEach(async () => {
    for (const title of ["A", "B", "C", "D"]) await createIssue(t, { title }, "2026-10-01");
  });

  it("create writes related-to like blocked-by, and nothing for an empty list", async () => {
    expect(await createIssue(t, { title: "E", relatedTo: ["BL-1", "[[archive/BL-2|b]]"], blockedBy: ["BL-3"] }, "2026-10-01")).toBe("BL-5");
    expect(note(5)).toContain('blocked-by: ["[[BL-3]]"]\nrelated-to: ["[[BL-1]]", "[[BL-2]]"]\ncreated:');
    expect(await createIssue(t, { title: "F", relatedTo: [] }, "2026-10-01")).toBe("BL-6");
    expect(note(6)).not.toContain("related-to");
    await expect(createIssue(t, { title: "G", relatedTo: ["BL-99"] }, "2026-10-01")).rejects.toThrow(/BL-99: no such issue/);
    await expect(createIssue(t, { title: "G", relatedTo: ["x"] }, "2026-10-01")).rejects.toThrow(/not an issue ID/);
    expect(await ids()).toHaveLength(6);
  });

  it("set takes a string or a list, and an empty value removes the key", async () => {
    await setProps(t, "BL-1", { "related-to": "BL-2" });
    expect(note(1)).toContain('related-to: ["[[BL-2]]"]');
    await setProps(t, "BL-1", { "related-to": ["BL-2", "BL-3"] });
    expect(note(1)).toContain('related-to: ["[[BL-2]]", "[[BL-3]]"]');
    expect(note(2)).not.toContain("related-to");
    await setProps(t, "BL-1", (doc) => ({ "related-to": [...doc.getList("related-to"), "BL-4"] }));
    expect(note(1)).toContain('related-to: ["[[BL-2]]", "[[BL-3]]", "[[BL-4]]"]');
    const others = [2, 3, 4].map(note);
    await setProps(t, "BL-1", { "related-to": null });
    expect(note(1)).not.toContain("related-to");
    expect([2, 3, 4].map(note)).toEqual(others);
  });

  it("refuses itself, unknown issues and non-IDs for related-to", async () => {
    const before = note(1);
    for (const value of ["BL-1", ["BL-2", "BL-99"], ["nope"]]) {
      await expect(setProps(t, "BL-1", { assignee: "x", "related-to": value }), JSON.stringify(value)).rejects.toThrow(OpError);
      expect(note(1)).toBe(before);
    }
  });

  it("an existing dangling link does not stand in the way of another edit", async () => {
    edit(1, (text) => text.replace("created:", 'blocked-by: ["[[BL-99]]"]\nrelated-to: ["[[BL-98]]", "[[BL-2]]"]\ncreated:'));
    await setProps(t, "BL-1", { assignee: "rk", "blocked-by": ["BL-99"], "related-to": ["[[BL-98]]", "BL-2", "BL-3"] });
    expect(note(1)).toContain("assignee: rk");
    expect(note(1)).toContain('related-to: ["[[BL-98]]", "[[BL-2]]", "[[BL-3]]"]');
  });

  it("removing a related issue removes this one from its note too", async () => {
    await setProps(t, "BL-1", { "related-to": ["BL-2", "BL-3"] });
    edit(2, (text) => text.replace("created:", 'related-to: ["[[archive/BL-1|first]]", "[[BL-3]]"]\ncreated:'));
    edit(3, (text) => text.replace("created:", 'related-to: ["[[BL-1]]"]\ncreated:'));
    await setProps(t, "BL-1", { "related-to": ["BL-3"] });
    expect(note(1)).toContain('related-to: ["[[BL-3]]"]');
    expect(note(2)).toContain('related-to: ["[[BL-3]]"]');
    expect(note(3)).toContain('related-to: ["[[BL-1]]"]');
    await setProps(t, "BL-1", { "related-to": null });
    expect(note(3)).not.toContain("related-to");
    expect(note(1)).not.toContain("related-to");
  });

  it("removing when the other note is missing or unlisted does not throw", async () => {
    edit(1, (text) => text.replace("created:", 'related-to: ["[[BL-2]]", "[[BL-99]]", "[[BL-3]]"]\ncreated:'));
    io.files.delete(path(2));
    await setProps(t, "BL-1", { "related-to": [] });
    expect(note(1)).not.toContain("related-to");
    expect(note(3)).not.toContain("related-to");
  });

  it("unrelate clears whichever side names the other", async () => {
    edit(1, (text) => text.replace("created:", 'related-to: ["[[BL-2]]", "[[BL-3]]"]\ncreated:'));
    edit(2, (text) => text.replace("created:", 'related-to: ["[[archive/BL-1|a]]"]\ncreated:'));
    edit(4, (text) => text.replace("created:", 'related-to: ["[[BL-1]]"]\ncreated:'));
    await unrelate(t, "BL-1", "BL-2");
    expect(note(1)).toContain('related-to: ["[[BL-3]]"]');
    expect(note(2)).not.toContain("related-to");
    await unrelate(t, "BL-1", "BL-4");
    expect(note(4)).not.toContain("related-to");
    expect(note(1)).toContain('related-to: ["[[BL-3]]"]');
    const before = [1, 2, 3, 4].map(note);
    await unrelate(t, "BL-2", "BL-3");
    expect([1, 2, 3, 4].map(note)).toEqual(before);
    await unrelate(t, "BL-3", "BL-1");
    expect(note(1)).not.toContain("related-to");
    io.files.delete(path(3));
    await unrelate(t, "BL-3", "BL-1");
  });

  it("unrelate refuses an unknown issue, but not an unknown other", async () => {
    await unrelate(t, "BL-1", "BL-99");
    await expect(unrelate(t, "BL-98", "BL-1")).rejects.toThrow("BL-98: no such issue");
  });

  it("refuses a blocked-by cycle and leaves the note alone", async () => {
    await setProps(t, "BL-1", { "blocked-by": ["BL-2"] });
    let before = note(2);
    await expect(setProps(t, "BL-2", { "blocked-by": "BL-1" })).rejects.toThrow("BL-2: would block itself through BL-1");
    expect(note(2)).toBe(before);
    await setProps(t, "BL-2", { "blocked-by": ["BL-3"] });
    before = note(3);
    await expect(setProps(t, "BL-3", { assignee: "x", "blocked-by": ["BL-4", "BL-1"] })).rejects.toThrow("BL-3: would block itself through BL-1");
    expect(note(3)).toBe(before);
    await setProps(t, "BL-3", { "blocked-by": ["BL-4"] });
    await expect(setProps(t, "BL-4", { "blocked-by": ["BL-1"] })).rejects.toThrow("BL-4: would block itself through BL-1");
  });

  it("an edit that adds no edge reads no other note", async () => {
    await setProps(t, "BL-1", { "blocked-by": ["BL-2"], "related-to": ["BL-4"] });
    io.files.delete(path(2));
    const read: string[] = [];
    const real = io.read.bind(io);
    io.read = async (p) => (read.push(p), real(p));
    await setProps(t, "BL-1", { assignee: "rk", "blocked-by": ["BL-2"], "related-to": ["BL-4", "BL-3"] });
    expect(read.filter((p) => p.includes("/issues/"))).toEqual([path(1)]);
  });
});
