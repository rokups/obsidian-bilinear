<script setup lang="ts">
import { computed, inject } from "vue";
import type { IssueRecord } from "../format/record";
import { CTRL } from "./controller";
import IssueMeta from "./IssueMeta.vue";
import PriorityIcon from "./PriorityIcon.vue";
import StatusIcon from "./StatusIcon.vue";

const props = defineProps<{ issue: IssueRecord; group: string }>();
const emit = defineEmits<{ menu: [event: MouseEvent, issue: IssueRecord] }>();
const c = inject(CTRL)!;

const isCursor = computed(() => c.isCursor(props.issue.id, props.group));
const isSelected = computed(() => c.selected.has(props.issue.id));
const hint = computed(() => {
  const h = c.dropHint.value;
  return h && h.group === props.group && h.id === props.issue.id ? h.pos : null;
});

/** A click anywhere opens the issue; with Shift or Ctrl it selects instead. */
function onClick(e: MouseEvent): void {
  if (c.justSwept()) return;
  if (e.shiftKey) c.selectRange(props.issue.id, props.group);
  else if (e.ctrlKey || e.metaKey) c.toggleSelect(props.issue.id);
  else return open(false);
  c.setCursor(props.issue.id, props.group);
}

function open(focus: boolean): void {
  c.setCursor(props.issue.id, props.group);
  if (!props.issue.missing) c.host.openIssue(props.issue, focus);
}

/** Pressing the checkbox starts a sweep that does the toggling; only a keyboard click, which has no mouse press before it, toggles here. */
function onCheckDown(e: MouseEvent): void {
  if (e.button !== 0) return;
  e.preventDefault();
  (e.currentTarget as HTMLElement).focus({ preventScroll: true });
  c.sweepStart(props.issue.id, props.group, e.view ?? window);
}

function onCheckClick(e: MouseEvent): void {
  if (e.detail === 0) c.toggleSelect(props.issue.id);
}

function onDragStart(e: DragEvent): void {
  if (c.sweeping.value) return e.preventDefault();
  c.dragStart(props.issue.id);
  e.dataTransfer?.setData("text/plain", c.dragging.value.join(" "));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

function onDragOver(e: DragEvent): void {
  if (!c.dragging.value.length) return;
  e.preventDefault();
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
  c.dropHint.value = { group: props.group, id: props.issue.id, pos: e.clientY < box.top + box.height / 2 ? "before" : "after" };
}

function onDrop(e: DragEvent): void {
  e.preventDefault();
  e.stopPropagation();
  void c.drop(props.group, props.issue.id, hint.value ?? "after");
}
</script>

<template>
  <div
    class="bl-row"
    :class="{ 'is-cursor': isCursor, 'is-selected': isSelected, 'is-missing': issue.missing, 'is-dragging': c.dragging.value.includes(issue.id), [`is-drop-${hint}`]: hint && c.canReorder.value }"
    :data-id="issue.id" :data-group="group" role="row" :aria-selected="isSelected"
    :draggable="!issue.missing && !c.showArchived.value"
    @click="onClick" @dblclick="open(true)" @contextmenu.prevent="emit('menu', $event, issue)"
    @mouseenter="c.sweepTo(issue.id, group)" @dragstart="onDragStart" @dragend="c.dragEnd()" @dragover="onDragOver" @drop="onDrop"
  >
    <button class="bl-check" :class="{ 'is-on': isSelected }" role="checkbox" :aria-checked="isSelected" :aria-label="`Select ${issue.id}`" @mousedown.stop="onCheckDown" @click.stop="onCheckClick"></button>
    <button class="bl-cell bl-cell-priority clickable-icon" :title="`Priority: ${issue.priority}`" :aria-label="`Priority: ${issue.priority}`" :disabled="issue.missing" @click.stop="c.openPicker('priority', [issue.id])">
      <PriorityIcon :priority="issue.priority" />
    </button>
    <span class="bl-id">{{ issue.id }}</span>
    <button class="bl-cell bl-cell-status clickable-icon" :title="`Status: ${issue.status ?? 'none'}`" :aria-label="`Status: ${issue.status ?? 'none'}`" :disabled="issue.missing" @click.stop="c.openPicker('status', [issue.id])">
      <StatusIcon :status="issue.status" :config="c.config.value" />
    </button>
    <span class="bl-title">{{ issue.title || issue.id }}</span>
    <template v-if="issue.missing">
      <span class="bl-chip is-missing">note missing</span>
      <span class="bl-spacer"></span>
      <button class="bl-small" @click.stop="c.recreate(issue.id)">Recreate</button>
      <button class="bl-small mod-warning" @click.stop="c.remove([issue.id])">Remove</button>
    </template>
    <template v-else>
      <span class="bl-spacer"></span>
      <IssueMeta :issue="issue" />
    </template>
  </div>
</template>
