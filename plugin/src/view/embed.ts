import { MarkdownRenderChild, setIcon, type EventRef, type TFile } from "obsidian";
import { createApp, shallowReactive, watch, type App as VueApp } from "vue";
import type { IssueRecord } from "../format/record";
import type BilinearPlugin from "../main";
import { emptySnapshot, type Snapshot } from "../store/snapshot";
import { TrackerStore, folderOf } from "../store/tracker-store";
import EmbedList from "../ui/EmbedList.vue";
import { SET_ICON } from "../ui/host";
import { parseEmbed, type EmbedOptions } from "./embed-options";

export interface EmbedState {
  snapshot: Snapshot;
  error: string | null;
  title: string;
}

/** A filtered, read-only issue list rendered in place of a `bilinear` code block. */
export class EmbedChild extends MarkdownRenderChild {
  private store: TrackerStore | null = null;
  private vue: VueApp | null = null;
  private state: EmbedState = shallowReactive({ snapshot: emptySnapshot(), error: null, title: "" });
  private retry: EventRef | null = null;
  private unwatch: (() => void) | null = null;

  constructor(
    el: HTMLElement,
    private plugin: BilinearPlugin,
    private source: string,
    private sourcePath: string,
  ) {
    super(el);
  }

  onload(): void {
    const opts = parseEmbed(this.source);
    const workspace = this.plugin.app.workspace;
    this.vue = createApp(EmbedList, {
      state: this.state,
      filter: opts.filter,
      archived: opts.archived,
      limit: opts.limit,
      onOpen: (issue: IssueRecord, event: MouseEvent) => {
        if (issue.path) void workspace.openLinkText(issue.path, this.sourcePath, event.ctrlKey || event.metaKey);
      },
      onTracker: () => {
        if (this.store) void workspace.openLinkText(this.store.indexFile.path, this.sourcePath);
      },
    });
    this.vue.provide(SET_ICON, setIcon);
    this.vue.mount(this.containerEl);
    if (!this.attach(opts)) {
      // At startup the metadata cache may not know the trackers yet.
      this.retry = this.plugin.app.metadataCache.on("resolved", () => {
        if (this.attach(opts)) this.stopRetry();
      });
    }
  }

  private stopRetry(): void {
    if (this.retry) this.plugin.app.metadataCache.offref(this.retry);
    this.retry = null;
  }

  private attach(opts: EmbedOptions): boolean {
    const file = this.resolve(opts.tracker);
    if (!file) {
      this.state.error = opts.tracker
        ? `Bilinear: no tracker found for "${opts.tracker}"`
        : "Bilinear: add a line such as 'tracker: Trackers/Bilinear', the path of an index note, to say which tracker to show";
      return false;
    }
    this.state.error = null;
    this.state.title = file.basename;
    const store = new TrackerStore(this.plugin.app, file);
    this.store = store;
    this.unwatch = watch(store.snapshot, (snapshot) => (this.state.snapshot = snapshot), { immediate: true });
    store.start();
    return true;
  }

  private resolve(name: string | null): TFile | null {
    const trackers = this.plugin.findTrackers();
    if (!name) return this.plugin.trackerContaining(this.sourcePath) ?? (trackers.length === 1 ? trackers[0] : null);
    const wanted = name.replace(/^\/+|\/+$/g, "").replace(/\.md$/, "");
    // A folder or a name stands for a tracker only where it means one.
    const only = (found: TFile[]) => (found.length === 1 ? found[0] : undefined);
    return (
      trackers.find((t) => t.path.replace(/\.md$/, "") === wanted) ??
      only(trackers.filter((t) => folderOf(t) === wanted)) ??
      only(trackers.filter((t) => t.basename === wanted)) ??
      null
    );
  }

  onunload(): void {
    this.stopRetry();
    this.unwatch?.();
    this.vue?.unmount();
    this.store?.stop();
    this.vue = null;
    this.store = null;
  }
}
