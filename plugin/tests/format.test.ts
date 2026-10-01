// The TypeScript port of the YAML subset and the note editors. The same
// cases are checked against the Python parser in cli/tests/test_yaml.py.

import { describe, expect, it } from "vitest";
import { cleanTitle, formatLine, idNumber, linkId, linkTarget, validDate } from "../src/format/ids";
import { Index, newIndexText } from "../src/format/index-note";
import { addComment, newNoteText, parseComments } from "../src/format/issue-note";
import { Doc, FrontmatterError, formatScalar, parseFlowList, parseScalar } from "../src/format/yaml";

describe("scalars", () => {
  it("parses plain scalars", () => {
    expect(parseScalar("in-progress")).toEqual(["in-progress", null]);
    expect(parseScalar(" 2026-10-10  ")).toEqual(["2026-10-10", null]);
    expect(parseScalar("")).toEqual([null, null]);
    expect(parseScalar("null")).toEqual([null, null]);
    expect(parseScalar("Fix #3 is a comment")).toEqual(["Fix", null]);
  });

  it("parses quoted scalars", () => {
    expect(parseScalar('"a: b"')).toEqual(["a: b", null]);
    expect(parseScalar('"say \\"hi\\"\\n"')).toEqual(['say "hi"\n', null]);
    expect(parseScalar("'it''s'")).toEqual(["it's", null]);
    expect(parseScalar('""')).toEqual(["", null]);
    expect(parseScalar('"x" # note')).toEqual(["x", null]);
    expect(parseScalar('"\\u00e9\\x41"')).toEqual(["éA", null]);
  });

  it("reports what is outside the subset", () => {
    for (const raw of ['"open', "'open", '"a" b', "&anchor x", "*alias", "| ", ">-", "{a: 1}", "!tag x", "a: b"]) {
      expect(parseScalar(raw)[1], raw).not.toBeNull();
    }
    expect(parseScalar("[[RB-9]]")).toEqual(["[[RB-9]]", "unquoted wikilink"]);
  });

  it("formats so that parsing gives the value back", () => {
    const values = [
      "plain", "in-progress", "2026-10-10", "", " padded ", "a: b", "a #b", "ends:", "[[RB-9]]", "-dash", "123", "1.5",
      "true", "No", "null", "~", 'say "hi"', "back\\slash", "tab\there", "line\nbreak", "it's", "@rk", "#tag", "é ü",
      "a,b", "100%", "x: ", "? what",
    ];
    for (const v of values) {
      expect(parseScalar(formatScalar(v)), v).toEqual([v, null]);
      expect(parseFlowList(`[${formatScalar(v, true)}, z]`), v).toEqual([[v, "z"], null]);
    }
  });

  it("quotes only when needed", () => {
    expect(formatScalar("Fix flaky cache test")).toBe("Fix flaky cache test");
    expect(formatScalar("it's")).toBe("it's");
    expect(formatScalar("[[RB-9]]")).toBe('"[[RB-9]]"');
    expect(formatScalar("a, b", true)).toBe('"a, b"');
    expect(formatScalar("a, b")).toBe("a, b");
  });

  it("parses inline lists", () => {
    expect(parseFlowList("[]")).toEqual([[], null]);
    expect(parseFlowList("[  ]")).toEqual([[], null]);
    expect(parseFlowList('[a, b c , "d, e"]')).toEqual([["a", "b c", "d, e"], null]);
    expect(parseFlowList(`["[[RB-3]]", 'x]']`)).toEqual([["[[RB-3]]", "x]"], null]);
    expect(parseFlowList("[[[RB-3]], [[RB-4]]]")[0]).toEqual(["[[RB-3]]", "[[RB-4]]"]);
    expect(parseFlowList("[[[RB-3]], [[RB-4]]]")[1]).not.toBeNull();
    expect(parseFlowList("[a, b")[1]).not.toBeNull();
    expect(parseFlowList("[a, {b: 1}]")[1]).not.toBeNull();
  });
});

const NOTE = `---
title: "Fix: it"
status: todo
labels:
  - build
  - "bug"
tags: [a, b]
empty:
# a comment

parent: "[[RB-9]]"
---
Body
`;

describe("frontmatter document", () => {
  it("parses and reproduces", () => {
    const d = new Doc(NOTE);
    expect(d.get("title")).toBe("Fix: it");
    expect(d.get("labels")).toEqual(["build", "bug"]);
    expect(d.get("tags")).toEqual(["a", "b"]);
    expect(d.get("empty")).toBeNull();
    expect(d.getList("empty")).toEqual([]);
    expect(d.getStr("parent")).toBe("[[RB-9]]");
    expect(d.keys()).toEqual(["title", "status", "labels", "tags", "empty", "parent"]);
    expect(d.body).toBe("Body\n");
    expect(d.problems()).toEqual([]);
    expect(d.text()).toBe(NOTE);
  });

  it("handles notes without frontmatter", () => {
    for (const text of ["", "Body only\n", "--- not a fence\n", "text\n---\nkey: v\n---\n"]) {
      const d = new Doc(text);
      expect(d.hasFm).toBe(false);
      expect(d.text()).toBe(text);
    }
    const d = new Doc("Body\n");
    d.set("status", "todo");
    expect(d.text()).toBe("---\nstatus: todo\n---\nBody\n");
  });

  it("never writes to unterminated frontmatter", () => {
    const d = new Doc("---\ntitle: x\nbody without end\n");
    expect(d.broken).toBe(true);
    expect(d.problems()).toEqual(["frontmatter is not terminated"]);
    expect(() => d.set("title", "y")).toThrow(FrontmatterError);
  });

  it("touches only the key being set", () => {
    const d = new Doc(NOTE);
    d.set("status", "done");
    expect(d.text()).toBe(NOTE.replace("status: todo", "status: done"));
  });

  it("keeps formatting when the value is unchanged", () => {
    const d = new Doc(NOTE);
    d.set("title", "Fix: it");
    d.set("labels", ["build", "bug"]);
    expect(d.text()).toBe(NOTE);
  });

  it("keeps the list style of a key", () => {
    const d = new Doc(NOTE);
    d.set("labels", ["ui"]);
    d.set("tags", ["a, b", "c"]);
    expect(d.text()).toContain('labels:\n  - ui\ntags: ["a, b", c]\n');
    d.set("labels", []);
    expect(d.text()).toContain("labels: []\n");
    const flat = new Doc("---\ntags:\n- a\n- b\n---\n");
    flat.set("tags", ["a", "b", "c"]);
    expect(flat.text()).toBe("---\ntags:\n- a\n- b\n- c\n---\n");
  });

  it("removes keys and appends new ones", () => {
    const d = new Doc(NOTE);
    d.set("labels", null);
    d.set("assignee", "rk");
    expect(d.text()).not.toContain("build");
    expect(d.text().endsWith('parent: "[[RB-9]]"\nassignee: rk\n---\nBody\n')).toBe(true);
  });

  it("keeps CRLF, a missing final newline and a BOM", () => {
    const text = "---\r\ntitle: x\r\n---";
    const d = new Doc(text);
    expect(d.text()).toBe(text);
    d.set("status", "todo");
    expect(d.text()).toBe("---\r\ntitle: x\r\nstatus: todo\r\n---");
    const bom = "﻿---\ntitle: x\n---\n";
    expect(new Doc(bom).get("title")).toBe("x");
    expect(new Doc(bom).text()).toBe(bom);
  });

  it("reports and keeps what is outside the subset", () => {
    const text = "---\nmeta:\n  owner: rk\ntext: |\n  one\n  two\n? odd\ntitle: x\ntitle: y\n---\n";
    const d = new Doc(text);
    expect(d.problems()).toHaveLength(4);
    expect(d.get("title")).toBe("x");
    d.set("status", "todo");
    expect(d.text()).toBe(text.replace("title: y\n", "title: y\nstatus: todo\n"));
  });
});

describe("ids and links", () => {
  it("reduces links to IDs", () => {
    expect(linkTarget("archive/RB-4.md#h|alias")).toBe("RB-4");
    expect(linkId("[[RB-9]]")).toBe("RB-9");
    expect(linkId("[[Trackers/RedBolt/archive/RB-4|the loader]]")).toBe("RB-4");
    expect(linkId("RB-9")).toBe("RB-9");
    expect(linkId("[[Some note]]")).toBeNull();
    expect(linkId("rb-9")).toBeNull();
    expect(linkId(null)).toBeNull();
  });

  it("numbers, titles, lines and dates", () => {
    expect(idNumber("RB-12", "RB")).toBe(12);
    expect(idNumber("XY-12", "RB")).toBeNull();
    expect(idNumber("XY-12", null)).toBe(12);
    expect(cleanTitle("  a \n b\t c ")).toBe("a b c");
    expect(formatLine("RB-1", "T")).toBe("- [[RB-1]] T");
    expect(formatLine("RB-1", "")).toBe("- [[RB-1]]");
    expect(validDate("2026-10-01")).toBe(true);
    expect(validDate("2024-02-29")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "2026-1-1", "tomorrow", "", null, "0000-01-01"]) expect(validDate(bad), String(bad)).toBe(false);
  });
});

describe("index note", () => {
  it("creates a usable empty index", () => {
    const idx = new Index(newIndexText("RB"));
    expect(idx.isTracker()).toBe(true);
    expect(idx.keyProblems()).toEqual([]);
    expect([idx.prefix, idx.next, idx.items.length]).toEqual(["RB", 1, 0]);
    idx.add("RB-1", "First");
    idx.add("RB-2", "Top", "Issues", true);
    idx.setNext(3);
    expect(idx.text()).toContain("next: 3\n");
    expect(idx.text()).toContain("## Issues\n- [[RB-2]] Top\n- [[RB-1]] First\n\n## Archive\n");
  });

  it("ignores headings and lists inside code fences", () => {
    const text = "---\nbilinear: tracker\n---\n~~~\n## Issues\n- [[RB-1]] fake\n~~~\n## Issues\n- [[RB-2]] real\n";
    expect(new Index(text).items.map((i) => i.id)).toEqual(["RB-2"]);
  });

  it("uses only the first section of a name and reports the rest", () => {
    const idx = new Index("## Issues\n- [[RB-1]] a\n## Issues\n- [[RB-2]] b\n# Top\n## Archive\n### Sub\n- [[RB-3]] c\n");
    expect(idx.items.map((i) => [i.id, i.section])).toEqual([["RB-1", "Issues"], ["RB-3", "Archive"]]);
    expect(idx.dupSections).toEqual(["Issues"]);
  });
});

describe("issue note", () => {
  it("writes properties in the documented order and omits empty ones", () => {
    expect(newNoteText({ created: "2026-10-01", title: "T", labels: [], assignee: null, status: "todo", parent: "[[RB-1]]" })).toBe(
      '---\ntitle: T\nstatus: todo\nparent: "[[RB-1]]"\ncreated: 2026-10-01\n---\n',
    );
  });

  it("appends and reads comments", () => {
    let text = "---\ntitle: T\n---\n";
    text = addComment(text, "2026-10-01", "rk", "first");
    text = addComment(text, "2026-10-02", "ana", "second:\n with a colon");
    expect(text).toBe("---\ntitle: T\n---\n\n## Comments\n- 2026-10-01 rk: first\n- 2026-10-02 ana: second: with a colon\n");
    expect(parseComments(text)).toEqual([
      { date: "2026-10-01", author: "rk", text: "first" },
      { date: "2026-10-02", author: "ana", text: "second: with a colon" },
    ]);
    expect(addComment("", "2026-10-01", "rk", "x")).toBe("## Comments\n- 2026-10-01 rk: x\n");
  });
});
