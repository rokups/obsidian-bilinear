<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ priority: string }>();
const bars = computed(() => ({ low: 1, medium: 2, high: 3 })[props.priority] ?? 0);
</script>

<template>
  <svg class="bl-priority-icon" :class="`is-${priority}`" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
    <template v-if="priority === 'urgent'">
      <rect x="1" y="1" width="12" height="12" rx="3" class="bl-fill" />
      <path d="M7 3.6V7.8 M7 9.8V10.4" class="bl-mark" />
    </template>
    <template v-else-if="bars">
      <rect v-for="n in 3" :key="n" :x="n * 4 - 2.5" :y="12 - n * 3.2" width="2.6" :height="n * 3.2" rx="0.8" :class="n <= bars ? 'bl-fill' : 'bl-dim'" />
    </template>
    <template v-else>
      <rect v-for="n in 3" :key="n" :x="n * 4 - 2.5" y="6.2" width="2.6" height="1.6" rx="0.8" class="bl-dim" />
    </template>
  </svg>
</template>
