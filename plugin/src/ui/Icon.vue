<script setup lang="ts">
import { inject, onMounted, ref, watch } from "vue";
import { HOST } from "./host";

const props = defineProps<{ name: string }>();
const host = inject(HOST)!;
const el = ref<HTMLElement | null>(null);

function draw(): void {
  if (!el.value) return;
  el.value.replaceChildren();
  host.setIcon(el.value, props.name);
}

onMounted(draw);
watch(() => props.name, draw);
</script>

<template>
  <span ref="el" class="bl-icon" aria-hidden="true"></span>
</template>
