// The operations that record and read context entries.

import { beforeEach, describe, expect, it } from "vitest";
import { parseContext } from "../src/format/context";
import { parseComments } from "../src/format/issue-note";
import { getContext, recordContext, type RecordInput } from "../src/ops/context";
import type { Tracker } from "../src/ops/io";
import { archiveIssues, commentIssue, createIssue, createTracker } from "../src/ops/issues";
import { listIssues } from "../src/ops/tracker";
import { MemoryIO } from "./memory-io";

const TODAY = "2026-10-05";
const opts = { author: "ann", today: TODAY };
let io: MemoryIO;
let t: Tracker;
const note = (id = "BL-1") => io.files.get(`T/Bilinear/issues/${id}.md`)!;
const index = () => io.files.get("T/Bilinear/Bilinear.md")!;
const entry = (text: string, local: string) => parseContext(text).entries.find((e) => e.local === local)!;
const rec = (target: string, ...inputs: RecordInput[]) => recordContext(t, target, inputs, opts);
const dec = (subject: string, content = "", extra: Partial<RecordInput> = {}): RecordInput => ({ type: "decision", subject, content, ...extra });

beforeEach(async () => {
  io = new MemoryIO();
  const indexPath = await createTracker(io, "T/Bilinear/Bilinear.md", "BL");
  t = { io, dir: "T/Bilinear", indexPath };
  await createIssue(t, { title: "First", description: "Text." }, TODAY);
  await createIssue(t, { title: "Second" }, TODAY);
});

describe("recordContext in an issue", () => {
  it("writes the entry before Comments and reads it back with a new Tracker", async () => {
    await commentIssue(t, "BL-1", "hello", "bob", TODAY);
    const [r] = await rec("bl-1", dec("Use X", "Because.", { rationale: "It is fast", evidence: ["commit:abc"] }));
    expect(r).toEqual({ id: "BL-1/D1", action: "created", superseded: [], warnings: [] });
    const text = note();
    expect(text.indexOf("## Context")).toBeGreaterThan(0);
    expect(text.indexOf("## Context")).toBeLessThan(text.indexOf("## Comments"));
    const e = entry(text, "D1");
    expect(e).toMatchObject({ subject: "Use X", content: "Because.", rationale: "It is fast", author: "ann", created: TODAY, updated: TODAY, status: "active", evidence: ["commit:abc"] });
    const again: Tracker = { io, dir: "T/Bilinear", indexPath: "T/Bilinear/Bilinear.md" };
    const [g] = await getContext(again, ["BL-1/D1"]);
    expect(g.entry).toEqual(e);
    expect(parseComments(text)).toHaveLength(1);
  });

  it("uses the default author and the date of today", async () => {
    await recordContext(t, "BL-1", [dec("A thing")], {});
    const e = entry(note(), "D1");
    expect(e.author).toBe("unknown");
    expect(e.created).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  });

  it("refuses an empty batch, an unknown issue and a foreign prefix", async () => {
    await expect(rec("BL-1")).rejects.toThrow(/nothing to record/);
    await expect(rec("BL-9", dec("A"))).rejects.toThrow(/BL-9/);
    await expect(rec("XX", dec("A"))).rejects.toThrow(/XX/);
  });

  it("works with an archived issue, as a comment does", async () => {
    await archiveIssues(t, ["BL-2"]);
    const [r] = await rec("BL-2", dec("Use X", "One."));
    expect(r.id).toBe("BL-2/D1");
    expect(entry(io.files.get("T/Bilinear/archive/BL-2.md")!, "D1").content).toBe("One.");
    expect((await getContext(t, ["BL-2/D1"]))[0].entry.subject).toBe("Use X");
  });
});

describe("recordContext in the tracker scope", () => {
  it("writes to the index note and leaves the issue list as it is", async () => {
    const before = (await listIssues(t)).map((i) => i.id);
    const [r] = await rec("bl", { type: "constraint", subject: "No network", content: "Never call out." });
    expect(r.id).toBe("BL/C1");
    expect(entry(index(), "C1").content).toBe("Never call out.");
    expect(index()).toContain("## Issues");
    expect((await listIssues(t)).map((i) => i.id)).toEqual(before);
    await createIssue(t, { title: "Third" }, TODAY);
    expect(entry(index(), "C1").subject).toBe("No network");
    expect((await listIssues(t)).map((i) => i.id)).toEqual([...before, "BL-3"]);
  });
});

describe("duplicates and similar entries", () => {
  it("skips an equal entry and returns the ID of the existing one", async () => {
    await rec("BL-1", dec("Use X", "Because  of this."));
    const before = note();
    const [r] = await rec("BL-1", dec("use  x!", "Because of\nthis."));
    expect(r).toEqual({ id: "BL-1/D1", action: "skipped", superseded: [], warnings: [] });
    expect(note()).toBe(before);
  });

  it("refuses an equal subject with other content, and the note stays", async () => {
    await rec("BL-1", dec("Use X", "One."));
    const before = note();
    await expect(rec("BL-1", dec("Use X", "Two."))).rejects.toThrow(/BL-1\/D1.*--supersedes BL-1\/D1.*--new/);
    expect(note()).toBe(before);
    const [r] = await rec("BL-1", dec("Use X", "Two.", { isNew: true }));
    expect(r).toMatchObject({ id: "BL-1/D2", action: "created" });
    expect(r.warnings[0]).toMatch(/BL-1\/D1 \(Use X\)/);
  });

  it("warns about a similar subject", async () => {
    await rec("BL-1", dec("Cache the parsed index note"));
    const [r] = await rec("BL-1", dec("Cache parsed index notes in memory"));
    expect(r.action).toBe("created");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("BL-1/D1 (Cache the parsed index note)");
  });

  it("does not warn about an entry in supersedes, nor about an equal subject that it replaces", async () => {
    await rec("BL-1", dec("Cache the parsed index note", "a"));
    const [r] = await rec("BL-1", dec("Cache the parsed index note", "b", { supersedes: ["d1"] }));
    expect(r.warnings).toEqual([]);
    expect(r.superseded).toEqual(["BL-1/D1"]);
  });

  it("warns when a decision meets an active rejected entry", async () => {
    await rec("BL-1", { type: "rejected", subject: "Polling", rejected: { attempted: "Poll the server every second", failed: "Too slow", applies: "All sync code" } });
    const [r] = await rec("BL-1", dec("Poll server every minute"));
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("BL-1/R1");
    expect(r.warnings[0]).toContain("Applies: All sync code");
  });

  it("finds an equal entry created earlier in the same batch", async () => {
    const r = await rec("BL-1", dec("Use X", "One."), dec("Use X", "One."));
    expect(r.map((x) => x.action)).toEqual(["created", "skipped"]);
    expect(r[1].id).toBe("BL-1/D1");
  });
});

describe("supersession", () => {
  it("links both entries and sets the status and the date", async () => {
    await rec("BL-1", dec("Use X", "One."));
    await io.process("T/Bilinear/issues/BL-1.md", (x) => x.replace("updated: 2026-10-05", "updated: 2026-01-01"));
    const [r] = await recordContext(t, "BL-1", [dec("Pick beta", "Two.", { supersedes: ["BL-1/d1"] })], { ...opts, today: "2026-10-06" });
    expect(r.superseded).toEqual(["BL-1/D1"]);
    const old = entry(note(), "D1");
    expect(old).toMatchObject({ status: "superseded", supersededBy: "D2", updated: "2026-10-06" });
    expect(entry(note(), "D2")).toMatchObject({ status: "active", supersedes: ["D1"] });
  });

  it("resolves a question and accepts a target of another type", async () => {
    await rec("BL-1", { type: "question", subject: "Which store?" });
    const [r] = await rec("BL-1", dec("Use SQLite", "Chosen.", { supersedes: ["Q1"] }));
    expect(r.superseded).toEqual(["BL-1/Q1"]);
    expect(entry(note(), "Q1")).toMatchObject({ status: "resolved", supersededBy: "D1" });
  });

  it("refuses a superseded target and an unknown target", async () => {
    await rec("BL-1", dec("Use X", "One."));
    await rec("BL-1", dec("Pick beta", "Two.", { supersedes: ["D1"] }));
    const before = note();
    await expect(rec("BL-1", dec("Choose gamma", "Three.", { supersedes: ["D1"] }))).rejects.toThrow(/BL-1\/D1 is already superseded/);
    await expect(rec("BL-1", dec("Choose gamma", "Three.", { supersedes: ["D9"] }))).rejects.toThrow(/D9 does not exist/);
    await expect(rec("BL-1", dec("Choose gamma", "Three.", { supersedes: ["BL-2/D1"] }))).rejects.toThrow(/not an entry of BL-1/);
    expect(note()).toBe(before);
  });

  it("lets a new state supersede all active states, also in one batch", async () => {
    const s = (subject: string): RecordInput => ({ type: "state", subject, content: subject });
    await rec("BL-1", s("Phase one"));
    const r = await rec("BL-1", s("Phase two"), s("Phase three"));
    expect(r[0].superseded).toEqual(["BL-1/S1"]);
    expect(r[1].superseded).toEqual(["BL-1/S2"]);
    expect(r.every((x) => x.warnings.length === 0)).toBe(true);
    const states = parseContext(note()).entries;
    expect(states.map((e) => e.status)).toEqual(["superseded", "superseded", "active"]);
    expect(states[0].supersededBy).toBe("S2");
    expect(states[1].supersededBy).toBe("S3");
    expect(states[2].supersedes).toEqual(["S2"]);
  });

  it("never reuses a number", async () => {
    await rec("BL-1", dec("Use X", "One."), dec("Pick beta", "Two."));
    await rec("BL-1", dec("Choose gamma", "Three.", { supersedes: ["D2"] }));
    const [r] = await rec("BL-1", dec("Select delta", "Four."));
    expect(r.id).toBe("BL-1/D4");
    expect(parseContext(note()).entries.map((e) => e.local)).toEqual(["D1", "D2", "D3", "D4"]);
  });
});

describe("a batch", () => {
  it("is all or nothing", async () => {
    await rec("BL-1", dec("Use X", "One."));
    const before = note();
    const bad = rec("BL-1", dec("Pick beta", "Two."), { type: "decision", subject: "   ", content: "x" });
    await expect(bad).rejects.toThrow(/input 2/);
    expect(note()).toBe(before);
    const bad2 = rec("BL-1", dec("Pick beta", "Two."), dec("Choose gamma", "Three.", { evidence: ["nokind"] }));
    await expect(bad2).rejects.toThrow(/input 2 \(Choose gamma\)/);
    expect(note()).toBe(before);
  });
});

describe("normalization", () => {
  it("accepts text that checkEntry would reject, and keeps its words", async () => {
    const content = "Line one.\r\n## Heading\r\n# Top\nRationale: x\n```\nRationale: kept\n\n```\nEnd.\r\n\r\n";
    const [r] = await rec("BL-1", { type: "decision", subject: " Use\tX \n", content, rationale: " First line\r\n\r\nsecond line\n```\na\n\nb\n```\n", alternatives: "None\n" });
    expect(r.action).toBe("created");
    const e = entry(note(), "D1");
    expect(e.subject).toBe("Use X");
    expect(e.content).toBe("Line one.\n#### Heading\n#### Top\n\\Rationale: x\n```\nRationale: kept\n\n```\nEnd.");
    expect(e.rationale).toBe("First line\nsecond line\n```\na\n\nb\n```");
    expect(e.alternatives).toBe("None");
    const words = (s: string) => s.replace(/[#\\`]/g, " ").split(/\s+/).filter(Boolean);
    expect(words(e.content)).toEqual(words(content));
  });

  it("escapes a label of the type only", async () => {
    await rec("BL-1", dec("A", "Failed: it is ok in a decision\nAlternatives: no"));
    expect(entry(note(), "D1").content).toBe("Failed: it is ok in a decision\n\\Alternatives: no");
  });
});

describe("rejected entries and evidence", () => {
  it("needs attempted, failed and applies, and only for type rejected", async () => {
    const r = { attempted: "A", failed: "B", applies: "C" };
    await expect(rec("BL-1", { type: "rejected", subject: "R", rejected: { attempted: "A", applies: "C" } })).rejects.toThrow(/non-empty failed/);
    await expect(rec("BL-1", { type: "rejected", subject: "R" })).rejects.toThrow(/non-empty attempted/);
    await expect(rec("BL-1", dec("D", "x", { rejected: r }))).rejects.toThrow(/only an entry of type rejected/);
    await rec("BL-1", { type: "rejected", subject: "R", rejected: { ...r, promising: "P\n\nQ" } });
    expect(entry(note(), "R1").rejected).toEqual({ ...r, promising: "P\nQ", happened: "" });
  });

  it("checks the evidence", async () => {
    await commentIssue(t, "BL-1", "one", "bob", TODAY);
    await commentIssue(t, "BL-1", "two", "bob", TODAY);
    await expect(rec("BL-1", dec("A", "", { evidence: [`comment:${TODAY}#3`] }))).rejects.toThrow(/has 2 comment/);
    await expect(rec("BL-1", dec("A", "", { evidence: ["comment:2020-01-01#1"] }))).rejects.toThrow(/has 0 comment/);
    await expect(rec("BL-1", dec("A", "", { evidence: [`comment:${TODAY}#0`] }))).rejects.toThrow(/n from 1/);
    await expect(rec("BL-1", dec("A", "", { evidence: ["nokind"] }))).rejects.toThrow(/kind:value/);
    await expect(rec("BL-1", dec("A", "", { evidence: ["Kind:x"] }))).rejects.toThrow(/kind:value/);
    await expect(rec("BL-1", dec("A", "", { evidence: ["file:"] }))).rejects.toThrow(/kind:value/);
    await expect(rec("BL-1", dec("A", "", { evidence: ["entry:D5"] }))).rejects.toThrow(/BL-1\/D5 does not exist/);
    await rec("BL-1", dec("A", "", { evidence: [`comment:${TODAY}#2`, "commit:abc", "file:src/a.ts", "entry:BL/C7"] }));
    await rec("BL-1", dec("B", "", { evidence: ["entry:d1"] }));
    expect(entry(note(), "D1").evidence).toEqual([`comment:${TODAY}#2`, "commit:abc", "file:src/a.ts", "entry:BL/C7"]);
    expect(entry(note(), "D2").evidence).toEqual(["entry:BL-1/D1"]);
  });
});

describe("comments", () => {
  it("still works after a record, and a record keeps the comments", async () => {
    await rec("BL-1", dec("A", "x"));
    await commentIssue(t, "BL-1", "after", "bob", TODAY);
    expect(parseComments(note()).map((c) => c.text)).toEqual(["after"]);
    expect(entry(note(), "D1").subject).toBe("A");
    const comments = parseComments(note());
    await rec("BL-1", dec("B", "y"));
    expect(parseComments(note())).toEqual(comments);
    expect(parseContext(note()).entries).toHaveLength(2);
  });
});

describe("getContext", () => {
  it("returns many entries of two notes in order", async () => {
    await rec("BL-1", dec("Use X", "One.", { evidence: ["commit:abc"] }));
    await rec("BL-1", dec("Pick beta", "Two.", { supersedes: ["D1"] }));
    await rec("BL", { type: "constraint", subject: "No network", content: "Never." });
    const got = await getContext(t, ["bl/c1", "BL-1/D1", "BL-1/d2"]);
    expect(got.map((g) => g.id)).toEqual(["BL/C1", "BL-1/D1", "BL-1/D2"]);
    expect(got[1].entry).toMatchObject({ status: "superseded", supersededBy: "D2", evidence: ["commit:abc"] });
    expect(got[1].text).toContain("- evidence:\n  - commit:abc\n");
    expect(got[1].text.startsWith("### D1: Use X\n")).toBe(true);
    expect(got[2].entry.status).toBe("active");
  });

  it("throws on an unknown note, entry or bad ID", async () => {
    await rec("BL-1", dec("Use X", "One."));
    await expect(getContext(t, ["BL-1/D9"])).rejects.toThrow(/BL-1\/D9/);
    await expect(getContext(t, ["BL-7/D1"])).rejects.toThrow(/BL-7\/D1/);
    await expect(getContext(t, ["ZZ/D1"])).rejects.toThrow(/ZZ\/D1/);
    await expect(getContext(t, ["BL-1/D1", "nonsense"])).rejects.toThrow(/nonsense/);
  });
});

describe("a batch and the IO that runs the callback again", () => {
  it("gives one result for each input", async () => {
    const again = new Proxy(io, {
      get(target, key) {
        if (key === "process") {
          return (path: string, fn: (text: string) => string) =>
            target.process(path, (text) => {
              fn(text);
              return fn(text);
            });
        }
        const v = (target as never)[key];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const t2: Tracker = { io: again, dir: t.dir, indexPath: t.indexPath };
    const r = await recordContext(t2, "BL-1", [dec("Alpha one", "a"), dec("Beta two", "b")], opts);
    expect(r.map((x) => x.id)).toEqual(["BL-1/D1", "BL-1/D2"]);
    expect(parseContext(note()).entries.map((e) => e.local)).toEqual(["D1", "D2"]);
  });
});

describe("the subject of an entry", () => {
  it("keeps subjects apart that differ in one letter or digit or sign", async () => {
    const r = await rec("BL-1", dec("Use X"), dec("Use Y"), dec("Phase 1"), dec("Phase 2"), dec("Use C"), dec("Use C++"));
    expect(r.map((x) => x.action)).toEqual(Array(6).fill("created"));
  });

  it("reads upper case, extra white space and marks at the ends as equal", async () => {
    await rec("BL-1", dec("Use X.", "Same."));
    const [r] = await rec("BL-1", dec("use  x", "Same."));
    expect(r).toMatchObject({ id: "BL-1/D1", action: "skipped" });
  });

  it("keeps two subjects of marks only apart", async () => {
    const r = await rec("BL-1", dec("?"), dec("!"));
    expect(r.map((x) => x.action)).toEqual(["created", "created"]);
    expect((await rec("BL-1", dec("?")))[0]).toMatchObject({ id: "BL-1/D1", action: "skipped" });
  });

  it("throws on a skip with supersedes, and the note stays", async () => {
    await rec("BL-1", dec("Use X", "Same."), dec("Other plan", "o"));
    const before = note();
    await expect(rec("BL-1", dec("Use X", "Same.", { supersedes: ["D2"] }))).rejects.toThrow(/BL-1\/D1 exists already.*BL-1\/D2 was not applied.*drop supersedes/);
    expect(note()).toBe(before);
  });

  it("warns on a skip that drops evidence", async () => {
    await rec("BL-1", dec("Use X", "Same.", { evidence: ["commit:abc"] }));
    const [r] = await rec("BL-1", dec("Use X", "Same.", { evidence: ["commit:abc", "commit:def"] }));
    expect(r.action).toBe("skipped");
    expect(r.warnings).toEqual(["the evidence was not added to BL-1/D1: commit:def"]);
  });

  it("does not skip a rejected entry with an equal subject and another failed", async () => {
    const rj = (failed: string) => ({ type: "rejected", subject: "Polling", rejected: { attempted: "A", failed, applies: "C" } }) as RecordInput;
    await rec("BL-1", rj("Slow"));
    await expect(rec("BL-1", rj("Racy"))).rejects.toThrow(/same subject and different content/);
    const [r] = await rec("BL-1", { ...rj("Racy"), isNew: true });
    expect(r.id).toBe("BL-1/R2");
    expect((await rec("BL-1", rj("Racy")))[0].action).toBe("skipped");
  });

  it("skips an identical state", async () => {
    await rec("BL-1", { type: "state", subject: "Phase one", content: "x" });
    const [r] = await rec("BL-1", { type: "state", subject: "Phase one", content: "x" });
    expect(r).toMatchObject({ id: "BL-1/S1", action: "skipped" });
  });
});

describe("the links inside a batch", () => {
  it("deduplicates the same target in one input", async () => {
    await rec("BL-1", dec("Use X", "One."));
    const [r] = await rec("BL-1", dec("Pick beta", "Two.", { supersedes: ["D1", "d1", "BL-1/D1"] }));
    expect(r.superseded).toEqual(["BL-1/D1"]);
    expect(entry(note(), "D2").supersedes).toEqual(["D1"]);
  });

  it("refuses the same target in two inputs, and the note stays", async () => {
    await rec("BL-1", dec("Use X", "One."));
    const before = note();
    await expect(rec("BL-1", dec("Pick beta", "Two.", { supersedes: ["D1"] }), dec("Choose gamma", "Three.", { supersedes: ["D1"] }))).rejects.toThrow(
      /input 1 of this batch already supersedes BL-1\/D1/,
    );
    expect(note()).toBe(before);
  });

  it("lets an input supersede an entry that an earlier input created", async () => {
    await rec("BL-1", dec("Use X", "One."), dec("Pick beta", "Two.", { supersedes: ["D1"] }));
    expect(entry(note(), "D1")).toMatchObject({ status: "superseded", supersededBy: "D2" });
    expect(entry(note(), "D2")).toMatchObject({ status: "active", supersedes: ["D1"] });
    await rec("BL-1", dec("Choose gamma", "Three."), { type: "question", subject: "Which one?", supersedes: ["D3"] });
    expect(entry(note(), "D3")).toMatchObject({ status: "superseded", supersededBy: "Q1" });
    expect(entry(note(), "Q1").supersedes).toEqual(["D3"]);
  });

  it("names the input for an equal subject in the same batch", async () => {
    const before = note();
    await expect(rec("BL-1", dec("Use X", "One."), dec("Use X", "Two."))).rejects.toThrow(/input 1 of this batch has the same subject and different content/);
    expect(note()).toBe(before);
  });

  it("gives no rejected warning for an entry that the decision supersedes", async () => {
    await rec("BL-1", { type: "rejected", subject: "Polling", rejected: { attempted: "Poll the server", failed: "Slow", applies: "Sync" } });
    const [r] = await rec("BL-1", dec("Poll server", "Again.", { supersedes: ["R1"] }));
    expect(r.warnings).toEqual([]);
    expect(entry(note(), "R1").status).toBe("superseded");
  });

  it("supersedes in the tracker scope", async () => {
    await rec("BL", { type: "constraint", subject: "No network", content: "One." });
    const before = (await listIssues(t)).map((i) => i.id);
    const [r] = await rec("BL", { type: "constraint", subject: "Offline only", content: "Two.", supersedes: ["bl/c1"] });
    expect(r.superseded).toEqual(["BL/C1"]);
    expect(entry(index(), "C1")).toMatchObject({ status: "superseded", supersededBy: "C2" });
    expect(index()).toContain("## Issues");
    expect((await listIssues(t)).map((i) => i.id)).toEqual(before);
  });
});

describe("odd text", () => {
  it("keeps a fake entry heading in the content as content", async () => {
    await rec("BL-1", dec("Use X", "Before\n### X1: fake\nAfter"));
    const entries = parseContext(note()).entries;
    expect(entries.map((e) => e.local)).toEqual(["D1"]);
    expect(entries[0].content).toBe("Before\n#### X1: fake\nAfter");
  });

  it("refuses a fence that is not closed, and the note stays", async () => {
    const before = note();
    await expect(rec("BL-1", dec("Use X", "Text\n```js\ncode"))).rejects.toThrow(/input 1 \(Use X\).*not closed/);
    expect(note()).toBe(before);
  });

  it("converts the error of insertEntry for a note with a fence that is not closed, and the note stays", async () => {
    await createIssue(t, { title: "Fenced", description: "Text\n```js\ncode" }, TODAY);
    const before = note("BL-3");
    await expect(rec("BL-3", dec("Use X", "Fine."))).rejects.toThrow(/input 1 \(Use X\).*code fence in the note is not closed/);
    expect(note("BL-3")).toBe(before);
  });

  it("keeps a status line in the content as content", async () => {
    await rec("BL-1", dec("Use X", "- status: superseded\nrest of it"));
    const e = entry(note(), "D1");
    expect(e.status).toBe("active");
    expect(e.content).toBe("- status: superseded\nrest of it");
  });

  it("writes a labelled value that starts with a fence, with its blank lines", async () => {
    await rec("BL-1", dec("Use X", "x", { rationale: "```\nx\n\ny\n```\nafter\n\nmore" }));
    expect(entry(note(), "D1").rationale).toBe("\n```\nx\n\ny\n```\nafter\nmore");
  });

  it("refuses a note with duplicate local IDs", async () => {
    await rec("BL-1", dec("Use X", "One."));
    io.files.set("T/Bilinear/issues/BL-1.md", note() + "\n### D1: Again\n- status: active\n");
    await expect(rec("BL-1", dec("Pick beta", "Two."))).rejects.toThrow(/more than one entry with the ID D1; a person must correct the note first/);
  });

  it("trims white space and a line break around a supersedes item", async () => {
    await rec("BL-1", dec("Use X", "One."));
    const [r] = await rec("BL-1", dec("Pick beta", "Two.", { supersedes: [" D1\n"] }));
    expect(r.superseded).toEqual(["BL-1/D1"]);
    expect(entry(note(), "D1").status).toBe("superseded");
    await expect(rec("BL-1", dec("Pick gamma", "Three.", { supersedes: [" BL-1/D2\n"] }))).resolves.toHaveLength(1);
  });

  it("keeps CRLF in a note, when it records and supersedes", async () => {
    io.files.set("T/Bilinear/issues/BL-1.md", note().replace(/\n/g, "\r\n"));
    await rec("BL-1", dec("Use X", "One.\nTwo."));
    await rec("BL-1", dec("Pick beta", "Three.", { supersedes: ["D1"] }));
    expect(note()).toContain("D2");
    expect(/(?<!\r)\n/.test(note())).toBe(false);
    expect(entry(note(), "D1")).toMatchObject({ status: "superseded", content: "One.\nTwo." });
  });
});

describe("getContext reads", () => {
  it("reads each note one time", async () => {
    await rec("BL-1", dec("Use X", "One."), dec("Pick beta", "Two."));
    await rec("BL", { type: "constraint", subject: "No network", content: "Never." });
    const reads: string[] = [];
    const read = io.read.bind(io);
    io.read = async (p: string) => {
      reads.push(p);
      return read(p);
    };
    await getContext(t, ["BL-1/D1", "BL/C1", "BL-1/D2", "BL-1/D1"]);
    expect(reads.filter((p) => p.endsWith("BL-1.md"))).toHaveLength(1);
  });
});
