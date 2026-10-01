<script setup lang="ts">
import { inject } from "vue";
import { CTRL } from "./controller";

const c = inject(CTRL)!;
</script>

<template>
  <div class="bl-bulk" role="toolbar" aria-label="Bulk edit">
    <span class="bl-bulk-count">{{ c.selected.size }} selected</span>
    <template v-if="c.showArchived.value">
      <button @click="c.unarchive(c.targets())">Unarchive</button>
    </template>
    <template v-else>
      <button @click="c.openPicker('status')">Status</button>
      <button @click="c.openPicker('priority')">Priority</button>
      <button @click="c.openPicker('labels')">Labels</button>
      <button @click="c.openPicker('assignee')">Assignee</button>
      <button @click="c.archive(c.targets())">Archive</button>
    </template>
    <button class="mod-warning" @click="c.remove(c.targets())">Delete</button>
    <button class="bl-link" @click="c.clearSelection()">Clear</button>
  </div>
</template>
