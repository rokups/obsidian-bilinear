<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { PRIORITIES } from "../format/ids";
import type { NewIssue } from "../ops/issues";

export interface TrackerChoice {
  indexPath: string;
  name: string;
  states: string[];
  labels: string[];
}

const props = defineProps<{ trackers: TrackerChoice[]; tracker: string; defaults: Partial<NewIssue> }>();
const emit = defineEmits<{ submit: [indexPath: string, issue: NewIssue, open: boolean]; cancel: [] }>();

const form = reactive({
  tracker: props.tracker,
  title: props.defaults.title ?? "",
  status: props.defaults.status ?? "",
  priority: props.defaults.priority ?? "none",
  labels: (props.defaults.labels ?? []).join(", "),
  assignee: props.defaults.assignee ?? "",
  due: props.defaults.due ?? "",
  top: props.defaults.top ?? false,
});
const titleInput = ref<HTMLInputElement | null>(null);
const current = computed(() => props.trackers.find((t) => t.indexPath === form.tracker) ?? props.trackers[0]);

watch(
  current,
  (t) => {
    if (t && !t.states.includes(form.status)) form.status = t.states[0] ?? "";
  },
  { immediate: true },
);

function submit(open: boolean): void {
  const title = form.title.trim();
  if (!title || !current.value) return void titleInput.value?.focus();
  emit(
    "submit",
    current.value.indexPath,
    {
      title,
      status: form.status,
      priority: form.priority,
      labels: form.labels.split(",").map((l) => l.trim()).filter(Boolean),
      assignee: form.assignee.trim() || undefined,
      due: form.due || undefined,
      parent: props.defaults.parent,
      top: form.top,
    },
    open,
  );
}

// The title comes first in the form so that typing starts there; the modal
// moves focus to its first control once it has opened, hence the second call.
onMounted(() => {
  titleInput.value?.focus();
  window.setTimeout(() => titleInput.value?.focus());
});
</script>

<template>
  <form class="bl-form" @submit.prevent="submit(false)" @keydown.ctrl.enter.prevent="submit(true)" @keydown.meta.enter.prevent="submit(true)">
    <input ref="titleInput" v-model="form.title" class="bl-form-title" type="text" placeholder="Issue title" aria-label="Issue title" />
    <div class="bl-form-row">
      <label v-if="trackers.length > 1" class="bl-field">Tracker
        <select v-model="form.tracker" class="dropdown">
          <option v-for="t in trackers" :key="t.indexPath" :value="t.indexPath">{{ t.name }}</option>
        </select>
      </label>
      <label class="bl-field">Status
        <select v-model="form.status" class="dropdown">
          <option v-for="s in current?.states ?? []" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <label class="bl-field">Priority
        <select v-model="form.priority" class="dropdown">
          <option v-for="p in PRIORITIES" :key="p" :value="p">{{ p }}</option>
        </select>
      </label>
      <label class="bl-field">Assignee
        <input v-model="form.assignee" type="text" />
      </label>
      <label class="bl-field">Due
        <input v-model="form.due" type="date" />
      </label>
    </div>
    <label class="bl-field">Labels
      <input v-model="form.labels" type="text" :placeholder="current?.labels.length ? current.labels.join(', ') : 'comma-separated'" />
    </label>
    <div class="bl-form-actions">
      <label class="bl-check-label"><input v-model="form.top" type="checkbox" /> Add at the top</label>
      <span class="bl-spacer"></span>
      <button type="button" @click="emit('cancel')">Cancel</button>
      <button type="button" @click="submit(true)">Create and open</button>
      <button type="submit" class="mod-cta">Create issue</button>
    </div>
  </form>
</template>
