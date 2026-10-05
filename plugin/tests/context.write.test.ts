// The write side of context entries: numbers, insert, patch, strip and the checks before writing.

import { describe, expect, it } from "vitest";
import { checkEntry, formatEntry, insertEntry, nextNumber, parseContext, patchEntry, stripContext, type ContextEntry } from "../src/format/context";
import { TYPE_LETTERS } from "../src/format/ids";
import { addComment, bodyLinks } from "../src/format/issue-note";
import { Doc } from "../src/format/yaml";
import { descriptionLinks } from "../src/store/snapshot";

function mk(letter: string, number: number, extra: Partial<ContextEntry> = {}): ContextEntry {
  return {
    local: `${letter}${number}`,
    type: TYPE_LETTERS[letter as keyof typeof TYPE_LETTERS],
    number,
    subject: `Subject ${letter}${number}`,
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
    extra: [],
    range: [0, 0],
    ...extra,
  };
}

const bare = ({ range, ...rest }: ContextEntry) => rest;
const crlf = (s: string) => s.replace(/\n/g, "\r\n");
const FM = "---\ntitle: Fix\nstatus: todo\n---\n\n";
const NEW = mk("D", 4, { content: "New content." });
const NEW_TEXT = "### D4: Subject D4\n- status: active\n\nNew content.\n";

/** The entry that `parseContext` finds in a text, without its range. */
function found(text: string, local: string) {
  const e = parseContext(text).entries.find((x) => x.local === local);
  return e ? bare(e) : undefined;
}

describe("nextNumber", () => {
  it("is 1 when there is none", () => {
    expect(nextNumber("Just text.\n", "D")).toBe(1);
    expect(nextNumber("## Context\n", "D")).toBe(1);
  });
  it("is the highest number plus one, with gaps and duplicates", () => {
    const text = `## Context\n\n### D1: a\n- status: active\n\n### D7: b\n- status: active\n\n### D3: c\n- status: active\n\n### D7: dup\n- status: active\n`;
    expect(nextNumber(text, "D")).toBe(8);
    expect(nextNumber(text, "d")).toBe(8);
  });
  it("ignores other letters", () => {
    const text = `## Context\n\n### D5: a\n- status: active\n\n### C2: b\n- status: active\n`;
    expect(nextNumber(text, "C")).toBe(3);
    expect(nextNumber(text, "F")).toBe(1);
  });
});

describe("insertEntry", () => {
  const check = (before: string, after: string) => {
    const out = insertEntry(before, NEW);
    expect(out).toBe(after);
    expect(found(out, "D4")).toEqual(bare(NEW));
  };

  it("creates the section at the end without Context and Comments", () => {
    check(`${FM}Description.\n`, `${FM}Description.\n\n## Context\n\n${NEW_TEXT}`);
  });
  it("creates the section in a note with frontmatter only", () => {
    check("---\ntitle: Fix\n---\n", `---\ntitle: Fix\n---\n\n## Context\n\n${NEW_TEXT}`);
  });
  it("creates the section before Comments", () => {
    check(`${FM}Description.\n\n## Comments\n\n- 2026-10-01 rk: hi\n`, `${FM}Description.\n\n## Context\n\n${NEW_TEXT}\n## Comments\n\n- 2026-10-01 rk: hi\n`);
  });
  it("adds a blank line before Comments when there is none", () => {
    check(`${FM}Description.\n## Comments\n- c\n`, `${FM}Description.\n\n## Context\n\n${NEW_TEXT}\n## Comments\n- c\n`);
  });
  it("appends to a section with entries", () => {
    const old = "### D1: Old\n- status: active\n\nOld content.\n";
    check(`${FM}Description.\n\n## Context\n\n${old}\n## Comments\n\n- c\n`, `${FM}Description.\n\n## Context\n\n${old}\n${NEW_TEXT}\n## Comments\n\n- c\n`);
  });
  it("appends to an empty section", () => {
    check(`${FM}Description.\n\n## Context\n`, `${FM}Description.\n\n## Context\n\n${NEW_TEXT}`);
  });
  it("appends to a section that comes after Comments", () => {
    const old = "### D1: Old\n- status: active\n";
    check(`${FM}Text.\n\n## Comments\n\n- c\n\n## Context\n\n${old}`, `${FM}Text.\n\n## Comments\n\n- c\n\n## Context\n\n${old}\n${NEW_TEXT}`);
  });
  it("keeps the blank lines at the end of a section", () => {
    const old = "### D1: Old\n- status: active\n";
    check(`## Context\n\n${old}\n\n## Comments\n`, `## Context\n\n${old}\n${NEW_TEXT}\n\n## Comments\n`);
  });
  it("writes a CRLF note with CRLF", () => {
    const before = crlf(`${FM}Description.\n\n## Comments\n\n- c\n`);
    const out = insertEntry(before, NEW);
    expect(out).toBe(crlf(`${FM}Description.\n\n## Context\n\n${NEW_TEXT}\n## Comments\n\n- c\n`));
    expect(found(out, "D4")).toEqual(bare(NEW));
    expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });
  it("finishes the last line of a note with no final line break", () => {
    check(`${FM}Description.`, `${FM}Description.\n\n## Context\n\n${NEW_TEXT}`);
    check(`${FM}## Context\n\n### D1: Old\n- status: active`, `${FM}## Context\n\n### D1: Old\n- status: active\n\n${NEW_TEXT}`);
  });
  it("puts the section at the end of an index note", () => {
    const index = "---\nprefix: BL\n---\n\n## Issues\n\n- [[BL-1]] One\n\n## Archive\n\n- [[BL-2]] Two\n";
    const out = insertEntry(index, NEW);
    expect(out).toBe(`${index}\n## Context\n\n${NEW_TEXT}`);
    expect(found(out, "D4")).toEqual(bare(NEW));
    expect(found(insertEntry(out, mk("C", 1)), "C1")).toEqual(bare(mk("C", 1)));
  });
  it("throws on an unsafe entry", () => {
    expect(() => insertEntry("Text.\n", mk("D", 1, { subject: "a\nb" }))).toThrow(/not safe to write/);
  });
});

describe("addComment with Context", () => {
  const old = "### D1: Old\n- status: active\n\nOld content.\n";
  const entries = (text: string) => parseContext(text).entries.map(bare);
  it("adds to Comments when Context comes before", () => {
    const before = `${FM}Text.\n\n## Context\n\n${old}\n## Comments\n\n- 2026-10-01 rk: first\n`;
    const out = addComment(before, "2026-10-02", "ana", "second");
    expect(out).toBe(`${FM}Text.\n\n## Context\n\n${old}\n## Comments\n\n- 2026-10-01 rk: first\n- 2026-10-02 ana: second\n`);
    expect(entries(out)).toEqual(entries(before));
  });
  it("adds to Comments when Context comes after", () => {
    const before = `${FM}Text.\n\n## Comments\n\n- 2026-10-01 rk: first\n\n## Context\n\n${old}`;
    const out = addComment(before, "2026-10-02", "ana", "second");
    expect(out).toBe(`${FM}Text.\n\n## Comments\n\n- 2026-10-01 rk: first\n- 2026-10-02 ana: second\n\n## Context\n\n${old}`);
    expect(entries(out)).toEqual(entries(before));
  });
});

describe("patchEntry", () => {
  const E = (n: number) => `### D${n}: Entry ${n}\n- status: active\n\nContent ${n}.\n`;
  const text = `${FM}Text.\n\n## Context\n\n${E(1)}\n${E(2)}\n${E(3)}\n\n## Comments\n\n- c\n`;
  const resolve = (e: ContextEntry): ContextEntry => ({ ...e, status: "resolved" });
  const lineCount = (s: string) => s.split("\n").length;

  for (const [n, name] of [[1, "first"], [2, "middle"], [3, "last"]] as const) {
    it(`changes the status of the ${name} entry`, () => {
      const out = patchEntry(text, `D${n}`, resolve);
      expect(out).toBe(text.replace(E(n), E(n).replace("active", "resolved")));
      expect(lineCount(out)).toBe(lineCount(text));
      expect(found(out, `D${n}`)?.status).toBe("resolved");
    });
  }
  it("accepts a local ID in lower case", () => {
    expect(patchEntry(text, "d2", resolve)).toBe(patchEntry(text, "D2", resolve));
  });
  it("keeps a missing final line break", () => {
    const before = `## Context\n\n${E(1)}\n### D2: Entry 2\n- status: active\n\nContent 2.`;
    const out = patchEntry(before, "D2", resolve);
    expect(out).toBe(`## Context\n\n${E(1)}\n### D2: Entry 2\n- status: resolved\n\nContent 2.`);
  });
  it("keeps trailing blank lines at the end of a note", () => {
    const before = `## Context\n\n${E(1)}\n\n`;
    expect(patchEntry(before, "D1", resolve)).toBe(before.replace("active", "resolved"));
  });
  it("writes a CRLF note with CRLF", () => {
    const before = crlf(text);
    const out = patchEntry(before, "D2", resolve);
    expect(out).toBe(crlf(text.replace(E(2), E(2).replace("active", "resolved"))));
  });
  it("changes an entry with extra bullets and a status that stays in extra", () => {
    const hand = "### D2: Hand\n- status: waiting\n- owner: rk\n  - nested\n\nBody.\n";
    const before = `## Context\n\n${E(1)}\n${hand}\n${E(3)}`;
    const out = patchEntry(before, "D2", (e) => {
      expect(e.statusInExtra).toBe(true);
      return { ...e, subject: "Renamed" };
    });
    expect(out).toBe(`## Context\n\n${E(1)}\n### D2: Renamed\n- owner: rk\n  - nested\n- status: waiting\n\nBody.\n\n${E(3)}`.replace("- owner: rk\n  - nested\n- status: waiting", "- status: waiting\n- owner: rk\n  - nested"));
    expect(found(out, "D2")?.status).toBe("active");
    expect(found(out, "D2")?.extra).toEqual(["- status: waiting", "- owner: rk", "  - nested"]);
    // A new valid status replaces the bullet that did not parse.
    const fixed = patchEntry(before, "D2", (e) => ({ ...e, status: "resolved" }));
    expect(found(fixed, "D2")?.status).toBe("resolved");
    expect(fixed).toContain("- status: resolved");
  });
  it("throws for an unknown ID", () => {
    expect(() => patchEntry(text, "D9", resolve)).toThrow(/no context entry/);
    expect(() => patchEntry("Text.\n", "D1", resolve)).toThrow(Error);
  });
  it("throws when the changed entry is not safe", () => {
    expect(() => patchEntry(text, "D1", (e) => ({ ...e, subject: "" }))).toThrow(/not safe to write/);
  });
});

describe("stripContext", () => {
  const E = "### D1: Entry\n- status: active\n\nContent.\n";
  it("removes a section in the middle", () => {
    expect(stripContext(`${FM}Text.\n\n## Context\n\n${E}\n## Comments\n\n- c\n`)).toBe(`${FM}Text.\n\n## Comments\n\n- c\n`);
  });
  it("removes a section at the end with the blank lines before it", () => {
    expect(stripContext(`${FM}Text.\n\n## Comments\n\n- c\n\n## Context\n\n${E}`)).toBe(`${FM}Text.\n\n## Comments\n\n- c\n`);
    expect(stripContext(`${FM}Text.\n\n## Context\n\n${E}\n\n`)).toBe(`${FM}Text.\n`);
  });
  it("removes a section in a CRLF note", () => {
    expect(stripContext(crlf(`${FM}Text.\n\n## Context\n\n${E}`))).toBe(crlf(`${FM}Text.\n`));
  });
  it("returns the text when there is no section", () => {
    const t = `${FM}Text.\n\n## Comments\n\n- c`;
    expect(stripContext(t)).toBe(t);
  });
  it("keeps a heading in a code block and the other sections", () => {
    const t = "## Plan\n\n```\n## Context\n```\n\n## Context\n\n### D1: x\n\n## Notes\n\nEnd.\n";
    expect(stripContext(t)).toBe("## Plan\n\n```\n## Context\n```\n\n## Notes\n\nEnd.\n");
  });
  it("is the inverse of insertEntry on a note without the section", () => {
    const t = `${FM}Text.\n\n## Comments\n\n- c\n`;
    expect(stripContext(insertEntry(t, NEW))).toBe(t);
  });
});

describe("checkEntry", () => {
  const problems = (extra: Partial<ContextEntry>, letter = "D") => checkEntry(mk(letter, 1, extra));
  const roundTrip = (e: ContextEntry) => {
    const out = insertEntry("Text.\n", e);
    expect(found(out, e.local)).toEqual(bare(e));
  };

  it("accepts a full entry and an entry that reads back the same", () => {
    const full = mk("D", 3, {
      subject: "A subject: with a colon",
      content: "First.\n\n```\n### not a heading\nRationale: no\n```\n\nSecond.\n#### Level four",
      rationale: "One.\nTwo.",
      alternatives: "\n```\nline\n\nafter blank\n```\nmore",
      evidence: ["file:a.ts", "comment:2026-10-01#2"],
      created: "2026-10-01",
      updated: "2026-10-02",
      author: "claude",
      supersedes: ["D1"],
      supersededBy: "D9",
      status: "superseded",
    });
    expect(checkEntry(full)).toEqual([]);
    roundTrip(full);
    const rejected = mk("R", 1, { rejected: { attempted: "a", promising: "", happened: "\n- x\n- y", failed: "f", applies: "ap" } });
    expect(checkEntry(rejected)).toEqual([]);
    roundTrip(rejected);
  });
  it("needs a subject of one line", () => {
    expect(problems({ subject: "" })).toHaveLength(1);
    expect(problems({ subject: "  " })).toHaveLength(1);
    expect(problems({ subject: "a\nb" })).toHaveLength(1);
    expect(problems({ subject: "a\r" })).toHaveLength(1);
    expect(problems({ subject: " a" })).toHaveLength(1);
    expect(problems({ subject: "a #" })).toHaveLength(1);
    expect(problems({ subject: "C#" })).toEqual([]);
  });
  it("rejects a heading of level 1 to 3 in content and in values, but not in code or at level 4", () => {
    for (const h of ["# a", "## a", "### a"]) {
      expect(problems({ content: `x\n${h}` })).toHaveLength(1);
      expect(problems({ rationale: `x\n${h}` })).toHaveLength(1);
      expect(problems({ alternatives: `\n${h}` })).toHaveLength(1);
    }
    expect(problems({ content: "x\n#### a" })).toEqual([]);
    expect(problems({ content: "```\n## a\n```" })).toEqual([]);
    expect(problems({ rationale: "# a" })).toEqual([]);
  });
  it("rejects a line that starts with a label of the entry, outside code", () => {
    expect(problems({ content: "x\nRationale: no" })).toHaveLength(1);
    expect(problems({ content: "Alternatives:" })).toHaveLength(1);
    expect(problems({ rationale: "x\nAlternatives: no" })).toHaveLength(1);
    expect(problems({ content: "```\nRationale: ok\n```" })).toEqual([]);
    expect(problems({ content: "Failed: ok for a decision" })).toEqual([]);
    expect(problems({ content: "Failed: not ok" }, "R")).toHaveLength(1);
    expect(problems({ rejected: { attempted: "x\nApplies: no", promising: "", happened: "", failed: "", applies: "" } }, "R")).toHaveLength(1);
  });
  it("needs balanced code fences in each field", () => {
    expect(problems({ content: "```\ncode" })).toHaveLength(1);
    expect(problems({ rationale: "x\n```\ncode" })).toHaveLength(1);
    expect(problems({ alternatives: "\n~~~\ncode" })).toHaveLength(1);
    expect(problems({ content: "```\ncode\n```" })).toEqual([]);
  });
  it("rejects a blank line in a labelled value, outside code", () => {
    expect(problems({ rationale: "a\n\nb" })).toHaveLength(1);
    expect(problems({ rationale: "a\n" })).toHaveLength(1);
    expect(problems({ alternatives: "\n\na" })).toHaveLength(1);
    expect(problems({ rationale: "a\n  \nb" })).toHaveLength(1);
    expect(problems({ alternatives: "\n```\na\n\nb\n```" })).toEqual([]);
    expect(problems({ content: "a\n\nb" })).toEqual([]);
  });
  it("accepts a fence on the first line of a value, and rejects a fence that is not closed", () => {
    expect(problems({ rationale: "```js inline\nmore" })).toEqual([]);
    expect(problems({ rationale: "```" })).toEqual([]);
    expect(problems({ rationale: "\n```\ncode\n```" })).toEqual([]);
    expect(problems({ rationale: "```\ncode\n```" }).some((p) => /not closed/.test(p))).toBe(true);
  });
  it("rejects extra lines that change the entry when written", () => {
    expect(problems({ extra: ["## Comments"] }).length).toBeGreaterThan(0);
    expect(() => insertEntry("Text.\n\n## Comments\n\n- c\n", mk("D", 1, { extra: ["## Comments"] }))).toThrow(/not safe to write/);
    expect(problems({ extra: ["- author: bob"] }).length).toBeGreaterThan(0);
    expect(problems({ extra: ["- author: bob"], author: "bob" })).toEqual([]);
    expect(problems({ extra: ["- owner: rk", "  - nested"] })).toEqual([]);
  });
  it("rejects a rejected entry without its fields", () => {
    expect(problems({}, "R").length).toBeGreaterThan(0);
  });
  it("rejects a line break in the author", () => {
    expect(problems({ author: "a\nb" })).toHaveLength(1);
    expect(problems({ author: "a\rb" })).toHaveLength(1);
    expect(problems({ author: "" })).toHaveLength(1);
    expect(problems({ author: "a b" })).toEqual([]);
  });
  it("needs valid dates or null", () => {
    expect(problems({ created: "2026-13-01" })).toHaveLength(1);
    expect(problems({ updated: "yesterday" })).toHaveLength(1);
    expect(problems({ created: "2026-02-28", updated: null })).toEqual([]);
  });
  it("needs evidence items of one line that are not empty", () => {
    expect(problems({ evidence: [""] })).toHaveLength(1);
    expect(problems({ evidence: ["a\nb"] })).toHaveLength(1);
    expect(problems({ evidence: ["- a"] })).toHaveLength(1);
    expect(problems({ evidence: ["a, b"] })).toEqual([]);
  });
  it("needs a local ID that matches, a known status and clean IDs of links", () => {
    expect(checkEntry({ ...mk("D", 1), local: "C1" })).toHaveLength(1);
    expect(problems({ supersedes: ["x"] })).toHaveLength(1);
    expect(problems({ supersededBy: "d2" })).toHaveLength(1);
    expect(problems({ status: "gone" as never })).toHaveLength(1);
  });
});

describe("links of the description", () => {
  const body = (order: "context-first" | "comments-first") => {
    const context = "## Context\n\n### D1: x\n- status: active\n\nSee [[BL-3]].\n\nRationale: [[BL-4]]\n";
    const comments = "## Comments\n\n- 2026-10-01 rk: see [[BL-5]]\n";
    return `See [[BL-1]] and ![[BL-2]].\n\n${order === "context-first" ? `${context}\n${comments}` : `${comments}\n${context}`}`;
  };
  for (const order of ["context-first", "comments-first"] as const) {
    it(`bodyLinks counts the description only, ${order}`, () => {
      expect(bodyLinks(body(order))).toEqual(["BL-1", "BL-2"]);
      expect(bodyLinks(new Doc(`${FM}${body(order)}\n## After\n\n[[BL-6]]\n`).body)).toEqual(["BL-1", "BL-2", "BL-6"]);
    });
    it(`descriptionLinks counts the description only, ${order}`, () => {
      const lines = body(order).split("\n");
      const headings = lines.flatMap((l, i) => {
        const m = /^(#{1,6}) (.*)$/.exec(l);
        return m ? [{ heading: m[2], level: m[1].length, position: { start: { line: i } } }] : [];
      });
      let offset = 0;
      const links: Array<{ link: string; position: { start: { line: number; offset: number } } }> = [];
      lines.forEach((l, i) => {
        for (const m of l.matchAll(/\[\[([^\]]+)\]\]/g)) links.push({ link: m[1], position: { start: { line: i, offset: offset + m.index! } } });
        offset += l.length + 1;
      });
      expect(descriptionLinks({ links, headings })).toEqual(["BL-1", "BL-2"]);
      // A level-2 heading after the sections ends them.
      const after = { link: "BL-6", position: { start: { line: lines.length + 1, offset: offset + 50 } } };
      const h2 = { heading: "After", level: 2, position: { start: { line: lines.length } } };
      expect(descriptionLinks({ links: [...links, after], headings: [...headings, h2] })).toEqual(["BL-1", "BL-2", "BL-6"]);
    });
  }
});

describe("insertEntry with a code fence that is not closed", () => {
  it("throws when the last entry of the section has one", () => {
    const text = "## Context\n\n### D1: Old\n- status: active\n\n```\ncode\n";
    expect(() => insertEntry(text, NEW)).toThrow(/code fence in the note is not closed/);
  });
  it("throws when the description has one and the section is created", () => {
    expect(() => insertEntry("Text.\n\n```\nopen\n", NEW)).toThrow(/code fence in the note is not closed/);
    expect(() => insertEntry("Text.\n\n```\nopen\n\n## Comments\n\n- c\n", NEW)).toThrow(/code fence in the note is not closed/);
  });
});

describe("formatEntry with a status that is kept in extra", () => {
  it("writes a status line when no status bullet is there", () => {
    const e = mk("D", 1, { statusInExtra: true, content: "- not metadata" });
    expect(formatEntry(e, "\n")).toBe("### D1: Subject D1\n- status: active\n\n- not metadata\n");
  });
});

describe("entries read from hand-written text", () => {
  const resolve = (e: ContextEntry): ContextEntry => ({ ...e, status: "resolved" });

  it("can have their status changed after a blank line of spaces", () => {
    const text = "## Context\n\n### D1: x\n- status: active\n\nBody.\n  \n### D2: y\n- status: active\n";
    expect(found(text, "D1")?.content).toBe("Body.");
    expect(patchEntry(text, "D1", resolve)).toBe("## Context\n\n### D1: x\n- status: resolved\n\nBody.\n  \n### D2: y\n- status: active\n");
  });
  it("can have their status changed with a fence on the first line of a value", () => {
    const text = "## Context\n\n### D1: x\n- status: active\n\nRationale: ```js inline\nmore\n";
    expect(found(text, "D1")?.rationale).toBe("```js inline\nmore");
    expect(patchEntry(text, "D1", resolve)).toBe(text.replace("active", "resolved"));
  });

  const hand: Record<string, string> = {
    "number 0": "### D0: x\n- status: active\n",
    "lower case letter": "### d3: x\n- status: active\n",
    "star bullets and status in capitals": "### D1: x\n* status: Active\n* author: rk\n",
    "no status": "### D1: x\n\nBody.\n",
    "status that does not parse": "### D1: x\n- status: waiting\n- owner: rk\n  - nested\n\nBody.\n",
    "status with lines under it": "### D1: x\n- status: resolved\n  - why\n\nBody.\n",
    "two statuses": "### D1: x\n- status: bad\n- status: resolved\n",
    "repeated keys": "### D1: x\n- status: active\n- author: a\n- author: b\n- created: nope\n- created: 2026-01-01\n",
    "inline evidence": "### D1: x\n- status: active\n- evidence: a, b\n",
    "closing hashes in the heading": "### D1: x ##\n- status: active\n",
    "content straight after the bullets": "### D1: x\n- status: active\nBody.\n",
    "labels in any order": "### D1: x\n- status: active\n\nAlternatives: b\nRationale: a\n",
    "label that repeats": "### D1: x\n- status: active\n\nRationale: a\nRationale: b\n",
    "empty label line": "### D1: x\n- status: active\n\nRationale:\nbody\nmore\n",
    "empty label": "### D1: x\n- status: active\n\nRationale:\n",
    "text after a value": "### D1: x\n- status: active\n\nRationale: a\n\nMore text.\n",
    "label of another type": "### D1: x\n- status: active\n\nRationale: a\nFailed: b\n",
    "fence with blank lines in a value": "### D1: x\n- status: active\n\nRationale:\n```\na\n\nb\n```\n",
    "level 4 heading": "### D1: x\n- status: active\n\n#### Detail\n\nText.\n",
    "rejected entry": "### R1: x\n- status: active\n\nAttempted: a\nFailed: b\n",
    "spaces before the content": "### D1: x\n- status: active\n\n   \n  Body.\n",
  };
  for (const [name, entryText] of Object.entries(hand)) {
    it(`passes checkEntry unchanged, and can be patched: ${name}`, () => {
      const text = `${FM}Text.\n\n## Context\n\n${entryText}\n### C9: next\n- status: active\n`;
      const [e] = parseContext(text).entries;
      expect(checkEntry(e)).toEqual([]);
      const out = patchEntry(text, e.local, resolve);
      expect(found(out, e.local)?.status).toBe("resolved");
      expect(found(out, "C9")).toEqual(found(text, "C9"));
    });
  }

  it("cannot pass when the subject is empty or a fence is not closed", () => {
    const empty = parseContext("## Context\n\n### D1:\n- status: active\n").entries[0];
    expect(empty.subject).toBe("");
    expect(checkEntry(empty).length).toBeGreaterThan(0);
    const open = parseContext("## Context\n\n### D1: x\n- status: active\n\n```\ncode\n").entries[0];
    expect(checkEntry(open).some((p) => /not closed/.test(p))).toBe(true);
  });
});

describe("insertEntry and patchEntry in odd notes", () => {
  it("keeps the BOM", () => {
    const bom = "\uFEFF";
    expect(insertEntry(`${bom}${FM}Text.\n`, NEW)).toBe(`${bom}${FM}Text.\n\n## Context\n\n${NEW_TEXT}`);
    const text = `${bom}${FM}## Context\n\n${NEW_TEXT}`;
    expect(patchEntry(text, "D4", (e) => ({ ...e, status: "resolved" }))).toBe(text.replace("active", "resolved"));
    expect(insertEntry(`${bom}## Context\n`, NEW)).toBe(`${bom}## Context\n\n${NEW_TEXT}`);
  });
  it("appends after intro text in the section", () => {
    const out = insertEntry("## Context\n\nSome intro text.\n", NEW);
    expect(out).toBe(`## Context\n\nSome intro text.\n\n${NEW_TEXT}`);
    expect(found(out, "D4")).toEqual(bare(NEW));
  });
  it("appends after a block that is not an entry", () => {
    const out = insertEntry("## Context\n\n### Notes\nfoo\n\n## Comments\n", NEW);
    expect(out).toBe(`## Context\n\n### Notes\nfoo\n\n${NEW_TEXT}\n## Comments\n`);
    expect(found(out, "D4")).toEqual(bare(NEW));
  });
  it("keeps a heading that follows the section directly", () => {
    const out = insertEntry("## Context\n## Comments\n- c\n", NEW);
    expect(out).toBe(`## Context\n\n${NEW_TEXT}\n## Comments\n- c\n`);
    expect(found(out, "D4")).toEqual(bare(NEW));
  });
});
