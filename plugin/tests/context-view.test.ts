// The L0 view of an issue: the token helpers and the small text that `show` gives to a new agent session.

import { describe, expect, it } from "vitest";
import { parseContext, type ContextEntry } from "../src/format/context";
import {
  L0_CAP,
  buildL0,
  collapseLocals,
  normalizeSubject,
  overlap,
  tokens,
  type L0Input,
} from "../src/format/context-view";
import { TYPE_LETTERS, type EntryType } from "../src/format/ids";

const LETTER_OF = Object.fromEntries(Object.entries(TYPE_LETTERS).map(([l, t]) => [t, l])) as Record<EntryType, string>;

function entry(type: EntryType, number: number, over: Partial<ContextEntry> = {}): ContextEntry {
  return {
    local: `${LETTER_OF[type]}${number}`,
    type,
    number,
    subject: `Subject ${number}`,
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
    ...(type === "rejected" ? { rejected: { attempted: "", promising: "", happened: "", failed: "", applies: "" } } : {}),
    extra: [],
    range: [0, 0],
    ...over,
  };
}

function input(over: Partial<L0Input> = {}): L0Input {
  return {
    issueId: "BL-9",
    title: "Fix the cache",
    description: "",
    entries: [],
    trackerId: "BL",
    trackerEntries: [],
    newestComment: null,
    ...over,
  };
}

describe("tokens", () => {
  it("lower-cases, splits at punctuation and keeps the first-seen order", () => {
    expect(tokens("Use One-Cache, per TEST!")).toEqual(["use", "one", "cache", "per", "test"]);
  });
  it("applies NFKC and keeps letters and digits of any script", () => {
    expect(tokens("ＡＢＣ２ café")).toEqual(["abc2", "café"]);
  });
  it("drops stop words and short tokens", () => {
    expect(tokens("the cache of a user is x")).toEqual(["cache", "user"]);
  });
  it("keeps negations", () => {
    expect(tokens("do not retry without it, never, no")).toEqual(["do", "not", "retry", "without", "never", "no"]);
  });
  it("keeps combining marks inside a word", () => {
    expect(tokens("कैश")).toEqual(["कैश"]);
    expect(normalizeSubject("कैश")).not.toBe("");
  });
  it("returns each token once", () => {
    expect(tokens("cache Cache CACHE")).toEqual(["cache"]);
  });
  it("returns nothing for empty input", () => {
    expect(tokens("")).toEqual([]);
    expect(tokens(" - ! ")).toEqual([]);
  });
});

describe("overlap", () => {
  it("is the Jaccard score of the token sets", () => {
    expect(overlap("one two three", "two three four")).toBeCloseTo(0.5);
    expect(overlap("Cache, one", "one CACHE")).toBe(1);
  });
  it("is 0 when a set is empty", () => {
    expect(overlap("", "cache")).toBe(0);
    expect(overlap("the of", "the of")).toBe(0);
  });
  it("tells a negation from its opposite", () => {
    expect(overlap("use a lock", "use not a lock")).toBeLessThan(1);
  });
});

describe("normalizeSubject", () => {
  it("joins the tokens with one space", () => {
    expect(normalizeSubject("  Use the  Cache -- per TEST ")).toBe("use cache per test");
    expect(normalizeSubject("Do NOT retry")).toBe(normalizeSubject("do not retry!"));
    expect(normalizeSubject("")).toBe("");
  });
});

describe("collapseLocals", () => {
  it("collapses runs of three or more per letter", () => {
    expect(collapseLocals(["D1", "D2", "D3", "D5"])).toEqual(["D1-D3", "D5"]);
    expect(collapseLocals(["F2", "F4", "A3", "A1", "A2"])).toEqual(["F2", "F4", "A1-A3"]);
    expect(collapseLocals(["D2", "D1"])).toEqual(["D1", "D2"]);
    expect(collapseLocals(["D1", "D1", "D2", "D3"], "BL/")).toEqual(["BL/D1-D3"]);
  });
});

const FULL = input({
  description: "The cache is shared.\n\nTests fail at random.",
  entries: [
    entry("state", 3, { content: "old", updated: "2026-09-30", author: "claude" }),
    entry("state", 4, { content: "Cache split done.\nTests next.", updated: "2026-10-02", author: "claude" }),
    entry("rejected", 1, {
      subject: "Global lock",
      content: "Tried a lock.",
      rejected: { attempted: "", promising: "", happened: "", failed: "\nDeadlock in CI.\nSecond line.", applies: "" },
    }),
    entry("constraint", 1, { subject: "No network", content: "Tests run offline." }),
    entry("decision", 3, { subject: "One directory per test", rationale: "\nShared state caused flaky runs.\nMore." }),
    entry("decision", 2, { subject: "Use tmp", content: "Temp dirs.\nMore." }),
    entry("question", 2, { subject: "Is CI cache needed?" }),
    entry("finding", 1, { subject: "Flaky run is order dependent" }),
    entry("finding", 2, { subject: "Second" }),
    entry("finding", 4, { subject: "Fourth" }),
    entry("finding", 5, { subject: "Fifth" }),
    entry("finding", 6, { subject: "Sixth" }),
    entry("artifact", 1),
    entry("artifact", 2),
    entry("artifact", 3),
    entry("decision", 1, { status: "superseded" }),
    entry("state", 1, { status: "superseded" }),
    entry("state", 2, { status: "superseded" }),
    entry("question", 1, { status: "resolved" }),
  ],
  trackerEntries: [
    entry("constraint", 1, { subject: "Plain text only", content: "No binary files." }),
    entry("decision", 1),
    entry("decision", 2),
    entry("constraint", 2, { status: "superseded" }),
  ],
  newestComment: "2026-10-03",
});

describe("buildL0", () => {
  it("builds the full example", () => {
    const view = buildL0(FULL);
    expect(view.text).toBe(
      [
        "CONTEXT BL-9 (L0, 847 of 8000 chars; 7 shown, 9 in index)",
        "Goal: Fix the cache",
        "  The cache is shared. Tests fail at random.",
        "State: S4 (2026-10-02 claude) Cache split done. Tests next.",
        "Rejected (do not retry):",
        "  R1 Global lock - failed: Deadlock in CI. Second line.",
        "Constraints:",
        "  C1 No network - Tests run offline.",
        "Decisions:",
        "  D3 One directory per test - Shared state caused flaky runs.",
        "  D2 Use tmp - Temp dirs.",
        "Open questions:",
        "  Q2 Is CI cache needed?",
        "Tracker constraints:",
        "  BL/C1 Plain text only - No binary files.",
        "Index (read with: context get <ID>...):",
        "  not shown: F6 finding Sixth",
        "  not shown: F5 finding Fifth",
        "  not shown: F4 finding Fourth",
        "  active: F1 F2 S3 A1-A3",
        "  tracker: BL/D1 BL/D2",
        "  superseded (3): D1 S1 S2",
        "  resolved (1): Q1",
        "Hint: the last comment (2026-10-03) is newer than the last context update. Run: context checkpoint BL-9",
        "",
      ].join("\n"),
    );
    expect(view.chars).toBe(view.text.length);
    expect(view.cap).toBe(L0_CAP);
    expect(view.shown).toEqual([
      "BL-9/S4",
      "BL-9/R1",
      "BL-9/C1",
      "BL-9/D3",
      "BL-9/D2",
      "BL-9/Q2",
      "BL/C1",
    ]);
    expect(view.omitted).toEqual([
      "BL-9/F1",
      "BL-9/F2",
      "BL-9/F4",
      "BL-9/F5",
      "BL-9/F6",
      "BL-9/S3",
      "BL-9/A1",
      "BL-9/A2",
      "BL-9/A3",
    ]);
    expect(view.counts).toEqual({ active: 15, superseded: 3, resolved: 1, tracker: 3 });
  });

  it("puts Rejected before Constraints and Decisions", () => {
    const { text } = buildL0(
      input({ entries: [entry("decision", 1), entry("constraint", 1), entry("rejected", 1), entry("question", 1)] }),
    );
    const at = (s: string) => text.indexOf(s);
    expect(at("Rejected (do not retry):")).toBeGreaterThan(at("Goal:"));
    expect(at("Rejected (do not retry):")).toBeLessThan(at("Constraints:"));
    expect(at("Constraints:")).toBeLessThan(at("Decisions:"));
    expect(at("Decisions:")).toBeLessThan(at("Open questions:"));
  });

  it("shows only the newest active state", () => {
    const view = buildL0(
      input({
        entries: [
          entry("state", 1, { content: "first", updated: "2026-10-01" }),
          entry("state", 2, { content: "second", updated: "2026-10-02" }),
          entry("state", 3, { content: "third", status: "superseded", updated: "2026-10-03" }),
        ],
      }),
    );
    expect(view.text).toContain("State: S2 (2026-10-02) second\n");
    expect(view.text).not.toContain("first\n");
    expect(view.text).not.toContain("third");
    expect(view.text).toContain("  active: S1\n");
    expect(view.text).toContain("  superseded (1): S3\n");
    expect(view.shown).toEqual(["BL-9/S2"]);
    expect(view.omitted).toEqual(["BL-9/S1"]);
  });

  it("orders a type by update date, then by number, and puts an undated entry last", () => {
    const { text } = buildL0(
      input({
        entries: [
          entry("question", 5),
          entry("question", 1, { updated: "2026-10-01" }),
          entry("question", 2, { updated: "2026-10-02" }),
          entry("question", 3, { updated: "2026-10-02" }),
          entry("question", 4),
        ],
      }),
    );
    expect(text).toContain("  Q3 Subject 3\n  Q2 Subject 2\n  Q1 Subject 1\n  Q5 Subject 5\n  Q4 Subject 4\n");
  });

  it("shows tracker constraints with full IDs and other tracker entries in the index only", () => {
    const view = buildL0(
      input({
        trackerEntries: [
          entry("constraint", 1, { content: "Rule" }),
          entry("decision", 1),
          entry("finding", 3),
          entry("constraint", 2, { status: "resolved" }),
        ],
      }),
    );
    expect(view.text).toContain("Tracker constraints:\n  BL/C1 Subject 1 - Rule\n");
    expect(view.text).toContain("  tracker: BL/D1 BL/F3\n");
    expect(view.text).not.toContain("BL/C2");
    expect(view.shown).toEqual(["BL/C1"]);
    expect(view.omitted).toEqual([]);
    expect(view.counts.tracker).toBe(3);
  });

  it("gives an empty text for no entries and no comment", () => {
    const view = buildL0(input());
    expect(view).toEqual({
      text: "",
      chars: 0,
      cap: L0_CAP,
      shown: [],
      omitted: [],
      counts: { active: 0, superseded: 0, resolved: 0, tracker: 0 },
    });
  });

  it("gives the goal and the hint for a comment and no entries", () => {
    const view = buildL0(input({ newestComment: "2026-10-03", description: "Body text." }));
    expect(view.text).toBe(
      [
        "CONTEXT BL-9 (L0, 185 of 8000 chars; 0 shown, 0 in index)",
        "Goal: Fix the cache",
        "  Body text.",
        "Hint: the issue has a comment (2026-10-03) and no context entry. Run: context checkpoint BL-9",
        "",
      ].join("\n"),
    );
  });

  it("gives the hint only when the comment is newer than the entries", () => {
    const at = (updated: string | null, created: string | null, comment: string | null) =>
      buildL0(input({ entries: [entry("question", 1, { updated, created })], newestComment: comment })).text;
    expect(at("2026-10-02", null, "2026-10-03")).toContain("Hint: the last comment (2026-10-03)");
    expect(at("2026-10-03", null, "2026-10-03")).not.toContain("Hint:");
    expect(at("2026-10-04", null, "2026-10-03")).not.toContain("Hint:");
    expect(at(null, "2026-10-01", "2026-10-03")).toContain("Hint:");
    expect(at(null, "2026-10-03", "2026-10-03")).not.toContain("Hint:");
    expect(at("2026-10-02", null, null)).not.toContain("Hint:");
  });

  it("cuts a long line at 220 characters on a word boundary", () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const { text } = buildL0(input({ entries: [entry("constraint", 1, { content: words })] }));
    const line = text.split("\n").find((l) => l.startsWith("  C1 "));
    expect(line).toBeDefined();
    expect((line as string).length).toBeLessThanOrEqual(220);
    expect(line).toMatch(/ word\d+…$/);
    expect(line).not.toMatch(/ word\d+ …$/);
  });

  it("cuts the head of the description at 400 characters", () => {
    const { text } = buildL0(input({ description: "\n" + "lorem ipsum ".repeat(100), newestComment: "2026-10-01" }));
    const line = text.split("\n")[2];
    expect(line.length).toBeLessThanOrEqual(402);
    expect(line.endsWith("…")).toBe(true);
  });

  it("makes a clean single line of a multi-line rationale that starts with a line break", () => {
    const { text } = buildL0(
      input({ entries: [entry("decision", 1, { rationale: "\n\n  First line.  \nSecond line.", content: "ignored" })] }),
    );
    expect(text).toContain("\n  D1 Subject 1 - First line.\n");
  });

  it("goes through parseContext with entries of every type", () => {
    const note = [
      "## Context log",
      "",
      "### D1: Pick it",
      "- status: active",
      "- updated: 2026-10-01",
      "",
      "Rationale: Because.",
      "",
      "### R1: Not this",
      "- status: active",
      "",
      "Failed: Broke.",
      "",
      "### Q1: Why",
      "- status: resolved",
      "",
    ].join("\n");
    const view = buildL0(input({ entries: parseContext(note).entries }));
    expect(view.text).toContain("  D1 Pick it - Because.\n");
    expect(view.text).toContain("  R1 Not this - failed: Broke.\n");
    expect(view.text).toContain("  resolved (1): Q1\n");
  });

  it("stays in the cap with 500 long entries and keeps the counts and the findability", () => {
    const types = Object.values(TYPE_LETTERS);
    const statuses = ["active", "active", "superseded", "resolved"] as const;
    const long = "long text with many words ".repeat(30);
    const entries = Array.from({ length: 500 }, (_, i) =>
      entry(types[i % types.length], Math.floor(i / types.length) + 1, {
        subject: `Subject ${i} ${long}`,
        content: long,
        rationale: `\n${long}`,
        status: statuses[i % statuses.length],
        updated: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
        ...(types[i % types.length] === "rejected"
          ? { rejected: { attempted: "", promising: "", happened: "", failed: `\n${long}`, applies: "" } }
          : {}),
      }),
    );
    const trackerEntries = Array.from({ length: 40 }, (_, i) =>
      entry(i % 2 ? "constraint" : "decision", i + 1, { content: long, subject: long }),
    );
    const view = buildL0(input({ title: "T ".repeat(300), description: long.repeat(5), entries, trackerEntries }));
    const lines = view.text.split("\n");
    expect(view.text.length).toBeLessThanOrEqual(8000);
    expect(view.chars).toBe(view.text.length);
    expect(lines[0]).toBe(
      `CONTEXT BL-9 (L0, ${view.text.length} of 8000 chars; ${view.shown.length} shown, ${view.omitted.length} in index)`,
    );
    expect(view.text).toContain("Rejected (do not retry):\n");
    expect(view.text.endsWith("\n")).toBe(true);
    expect(lines.some((l) => l !== l.trimEnd())).toBe(false);
    const active = entries.filter((e) => e.status === "active");
    const sup = entries.filter((e) => e.status === "superseded").length;
    const res = entries.filter((e) => e.status === "resolved").length;
    expect(view.counts).toEqual({ active: active.length, superseded: sup, resolved: res, tracker: 40 });
    expect(view.text).toContain(`superseded (${sup}): `);
    expect(view.text).toContain(`resolved (${res}): `);
    const ids = [...view.shown, ...view.omitted];
    expect(new Set(ids).size).toBe(ids.length);
    const wanted = [
      ...active.map((e) => `BL-9/${e.local}`),
      ...trackerEntries.filter((e) => e.type === "constraint").map((e) => `BL/${e.local}`),
    ];
    expect([...ids].sort()).toEqual([...wanted].sort());
    expect(view.omitted.length).toBeGreaterThan(0);
    // Each omitted entry is on a `not shown:` line, inside a range item, or after a cut of the line of its own tier.
    const index = lines.slice(lines.indexOf("Index (read with: context get <ID>...):"));
    const tier = (head: string) => index.find((l) => l.startsWith(head));
    expect(tier("  active:")).toBeDefined();
    expect(tier("  tracker:")).toBeDefined();
    const covers = (item: string, tracker: boolean, letter: string, n: number): boolean => {
      const m = /^(BL\/)?([A-Z])([0-9]+)(?:-[A-Z]([0-9]+))?$/.exec(item);
      if (!m || (m[1] !== undefined) !== tracker || m[2] !== letter) return false;
      return parseInt(m[3], 10) <= n && n <= parseInt(m[4] ?? m[3], 10);
    };
    let cutIds = 0;
    for (const id of view.omitted) {
      const tracker = !id.startsWith("BL-9/");
      const local = id.slice(id.indexOf("/") + 1);
      if (index.some((l) => l.startsWith(`  not shown: ${tracker ? id : local} `))) continue;
      const line = tier(tracker ? "  tracker:" : "  active:") as string;
      const items = line.slice(line.indexOf(":") + 2).split(" ");
      if (items.some((x) => covers(x, tracker, local[0], parseInt(local.slice(1), 10)))) continue;
      expect(line.endsWith("… (context list --all)")).toBe(true);
      cutIds++;
    }
    expect(cutIds).toBeLessThan(view.omitted.length);
  });

  it("holds a custom small cap", () => {
    const types = Object.values(TYPE_LETTERS);
    const entries = Array.from({ length: 120 }, (_, i) =>
      entry(types[i % types.length], i + 1, { content: "text ".repeat(60), status: i % 5 === 0 ? "resolved" : "active" }),
    );
    for (const cap of [1500, 600, 300, 120, 60, 10, 1]) {
      const view = buildL0(input({ entries, newestComment: "2026-12-01", cap }));
      expect(view.text.length).toBeLessThanOrEqual(cap);
      expect(view.chars).toBe(view.text.length);
      expect(view.cap).toBe(cap);
      if (cap >= 300) {
        expect(view.text.split("\n")[0]).toBe(
          `CONTEXT BL-9 (L0, ${view.text.length} of ${cap} chars; ${view.shown.length} shown, ${view.omitted.length} in index)`,
        );
      }
    }
  });

  it("ends no line with a space, also for an empty subject", () => {
    const view = buildL0(
      input({
        entries: [
          entry("question", 1, { subject: "" }),
          entry("question", 2, { subject: "\u00a0" }),
          entry("state", 1, { subject: "", content: "" }),
          entry("finding", 1, { subject: "" }),
          entry("constraint", 1, { subject: "" }),
        ],
      }),
    );
    const lines = view.text.split("\n");
    expect(lines.filter((l) => l !== l.trimEnd())).toEqual([]);
    expect(lines).toContain("  Q1");
    expect(lines).toContain("  Q2");
    expect(lines).toContain("  C1");
    expect(lines).toContain("State: S1");
    expect(lines).toContain("  not shown: F1 finding");
  });

  it("takes created when an entry has no update date, to choose the newest state", () => {
    const { text } = buildL0(
      input({
        entries: [
          entry("state", 4, { content: "four", updated: "2026-10-02" }),
          entry("state", 5, { content: "five", created: "2026-10-04", updated: null }),
        ],
      }),
    );
    expect(text).toContain("State: S5 (2026-10-04) five\n");
    expect(text).not.toContain("four");
  });

  it("makes one line of the whole failed value of a rejected entry", () => {
    const e = entry("rejected", 1, {
      rejected: { attempted: "", promising: "", happened: "", failed: "\nOne.\n\nTwo.", applies: "" },
    });
    expect(buildL0(input({ entries: [e] })).text).toContain("\n  R1 Subject 1 - failed: One. Two.\n");
  });

  it("cuts a line without a lone surrogate", () => {
    // Each offset puts a different half of a pair at the cut point.
    for (let n = 198; n <= 202; n++) {
      const content = "a".repeat(n) + "😀😀" + "b".repeat(30);
      const { text } = buildL0(input({ entries: [entry("constraint", 1, { content })] }));
      const line = text.split("\n").find((l) => l.startsWith("  C1 ")) as string;
      expect(line.length).toBeLessThanOrEqual(220);
      expect(line.endsWith("…")).toBe(true);
      expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)).toBe(false);
    }
  });

  it("holds the cap for a subject of 5000 characters with no space and an issue ID of 500 characters", () => {
    const types = Object.values(TYPE_LETTERS);
    const entries = types.map((t, i) => entry(t, i + 1, { subject: "x".repeat(5000), content: "y".repeat(5000) }));
    for (const [issueId, cap] of [["BL-9", 8000], ["A".repeat(500) + "-1", 8000], ["A".repeat(500) + "-1", 300], ["BL-9", 300]] as const) {
      const view = buildL0(
        input({ issueId, title: "z".repeat(5000), entries, newestComment: "2026-12-01", cap }),
      );
      expect(view.text.length).toBeLessThanOrEqual(cap);
      expect(view.chars).toBe(view.text.length);
      expect(view.text.split("\n").some((l) => l !== l.trimEnd())).toBe(false);
    }
  });

  describe("the greedy fill", () => {
    const long = "word ".repeat(80);
    const entries = [
      ...[1, 2, 3, 4, 5].map((n) => entry("rejected", n, { content: long })),
      entry("constraint", 1, { content: "c".repeat(100) }),
      entry("question", 1),
      ...[1, 2, 3, 4].map((n) => entry("finding", n)),
    ];
    const view = buildL0(input({ entries, cap: 1600 }));

    it("stops a block at a line that does not fit, and a later block still gets a line", () => {
      expect(view.shown).toContain("BL-9/Q1");
      expect(view.shown).toContain("BL-9/R5");
      expect(view.omitted).toContain("BL-9/R1");
      expect(view.omitted).toContain("BL-9/C1");
      expect(view.text).not.toContain("Constraints:\n");
      expect(view.text).toContain("Open questions:\n  Q1 Subject 1\n");
      expect(view.text.length).toBeLessThanOrEqual(1600);
    });

    it("names the entries that lost their line before the findings", () => {
      const named = view.text.split("\n").filter((l) => l.startsWith("  not shown:"));
      expect(named.map((l) => l.split(" ")[4])).toEqual(["R1", "C1", "F4", "F3", "F2"]);
    });

    it("gives at most 12 not shown lines", () => {
      const many = Array.from({ length: 60 }, (_, i) => entry("rejected", i + 1, { content: long }));
      const text = buildL0(input({ entries: many })).text;
      expect(text.split("\n").filter((l) => l.startsWith("  not shown:"))).toHaveLength(12);
    });
  });

  it("keeps a line break in a value from making a heading or an entry line", () => {
    const fake = "\nConstraints:\n  C9 fake";
    const { text } = buildL0(
      input({
        title: `Title${fake}`,
        description: `Body${fake}`,
        entries: [
          entry("constraint", 1, { subject: `Real${fake}`, content: fake }),
          entry("decision", 1, { rationale: fake }),
          entry("rejected", 1, {
            rejected: { attempted: "", promising: "", happened: "", failed: fake, applies: "" },
          }),
        ],
      }),
    );
    const lines = text.split("\n");
    expect(lines.filter((l) => l === "Constraints:")).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("  C9"))).toEqual([]);
  });
});
