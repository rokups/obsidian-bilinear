<script setup lang="ts">
import { computed } from "vue";
import { labelCssColor } from "../store/labels";

const props = defineProps<{ label: string; colors: Record<string, string>; dotOnly?: boolean }>();
const color = computed(() => labelCssColor(props.label, props.colors));
</script>

<template>
  <span v-if="dotOnly" class="bl-dot" :style="{ '--bl-label': color }"></span>
  <span v-else class="bl-chip bl-label" :style="{ '--bl-label': color }"><span class="bl-dot"></span>{{ label }}</span>
</template>
