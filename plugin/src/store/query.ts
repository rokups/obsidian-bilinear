// Filtering, sorting and grouping. There is one flat global order (the
// index); grouped views show each group in its relative index order.

import { PRIORITIES } from "../format/ids";
import type { IssueRecord } from "../format/record";

export type Layout = "list" | "board";
export type GroupKey = "status" | "priority" | "assignee" | "label" | "none";
export type SortKey = "manual" | "priority" | "due" | "created" | "title";

export const GROUP_KEYS: GroupKey[] = ["status", "priority", "assignee", "label", "none"];
export const SORT_KEYS: SortKey[] = ["manual", "priority", "due", "created", "title"];

export interface Filter {
  text: string;
  status: string[];
  priority: string[];
  labels: string[];
  assignee: string[];
}

export interface ViewSpec {
  layout: Layout;
  groupBy: GroupKey;
  sortBy: SortKey;
  filter: Filter;
}

export interface TrackerConfig {
  prefix: string | null;
  next: number | null;
  states: string[];
  closedStates: string[];
  /** The state for issues that wait to be accepted or rejected, if there is one. */
  triageState: string | null;
  labels: string[];
  /** Colours set in the index: label name to a colour name or hex value. */
  labelColors: Record<string, string>;
  /** Icons set in the index: state to one of STATE_SHAPES or a Lucide icon name. */
  stateIcons: Record<string, string>;
  stateColors: Record<string, string>;
}

export interface Group {
  /** Unique within one grouping. */
  key: string;
  label: string;
  /** The property value issues in this group share; null for "none of them". */
  value: string | null;
  issues: IssueRecord[];
}

/** Assignee filter value that matches issues with no assignee. */
export const UNASSIGNED = "";

export function emptyFilter(): Filter {
  return { text: "", status: [], priority: [], labels: [], assignee: [] };
}

export function defaultSpec(): ViewSpec {
  return { layout: "list", groupBy: "status", sortBy: "manual", filter: emptyFilter() };
}

export function filterIsEmpty(f: Filter): boolean {
  return !f.text.trim() && !f.status.length && !f.priority.length && !f.labels.length && !f.assignee.length;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** A view spec from untrusted JSON (saved views, workspace state). */
export function normalizeSpec(raw: unknown): ViewSpec {
  const spec = defaultSpec();
  if (!raw || typeof raw !== "object") return spec;
  const r = raw as Record<string, unknown>;
  if (r["layout"] === "list" || r["layout"] === "board") spec.layout = r["layout"];
  if (GROUP_KEYS.includes(r["groupBy"] as GroupKey)) spec.groupBy = r["groupBy"] as GroupKey;
  if (SORT_KEYS.includes(r["sortBy"] as SortKey)) spec.sortBy = r["sortBy"] as SortKey;
  const f = r["filter"];
  if (f && typeof f === "object") {
    const fr = f as Record<string, unknown>;
    spec.filter = {
      text: typeof fr["text"] === "string" ? fr["text"] : "",
      status: strings(fr["status"]),
      priority: strings(fr["priority"]),
      labels: strings(fr["labels"]),
      assignee: strings(fr["assignee"]),
    };
  }
  return spec;
}

export function applyFilter(issues: IssueRecord[], f: Filter): IssueRecord[] {
  const words = f.text.toLowerCase().split(/\s+/).filter(Boolean);
  return issues.filter((i) => {
    if (f.status.length && !f.status.includes(i.status ?? "")) return false;
    if (f.priority.length && !f.priority.includes(i.priority)) return false;
    if (f.labels.length && !f.labels.some((l) => i.labels.includes(l))) return false;
    if (f.assignee.length && !f.assignee.includes(i.assignee ?? UNASSIGNED)) return false;
    if (words.length) {
      const hay = `${i.id} ${i.title} ${i.assignee ?? ""} ${i.labels.join(" ")}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

function priorityRank(p: string): number {
  const i = (PRIORITIES as readonly string[]).indexOf(p);
  return i < 0 ? 0 : i;
}

/** Stable sort; "manual" keeps index order. Missing dates sort last. */
export function sortIssues(issues: IssueRecord[], sortBy: SortKey): IssueRecord[] {
  if (sortBy === "manual") return issues;
  const date = (v: string | null) => v ?? "9999-99-99";
  const cmp: Record<Exclude<SortKey, "manual">, (a: IssueRecord, b: IssueRecord) => number> = {
    priority: (a, b) => priorityRank(b.priority) - priorityRank(a.priority),
    due: (a, b) => date(a.due).localeCompare(date(b.due)),
    created: (a, b) => (b.created ?? "").localeCompare(a.created ?? ""),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }),
  };
  return issues
    .map((issue, n) => ({ issue, n }))
    .sort((a, b) => cmp[sortBy](a.issue, b.issue) || a.n - b.n)
    .map((x) => x.issue);
}

/**
 * Split issues into groups. Status groups cover every state, in order, even
 * when empty (they are drop targets); other groupings omit empty groups.
 */
export function groupIssues(issues: IssueRecord[], groupBy: GroupKey, config: TrackerConfig): Group[] {
  if (groupBy === "none") return [{ key: "all", label: "All issues", value: null, issues }];
  const groups = new Map<string, Group>();
  const group = (key: string, label: string, value: string | null) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, label, value, issues: [] }));
    return g;
  };
  if (groupBy === "status") {
    for (const s of config.states) group(`s:${s}`, s, s);
    for (const i of issues) {
      if (i.status === null) group("none", i.missing ? "Note missing" : "No status", null).issues.push(i);
      else group(`s:${i.status}`, i.status, i.status).issues.push(i);
    }
    return [...groups.values()];
  }
  if (groupBy === "priority") {
    for (const p of [...PRIORITIES].reverse()) group(`p:${p}`, p === "none" ? "No priority" : p, p);
    for (const i of issues) group(`p:${i.priority}`, i.priority, i.priority).issues.push(i);
  } else if (groupBy === "assignee") {
    const names = [...new Set(issues.map((i) => i.assignee).filter((a): a is string => !!a))].sort((a, b) => a.localeCompare(b));
    for (const a of names) group(`a:${a}`, a, a);
    for (const i of issues) {
      if (i.assignee) group(`a:${i.assignee}`, i.assignee, i.assignee).issues.push(i);
      else group("none", "Unassigned", null).issues.push(i);
    }
  } else {
    for (const l of config.labels) group(`l:${l}`, l, l);
    for (const i of issues) {
      if (!i.labels.length) group("none", "No label", null).issues.push(i);
      for (const l of i.labels) group(`l:${l}`, l, l).issues.push(i);
    }
  }
  const out = [...groups.values()].filter((g) => g.issues.length > 0);
  const none = out.findIndex((g) => g.key === "none");
  if (none >= 0) out.push(...out.splice(none, 1));
  return out;
}

export interface Progress {
  done: number;
  total: number;
  /** The linked issues counted, sub-issues first. */
  issues: string[];
}

/**
 * Progress of each issue, from the state of the issues linked to it: its
 * sub-issues (those naming it as `parent`) and the issues its description
 * links to. Progress is how many of them are in a closed state; issues with
 * none are not in the map. `all` includes archived issues.
 */
export function linkedProgress(all: IssueRecord[], closedStates: string[]): Map<string, Progress> {
  const byId = new Map(all.map((i) => [i.id, i]));
  const children = new Map<string, string[]>();
  for (const i of all) {
    if (!i.parent || i.parent === i.id || !byId.has(i.parent)) continue;
    const list = children.get(i.parent);
    if (list) list.push(i.id);
    else children.set(i.parent, [i.id]);
  }
  const out = new Map<string, Progress>();
  for (const i of all) {
    const issues: string[] = [];
    for (const other of [...(children.get(i.id) ?? []), ...i.links]) {
      if (byId.has(other) && other !== i.id && !issues.includes(other)) issues.push(other);
    }
    if (!issues.length) continue;
    const done = issues.filter((id) => {
      const status = byId.get(id)!.status;
      return status !== null && closedStates.includes(status);
    }).length;
    out.set(i.id, { done, total: issues.length, issues });
  }
  return out;
}

/** The property a grouping stands for, if dropping into a group can set it. */
export function groupProperty(groupBy: GroupKey): "status" | "priority" | "assignee" | null {
  return groupBy === "status" || groupBy === "priority" || groupBy === "assignee" ? groupBy : null;
}
