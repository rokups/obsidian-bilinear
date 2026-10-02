<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { GROUP_KEYS, SORT_KEYS, UNASSIGNED, filterIsEmpty, type Filter } from "../store/query";
import { CTRL } from "./controller";
import type { MenuEntry } from "./host";
import Icon from "./Icon.vue";

const c = inject(CTRL)!;

type Facet = Exclude<keyof Filter, "text">;

const facets = computed<Array<{ key: Facet; title: string; values: Array<[string, string]> }>>(() => [
  { key: "status", title: "Status", values: c.config.value.states.map((s) => [s, s]) },
  { key: "priority", title: "Priority", values: [...c.priorities].reverse().map((p) => [p, p === "none" ? "No priority" : p]) },
  { key: "labels", title: "Label", values: c.labels.value.map((l) => [l, l]) },
  { key: "assignee", title: "Assignee", values: [...c.assignees.value.map((a): [string, string] => [a, a]), [UNASSIGNED, "Unassigned"]] },
]);

const chips = computed(() =>
  facets.value.flatMap((f) =>
    c.spec.filter[f.key].map((value) => ({ key: f.key, value, text: `${f.title}: ${f.values.find((v) => v[0] === value)?.[1] ?? value}` })),
  ),
);

function facetMenu(e: MouseEvent, key: Facet): void {
  const f = facets.value.find((x) => x.key === key)!;
  if (!f.values.length) return c.host.notice(`No ${f.title.toLowerCase()} values yet`);
  c.host.showMenu(
    e,
    f.values.map(([value, title]) => ({ title, checked: c.spec.filter[key].includes(value), action: () => c.toggleFilter(key, value) })),
  );
}

function viewsMenu(e: MouseEvent): void {
  const entries: MenuEntry[] = c.snapshot.value.views.map((v) => ({ title: v.name, checked: c.activeView.value === v.name, action: () => c.applyView(v.name) }));
  if (entries.length) entries.push({ separator: true });
  entries.push({ title: "Save current view…", icon: "save", action: () => void c.saveView() });
  for (const v of c.snapshot.value.views) {
    entries.push({ title: `Delete view "${v.name}"`, icon: "trash", danger: true, action: () => void c.deleteView(v.name) });
  }
  c.host.showMenu(e, entries);
}

function moreMenu(e: MouseEvent): void {
  c.host.showMenu(e, [
    { title: "Archive closed issues", icon: "archive", action: () => void c.archiveAllClosed() },
    { title: "Lint tracker", icon: "stethoscope", action: () => c.host.lint() },
    { title: "Customize states and labels…", icon: "palette", action: () => c.host.customize() },
    { separator: true },
    { title: "Open as Markdown", icon: "file-text", action: () => c.host.openAsMarkdown() },
  ]);
}

// In a narrow pane everything but the filter box folds away behind a toggle.
const open = ref(false);
/** Something folded away is narrowing or changing what the list shows. */
const folded = computed(() => chips.value.length > 0 || c.showArchived.value || c.activeView.value !== null);

function onText(): void {
  c.activeView.value = null;
}
</script>

<template>
  <div class="bl-toolbar" :class="{ 'is-open': open }">
    <div class="bl-toolbar-row bl-toolbar-main">
      <div class="bl-segment bl-fold" role="group" aria-label="Layout">
        <button :class="{ 'is-active': c.spec.layout === 'list' }" aria-label="List layout" @click="c.spec.layout = 'list'"><Icon name="list" /></button>
        <button :class="{ 'is-active': c.spec.layout === 'board' }" aria-label="Board layout" @click="c.spec.layout = 'board'"><Icon name="columns-3" /></button>
      </div>
      <button class="bl-tool bl-fold" @click="viewsMenu($event)"><Icon name="bookmark" /> {{ c.activeView.value ?? "Views" }}</button>
      <div class="bl-filter">
        <Icon name="search" />
        <input v-model="c.spec.filter.text" class="bl-filter-input" type="search" placeholder="Filter issues" aria-label="Filter issues" spellcheck="false" @input="onText" @keydown.esc.stop="($event.target as HTMLElement).blur()" />
      </div>
      <button class="bl-tool bl-fold-toggle" :class="{ 'is-on': folded }" aria-label="Layout, filters and sorting" :aria-expanded="open" @click="open = !open"><Icon name="sliders-horizontal" /></button>
      <button class="clickable-icon" aria-label="More actions" @click="moreMenu($event)"><Icon name="more-horizontal" /></button>
      <button class="mod-cta bl-new" aria-label="New issue" @click="c.host.newIssue({})"><Icon name="plus" /> <span class="bl-new-text">New issue</span></button>
    </div>
    <div class="bl-toolbar-row bl-toolbar-options">
      <button v-for="f in facets" :key="f.key" class="bl-tool" :class="{ 'is-on': c.spec.filter[f.key].length }" @click="facetMenu($event, f.key)">{{ f.title }}</button>
      <span class="bl-spacer"></span>
      <label class="bl-select">Group
        <select v-model="c.spec.groupBy" class="dropdown" aria-label="Group by">
          <option v-for="g in GROUP_KEYS" :key="g" :value="g">{{ g }}</option>
        </select>
      </label>
      <label class="bl-select">Sort
        <select v-model="c.spec.sortBy" class="dropdown" aria-label="Sort by">
          <option v-for="s in SORT_KEYS" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <button class="bl-tool" :class="{ 'is-on': c.showArchived.value }" :aria-pressed="c.showArchived.value" @click="c.showArchived.value = !c.showArchived.value">
        <Icon name="archive" /> Archive <span class="bl-count">{{ c.snapshot.value.archived.length }}</span>
      </button>
    </div>
    <div v-if="chips.length || !filterIsEmpty(c.spec.filter)" class="bl-toolbar-row bl-chips">
      <button v-for="chip in chips" :key="`${chip.key}:${chip.value}`" class="bl-chip bl-filter-chip" :aria-label="`Remove filter ${chip.text}`" @click="c.toggleFilter(chip.key, chip.value)">
        {{ chip.text }} <span aria-hidden="true">×</span>
      </button>
      <span class="bl-count">{{ c.visible.value.length }} shown</span>
      <button class="bl-link" @click="c.clearFilter()">Clear filters</button>
    </div>
  </div>
</template>
