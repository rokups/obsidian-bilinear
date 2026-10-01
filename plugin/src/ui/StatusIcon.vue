<script setup lang="ts">
import { computed } from "vue";
import type { TrackerConfig } from "../store/query";
import { stateColor, stateDrawing } from "../store/states";
import Icon from "./Icon.vue";

const props = defineProps<{ status: string | null; config: TrackerConfig }>();

const drawing = computed(() => stateDrawing(props.status, props.config));
const color = computed(() => stateColor(props.status, props.config));

const pie = computed(() => {
  const d = drawing.value;
  if (d.kind !== "ring" || d.fraction <= 0) return "";
  const f = Math.min(0.92, d.fraction);
  const a = f * 2 * Math.PI;
  const x = 7 + 3.2 * Math.sin(a);
  const y = 7 - 3.2 * Math.cos(a);
  return `M7 7 L7 3.8 A3.2 3.2 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`;
});
</script>

<template>
  <span v-if="drawing.kind === 'lucide'" class="bl-status-icon is-lucide" :style="{ '--bl-state': color }"><Icon :name="drawing.name" /></span>
  <svg v-else class="bl-status-icon" :style="{ '--bl-state': color }" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
    <template v-if="drawing.kind === 'check'">
      <circle cx="7" cy="7" r="6" class="bl-fill" />
      <path d="M4.2 7.2 6.2 9.2 9.9 5.2" class="bl-mark" />
    </template>
    <template v-else-if="drawing.kind === 'cross'">
      <circle cx="7" cy="7" r="6" class="bl-fill" />
      <path d="M4.8 4.8 9.2 9.2 M9.2 4.8 4.8 9.2" class="bl-mark" />
    </template>
    <template v-else>
      <circle cx="7" cy="7" r="5.5" class="bl-ring" :stroke-dasharray="drawing.dashed ? '1.6 1.9' : undefined" />
      <path v-if="pie" :d="pie" class="bl-fill" />
    </template>
  </svg>
</template>
