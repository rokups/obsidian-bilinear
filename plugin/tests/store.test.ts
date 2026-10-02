import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { Doc } from "../src/format/yaml";
import type { IssueRecord } from "../src/format/record";
import { applyFilter, defaultSpec, issueRelations, linkedProgress, emptyFilter, groupIssues, normalizeSpec, reaches, sortIssues, type TrackerConfig } from "../src/store/query";
import { buildSnapshot } from "../src/store/snapshot";
import { readViews, writeViews, type SavedView } from "../src/store/views";
import { bodyLinks } from "../src/format/issue-note";
import { TRACKER_DIR, cases, openTracker, toFixtureRecords } from "./fixtures";
import { MemoryIO } from "./memory-io";

/** Stand-in for Obsidian's metadata cache: a real YAML parser over the frontmatter. */
function cacheLookup(io: MemoryIO) {
  return (path: string) => {
    const text = io.files.get(path);
    if (text === undefined) return undefined;
    // Obsidian parses the links itself; the subset parser stands in for it here.
    const links = bodyLinks(new Doc(text).body);
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
    if (!m) return { frontmatter: null, links };
    try {
      return { frontmatter: (parseYaml(m[1]) as Record<string, unknown>) ?? null, links };
    } catch {
      return { frontmatter: null, links };
    }
  };
}

describe("snapshot from the metadata cache", () => {
  const listCases = cases().filter((c) => c.op.op === "list");

  it("has list fixtures", () => {
    expect(listCases.length).toBeGreaterThan(5);
  });

  it.each(listCases.map((c) => [c.name, c] as const))("agrees with the CLI on %s", async (_name, c) => {
    const io = MemoryIO.fromDisk(join(c.dir, "before"), TRACKER_DIR);
    const t = await openTracker(io);
    const snap = buildSnapshot(io.files.get(t.indexPath)!, t.dir, cacheLookup(io));
    const got = toFixtureRecords([...snap.issues, ...snap.archived], snap.config.closedStates);
    const want = c.op.expect!.issues!;
    expect(got.map((i) => i.id).sort()).toEqual(want.map((i) => i.id).sort());
    for (const w of want) expect(got.find((g) => g.id === w.id)).toMatchObject(w);
    expect(snap.issues.every((i) => !i.archived)).toBe(true);
    expect(snap.archived.every((i) => i.archived)).toBe(true);
  });

  it("reads the tracker config and reports an unusable index", () => {
    const snap = buildSnapshot("---\nbilinear: tracker\nprefix: bl\nnext: 3\nstates: [a, b]\nclosed-states: [b]\nlabel-colors: [x=Red, bad, y=#abc]\nstate-icons: [a=Lucide-Eye]\nstate-colors: [b=green]\n---\n", "T", () => undefined);
    expect(snap.config).toEqual({ prefix: null, next: 3, states: ["a", "b"], closedStates: ["b"], triageState: null, labels: [], labelColors: { x: "red", y: "#abc" }, stateIcons: { a: "eye" }, stateColors: { b: "green" } });
    expect(snap.problems).toHaveLength(1);
    expect(buildSnapshot("---\nbilinear: tracker\n", "T", () => undefined).problems).toEqual(["frontmatter is not terminated"]);
  });

  it("looks in issues/, then archive/, then the tracker folder", () => {
    const index = "---\nbilinear: tracker\nprefix: BL\nnext: 4\nstates: [todo]\n---\n## Issues\n- [[BL-1]] a\n- [[BL-2]] b\n- [[BL-3]] c\n\n## Archive\n- [[BL-4]] d\n";
    const notes = new Set(["T/issues/BL-1.md", "T/archive/BL-1.md", "T/BL-1.md", "T/archive/BL-2.md", "T/BL-2.md", "T/BL-3.md", "T/issues/BL-4.md", "T/BL-4.md"]);
    const snap = buildSnapshot(index, "T", (p) => (notes.has(p) ? { frontmatter: {}, links: [] } : undefined));
    expect([...snap.issues, ...snap.archived].map((i) => i.path)).toEqual(["T/issues/BL-1.md", "T/archive/BL-2.md", "T/BL-3.md", "T/issues/BL-4.md"]);
  });

  it("coerces typed YAML values to text", () => {
    const index = "---\nbilinear: tracker\nprefix: BL\nnext: 2\nstates: [todo]\n---\n## Issues\n- [[BL-1]] line title\n";
    const snap = buildSnapshot(index, "T", (p) => (p === "T/BL-1.md" ? { frontmatter: { title: 42, status: true, labels: "solo", assignee: null, "blocked-by": "[[BL-7]]" }, links: ["archive/BL-4|x", "BL-1", "Note", "BL-4"] } : undefined));
    expect(snap.issues[0]).toMatchObject({ title: "42", status: "true", labels: ["solo"], assignee: null, blockedBy: ["BL-7"], links: ["BL-4"], path: "T/BL-1.md" });
  });
});

function issue(id: string, over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id, title: id, status: "todo", priority: "none", labels: [], assignee: null, due: null,
    blockedBy: [], relatedTo: [], created: null, links: [], archived: false, missing: false, path: `T/${id}.md`, ...over,
  };
}

const config: TrackerConfig = { prefix: "BL", next: 9, states: ["backlog", "todo", "done"], closedStates: ["done"], triageState: null, labels: ["bug", "ui"], labelColors: {}, stateIcons: {}, stateColors: {} };

describe("query", () => {
  const issues = [
    issue("BL-1", { title: "Cache layer", priority: "high", assignee: "rk", labels: ["bug"], due: "2026-11-01", created: "2026-09-01" }),
    issue("BL-2", { title: "cold start", status: "done", priority: "urgent", labels: ["ui", "perf"], created: "2026-09-03" }),
    issue("BL-3", { title: "Board", status: "backlog", assignee: "ana", due: "2026-10-05" }),
    issue("BL-4", { title: "Missing", status: null, missing: true, path: null }),
  ];
  const ids = (list: IssueRecord[]) => list.map((i) => i.id);

  it("filters", () => {
    const f = emptyFilter();
    expect(ids(applyFilter(issues, f))).toEqual(["BL-1", "BL-2", "BL-3", "BL-4"]);
    expect(ids(applyFilter(issues, { ...f, text: "CACHE bl-1" }))).toEqual(["BL-1"]);
    expect(ids(applyFilter(issues, { ...f, text: "perf" }))).toEqual(["BL-2"]);
    expect(ids(applyFilter(issues, { ...f, status: ["todo", "done"] }))).toEqual(["BL-1", "BL-2"]);
    expect(ids(applyFilter(issues, { ...f, priority: ["none"] }))).toEqual(["BL-3", "BL-4"]);
    expect(ids(applyFilter(issues, { ...f, labels: ["bug", "ui"] }))).toEqual(["BL-1", "BL-2"]);
    expect(ids(applyFilter(issues, { ...f, assignee: ["ana", ""] }))).toEqual(["BL-2", "BL-3", "BL-4"]);
    expect(ids(applyFilter(issues, { ...f, assignee: ["rk"], status: ["done"] }))).toEqual([]);
  });

  it("sorts stably, keeping index order for ties and for manual", () => {
    expect(sortIssues(issues, "manual")).toBe(issues);
    expect(ids(sortIssues(issues, "priority"))).toEqual(["BL-2", "BL-1", "BL-3", "BL-4"]);
    expect(ids(sortIssues(issues, "due"))).toEqual(["BL-3", "BL-1", "BL-2", "BL-4"]);
    expect(ids(sortIssues(issues, "created"))).toEqual(["BL-2", "BL-1", "BL-3", "BL-4"]);
    expect(ids(sortIssues(issues, "title"))).toEqual(["BL-3", "BL-1", "BL-2", "BL-4"]);
  });

  it("groups by status with every state, in state order", () => {
    const groups = groupIssues(issues, "status", config);
    expect(groups.map((g) => [g.label, ids(g.issues)])).toEqual([
      ["backlog", ["BL-3"]], ["todo", ["BL-1"]], ["done", ["BL-2"]], ["Note missing", ["BL-4"]],
    ]);
    const odd = groupIssues([issue("BL-9", { status: "started" })], "status", config);
    expect(odd.map((g) => g.label)).toEqual(["backlog", "todo", "done", "started"]);
  });

  it("groups by priority, assignee and label", () => {
    expect(groupIssues(issues, "priority", config).map((g) => [g.label, ids(g.issues)])).toEqual([
      ["urgent", ["BL-2"]], ["high", ["BL-1"]], ["No priority", ["BL-3", "BL-4"]],
    ]);
    expect(groupIssues(issues, "assignee", config).map((g) => [g.label, g.value, ids(g.issues)])).toEqual([
      ["ana", "ana", ["BL-3"]], ["rk", "rk", ["BL-1"]], ["Unassigned", null, ["BL-2", "BL-4"]],
    ]);
    expect(groupIssues(issues, "label", config).map((g) => [g.label, ids(g.issues)])).toEqual([
      ["bug", ["BL-1"]], ["ui", ["BL-2"]], ["perf", ["BL-2"]], ["No label", ["BL-3", "BL-4"]],
    ]);
    expect(groupIssues(issues, "none", config)).toHaveLength(1);
  });

  it("derives progress from the blockers, open or archived, and not from description links", () => {
    const all = [
      ...issues,
      issue("BL-5", { status: "done", archived: true }),
      issue("BL-6", { blockedBy: ["BL-2", "BL-3", "BL-6", "BL-99", "BL-2", "BL-5"] }),
      issue("BL-7", { links: ["BL-4", "BL-2"] }),
      issue("BL-8", { blockedBy: ["BL-4"], links: ["BL-2"], relatedTo: ["BL-2"] }),
    ];
    expect(linkedProgress(all, config.closedStates)).toEqual(
      new Map([
        ["BL-6", { done: 2, total: 3, issues: ["BL-2", "BL-3", "BL-5"] }],
        ["BL-8", { done: 0, total: 1, issues: ["BL-4"] }],
      ]),
    );
  });

  it("normalizes untrusted specs", () => {
    expect(normalizeSpec(null)).toEqual(defaultSpec());
    expect(normalizeSpec({ layout: "grid", groupBy: "label", sortBy: 7, filter: { text: "x", status: ["a", 1], labels: "no" } })).toEqual({
      layout: "list", groupBy: "label", sortBy: "manual", filter: { text: "x", status: ["a"], priority: [], labels: [], assignee: [] },
    });
  });
});

describe("relations", () => {
  const closed = config.closedStates;
  const all = [
    issue("BL-1", { blockedBy: ["BL-2", "BL-3", "BL-3", "BL-1", "BL-99"], relatedTo: ["BL-4", "BL-1", "BL-99", "BL-5"] }),
    issue("BL-2", { status: "done" }),
    issue("BL-3", { blockedBy: ["BL-2"], relatedTo: ["BL-4"] }),
    issue("BL-4", { relatedTo: ["BL-1", "BL-3"] }),
    issue("BL-5", { status: "done", archived: true, blockedBy: ["BL-6", "BL-2"] }),
    issue("BL-6", { status: null, missing: true, path: null, blockedBy: ["BL-99"], relatedTo: ["BL-99"] }),
    issue("BL-7", { blockedBy: ["BL-5"] }),
  ];
  const rel = issueRelations(all, closed);

  it("has an entry for every issue", () => {
    expect([...rel.keys()]).toEqual(all.map((i) => i.id));
  });

  it("lists the blockers in the stored order, once each, without itself or unknown issues", () => {
    expect(rel.get("BL-1")!.blockedBy).toEqual(["BL-2", "BL-3"]);
    expect(rel.get("BL-6")!.blockedBy).toEqual([]);
    expect(rel.get("BL-2")!.blockedBy).toEqual([]);
  });

  it("derives the issues an issue blocks, in index order", () => {
    expect(rel.get("BL-2")!.blocks).toEqual(["BL-1", "BL-3", "BL-5"]);
    expect(rel.get("BL-3")!.blocks).toEqual(["BL-1"]);
    expect(rel.get("BL-1")!.blocks).toEqual([]);
    expect(rel.get("BL-5")!.blocks).toEqual(["BL-7"]);
  });

  it("relates issues from either side, or both, once", () => {
    expect(rel.get("BL-1")!.related).toEqual(["BL-4", "BL-5"]);
    expect(rel.get("BL-4")!.related).toEqual(["BL-1", "BL-3"]);
    expect(rel.get("BL-3")!.related).toEqual(["BL-4"]);
    expect(rel.get("BL-5")!.related).toEqual(["BL-1"]);
    expect(rel.get("BL-6")!.related).toEqual([]);
    expect(rel.get("BL-2")!.related).toEqual([]);
  });

  it("is blocked by an open blocker, and not by a closed one", () => {
    expect(rel.get("BL-1")!.blocked).toBe(true);
    expect(rel.get("BL-3")!.blocked).toBe(false);
    expect(rel.get("BL-2")!.blocked).toBe(false);
  });

  it("counts a blocker whose note is missing as open, and ignores whether a blocker is archived", () => {
    expect(rel.get("BL-5")!.blocked).toBe(true);
    expect(rel.get("BL-7")!.blocked).toBe(false);
    expect(issueRelations([issue("BL-1", { blockedBy: ["BL-2"] }), issue("BL-2", { status: "done", archived: true })], closed).get("BL-1")!.blocked).toBe(false);
  });

  it("is not blocked by unknown issues or by itself", () => {
    expect(rel.get("BL-6")!.blocked).toBe(false);
    expect(issueRelations([issue("BL-1", { blockedBy: ["BL-1", "BL-9"] })], closed).get("BL-1")).toEqual({ blocks: [], related: [], blockedBy: [], blocked: false });
  });

  describe("reaches", () => {
    const chain = [
      issue("BL-1", { blockedBy: ["BL-2"] }),
      issue("BL-2", { blockedBy: ["BL-3", "BL-9"] }),
      issue("BL-3", { blockedBy: ["BL-4"] }),
      issue("BL-4"),
      issue("BL-5", { blockedBy: ["BL-99"] }),
    ];

    it("follows a chain in one or more steps", () => {
      expect(reaches(chain, "BL-1", "BL-2")).toBe(true);
      expect(reaches(chain, "BL-1", "BL-4")).toBe(true);
      expect(reaches(chain, "BL-4", "BL-1")).toBe(false);
      expect(reaches(chain, "BL-1", "BL-5")).toBe(false);
      expect(reaches(chain, "BL-1", "BL-1")).toBe(false);
    });

    it("treats unknown issues as dead ends", () => {
      expect(reaches(chain, "BL-77", "BL-1")).toBe(false);
      expect(reaches(chain, "BL-5", "BL-1")).toBe(false);
      expect(reaches(chain, "BL-2", "BL-9")).toBe(true);
    });

    it("ends on an existing cycle, and finds a cycle through the issue itself", () => {
      const loop = [issue("BL-1", { blockedBy: ["BL-2"] }), issue("BL-2", { blockedBy: ["BL-3"] }), issue("BL-3", { blockedBy: ["BL-2"] })];
      expect(reaches(loop, "BL-1", "BL-4")).toBe(false);
      expect(reaches(loop, "BL-2", "BL-2")).toBe(true);
      expect(reaches(loop, "BL-1", "BL-1")).toBe(false);
    });
  });
});

describe("saved views", () => {
  const view: SavedView = { name: "Mine", ...defaultSpec(), filter: { ...emptyFilter(), assignee: ["rk"] } };
  const base = "---\nbilinear: tracker\n---\n\nNotes.\n\n## Issues\n- [[BL-1]] One\n\n## Archive\n";

  it("adds the block before the issues section and reads it back", () => {
    const text = writeViews(base, [view]);
    expect(text.startsWith("---\nbilinear: tracker\n---\n\nNotes.\n\n```bilinear-views\n[\n")).toBe(true);
    expect(text.endsWith("]\n```\n\n## Issues\n- [[BL-1]] One\n\n## Archive\n")).toBe(true);
    expect(readViews(text)).toEqual([view]);
  });

  it("replaces only the block contents", () => {
    const once = writeViews(base, [view]);
    const twice = writeViews(once, [view, { ...view, name: "Board", layout: "board" }]);
    expect(readViews(twice).map((v) => [v.name, v.layout])).toEqual([["Mine", "list"], ["Board", "board"]]);
    expect(writeViews(twice, [view])).toBe(once);
    const emptied = writeViews(once, []);
    expect(readViews(emptied)).toEqual([]);
    expect(emptied).toContain("```bilinear-views\n[]\n```\n");
  });

  it("does nothing when there is nothing to save, and tolerates bad JSON", () => {
    expect(writeViews(base, [])).toBe(base);
    expect(readViews(base)).toEqual([]);
    expect(readViews(base.replace("Notes.", "```bilinear-views\n{not json\n```"))).toEqual([]);
    expect(readViews(base.replace("Notes.", '```bilinear-views\n[{"name": "A"}, {"name": "A"}, {"x": 1}, 3]\n```')).map((v) => v.name)).toEqual(["A"]);
  });

  it("keeps CRLF and leaves the issue list alone", () => {
    const crlf = base.replace(/\n/g, "\r\n");
    const text = writeViews(crlf, [view]);
    expect(text.includes("\n") && !/[^\r]\n/.test(text)).toBe(true);
    expect(new Doc(text).body.endsWith("## Issues\r\n- [[BL-1]] One\r\n\r\n## Archive\r\n")).toBe(true);
  });

  it("appends the block when there is no issues section", () => {
    expect(writeViews("---\nbilinear: tracker\n---\nNotes", [view]).startsWith("---\nbilinear: tracker\n---\nNotes\n\n```bilinear-views\n")).toBe(true);
  });
});

describe("label colours", () => {
  it("uses the colour from the index, or a stable one picked by name", async () => {
    const { labelColorName, labelCssColor } = await import("../src/store/labels");
    expect(labelColorName("bug", { bug: "red" })).toBe("red");
    expect(labelCssColor("bug", { bug: "red" })).toBe("var(--color-red)");
    expect(labelCssColor("bug", { bug: "#0af" })).toBe("#0af");
    expect(labelCssColor("bug", { bug: "gray" })).toBe("var(--text-faint)");
    const auto = labelColorName("bug", {});
    expect(["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"]).toContain(auto);
    expect(labelColorName("bug", { other: "red" })).toBe(auto);
    expect(new Set(["bug", "build", "ui", "perf", "docs", "infra"].map((l) => labelColorName(l, {}))).size).toBeGreaterThan(2);
  });
});

describe("state drawings", () => {
  const cfg = { states: ["backlog", "todo", "in-progress", "in-review", "done", "canceled"], closedStates: ["done", "canceled"], stateIcons: {}, stateColors: {} };

  it("draws the workflow automatically", async () => {
    const { stateDrawing, stateColor } = await import("../src/store/states");
    expect(stateDrawing("backlog", cfg)).toEqual({ kind: "ring", dashed: true, fraction: 0 });
    expect(stateDrawing("todo", cfg)).toEqual({ kind: "ring", dashed: false, fraction: 0.25 });
    expect(stateDrawing("in-review", cfg)).toEqual({ kind: "ring", dashed: false, fraction: 0.75 });
    expect(stateDrawing("done", cfg)).toEqual({ kind: "check" });
    expect(stateDrawing("canceled", cfg)).toEqual({ kind: "cross" });
    expect(stateDrawing("started", cfg)).toEqual({ kind: "ring", dashed: true, fraction: 0 });
    expect(stateDrawing(null, cfg)).toEqual({ kind: "ring", dashed: true, fraction: 0 });
    expect([stateColor("backlog", cfg), stateColor("todo", cfg), stateColor("done", cfg), stateColor("canceled", cfg)]).toEqual([
      "var(--text-faint)", "var(--color-yellow)", "var(--interactive-accent)", "var(--text-faint)",
    ]);
  });

  it("draws the triage state apart from the workflow", async () => {
    const { stateDrawing, stateColor } = await import("../src/store/states");
    const triaged = { ...cfg, states: ["triage", ...cfg.states], triageState: "triage" };
    expect(stateDrawing("triage", triaged)).toEqual({ kind: "lucide", name: "inbox" });
    expect(stateColor("triage", triaged)).toBe("var(--color-orange)");
    // The other states are drawn as they are without it.
    for (const state of cfg.states) {
      expect(stateDrawing(state, triaged), state).toEqual(stateDrawing(state, cfg));
      expect(stateColor(state, triaged), state).toBe(stateColor(state, cfg));
    }
    expect(stateDrawing("triage", { ...triaged, stateIcons: { triage: "circle" } })).toEqual({ kind: "ring", dashed: false, fraction: 0 });
  });

  it("uses the icon and colour from the index", async () => {
    const { stateDrawing, stateColor } = await import("../src/store/states");
    const styled = { ...cfg, stateIcons: { todo: "circle", "in-review": "eye", done: "half" }, stateColors: { "in-review": "purple", done: "#2da44e", todo: "gray" } };
    expect(stateDrawing("todo", styled)).toEqual({ kind: "ring", dashed: false, fraction: 0 });
    expect(stateDrawing("in-review", styled)).toEqual({ kind: "lucide", name: "eye" });
    expect(stateDrawing("done", styled)).toEqual({ kind: "ring", dashed: false, fraction: 0.5 });
    expect(stateDrawing("in-progress", styled)).toEqual({ kind: "ring", dashed: false, fraction: 0.5 });
    expect([stateColor("in-review", styled), stateColor("done", styled), stateColor("todo", styled), stateColor("in-progress", styled)]).toEqual([
      "var(--color-purple)", "#2da44e", "var(--text-faint)", "var(--color-yellow)",
    ]);
  });
});

describe("description links from the metadata cache", () => {
  it("takes links and embeds in order, leaving out the comments section", async () => {
    const { descriptionLinks } = await import("../src/store/snapshot");
    const at = (line: number, offset: number) => ({ start: { line, offset } });
    expect(
      descriptionLinks({
        links: [
          { link: "BL-3", position: at(4, 40) },
          { link: "BL-9", position: at(9, 120) },
          { link: "BL-5", position: at(12, 200) },
        ],
        embeds: [{ link: "BL-1#Notes", position: at(2, 10) }],
        headings: [
          { heading: "Plan", level: 2, position: at(1, 0) },
          { heading: "Comments", level: 2, position: at(8, 100) },
          { heading: "Detail", level: 3, position: at(10, 150) },
          { heading: "Links", level: 2, position: at(11, 180) },
        ],
      }),
    ).toEqual(["BL-1#Notes", "BL-3", "BL-5"]);
    expect(descriptionLinks(null)).toEqual([]);
    expect(descriptionLinks({ links: [{ link: "BL-2", position: at(3, 5) }] })).toEqual(["BL-2"]);
  });
});
