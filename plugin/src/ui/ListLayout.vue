<script setup lang="ts">
import { inject } from "vue";
import type { IssueRecord } from "../format/record";
import type { Group } from "../store/query";
import { groupProperty } from "../store/query";
import { CTRL } from "./controller";
import GroupIcon from "./GroupIcon.vue";
import Icon from "./Icon.vue";
import IssueRow from "./IssueRow.vue";

const emit = defineEmits<{ menu: [event: MouseEvent, issue: IssueRecord] }>();
const c = inject(CTRL)!;

function toggle(key: string): void {
  if (!c.collapsed.delete(key)) c.collapsed.add(key);
}

function onGroupOver(e: DragEvent, g: Group): void {
  if (!c.dragging.value.length) return;
  e.preventDefault();
  c.dropHint.value = { group: g.key, id: null, pos: "after" };
}

function create(g: Group): void {
  const prop = groupProperty(c.groupBy.value);
  if (prop && g.value !== null) c.host.newIssue({ [prop]: g.value });
  else if (c.groupBy.value === "label" && g.value !== null) c.host.newIssue({ labels: [g.value] });
  else c.host.newIssue({});
}
</script>

<template>
  <div class="bl-list" role="grid">
    <section v-for="g in c.groups.value" :key="g.key" class="bl-group" :class="{ 'is-drop': c.dropHint.value?.group === g.key && c.dropHint.value.id === null }">
      <header
        v-if="c.groupBy.value !== 'none'" class="bl-group-head"
        @click="toggle(g.key)" @dragover="onGroupOver($event, g)" @drop.prevent="c.drop(g.key, null, 'after')"
      >
        <Icon :name="c.collapsed.has(g.key) ? 'chevron-right' : 'chevron-down'" />
        <GroupIcon :group="g" />
        <span class="bl-group-name">{{ g.label }}</span>
        <span class="bl-count">{{ g.issues.length }}</span>
        <span class="bl-spacer"></span>
        <button v-if="!c.showArchived.value" class="clickable-icon" :aria-label="`New issue in ${g.label}`" @click.stop="create(g)"><Icon name="plus" /></button>
      </header>
      <template v-if="!c.collapsed.has(g.key)">
        <IssueRow v-for="issue in g.issues" :key="issue.id" :issue="issue" :group="g.key" @menu="(e, i) => emit('menu', e, i)" />
      </template>
    </section>
    <div v-if="!c.visible.value.length" class="bl-empty">
      {{ c.showArchived.value ? "No archived issues" : c.snapshot.value.issues.length ? "No issues match the filter" : "No issues yet. Press C to create one." }}
    </div>
  </div>
</template>
