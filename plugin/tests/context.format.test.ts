// The read side of context entries: parse, write, and the full IDs.

import { describe, expect, it } from "vitest";
import { formatEntry, fullId, parseContext, parseFullId, type ContextEntry } from "../src/format/context";
import { TYPE_LETTERS } from "../src/format/ids";

const EXAMPLE = `## Context log

### D3: Use one cache directory per test
- status: active
- author: claude
- created: 2026-10-01
- updated: 2026-10-02
- supersedes: D1
- evidence:
  - comment:2026-10-01#2
  - file:src/cache.ts

Each test gets a temp directory. Tests no longer share state.

Rationale: Shared state caused the flaky failures.
Alternatives: A global lock. A fixture reset.
`;

const note = (body: string) => `---\ntitle: Fix\nstatus: todo\n---\n\nDescription.\n\n${body}`;

/** Wrap an entry text in its section, as it is in a note, and parse it. */
const reparse = (text: string, eol = "\n") => parseContext(`## Context log${eol}${eol}${text}`);
const withoutRange = ({ range, ...rest }: ContextEntry) => rest;

function entry(letter: string, extra: Partial<ContextEntry> = {}): ContextEntry {
  const type = TYPE_LETTERS[letter as keyof typeof TYPE_LETTERS];
  return {
    local: `${letter}2`,
    type,
    number: 2,
    subject: "A subject: with a colon",
    content: "First line.\n\nSecond paragraph.",
    rationale: "Because.\nIt goes on.",
    alternatives: "Other things.",
    evidence: ["comment:2026-10-01#2", "file:src/cache.ts"],
    created: "2026-10-01",
    updated: "2026-10-02",
    author: "claude",
    status: "superseded",
    supersedes: ["D1", "D2"],
    supersededBy: "D9",
    extra: [],
    range: [0, 0],
    ...(letter === "R"
      ? { rejected: { attempted: "a", promising: "p", happened: "h\nmore", failed: "f", applies: "ap" } }
      : {}),
    ...extra,
  };
}

describe("parseContext", () => {
  it("reads the example", () => {
    const r = parseContext(EXAMPLE);
    expect(r.problems).toEqual([]);
    expect(r.duplicates).toEqual([]);
    expect(r.section).toEqual([0, 16]);
    expect(r.entries).toEqual([
      {
        local: "D3",
        type: "decision",
        number: 3,
        subject: "Use one cache directory per test",
        content: "Each test gets a temp directory. Tests no longer share state.",
        rationale: "Shared state caused the flaky failures.",
        alternatives: "A global lock. A fixture reset.",
        evidence: ["comment:2026-10-01#2", "file:src/cache.ts"],
        created: "2026-10-01",
        updated: "2026-10-02",
        author: "claude",
        status: "active",
        supersedes: ["D1"],
        supersededBy: null,
        extra: [],
        range: [2, 16],
      },
    ]);
  });

  it("gives no section and no entries for a note without ## Context log", () => {
    const r = parseContext(note("## Comments\n- 2026-10-01 rk: hi\n"));
    expect(r).toEqual({ entries: [], section: null, duplicates: [], problems: [] });
    expect(parseContext("")).toEqual({ entries: [], section: null, duplicates: [], problems: [] });
  });

  it("counts lines of the whole text, frontmatter included", () => {
    const text = note(EXAMPLE);
    const r = parseContext(text);
    expect(r.section).toEqual([7, 23]);
    expect(r.entries[0].range).toEqual([9, 23]);
    expect(text.split("\n").slice(9, 10)[0]).toBe("### D3: Use one cache directory per test");
  });

  it("works before and after ## Comments", () => {
    const comments = "## Comments\n- 2026-10-01 rk: hi\n\n";
    const before = parseContext(note(`${EXAMPLE}\n${comments}`));
    const after = parseContext(note(`${comments}${EXAMPLE}`));
    expect(before.entries.length).toBe(1);
    expect(after.entries.length).toBe(1);
    expect(withoutRange(before.entries[0])).toEqual(withoutRange(after.entries[0]));
    expect(before.section).toEqual([7, 24]);
    expect(before.entries[0].range).toEqual([9, 24]);
    expect(after.section).toEqual([10, 26]);
    expect(after.entries[0].range).toEqual([12, 26]);
    expect(before.entries[0].content).not.toContain("Comments");
  });

  it("gives exact ranges for the odd shapes of a text", () => {
    const entry1 = "### D1: x\n- status: active\n";
    const crlf = parseContext("## Context log\r\n\r\n### D1: x\r\n- status: active\r\n\r\nBody.\r\n");
    expect(crlf.section).toEqual([0, 6]);
    expect(crlf.entries[0].range).toEqual([2, 6]);
    expect([crlf.entries[0].subject, crlf.entries[0].content]).toEqual(["x", "Body."]);
    const bom = parseContext("\ufeff## Context log\n" + entry1);
    expect(bom.section).toEqual([0, 3]);
    expect(bom.entries[0].range).toEqual([1, 3]);
    const bomFm = parseContext("\ufeff---\ntitle: T\n---\n## Context log\n" + entry1);
    expect(bomFm.section).toEqual([3, 6]);
    expect(bomFm.entries[0].range).toEqual([4, 6]);
    const noEol = parseContext("## Context log\n### D1: x\n- status: active");
    expect(noEol.section).toEqual([0, 3]);
    expect(noEol.entries[0].range).toEqual([1, 3]);
    const two = parseContext("## Context log\n" + entry1 + "### D2: y\n- status: active\n");
    expect(two.section).toEqual([0, 5]);
    expect(two.entries.map((x) => x.range)).toEqual([[1, 3], [3, 5]]);
    const fm = parseContext("---\ntitle: T\n---\n## Context log\n" + entry1 + "## Comments\n- 2026-10-01 rk: hi\n");
    expect(fm.section).toEqual([3, 6]);
    expect(fm.entries[0].range).toEqual([4, 6]);
    const plain = parseContext("Text\n\n## Context log\n" + entry1);
    expect(plain.section).toEqual([2, 5]);
    expect(plain.entries[0].range).toEqual([3, 5]);
  });

  it("keeps a bullet list and a code fence in the content", () => {
    const text = "### D1: x\n- status: active\n\nIntro:\n\n- one\n- two\n\n```ts\n### D2: no\nRationale: no\n\n  indented\n```\n\nRationale: yes\n";
    const e = reparse(text).entries[0];
    expect(e.extra).toEqual([]);
    expect(e.content).toBe("Intro:\n\n- one\n- two\n\n```ts\n### D2: no\nRationale: no\n\n  indented\n```");
    expect(e.rationale).toBe("yes");
    expect(formatEntry(e, "\n")).toBe(text);
  });

  it("puts a bullet list right after the metadata into extra, so no text is lost", () => {
    const text = "### D1: x\n- status: active\n- one\n- two: 2\n- three\n\nBody.\n";
    const e = reparse(text).entries[0];
    expect(e.extra).toEqual(["- one", "- two: 2", "- three"]);
    expect(e.content).toBe("Body.");
    expect(formatEntry(e, "\n")).toBe(text);
    const list = reparse("### D1: x\n- one\n- two\n").entries[0];
    expect(list.extra).toEqual(["- one", "- two"]);
    expect(list.content).toBe("");
  });

  it("keeps the lines under a bullet that is not a list, and a list under a scalar key", () => {
    const text = "### D1: x\n- status: active\n  checked by rk\n- supersedes:\n  - D1\n  - D2\n- author: a\n";
    const r = reparse(text);
    const e = r.entries[0];
    expect(e.status).toBe("active");
    expect(e.supersedes).toEqual([]);
    expect(e.extra).toEqual(["- status: active", "  checked by rk", "- supersedes:", "  - D1", "  - D2"]);
    expect(r.problems.length).toBeGreaterThan(0);
    const again = reparse(formatEntry(e, "\n")).entries[0];
    expect(withoutRange(again)).toEqual(withoutRange(e));
  });

  it("keeps a status that does not parse, and writes no second status line", () => {
    const r = reparse("### D1: x\n- status: done\n- author: a\n\nBody.\n");
    const e = r.entries[0];
    expect(e.status).toBe("active");
    expect(e.extra).toEqual(["- status: done"]);
    expect(r.problems).toEqual(["D1: unknown status: done"]);
    const text = formatEntry(e, "\n");
    expect(text).toBe("### D1: x\n- author: a\n- status: done\n\nBody.\n");
    const again = reparse(text);
    expect(withoutRange(again.entries[0])).toEqual(withoutRange(e));
    expect(formatEntry(again.entries[0], "\n")).toBe(text);
    expect(again.problems).toEqual(["D1: unknown status: done"]);
  });

  it("keeps a valid status that has lines under it, as the one status line", () => {
    const text = "### D1: x\n- author: a\n- status: superseded\n  by D4\n\nBody.\n";
    const r = reparse(text);
    const e = r.entries[0];
    expect(e.status).toBe("superseded");
    expect(e.extra).toEqual(["- status: superseded", "  by D4"]);
    expect(r.problems).toEqual(["D1: status has lines under it"]);
    const out = formatEntry(e, "\n");
    expect(out.match(/- status:/g)?.length).toBe(1);
    expect(out).toBe("### D1: x\n- author: a\n- status: superseded\n  by D4\n\nBody.\n");
    expect(withoutRange(reparse(out).entries[0])).toEqual(withoutRange(e));
    // A status set since wins over the kept bullet.
    const out2 = formatEntry({ ...e, status: "resolved" }, "\n");
    expect(reparse(out2).entries[0].status).toBe("resolved");
  });

  it("is stable for a bad status followed by a valid one, whatever it is", () => {
    for (const valid of ["active", "resolved"]) {
      const e = reparse(`### D1: x\n- status: done\n- status: ${valid}\n`).entries[0];
      expect(e.status).toBe(valid);
      expect(e.extra).toEqual(["- status: done"]);
      const out = formatEntry(e, "\n");
      const again = reparse(out);
      expect(again.problems).toEqual([]);
      expect(withoutRange(again.entries[0])).toEqual(withoutRange(e));
      expect(formatEntry(again.entries[0], "\n")).toBe(out);
    }
  });

  it("takes a later valid status after a bad one", () => {
    const e = reparse("### D1: x\n- status: done\n- status: resolved\n").entries[0];
    expect(e.status).toBe("resolved");
    expect(e.extra).toEqual(["- status: done"]);
    const again = reparse(formatEntry(e, "\n")).entries[0];
    expect(withoutRange(again)).toEqual(withoutRange(e));
  });

  it("takes a later valid value after a bad one of the same key", () => {
    const r = reparse("### D1: x\n- status: active\n- created: soon\n- created: 2026-10-01\n");
    expect(r.entries[0].created).toBe("2026-10-01");
    expect(r.entries[0].extra).toEqual(["- created: soon"]);
    expect(r.problems.length).toBe(1);
  });

  it("keeps the indent and the blank lines of a code block in a labelled value", () => {
    const text = "### D1: x\n- status: active\n\nRationale: see\n```yaml\nkey:\n  - a\n\n  - b\n```\nAlternatives: none\n";
    const e = reparse(text).entries[0];
    expect(e.rationale).toBe("see\n```yaml\nkey:\n  - a\n\n  - b\n```");
    expect(e.alternatives).toBe("none");
    expect(e.content).toBe("");
    const out = formatEntry(e, "\n");
    expect(out).toBe(text);
    expect(withoutRange(reparse(out).entries[0])).toEqual(withoutRange(e));
  });

  it("writes a label alone when its value starts with a code fence", () => {
    const text = "## Context log\n\n### D1: x\n- status: active\n\nRationale:\n```ts\ncode\n```\n\n### D2: y\n- status: active\n\n## Comments\n- 2026-10-01 rk: hi\n";
    const r = parseContext(text);
    expect(r.entries.map((x) => x.local)).toEqual(["D1", "D2"]);
    expect(r.entries[0].rationale).toBe("\n```ts\ncode\n```");
    expect(r.entries[1].range).toEqual([10, 13]);
    expect(r.section).toEqual([0, 13]);
    const out = r.entries.map((x) => formatEntry(x, "\n")).join("\n");
    expect(`## Context log\n\n${out}\n## Comments\n- 2026-10-01 rk: hi\n`).toBe(text);
    const again = parseContext(`## Context log\n\n${out}`);
    expect(again.entries.map((x) => withoutRange(x))).toEqual(r.entries.map((x) => withoutRange(x)));
  });

  it("keeps where the first line of a labelled value is, so fence-like text stays as it was", () => {
    const cases = [
      ["Rationale: ```x``` is slow", "```x``` is slow"],
      ["Rationale: ~~~old~~~ plan", "~~~old~~~ plan"],
      ["Rationale:\nplain text", "\nplain text"],
      ["Rationale:\n~~~\nx\n~~~", "\n~~~\nx\n~~~"],
      ["Rationale: a\n```\nb\n\n```", "a\n```\nb\n\n```"],
    ];
    for (const [label, value] of cases) {
      const text = `## Context log\n\n### D1: x\n- status: active\n\n${label}\n\n### D2: y\n- status: active\n\n## Comments\n- 2026-10-01 rk: hi\n`;
      const r = parseContext(text);
      expect(r.entries.map((x) => x.local), label).toEqual(["D1", "D2"]);
      expect(r.entries[0].rationale, label).toBe(value);
      expect(r.section![1], label).toBe(text.split("\n").indexOf("## Comments"));
      const out = r.entries.map((x) => formatEntry(x, "\n")).join("\n");
      expect(`## Context log\n\n${out}\n## Comments\n- 2026-10-01 rk: hi\n`, label).toBe(text);
      const again = parseContext(`## Context log\n\n${out}`);
      expect(again.entries.map((x) => withoutRange(x)), label).toEqual(r.entries.map((x) => withoutRange(x)));
    }
  });

  it("is stable when the status bullet that gave the value is not the first kept", () => {
    const e = reparse("### D1: x\n- status: done\n- status: resolved\n  note\n\nBody.\n").entries[0];
    expect(e.status).toBe("resolved");
    expect(e.statusInExtra).toBe(true);
    const out = formatEntry(e, "\n");
    expect(out).toBe("### D1: x\n- status: done\n- status: resolved\n  note\n\nBody.\n");
    const again = reparse(out).entries[0];
    expect(again.statusInExtra).toBe(true);
    expect(withoutRange(again)).toEqual(withoutRange(e));
  });

  it("keeps the indent of a continuation line", () => {
    const e = reparse("### D1: x\n- status: active\n\nRationale: a\n    b\n").entries[0];
    expect(e.rationale).toBe("a\n    b");
  });

  it("reads nested and inline evidence", () => {
    const nested = reparse("### F1: x\n- status: active\n- evidence:\n  - a:1\n  * b:2\n");
    const inline = reparse("### F1: x\n- status: active\n- evidence: a:1, b:2\n");
    expect(nested.entries[0].evidence).toEqual(["a:1", "b:2"]);
    expect(inline.entries[0].evidence).toEqual(["a:1", "b:2"]);
  });

  it("skips foreign level-3 blocks, keeps intro text, and ends an entry at any heading", () => {
    const r = parseContext(
      "## Context log\n\nSome intro.\n\n### Notes\nfree text\n\n### q4: Open?\n- status: Resolved\n\nBody.\n\n#### Deeper\nstays\n\n### Other\nx\n\n### S1: State\n- status: active\n",
    );
    expect(r.problems).toEqual([]);
    expect(r.entries.map((e) => e.local)).toEqual(["Q4", "S1"]);
    expect(r.entries[0].status).toBe("resolved");
    expect(r.entries[0].content).toBe("Body.\n\n#### Deeper\nstays");
    expect(r.entries[0].range).toEqual([7, 15]);
  });

  it("ignores headings inside code fences", () => {
    const r = reparse("### D1: x\n- status: active\n\n```\n### D2: not an entry\n## Comments\n```\n");
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].content).toContain("### D2: not an entry");
  });

  it("reads a bad or missing status as active with a problem", () => {
    const r = reparse("### D1: a\n- status: bogus\n\n### D2: b\n- author: x\n");
    expect(r.entries.map((e) => e.status)).toEqual(["active", "active"]);
    expect(r.problems.length).toBe(2);
    expect(r.problems[0]).toContain("D1");
    expect(r.problems[1]).toContain("D2");
  });

  it("keeps unknown bullets and bad values in extra", () => {
    const r = reparse(
      "### D1: a\n- status: active\n- custom: 1\n  - nested\n- plain bullet\n- created: soon\n- superseded-by: nope\n\nText.\n",
    );
    const e = r.entries[0];
    expect(e.extra).toEqual(["- custom: 1", "  - nested", "- plain bullet", "- created: soon", "- superseded-by: nope"]);
    expect(e.created).toBeNull();
    expect(e.content).toBe("Text.");
    expect(r.problems.length).toBe(2);
  });

  it("reports duplicate IDs once and keeps both entries", () => {
    const r = reparse("### D1: a\n- status: active\n\n### d1: b\n- status: active\n\n### D1: c\n- status: active\n");
    expect(r.duplicates).toEqual(["D1"]);
    expect(r.entries.length).toBe(3);
  });

  it("continues a labelled value on the next lines until a blank line", () => {
    const r = reparse("### D1: a\n- status: active\n\nBody\nRationale: one\ntwo\n\nthree\nAlternatives: x\n");
    expect(r.entries[0].rationale).toBe("one\ntwo");
    expect(r.entries[0].alternatives).toBe("x");
    expect(r.entries[0].content).toBe("Body\n\nthree");
  });

  it("reads the labels of a rejected entry only on that type", () => {
    const r = reparse(
      "### R1: a\n- status: active\n\nAttempted: x\nApplies: y\n\n### D1: b\n- status: active\n\nAttempted: x\n",
    );
    expect(r.entries[0].rejected).toEqual({ attempted: "x", promising: "", happened: "", failed: "", applies: "y" });
    expect(r.entries[1].rejected).toBeUndefined();
    expect(r.entries[1].content).toBe("Attempted: x");
  });

  it("does not throw on odd text", () => {
    for (const t of ["## Context log", "## Context log\n### D1", "## Context log\n### D1:\n-", "## Context log\n### D1: x\n- :\n- status", "\ufeff## Context log\r\n### Z9: x\r\n"]) {
      expect(() => parseContext(t), t).not.toThrow();
    }
    expect(parseContext("## Context log\r\n### D1: x\r\n- status: active\r\n").entries[0].subject).toBe("x");
  });
});

describe("formatEntry", () => {
  it("writes the canonical form of the example", () => {
    const e = parseContext(EXAMPLE).entries[0];
    expect(`## Context log\n\n${formatEntry(e, "\n")}`).toBe(EXAMPLE);
  });

  it("round-trips each type, with all fields", () => {
    for (const letter of Object.keys(TYPE_LETTERS)) {
      const e = entry(letter);
      const r = reparse(formatEntry(e, "\n"));
      expect(r.problems, letter).toEqual([]);
      expect(r.entries.length).toBe(1);
      expect(withoutRange(r.entries[0]), letter).toEqual(withoutRange(e));
    }
  });

  it("round-trips an entry with only the required fields", () => {
    const e = entry("C", {
      content: "",
      rationale: "",
      alternatives: "",
      evidence: [],
      created: null,
      updated: null,
      author: null,
      status: "active",
      supersedes: [],
      supersededBy: null,
    });
    const text = formatEntry(e, "\n");
    expect(text).toBe("### C2: A subject: with a colon\n- status: active\n");
    expect(withoutRange(reparse(text).entries[0])).toEqual(withoutRange(e));
  });

  it("writes labels without content, and unknown bullets back", () => {
    const e = entry("D", { content: "", extra: ["- custom: 1", "  - nested"] });
    const text = formatEntry(e, "\r\n");
    expect(text).toContain("  - nested\r\n\r\nRationale: Because.\r\nIt goes on.\r\n");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    const back = reparse(text, "\r\n").entries[0];
    expect(back.extra).toEqual(["- custom: 1", "  - nested"]);
    expect(withoutRange(back)).toEqual(withoutRange(e));
  });

  it("writes the letter in upper case from the type", () => {
    const e = parseContext("## Context log\n### d7: x\n- status: active\n").entries[0];
    expect(formatEntry(e, "\n").startsWith("### D7: x\n")).toBe(true);
  });
});

describe("full IDs", () => {
  it("builds them in upper case", () => {
    expect(fullId("BL-9", "D3")).toBe("BL-9/D3");
    expect(fullId("bl", "d1")).toBe("BL/D1");
  });

  it("parses them, any letter case", () => {
    expect(parseFullId("BL-9/D3")).toEqual({ noteId: "BL-9", local: "D3" });
    expect(parseFullId("bl-9/d3")).toEqual({ noteId: "BL-9", local: "D3" });
    expect(parseFullId("BL/D1")).toEqual({ noteId: "BL", local: "D1" });
    expect(parseFullId(" web2/r10 ")).toEqual({ noteId: "WEB2", local: "R10" });
  });

  it("refuses what is not a full ID", () => {
    for (const s of ["", "BL-9", "BL-9/", "/D3", "BL-9/X3", "BL-9/D", "BL-9/D3/D4", "BL-/D3", "9/D3", "BL-9/D3x"]) {
      expect(parseFullId(s), s).toBeNull();
    }
  });
});
