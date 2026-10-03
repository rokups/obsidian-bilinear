<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, watch } from "vue";
import { linkTargetLabel, linkTargets } from "../store/query";
import { CTRL, type PickerState } from "./controller";
import LabelChip from "./LabelChip.vue";
import PriorityIcon from "./PriorityIcon.vue";
import StatusIcon from "./StatusIcon.vue";

// A small command-palette style chooser for status, priority, labels,
// assignee, blockers and related issues. Labels, blockers and related issues
// are toggled and the picker stays open; the others close on choice. Labels and assignee accept new values typed into the input.
const props = defineProps<{ state: PickerState }>();
const c = inject(CTRL)!;

interface Option {
  value: string | null;
  label: string;
  checked: boolean;
  create?: boolean;
}

/** Pickers that toggle values and stay open. */
const toggles = computed(() => ["labels", "blocked-by", "related-to"].includes(props.state.kind));
const query = ref("");
const active = ref(0);
const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);

const targets = computed(() => props.state.ids.map((id) => c.byId.value.get(id)).filter((i) => i !== undefined));

function shared<T>(get: (i: (typeof targets.value)[number]) => T): T | undefined {
  const values = new Set(targets.value.map(get));
  return values.size === 1 ? [...values][0] : undefined;
}

const title = computed(() => {
  const what = {
    status: "Set status", priority: "Set priority", labels: "Set labels", assignee: "Assign", "blocked-by": "Blocked by", "related-to": "Related to",
  }[props.state.kind];
  return props.state.ids.length === 1 ? `${what}: ${props.state.ids[0]}` : `${what}: ${props.state.ids.length} issues`;
});

const options = computed<Option[]>(() => {
  const kind = props.state.kind;
  let all: Option[];
  if (kind === "status") {
    const cur = shared((i) => i.status);
    all = c.config.value.states.map((s) => ({ value: s, label: s, checked: s === cur }));
  } else if (kind === "priority") {
    const cur = shared((i) => i.priority);
    all = [...c.priorities].reverse().map((p) => ({ value: p, label: p === "none" ? "No priority" : p, checked: p === cur }));
  } else if (kind === "labels") {
    all = c.labels.value.map((l) => ({ value: l, label: l, checked: c.allHaveLabel(props.state.ids, l) }));
  } else if (kind === "blocked-by" || kind === "related-to") {
    all = linkTargets(c.all.value, c.snapshot.value.siblings, props.state.ids).map((t) => ({
      value: t.issue.id, label: linkTargetLabel(t), checked: c.allHaveRelation(kind, props.state.ids, t.issue.id),
    }));
  } else {
    const cur = shared((i) => i.assignee);
    all = [{ value: null, label: "Unassigned", checked: cur === null }, ...c.assignees.value.map((a) => ({ value: a, label: a, checked: a === cur }))];
  }
  const q = query.value.trim().toLowerCase();
  // Exact matches first, then prefixes, then anything containing the text.
  const rank = (o: Option) => {
    const l = o.label.toLowerCase();
    return l === q ? 0 : l.startsWith(q) ? 1 : 2;
  };
  const out = q ? all.filter((o) => o.label.toLowerCase().includes(q)).sort((a, b) => rank(a) - rank(b)) : all;
  const typed = query.value.trim();
  if (typed && (kind === "labels" || kind === "assignee") && !all.some((o) => o.value === typed)) {
    out.push({ value: typed, label: kind === "labels" ? `Add label "${typed}"` : `Assign to "${typed}"`, checked: false, create: true });
  }
  return out;
});

watch(options, (o) => {
  active.value = Math.min(active.value, Math.max(0, o.length - 1));
});
watch(query, () => {
  active.value = 0;
});

function choose(o: Option | undefined): void {
  if (!o) return;
  c.pick(o.value);
  if (toggles.value) query.value = "";
}

function onContext(e: MouseEvent, o: Option): void {
  if (props.state.kind === "labels" && o.value !== null && !o.create) c.labelMenu(e, o.value);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) active.value = Math.min(options.value.length - 1, active.value + 1);
  else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) active.value = Math.max(0, active.value - 1);
  else if (e.key === "Enter") choose(options.value[active.value]);
  else if (e.key === "Escape") c.closePicker();
  else return;
  e.preventDefault();
  e.stopPropagation();
  void nextTick(() => list.value?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" }));
}

onMounted(() => {
  const at = options.value.findIndex((o) => o.checked);
  if (!toggles.value && at >= 0) active.value = at;
  input.value?.focus();
});
</script>

<template>
  <div class="bl-overlay" @mousedown.self="c.closePicker()">
    <div class="bl-picker" role="dialog" :aria-label="title" @keydown="onKey">
      <div class="bl-picker-title">{{ title }}</div>
      <input ref="input" v-model="query" type="text" class="bl-picker-input" :placeholder="state.kind === 'labels' ? 'Filter or type a new label; right-click one for its colour' : state.kind === 'assignee' ? 'Filter or type a new value' : 'Filter'" spellcheck="false" />
      <div ref="list" class="bl-picker-list" role="listbox">
        <div
          v-for="(o, n) in options" :key="`${o.create ? 'new' : 'opt'}:${o.value}`"
          class="bl-option" :class="{ 'is-active': n === active, 'is-checked': o.checked }" role="option" :aria-selected="o.checked"
          @mousemove="active = n" @click="choose(o)" @contextmenu.prevent="onContext($event, o)"
        >
          <StatusIcon v-if="state.kind === 'status'" :status="o.value" :config="c.config.value" />
          <PriorityIcon v-else-if="state.kind === 'priority'" :priority="o.value ?? 'none'" />
          <StatusIcon v-else-if="o.value !== null && (state.kind === 'blocked-by' || state.kind === 'related-to')" :status="c.linkable.value.get(o.value)?.status ?? null" :config="c.configOf(o.value)" />
          <LabelChip v-else-if="state.kind === 'labels' && o.value !== null" :label="o.value" :colors="c.config.value.labelColors" dot-only />
          <span class="bl-option-label">{{ o.label }}</span>
          <span v-if="o.checked" class="bl-option-check">✓</span>
        </div>
        <div v-if="!options.length" class="bl-option is-empty">Nothing matches</div>
      </div>
    </div>
  </div>
</template>
