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
  e.stopPropagation();
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
    class="bl-card"
    :class="{ 'is-cursor': c.isCursor(issue.id, group), 'is-selected': isSelected, 'is-missing': issue.missing, 'is-dragging': c.dragging.value.includes(issue.id), [`is-drop-${hint}`]: hint && c.canReorder.value }"
    :data-id="issue.id" :data-group="group"
    :draggable="!issue.missing && !c.showArchived.value"
    @click="onClick" @dblclick="open(true)" @contextmenu.prevent="emit('menu', $event, issue)"
    @dragstart="onDragStart" @dragend="c.dragEnd()" @dragover="onDragOver" @drop="onDrop"
  >
    <div class="bl-card-head">
      <span class="bl-id">{{ issue.id }}</span>
      <span class="bl-spacer"></span>
      <button class="bl-cell clickable-icon" :title="`Priority: ${issue.priority}`" :aria-label="`Priority: ${issue.priority}`" :disabled="issue.missing" @click.stop="c.openPicker('priority', [issue.id])">
        <PriorityIcon :priority="issue.priority" />
      </button>
    </div>
    <div class="bl-card-title">
      <button v-if="c.groupBy.value !== 'status'" class="bl-cell clickable-icon" :title="`Status: ${issue.status ?? 'none'}`" :aria-label="`Status: ${issue.status ?? 'none'}`" :disabled="issue.missing" @click.stop="c.openPicker('status', [issue.id])">
        <StatusIcon :status="issue.status" :states="c.config.value.states" :closed-states="c.config.value.closedStates" />
      </button>
      <span class="bl-title" @click.stop="open(false)">{{ issue.title || issue.id }}</span>
    </div>
    <div v-if="issue.missing" class="bl-card-meta">
      <span class="bl-chip is-missing">note missing</span>
      <button class="bl-small" @click.stop="c.recreate(issue.id)">Recreate</button>
      <button class="bl-small mod-warning" @click.stop="c.remove([issue.id])">Remove</button>
    </div>
    <div v-else class="bl-card-meta">
      <IssueMeta :issue="issue" />
    </div>
  </div>
</template>
