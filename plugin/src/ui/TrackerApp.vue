<script setup lang="ts">
import { inject, nextTick, onMounted, ref, watch } from "vue";
import type { IssueRecord } from "../format/record";
import BoardLayout from "./BoardLayout.vue";
import BulkBar from "./BulkBar.vue";
import { CTRL } from "./controller";
import type { MenuEntry } from "./host";
import ListLayout from "./ListLayout.vue";
import Picker from "./Picker.vue";
import Toolbar from "./Toolbar.vue";

const c = inject(CTRL)!;
const root = ref<HTMLElement | null>(null);

defineExpose({ focus: () => root.value?.focus() });

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

function onKey(e: KeyboardEvent): void {
  if (c.picker.value || isTyping(e.target)) return;
  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    c.nudge(e.key === "ArrowUp" ? -1 : 1);
    e.preventDefault();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  switch (key) {
    case "c": c.host.newIssue({}); break;
    case "j": case "ArrowDown": c.moveCursor(1); break;
    case "k": case "ArrowUp": c.moveCursor(-1); break;
    case "Enter": {
      const issue = c.cursorIssue();
      if (issue && !issue.missing) c.host.openIssue(issue, e.shiftKey);
      break;
    }
    case "s": c.openPicker("status"); break;
    case "p": c.openPicker("priority"); break;
    case "l": c.openPicker("labels"); break;
    case "a": c.openPicker("assignee"); break;
    case "x": if (c.cursor.value) c.toggleSelect(c.cursor.value.id); break;
    case "/": root.value?.querySelector<HTMLInputElement>(".bl-filter-input")?.focus(); break;
    case "Escape": c.clearSelection(); break;
    default: return;
  }
  e.preventDefault();
}

// Keep the cursor row in view as it moves.
watch(c.cursor, async (row) => {
  if (!row) return;
  await nextTick();
  root.value?.querySelector(`[data-id="${CSS.escape(row.id)}"][data-group="${CSS.escape(row.group)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
});

// Closing the picker returns the keyboard to the list.
watch(c.picker, (p) => {
  if (!p) root.value?.focus();
});

function onMenu(e: MouseEvent, issue: IssueRecord): void {
  const ids = c.selected.has(issue.id) ? c.targets() : [issue.id];
  const many = ids.length > 1 ? ` ${ids.length} issues` : "";
  const entries: MenuEntry[] = [];
  if (issue.missing) {
    entries.push({ title: "Recreate note", icon: "file-plus", action: () => void c.recreate(issue.id) });
  } else {
    if (ids.length === 1) {
      entries.push({ title: "Open", icon: "file-text", action: () => c.host.openIssue(issue, true) });
      entries.push({ title: "Add comment…", icon: "message-square", action: () => void c.comment(issue.id) });
      entries.push({ separator: true });
    }
    entries.push({ title: "Set status…", icon: "circle-dot", action: () => c.openPicker("status", ids) });
    entries.push({ title: "Set priority…", icon: "signal", action: () => c.openPicker("priority", ids) });
    entries.push({ title: "Set labels…", icon: "tag", action: () => c.openPicker("labels", ids) });
    entries.push({ title: "Set assignee…", icon: "user", action: () => c.openPicker("assignee", ids) });
    entries.push({ title: "Set blockers…", icon: "octagon-x", action: () => c.openPicker("blocked-by", ids) });
    entries.push({ title: "Set related…", icon: "link", action: () => c.openPicker("related-to", ids) });
    entries.push({ separator: true });
    if (issue.archived) entries.push({ title: `Unarchive${many}`, icon: "archive-restore", action: () => void c.unarchive(ids) });
    else entries.push({ title: `Archive${many}`, icon: "archive", action: () => void c.archive(ids) });
  }
  entries.push({ title: `Delete${many}`, icon: "trash", danger: true, action: () => void c.remove(ids) });
  c.host.showMenu(e, entries);
}

onMounted(() => root.value?.focus());
</script>

<template>
  <div ref="root" class="bl-root" :class="[`is-${c.spec.layout}`, { 'is-busy': c.busy.value }]" tabindex="0" @keydown="onKey">
    <Toolbar />
    <div v-if="c.snapshot.value.problems.length" class="bl-problems" role="alert">
      <strong>This tracker's index note needs fixing:</strong>
      <ul><li v-for="p in c.snapshot.value.problems" :key="p">{{ p }}</li></ul>
      <button @click="c.host.openAsMarkdown()">Open as Markdown</button>
    </div>
    <div class="bl-body">
      <ListLayout v-if="c.spec.layout === 'list'" @menu="onMenu" />
      <BoardLayout v-else @menu="onMenu" />
    </div>
    <BulkBar v-if="c.selected.size" />
    <Picker v-if="c.picker.value" :key="`${c.picker.value.kind}:${c.picker.value.ids.join()}`" :state="c.picker.value" />
  </div>
</template>
