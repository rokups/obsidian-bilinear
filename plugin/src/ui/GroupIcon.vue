<script setup lang="ts">
import { inject } from "vue";
import type { Group } from "../store/query";
import { CTRL } from "./controller";
import PriorityIcon from "./PriorityIcon.vue";
import StatusIcon from "./StatusIcon.vue";

defineProps<{ group: Group }>();
const c = inject(CTRL)!;
</script>

<template>
  <StatusIcon v-if="c.groupBy.value === 'status'" :status="group.value" :states="c.config.value.states" :closed-states="c.config.value.closedStates" />
  <PriorityIcon v-else-if="c.groupBy.value === 'priority'" :priority="group.value ?? 'none'" />
</template>
