import { shallowRef } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueRecord } from "../src/format/record";
import { defaultSpec, type TrackerConfig } from "../src/store/query";
import type { Snapshot } from "../src/store/snapshot";
import { createController, sweepSelection, type StoreLike, type SweepWindow } from "../src/ui/controller";
import type { Host } from "../src/ui/host";

const config: TrackerConfig = { prefix: "T", next: 6, states: ["todo"], closedStates: [], triageState: null, labels: [], labelColors: {}, stateIcons: {}, stateColors: {} };

function issue(id: string): IssueRecord {
  return { id, title: id, status: "todo", priority: "none", labels: [], assignee: null, due: null, blockedBy: [], relatedTo: [], created: null, links: [], archived: false, missing: false, path: `${id}.md` };
}

/** A controller over five issues in one group, and a window that records its listeners. */
function setup() {
  const snapshot: Snapshot = { config, issues: ["T-1", "T-2", "T-3", "T-4", "T-5"].map(issue), archived: [], views: [], problems: [], siblings: [] };
  const store = { snapshot: shallowRef(snapshot) } as unknown as StoreLike;
  const c = createController(store, {} as Host, defaultSpec());
  const listeners = new Map<string, () => void>();
  const win: SweepWindow = {
    addEventListener: ((type: string, fn: () => void) => void listeners.set(type, fn)) as SweepWindow["addEventListener"],
    removeEventListener: ((type: string, fn: () => void) => void (listeners.get(type) === fn && listeners.delete(type))) as SweepWindow["removeEventListener"],
  };
  const group = c.order.value[0].group;
  return { c, store, snapshot, win, listeners, group, sel: () => [...c.selected].sort() };
}

describe("sweepSelection", () => {
  const rows = ["a", "b", "c", "d"].map((id) => ({ id, group: "g" }));

  it("selects the range in either direction, inclusive", () => {
    expect([...sweepSelection(new Set(), rows, 1, 3, true)]).toEqual(["b", "c", "d"]);
    expect([...sweepSelection(new Set(), rows, 2, 0, true)]).toEqual(["a", "b", "c"]);
  });

  it("deselects the range and keeps the rest", () => {
    expect([...sweepSelection(new Set(["a", "b", "d"]), rows, 1, 2, false)]).toEqual(["a", "d"]);
  });
});

describe("selection sweep", () => {
  afterEach(() => vi.useRealTimers());

  it("marks the click that ends it, until the timers run", () => {
    vi.useFakeTimers();
    const { c, win, listeners, group } = setup();
    expect(c.justSwept()).toBe(false);
    c.sweepStart("T-1", group, win);
    expect(c.justSwept()).toBe(false);
    listeners.get("mouseup")!();
    expect(c.justSwept()).toBe(true);
    vi.runAllTimers();
    expect(c.justSwept()).toBe(false);
  });

  it("selects every row between the first and the entered one, skipped rows included", () => {
    const { c, win, group } = setup();
    c.sweepStart("T-2", group, win);
    expect(c.sweeping.value).toBe(true);
    expect([...c.selected]).toEqual(["T-2"]);
    c.sweepTo("T-5", group);
    expect([...c.selected].sort()).toEqual(["T-2", "T-3", "T-4", "T-5"]);
    expect(c.cursor.value).toEqual({ id: "T-5", group });
  });

  it("gives rows back what they had when the pointer reverses", () => {
    const { c, win, group, sel } = setup();
    c.selected.add("T-1");
    c.selected.add("T-4");
    c.sweepStart("T-2", group, win);
    c.sweepTo("T-4", group);
    expect(sel()).toEqual(["T-1", "T-2", "T-3", "T-4"]);
    c.sweepTo("T-3", group);
    expect(sel()).toEqual(["T-1", "T-2", "T-3", "T-4"]);
    c.sweepTo("T-1", group);
    expect(sel()).toEqual(["T-1", "T-2", "T-4"]);
    c.sweepTo("T-2", group);
    expect(sel()).toEqual(["T-1", "T-2", "T-4"]);
    c.sweepTo("T-5", group);
    expect(sel()).toEqual(["T-1", "T-2", "T-3", "T-4", "T-5"]);
    c.sweepTo("T-2", group);
    expect(sel()).toEqual(["T-1", "T-2", "T-4"]);
  });

  it("deselects when it starts on a selected row", () => {
    const { c, win, group, sel } = setup();
    for (const id of ["T-1", "T-2", "T-3", "T-4"]) c.selected.add(id);
    c.sweepStart("T-2", group, win);
    expect(sel()).toEqual(["T-1", "T-3", "T-4"]);
    c.sweepTo("T-4", group);
    expect(sel()).toEqual(["T-1"]);
    c.sweepTo("T-3", group);
    expect(sel()).toEqual(["T-1", "T-4"]);
  });

  it("toggles one row once for a press without movement, and listens only while it lasts", () => {
    const { c, win, listeners, group, sel } = setup();
    c.sweepStart("T-3", group, win);
    expect([...listeners.keys()].sort()).toEqual(["blur", "mouseup"]);
    listeners.get("mouseup")!();
    expect(listeners.size).toBe(0);
    expect(c.sweeping.value).toBe(false);
    expect(sel()).toEqual(["T-3"]);
    c.sweepStart("T-3", group, win);
    c.sweepEnd();
    expect(sel()).toEqual([]);
  });

  it("ends on a window blur", () => {
    const { c, win, listeners, group } = setup();
    c.sweepStart("T-1", group, win);
    listeners.get("blur")!();
    expect(c.sweeping.value).toBe(false);
    expect(listeners.size).toBe(0);
  });

  it("does not bring back an issue that left the view mid-sweep", () => {
    const { c, store, snapshot, win, group, sel } = setup();
    c.selected.add("T-4");
    c.sweepStart("T-1", group, win);
    store.snapshot.value = { ...snapshot, issues: snapshot.issues.filter((i) => i.id !== "T-4") };
    c.sweepTo("T-3", group);
    expect(sel()).toEqual(["T-1", "T-2", "T-3"]);
  });

  it("ignores rows entered after it ended", () => {
    const { c, win, group, sel } = setup();
    c.sweepStart("T-1", group, win);
    c.sweepEnd();
    c.sweepTo("T-5", group);
    expect(sel()).toEqual(["T-1"]);
  });
});
