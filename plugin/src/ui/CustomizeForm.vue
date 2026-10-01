<script setup lang="ts">
import { computed, ref } from "vue";
import { COLOR_NAMES, STATE_SHAPES } from "../format/ids";
import type { TrackerConfig } from "../store/query";
import LabelChip from "./LabelChip.vue";
import StatusIcon from "./StatusIcon.vue";

// How states and labels look. Every change is written to the index note at
// once, so there is nothing to save.
const props = defineProps<{ state: { config: TrackerConfig }; iconNames: string[] }>();
const emit = defineEmits<{
  stateIcon: [state: string, icon: string | null];
  stateColor: [state: string, color: string | null];
  labelColor: [label: string, color: string | null];
  addLabel: [label: string];
}>();

const config = computed(() => props.state.config);
const AUTO = "";
const OTHER = "other";
const shapeNames: Record<string, string> = {
  dashed: "Dashed ring", circle: "Ring", quarter: "Quarter", half: "Half", "three-quarters": "Three quarters", check: "Check", cross: "Cross",
};
/** States whose icon select is on "Other icon" but that have no icon name yet. */
const choosing = ref(new Set<string>());
const newLabel = ref("");

const labels = computed(() => [...new Set([...config.value.labels, ...Object.keys(config.value.labelColors)])]);

function iconChoice(state: string): string {
  const icon = config.value.stateIcons[state];
  if (icon === undefined) return choosing.value.has(state) ? OTHER : AUTO;
  return STATE_SHAPES.includes(icon) ? icon : OTHER;
}

function onIconChoice(state: string, value: string): void {
  if (value === OTHER) {
    choosing.value.add(state);
    return;
  }
  choosing.value.delete(state);
  emit("stateIcon", state, value === AUTO ? null : value);
}

function onIconName(state: string, value: string): void {
  const name = value.trim().toLowerCase().replace(/^lucide-/, "");
  if (!name) return;
  choosing.value.delete(state);
  emit("stateIcon", state, name);
}

function colorOptions(current: string | undefined): string[] {
  return current !== undefined && !COLOR_NAMES.includes(current) ? [...COLOR_NAMES, current] : COLOR_NAMES;
}

function title(name: string): string {
  return name.startsWith("#") ? name : name[0].toUpperCase() + name.slice(1);
}

function addLabel(): void {
  const name = newLabel.value.trim();
  if (name) emit("addLabel", name);
  newLabel.value = "";
}
</script>

<template>
  <div class="bl-customize">
    <h4>States</h4>
    <div v-for="s in config.states" :key="s" class="bl-customize-row">
      <StatusIcon :status="s" :config="config" />
      <span class="bl-customize-name">{{ s }}</span>
      <input
        v-if="iconChoice(s) === OTHER" class="bl-customize-icon" type="text" list="bl-icon-names" placeholder="Lucide icon, e.g. rocket"
        :aria-label="`Icon name for ${s}`" :value="config.stateIcons[s] ?? ''" spellcheck="false"
        @change="onIconName(s, ($event.target as HTMLInputElement).value)"
      />
      <select class="dropdown" :aria-label="`Icon for ${s}`" :value="iconChoice(s)" @change="onIconChoice(s, ($event.target as HTMLSelectElement).value)">
        <option :value="AUTO">Automatic icon</option>
        <option v-for="shape in STATE_SHAPES" :key="shape" :value="shape">{{ shapeNames[shape] }}</option>
        <option :value="OTHER">Other icon…</option>
      </select>
      <select
        class="dropdown" :aria-label="`Colour for ${s}`" :value="config.stateColors[s] ?? AUTO"
        @change="emit('stateColor', s, ($event.target as HTMLSelectElement).value || null)"
      >
        <option :value="AUTO">Automatic colour</option>
        <option v-for="c in colorOptions(config.stateColors[s])" :key="c" :value="c">{{ title(c) }}</option>
      </select>
    </div>
    <datalist id="bl-icon-names">
      <option v-for="name in iconNames" :key="name" :value="name"></option>
    </datalist>

    <h4>Labels</h4>
    <div v-for="l in labels" :key="l" class="bl-customize-row">
      <LabelChip :label="l" :colors="config.labelColors" />
      <span class="bl-spacer"></span>
      <select
        class="dropdown" :aria-label="`Colour for ${l}`" :value="config.labelColors[l] ?? AUTO"
        @change="emit('labelColor', l, ($event.target as HTMLSelectElement).value || null)"
      >
        <option :value="AUTO">Automatic colour</option>
        <option v-for="c in colorOptions(config.labelColors[l])" :key="c" :value="c">{{ title(c) }}</option>
      </select>
    </div>
    <div v-if="!labels.length" class="bl-customize-empty">No labels yet.</div>
    <form class="bl-customize-row" @submit.prevent="addLabel">
      <input v-model="newLabel" type="text" placeholder="New label" aria-label="New label" />
      <button type="submit">Add label</button>
    </form>
  </div>
</template>
