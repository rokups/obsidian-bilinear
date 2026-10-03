// Filtering, sorting and grouping. There is one flat global order (the
// index); grouped views show each group in its relative index order.

import { PRIORITIES, idNumber } from "../format/ids";
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
  /** The blockers counted, in the order named. */
  issues: string[];
}

/** Whether an issue is in a closed state of the tracker that owns it. */
export type ClosedFn = (i: IssueRecord) => boolean;

/**
 * What decides whether an issue is closed: one tracker's `closed-states`, or
 * a function that can tell for issues of several trackers.
 */
export type Closed = string[] | ClosedFn;

/**
 * Closed-ness for issues of sibling trackers: an issue is closed when its
 * status is in the `closed-states` of the tracker it belongs to, never in
 * those of another. That is this tracker when the ID has its prefix; else the
 * sibling whose index lists the ID (`listed`, whatever the ID's prefix), else
 * the sibling whose prefix the ID has. An ID none of them claims is judged by
 * this tracker, which lists it (an adopted issue with a mismatched prefix). An
 * issue without a note is never closed. The viewing tracker comes first, so it
 * wins over a sibling with the same prefix.
 */
export function makeClosed(
  ownPrefix: string | null,
  ownClosedStates: string[],
  siblings: (Pick<TrackerConfig, "prefix" | "closedStates"> & { listed?: ReadonlySet<string> })[],
): ClosedFn {
  const has = (prefix: string | null, id: string) => prefix !== null && idNumber(id, prefix) !== null;
  return (i) => {
    if (i.status === null) return false;
    const owner =
      has(ownPrefix, i.id) ? undefined : (siblings.find((s) => s.listed?.has(i.id)) ?? siblings.find((s) => has(s.prefix, i.id)));
    return (owner?.closedStates ?? ownClosedStates).includes(i.status);
  };
}

function closedFn(closed: Closed): ClosedFn {
  return typeof closed === "function" ? closed : (i) => i.status !== null && closed.includes(i.status);
}

/** The issues to look links up in: those of `all`, then the `foreign` ones with other IDs. */
function withForeign(all: IssueRecord[], foreign: IssueRecord[]): IssueRecord[] {
  if (!foreign.length) return all;
  const own = new Set(all.map((i) => i.id));
  return [...all, ...foreign.filter((f) => !own.has(f.id))];
}

/**
 * Progress of each issue, from the state of the issues it is `blocked-by`
 * (each counted once; descriptions and `related-to` do not count): how many of them are in a closed state. Issues with no blockers
 * are not in the map. `all` includes archived issues. `foreign` holds issues
 * of sibling trackers: they can be blockers too, but get no entry.
 */
export function linkedProgress(all: IssueRecord[], closed: Closed, foreign: IssueRecord[] = []): Map<string, Progress> {
  const byId = new Map(withForeign(all, foreign).map((i) => [i.id, i]));
  const isClosed = closedFn(closed);
  const out = new Map<string, Progress>();
  for (const i of all) {
    const issues = [...new Set(i.blockedBy)].filter((id) => id !== i.id && byId.has(id));
    if (!issues.length) continue;
    const done = issues.filter((id) => isClosed(byId.get(id)!)).length;
    out.set(i.id, { done, total: issues.length, issues });
  }
  return out;
}

export interface Relations {
  /** The issues that name this one in `blocked-by`, in index order. */
  blocks: string[];
  /** The issues related to this one, whichever of the two names the other. */
  related: string[];
  /** The issues this one names in `blocked-by`, in the order named. */
  blockedBy: string[];
  /** Some issue it is blocked by is not in a closed state. */
  blocked: boolean;
}

/**
 * Blocking and related issues of each issue; every issue in `all` is in the
 * map. IDs that name no issue are ignored, and so is an issue naming itself.
 * An issue is blocked while any issue blocking it is open, or its note is
 * missing; whether the blocker is archived does not matter. `foreign` holds
 * issues of sibling trackers: they take part in the relations of the issues
 * of `all`, but get no entry themselves.
 */
export function issueRelations(all: IssueRecord[], closed: Closed, foreign: IssueRecord[] = []): Map<string, Relations> {
  const lookup = withForeign(all, foreign);
  const byId = new Map(lookup.map((i) => [i.id, i]));
  const isClosed = closedFn(closed);
  const out = new Map<string, Relations>();
  for (const i of all) {
    const blockedBy = [...new Set(i.blockedBy)].filter((id) => id !== i.id && byId.has(id));
    const blocked = blockedBy.some((id) => !isClosed(byId.get(id)!));
    out.set(i.id, { blocks: [], related: [], blockedBy, blocked });
  }
  for (const i of all) {
    for (const other of lookup) {
      if (other.id === i.id) continue;
      if (other.blockedBy.includes(i.id)) out.get(i.id)!.blocks.push(other.id);
      if (i.relatedTo.includes(other.id) || other.relatedTo.includes(i.id)) out.get(i.id)!.related.push(other.id);
    }
  }
  return out;
}

/**
 * Whether following `blocked-by` from issue `from` reaches `to` in one or
 * more steps. Unknown IDs are dead ends; existing cycles end the walk. The
 * walk passes through `foreign` issues of sibling trackers as well.
 */
export function reaches(all: IssueRecord[], from: string, to: string, foreign: IssueRecord[] = []): boolean {
  const byId = new Map(withForeign(all, foreign).map((i) => [i.id, i]));
  const next = (id: string): string[] => byId.get(id)?.blockedBy ?? [];
  const seen = new Set<string>();
  const stack = [...next(from)];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...next(id));
  }
  return false;
}

/** The property a grouping stands for, if dropping into a group can set it. */
export function groupProperty(groupBy: GroupKey): "status" | "priority" | "assignee" | null {
  return groupBy === "status" || groupBy === "priority" || groupBy === "assignee" ? groupBy : null;
}

/** An issue an issue may link to, and the sibling tracker it belongs to (`null` for the viewing tracker's own). */
export interface LinkTarget {
  issue: IssueRecord;
  tracker: string | null;
}

/**
 * The issues a `blocked-by` / `related-to` picker offers: those of the
 * viewing tracker first (open, then archived), then those of each sibling
 * tracker, tagged with its name. An ID the viewing tracker has is not offered
 * again from a sibling, and `exclude` holds the issues being edited.
 */
export function linkTargets(
  own: IssueRecord[],
  siblings: { name: string; issues: IssueRecord[]; archived: IssueRecord[] }[],
  exclude: string[] = [],
): LinkTarget[] {
  const seen = new Set(exclude);
  const out: LinkTarget[] = [];
  const add = (issue: IssueRecord, tracker: string | null) => {
    if (seen.has(issue.id)) return;
    seen.add(issue.id);
    out.push({ issue, tracker });
  };
  for (const i of own) add(i, null);
  for (const s of siblings) for (const i of [...s.issues, ...s.archived]) add(i, s.name);
  return out;
}

/** The picker row of a link target: `ID Title`, with the sibling tracker's name after it. */
export function linkTargetLabel(t: LinkTarget): string {
  return `${t.issue.id} ${t.issue.title}${t.tracker === null ? "" : ` (${t.tracker})`}`;
}

/** One line of a tooltip listing linked issues: `ID  status  title`, and `(Tracker)` for a sibling's issue. */
export function linkedLine(id: string, issue: IssueRecord | undefined, tracker: string | null): string {
  const line = `${id}  ${issue?.status ?? "note missing"}  ${issue?.title ?? ""}`.trimEnd();
  return tracker === null ? line : `${line}  (${tracker})`;
}
