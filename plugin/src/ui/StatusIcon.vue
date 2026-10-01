<script setup lang="ts">
import { computed } from "vue";

// A ring that fills as the state moves through the workflow; closed states
// are solid with a check, or a cross for states that read as "not done".
const props = defineProps<{ status: string | null; states: string[]; closedStates: string[] }>();

const kind = computed(() => {
  const s = props.status;
  if (s === null || !props.states.includes(s)) return "unknown";
  if (props.closedStates.includes(s)) return /cancel|wont|won't|dup|reject|invalid/i.test(s) ? "dropped" : "done";
  return "open";
});

/** 0 for the first open state, approaching 1 for the last. */
const fraction = computed(() => {
  const open = props.states.filter((s) => !props.closedStates.includes(s));
  const at = open.indexOf(props.status ?? "");
  if (at <= 0) return 0;
  return open.length <= 2 ? 0.5 : (at - 1) / (open.length - 1) + 1 / (open.length - 1) / 2 + 0.15;
});

const first = computed(() => kind.value === "open" && props.states.indexOf(props.status ?? "") === 0);

const pie = computed(() => {
  const f = Math.min(0.92, Math.max(0, fraction.value));
  if (f <= 0) return "";
  const a = f * 2 * Math.PI;
  const x = 7 + 3.2 * Math.sin(a);
  const y = 7 - 3.2 * Math.cos(a);
  return `M7 7 L7 3.8 A3.2 3.2 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`;
});
</script>

<template>
  <svg class="bl-status-icon" :class="`is-${kind}`" :data-first="first" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
    <template v-if="kind === 'done'">
      <circle cx="7" cy="7" r="6" class="bl-fill" />
      <path d="M4.2 7.2 6.2 9.2 9.9 5.2" class="bl-mark" />
    </template>
    <template v-else-if="kind === 'dropped'">
      <circle cx="7" cy="7" r="6" class="bl-fill" />
      <path d="M4.8 4.8 9.2 9.2 M9.2 4.8 4.8 9.2" class="bl-mark" />
    </template>
    <template v-else>
      <circle cx="7" cy="7" r="5.5" class="bl-ring" :stroke-dasharray="first || kind === 'unknown' ? '1.6 1.9' : undefined" />
      <path v-if="pie" :d="pie" class="bl-fill" />
    </template>
  </svg>
</template>
