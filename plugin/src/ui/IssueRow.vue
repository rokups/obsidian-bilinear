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

function onClick(e: MouseEvent): void {
  if (e.shiftKey) c.selectRange(props.issue.id, props.group);
  else if (e.ctrlKey || e.metaKey) c.toggleSelect(props.issue.id);
  c.setCursor(props.issue.id, props.group);
}

function open(focus: boolean): void {
  c.setCursor(props.issue.id, props.group);
  if (!props.issue.missing) c.host.openIssue(props.issue, focus);
}

function onDragStart(e: DragEvent): void {
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
    @dragstart="onDragStart" @dragend="c.dragEnd()" @dragover="onDragOver" @drop="onDrop"
  >
    <button class="bl-check" :class="{ 'is-on': isSelected }" role="checkbox" :aria-checked="isSelected" :aria-label="`Select ${issue.id}`" @click.stop="c.toggleSelect(issue.id)"></button>
    <button class="bl-cell clickable-icon" :title="`Priority: ${issue.priority}`" :aria-label="`Priority: ${issue.priority}`" :disabled="issue.missing" @click.stop="c.openPicker('priority', [issue.id])">
      <PriorityIcon :priority="issue.priority" />
    </button>
    <span class="bl-id">{{ issue.id }}</span>
    <button class="bl-cell clickable-icon" :title="`Status: ${issue.status ?? 'none'}`" :aria-label="`Status: ${issue.status ?? 'none'}`" :disabled="issue.missing" @click.stop="c.openPicker('status', [issue.id])">
      <StatusIcon :status="issue.status" :states="c.config.value.states" :closed-states="c.config.value.closedStates" />
    </button>
    <span class="bl-title" @click.stop="open(false)">{{ issue.title || issue.id }}</span>
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
