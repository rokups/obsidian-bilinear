// View state and actions shared by the tracker components.

import { computed, reactive, ref, toRaw, watch, type InjectionKey, type Ref, type ShallowRef } from "vue";
import { COLOR_NAMES, PRIORITIES, todayIso } from "../format/ids";
import type { IssueRecord } from "../format/record";
import type { Tracker } from "../ops/io";
import { archiveClosed, archiveIssues, commentIssue, deleteIssue, moveIssue, recreateNote, setLabel, setProps, unarchiveIssues, type PropEdits } from "../ops/issues";
import { applyFilter, childProgress, groupIssues, groupProperty, sortIssues, type Filter, type GroupKey, type ViewSpec } from "../store/query";
import { labelColorName } from "../store/labels";
import type { Snapshot } from "../store/snapshot";
import type { SavedView } from "../store/views";
import type { Host } from "./host";

export interface StoreLike {
  snapshot: ShallowRef<Snapshot>;
  loaded: Ref<boolean>;
  readonly tracker: Tracker;
  reload(): Promise<void>;
  saveViews(views: SavedView[]): Promise<void>;
}

export type PickerKind = "status" | "priority" | "labels" | "assignee";

export interface PickerState {
  kind: PickerKind;
  ids: string[];
}

/** A row is an issue shown in a group; under label grouping an issue can have several. */
export interface RowRef {
  id: string;
  group: string;
}

export interface DropHint {
  group: string;
  id: string | null;
  pos: "before" | "after";
}

function cloneSpec(spec: ViewSpec): ViewSpec {
  const f = spec.filter;
  return {
    layout: spec.layout,
    groupBy: spec.groupBy,
    sortBy: spec.sortBy,
    filter: { text: f.text, status: [...f.status], priority: [...f.priority], labels: [...f.labels], assignee: [...f.assignee] },
  };
}

export function createController(store: StoreLike, host: Host, initial: ViewSpec) {
  const spec = reactive<ViewSpec>(cloneSpec(initial));
  const showArchived = ref(false);
  const cursor = ref<RowRef | null>(null);
  const selected = reactive(new Set<string>());
  const collapsed = reactive(new Set<string>());
  const picker = ref<PickerState | null>(null);
  const dragging = ref<string[]>([]);
  const dropHint = ref<DropHint | null>(null);
  const activeView = ref<string | null>(null);
  const busy = ref(false);

  const snapshot = computed(() => store.snapshot.value);
  const config = computed(() => snapshot.value.config);
  const all = computed(() => [...snapshot.value.issues, ...snapshot.value.archived]);
  const byId = computed(() => new Map(all.value.map((i) => [i.id, i])));
  const source = computed(() => (showArchived.value ? snapshot.value.archived : snapshot.value.issues));
  const visible = computed(() => sortIssues(applyFilter(source.value, spec.filter), spec.sortBy));
  /** A board needs columns that stand for a property; fall back to status. */
  const groupBy = computed<GroupKey>(() => (spec.layout === "board" && !groupProperty(spec.groupBy) ? "status" : spec.groupBy));
  const groups = computed(() => groupIssues(visible.value, groupBy.value, config.value));
  const order = computed<RowRef[]>(() =>
    groups.value.flatMap((g) => (spec.layout === "list" && collapsed.has(g.key) ? [] : g.issues.map((i) => ({ id: i.id, group: g.key })))),
  );
  const progress = computed(() => childProgress(all.value, config.value.closedStates));
  const canReorder = computed(() => spec.sortBy === "manual" && !showArchived.value);
  const assignees = computed(() => [...new Set(all.value.map((i) => i.assignee).filter((a): a is string => !!a))].sort((a, b) => a.localeCompare(b)));
  const labels = computed(() => [...new Set([...config.value.labels, ...all.value.flatMap((i) => i.labels)])]);

  watch(spec, () => host.specChanged(cloneSpec(toRaw(spec))), { deep: true });

  // Selection and cursor follow the data: drop what is no longer shown.
  watch(order, (rows) => {
    const shown = new Set(rows.map((r) => r.id));
    for (const id of [...selected]) if (!shown.has(id)) selected.delete(id);
    const c = cursor.value;
    if (c && !rows.some((r) => r.id === c.id && r.group === c.group)) {
      cursor.value = rows.find((r) => r.id === c.id) ?? null;
    }
  });

  // -- running operations: one at a time, errors shown as notices

  let queue: Promise<unknown> = Promise.resolve();
  function run(fn: (t: Tracker) => Promise<void>): Promise<void> {
    const next = queue.then(async () => {
      busy.value = true;
      try {
        await fn(store.tracker);
      } catch (e) {
        host.notice(e instanceof Error ? e.message : String(e));
      } finally {
        busy.value = false;
        await store.reload();
      }
    });
    queue = next;
    return next;
  }

  // -- cursor and selection

  function isCursor(id: string, group: string): boolean {
    return cursor.value?.id === id && cursor.value.group === group;
  }

  function setCursor(id: string, group: string): void {
    cursor.value = { id, group };
  }

  function moveCursor(delta: number): void {
    const rows = order.value;
    if (!rows.length) return;
    const c = cursor.value;
    const at = c ? rows.findIndex((r) => r.id === c.id && r.group === c.group) : -1;
    const to = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + delta));
    cursor.value = rows[to];
  }

  function toggleSelect(id: string): void {
    if (!selected.delete(id)) selected.add(id);
  }

  /** Select every row between the cursor and the given row. */
  function selectRange(id: string, group: string): void {
    const rows = order.value;
    const c = cursor.value;
    const a = c ? rows.findIndex((r) => r.id === c.id && r.group === c.group) : -1;
    const b = rows.findIndex((r) => r.id === id && r.group === group);
    if (a < 0 || b < 0) return void selected.add(id);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(rows[i].id);
  }

  function clearSelection(): void {
    selected.clear();
  }

  /** What a keyboard action applies to: the selection, else the cursor row. */
  function targets(): string[] {
    if (selected.size) return order.value.map((r) => r.id).filter((id, n, list) => selected.has(id) && list.indexOf(id) === n);
    return cursor.value ? [cursor.value.id] : [];
  }

  function cursorIssue(): IssueRecord | null {
    return cursor.value ? (byId.value.get(cursor.value.id) ?? null) : null;
  }

  function reveal(id: string): void {
    showArchived.value = byId.value.get(id)?.archived ?? false;
    const row = order.value.find((r) => r.id === id);
    if (row) cursor.value = row;
    else pendingReveal = id;
  }
  let pendingReveal: string | null = null;
  watch(order, (rows) => {
    if (!pendingReveal) return;
    const row = rows.find((r) => r.id === pendingReveal);
    if (row) {
      cursor.value = row;
      pendingReveal = null;
    }
  });

  // -- property edits

  function editable(ids: string[]): string[] {
    return ids.filter((id) => byId.value.get(id)?.missing === false);
  }

  function edit(ids: string[], edits: PropEdits): Promise<void> {
    return run(async (t) => {
      for (const id of editable(ids)) await setProps(t, id, edits);
    });
  }

  function openPicker(kind: PickerKind, ids: string[] = targets()): void {
    ids = editable(ids);
    if (ids.length) picker.value = { kind, ids };
  }

  function closePicker(): void {
    picker.value = null;
  }

  /** Whether every picker target has the label (labels picker check marks). */
  function allHaveLabel(ids: string[], label: string): boolean {
    return ids.every((id) => byId.value.get(id)?.labels.includes(label));
  }

  function pick(value: string | null): void {
    const p = picker.value;
    if (!p) return;
    if (p.kind === "labels") {
      if (!value) return;
      const remove = allHaveLabel(p.ids, value);
      void run(async (t) => {
        for (const id of p.ids) {
          const current = byId.value.get(id)?.labels ?? [];
          if (remove) await setProps(t, id, { labels: current.filter((l) => l !== value) });
          else if (!current.includes(value)) await setProps(t, id, { labels: [...current, value] });
        }
      });
      return;
    }
    picker.value = null;
    if (p.kind === "assignee") void edit(p.ids, { assignee: value });
    else if (value) void edit(p.ids, { [p.kind]: value });
  }

  /** Menu for choosing a label's colour; the choice is stored in the index note. */
  function labelMenu(event: MouseEvent, label: string): void {
    const colors = config.value.labelColors;
    const current = colors[label];
    const auto = labelColorName(label, {});
    host.showMenu(event, [
      { title: `Automatic (${auto})`, checked: current === undefined, action: () => void run((t) => setLabel(t, label, null)) },
      { separator: true },
      ...COLOR_NAMES.map((name) => ({
        title: name[0].toUpperCase() + name.slice(1),
        checked: current === name,
        action: () => void run((t) => setLabel(t, label, name)),
      })),
    ]);
  }

  // -- structural operations

  function archive(ids: string[]): Promise<void> {
    return run(async (t) => void (await archiveIssues(t, ids)));
  }

  function unarchive(ids: string[]): Promise<void> {
    return run(async (t) => void (await unarchiveIssues(t, ids)));
  }

  function archiveAllClosed(): Promise<void> {
    return run(async (t) => {
      const done = await archiveClosed(t);
      host.notice(done.length ? `Archived ${done.length} closed issue${done.length === 1 ? "" : "s"}` : "No closed issues to archive");
    });
  }

  async function remove(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const what = ids.length === 1 ? ids[0] : `${ids.length} issues`;
    if (!(await host.confirm(`Delete ${what}?`, "The note is moved to the trash and the issue is removed from the tracker.", "Delete"))) return;
    await run(async (t) => {
      for (const id of ids) await deleteIssue(t, id);
    });
  }

  function recreate(id: string): Promise<void> {
    return run(async (t) => void (await recreateNote(t, id, todayIso())));
  }

  async function comment(id: string): Promise<void> {
    const text = await host.prompt(`Comment on ${id}`, "Write a comment");
    if (text) await run((t) => commentIssue(t, id, text, host.author(), todayIso()));
  }

  /** Alt+Up / Alt+Down: move the cursor issue past its neighbour in the group. */
  function nudge(delta: -1 | 1): void {
    const c = cursor.value;
    if (!c) return;
    if (!canReorder.value) return host.notice("Reordering needs manual sort order");
    const list = groups.value.find((g) => g.key === c.group)?.issues ?? [];
    const neighbour = list[list.findIndex((i) => i.id === c.id) + delta];
    if (neighbour) void run((t) => moveIssue(t, c.id, delta < 0 ? "before" : "after", neighbour.id));
  }

  // -- drag and drop

  function dragStart(id: string): void {
    dragging.value = selected.has(id) ? targets() : [id];
  }

  function dragEnd(): void {
    dragging.value = [];
    dropHint.value = null;
  }

  /**
   * Drop the dragged issues on a group, optionally next to an issue. Dropping
   * into another group sets the property the grouping stands for; with manual
   * sort order the issues are also moved in the index.
   */
  function drop(groupKey: string, anchorId: string | null, pos: "before" | "after"): Promise<void> {
    const ids = dragging.value;
    dragEnd();
    const group = groups.value.find((g) => g.key === groupKey);
    if (!ids.length || !group) return Promise.resolve();
    const prop = groupProperty(groupBy.value);
    return run(async (t) => {
      for (const id of editable(ids)) {
        const rec = byId.value.get(id)!;
        if (!prop || (rec[prop] ?? null) === group.value) continue;
        if (group.value !== null) await setProps(t, id, { [prop]: group.value });
        else if (prop === "assignee") await setProps(t, id, { assignee: null });
      }
      if (!canReorder.value) return;
      let anchor = anchorId;
      let where = pos;
      if (!anchor) {
        const rest = group.issues.filter((i) => !ids.includes(i.id));
        if (!rest.length) return;
        anchor = rest[rest.length - 1].id;
        where = "after";
      }
      for (const id of ids) {
        if (id === anchor) continue;
        await moveIssue(t, id, where, anchor);
        if (where === "after") anchor = id;
      }
    });
  }

  // -- filters and saved views

  function toggleFilter(key: Exclude<keyof Filter, "text">, value: string): void {
    const list = spec.filter[key];
    const at = list.indexOf(value);
    if (at >= 0) list.splice(at, 1);
    else list.push(value);
    activeView.value = null;
  }

  function clearFilter(): void {
    Object.assign(spec.filter, { text: "", status: [], priority: [], labels: [], assignee: [] });
  }

  function applySpec(next: ViewSpec): void {
    const c = cloneSpec(next);
    spec.layout = c.layout;
    spec.groupBy = c.groupBy;
    spec.sortBy = c.sortBy;
    Object.assign(spec.filter, c.filter);
  }

  function applyView(name: string): void {
    const view = snapshot.value.views.find((v) => v.name === name);
    if (!view) return;
    applySpec(view);
    activeView.value = name;
  }

  async function saveView(): Promise<void> {
    const name = (await host.prompt("Save view", "View name", activeView.value ?? ""))?.trim();
    if (!name) return;
    const views = snapshot.value.views.filter((v) => v.name !== name);
    views.push({ name, ...cloneSpec(toRaw(spec)) });
    try {
      await store.saveViews(views);
      activeView.value = name;
    } catch (e) {
      host.notice(e instanceof Error ? e.message : String(e));
    }
    await store.reload();
  }

  async function deleteView(name: string): Promise<void> {
    try {
      await store.saveViews(snapshot.value.views.filter((v) => v.name !== name));
      if (activeView.value === name) activeView.value = null;
    } catch (e) {
      host.notice(e instanceof Error ? e.message : String(e));
    }
    await store.reload();
  }

  return {
    store, host, spec, showArchived, cursor, selected, collapsed, picker, dragging, dropHint, activeView, busy,
    snapshot, config, all, byId, visible, groupBy, groups, order, progress, canReorder, assignees, labels,
    priorities: PRIORITIES as readonly string[],
    isCursor, setCursor, moveCursor, toggleSelect, selectRange, clearSelection, targets, cursorIssue, reveal,
    edit, openPicker, closePicker, allHaveLabel, pick, labelMenu,
    archive, unarchive, archiveAllClosed, remove, recreate, comment, nudge,
    dragStart, dragEnd, drop,
    toggleFilter, clearFilter, applySpec, applyView, saveView, deleteView,
  };
}

export type Controller = ReturnType<typeof createController>;
export const CTRL: InjectionKey<Controller> = Symbol("bilinear-controller");
