<script setup lang="ts">
import { computed, inject } from "vue";
import type { IssueRecord } from "../format/record";
import { todayIso } from "../format/ids";
import { CTRL } from "./controller";
import LabelChip from "./LabelChip.vue";

// The right-hand details shared by list rows and board cards.
const props = defineProps<{ issue: IssueRecord }>();
const c = inject(CTRL)!;

const progress = computed(() => c.progress.value.get(props.issue.id));
const closed = computed(() => props.issue.status !== null && c.config.value.closedStates.includes(props.issue.status));
const overdue = computed(() => !!props.issue.due && !closed.value && props.issue.due < todayIso());
/** Blockers that are still open. */
const blockers = computed(() =>
  props.issue.blockedBy.filter((id) => {
    const b = c.byId.value.get(id);
    return !b || b.status === null || !c.config.value.closedStates.includes(b.status);
  }),
);
const progressTitle = computed(() => {
  const p = progress.value;
  if (!p) return "";
  const lines = p.issues.map((id) => {
    const i = c.byId.value.get(id);
    return `${id}  ${i?.status ?? "note missing"}  ${i?.title ?? ""}`.trimEnd();
  });
  return `${p.done} of ${p.total} linked issues closed\n${lines.join("\n")}`;
});
const initials = computed(() => (props.issue.assignee ?? "").trim().slice(0, 2).toUpperCase());
</script>

<template>
  <span v-if="blockers.length" class="bl-chip is-blocked" :title="`Blocked by ${blockers.join(', ')}`">blocked</span>
  <span v-if="progress" class="bl-chip bl-progress" :class="{ 'is-complete': progress.done === progress.total }" :title="progressTitle">
    <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
      <circle cx="7" cy="7" r="5" class="bl-ring" />
      <circle
        cx="7" cy="7" r="5" class="bl-arc" transform="rotate(-90 7 7)"
        :stroke-dasharray="`${(progress.done / progress.total) * 31.416} 31.416`"
      />
    </svg>
    {{ progress.done }}/{{ progress.total }}
  </span>
  <span v-if="issue.parent" class="bl-chip is-parent" :title="`Sub-issue of ${issue.parent}`">{{ issue.parent }}</span>
  <LabelChip
    v-for="label in issue.labels" :key="label" :label="label" :colors="c.config.value.labelColors"
    title="Right-click to change the colour" @contextmenu.prevent.stop="c.labelMenu($event, label)"
  />
  <span v-if="issue.due" class="bl-due" :class="{ 'is-overdue': overdue }" :title="overdue ? 'Overdue' : 'Due date'">{{ issue.due }}</span>
  <button
    v-if="!issue.missing" class="bl-avatar clickable-icon" :class="{ 'is-empty': !issue.assignee }"
    :title="issue.assignee ? `Assigned to ${issue.assignee}` : 'Unassigned'" :aria-label="issue.assignee ? `Assigned to ${issue.assignee}` : 'Unassigned'"
    @click.stop="c.openPicker('assignee', [issue.id])"
  >{{ initials }}</button>
</template>
