<script setup lang="ts">
import { computed } from "vue";
import type { IssueRecord } from "../format/record";
import { applyFilter, type Filter } from "../store/query";
import type { Snapshot } from "../store/snapshot";
import LabelChip from "./LabelChip.vue";
import PriorityIcon from "./PriorityIcon.vue";
import StatusIcon from "./StatusIcon.vue";

// Read-only list for the `bilinear` code block.
const props = defineProps<{
  state: { snapshot: Snapshot; error: string | null; title: string };
  filter: Filter;
  archived: boolean;
  limit: number;
}>();
const emit = defineEmits<{ open: [issue: IssueRecord, event: MouseEvent]; tracker: [] }>();

const snap = computed(() => props.state.snapshot);
const matching = computed(() => applyFilter(props.archived ? snap.value.archived : snap.value.issues, props.filter));
const shown = computed(() => (props.limit > 0 ? matching.value.slice(0, props.limit) : matching.value));
</script>

<template>
  <div class="bl-embed">
    <div v-if="state.error" class="bl-embed-error">{{ state.error }}</div>
    <template v-else>
      <div class="bl-embed-head">
        <a class="bl-embed-title" @click="emit('tracker')">{{ state.title }}</a>
        <span class="bl-count">{{ matching.length }}</span>
      </div>
      <div v-for="issue in shown" :key="issue.id" class="bl-row bl-embed-row" :class="{ 'is-missing': issue.missing }" @click="emit('open', issue, $event)">
        <PriorityIcon :priority="issue.priority" />
        <span class="bl-id">{{ issue.id }}</span>
        <StatusIcon :status="issue.status" :states="snap.config.states" :closed-states="snap.config.closedStates" />
        <span class="bl-title">{{ issue.title || issue.id }}</span>
        <span class="bl-spacer"></span>
        <LabelChip v-for="label in issue.labels" :key="label" :label="label" :colors="snap.config.labelColors" />
        <span v-if="issue.due" class="bl-due">{{ issue.due }}</span>
        <span v-if="issue.assignee" class="bl-chip">{{ issue.assignee }}</span>
      </div>
      <div v-if="!shown.length" class="bl-empty">No matching issues</div>
      <div v-else-if="shown.length < matching.length" class="bl-embed-more">and {{ matching.length - shown.length }} more</div>
    </template>
  </div>
</template>
