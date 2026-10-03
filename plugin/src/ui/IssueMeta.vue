<script setup lang="ts">
import { computed, inject } from "vue";
import type { IssueRecord } from "../format/record";
import { todayIso } from "../format/ids";
import { linkedLine } from "../store/query";
import { CTRL } from "./controller";
import LabelChip from "./LabelChip.vue";

// The right-hand details shared by list rows and board cards.
const props = defineProps<{ issue: IssueRecord }>();
const c = inject(CTRL)!;

const progress = computed(() => c.progress.value.get(props.issue.id));
const closed = computed(() => props.issue.status !== null && c.config.value.closedStates.includes(props.issue.status));
const overdue = computed(() => !!props.issue.due && !closed.value && props.issue.due < todayIso());
const relations = computed(() => c.relations.value.get(props.issue.id));
/** One line per issue, as `ID  status  title`, and the tracker's name after a sibling's issue. */
const lines = (ids: string[]) => ids.map((id) => linkedLine(id, c.linkable.value.get(id), c.trackerOf(id)));
/** Blockers that are still open; a missing note counts as open. */
const openBlockers = computed(() =>
  (relations.value?.blockedBy ?? []).filter((id) => {
    const i = c.linkable.value.get(id);
    return i === undefined || !c.isClosed.value(i);
  }),
);
const blockedTitle = computed(() => `Blocked by\n${lines(openBlockers.value).join("\n")}`);
const blocksTitle = computed(() => `Blocks\n${lines(relations.value?.blocks ?? []).join("\n")}`);
const relatedTitle = computed(() => `Related to\n${lines(relations.value?.related ?? []).join("\n")}`);
const progressTitle = computed(() => {
  const p = progress.value;
  if (!p) return "";
  return `${p.done} of ${p.total} blockers closed\n${lines(p.issues).join("\n")}`;
});
const initials = computed(() => (props.issue.assignee ?? "").trim().slice(0, 2).toUpperCase());
</script>

<template>
  <span v-if="relations?.blocked" class="bl-chip is-blocked" :title="blockedTitle">blocked</span>
  <span v-if="relations?.blocks.length" class="bl-chip is-relation" :title="blocksTitle">blocks {{ relations.blocks.length }}</span>
  <span v-if="relations?.related.length" class="bl-chip is-relation" :title="relatedTitle">related {{ relations.related.length }}</span>
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
