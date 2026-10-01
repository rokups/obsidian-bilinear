<script setup lang="ts">
import { inject } from "vue";
import type { Group } from "../store/query";
import { CTRL } from "./controller";
import LabelChip from "./LabelChip.vue";
import PriorityIcon from "./PriorityIcon.vue";
import StatusIcon from "./StatusIcon.vue";

defineProps<{ group: Group }>();
const c = inject(CTRL)!;
</script>

<template>
  <StatusIcon v-if="c.groupBy.value === 'status'" :status="group.value" :config="c.config.value" />
  <PriorityIcon v-else-if="c.groupBy.value === 'priority'" :priority="group.value ?? 'none'" />
  <LabelChip v-else-if="c.groupBy.value === 'label' && group.value !== null" :label="group.value" :colors="c.config.value.labelColors" dot-only />
</template>
