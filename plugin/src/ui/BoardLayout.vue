<script setup lang="ts">
import { inject } from "vue";
import type { IssueRecord } from "../format/record";
import type { Group } from "../store/query";
import { groupProperty } from "../store/query";
import { CTRL } from "./controller";
import GroupIcon from "./GroupIcon.vue";
import Icon from "./Icon.vue";
import IssueCard from "./IssueCard.vue";

const emit = defineEmits<{ menu: [event: MouseEvent, issue: IssueRecord] }>();
const c = inject(CTRL)!;

function onColumnOver(e: DragEvent, g: Group): void {
  if (!c.dragging.value.length) return;
  e.preventDefault();
  c.dropHint.value = { group: g.key, id: null, pos: "after" };
}

function create(g: Group): void {
  const prop = groupProperty(c.groupBy.value);
  c.host.newIssue(prop && g.value !== null ? { [prop]: g.value } : {});
}
</script>

<template>
  <div class="bl-board">
    <section
      v-for="g in c.groups.value" :key="g.key" class="bl-column"
      :class="{ 'is-drop': c.dropHint.value?.group === g.key && c.dropHint.value.id === null }"
      @dragover="onColumnOver($event, g)" @drop.prevent="c.drop(g.key, null, 'after')"
    >
      <header class="bl-column-head">
        <GroupIcon :group="g" />
        <span class="bl-group-name">{{ g.label }}</span>
        <span class="bl-count">{{ g.issues.length }}</span>
        <span class="bl-spacer"></span>
        <button v-if="!c.showArchived.value" class="clickable-icon" :aria-label="`New issue in ${g.label}`" @click.stop="create(g)"><Icon name="plus" /></button>
      </header>
      <div class="bl-column-body">
        <IssueCard v-for="issue in g.issues" :key="issue.id" :issue="issue" :group="g.key" @menu="(e, i) => emit('menu', e, i)" />
      </div>
    </section>
  </div>
</template>
