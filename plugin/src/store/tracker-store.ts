import { type App, type EventRef, type TAbstractFile, type TFile } from "obsidian";
import { ref, shallowRef } from "vue";
import { ID_RE } from "../format/ids";
import type { Tracker } from "../ops/io";
import { VaultIO } from "../view/vault-io";
import { buildSiblings, buildSnapshot, descriptionLinks, emptySnapshot, touches, type IndexNote, type NoteLookup, type Snapshot } from "./snapshot";
import { writeViews, type SavedView } from "./views";

export function folderOf(file: TFile): string {
  const p = file.parent?.path ?? "";
  return p === "/" ? "" : p;
}

/**
 * The reactive state behind a tracker view: the index list resolved against
 * the notes, with properties taken from the metadata cache. It re-reads on
 * vault and metadata cache events, so edits made outside the plugin (the CLI,
 * the Properties UI, sync) show up live.
 */
export class TrackerStore {
  readonly snapshot = shallowRef<Snapshot>(emptySnapshot());
  readonly loaded = ref(false);
  private io: VaultIO;
  private refs: Array<[{ offref(ref: EventRef): void }, EventRef]> = [];
  private timer: number | null = null;
  private stopped = false;
  /** The IDs on the index's lines, as last read. */
  private listed = new Set<string>();
  /** Every index note of a sibling tracker, usable or not, as last read: a change to one of them can change which are usable. */
  private indexNotes = new Set<string>();

  constructor(
    private app: App,
    readonly indexFile: TFile,
  ) {
    this.io = new VaultIO(app);
  }

  get dir(): string {
    return folderOf(this.indexFile);
  }

  get tracker(): Tracker {
    return { io: this.io, dir: this.dir, indexPath: this.indexFile.path };
  }

  start(): void {
    const { vault, metadataCache } = this.app;
    const onFile = (file: TAbstractFile) => this.touched(file.path);
    this.refs.push(
      [vault, vault.on("modify", onFile)],
      [vault, vault.on("create", onFile)],
      [vault, vault.on("delete", onFile)],
      [vault, vault.on("rename", (file, oldPath) => (this.touched(file.path), this.touched(oldPath)))],
      [metadataCache, metadataCache.on("changed", onFile)],
    );
    void this.reload();
  }

  stop(): void {
    this.stopped = true;
    for (const [source, ref] of this.refs) source.offref(ref);
    this.refs = [];
    if (this.timer !== null) window.clearTimeout(this.timer);
  }

  /**
   * Is this path the index, an index note of a sibling tracker, or a note of this tracker or a sibling in issues/,
   * archive/ or the tracker folder? (A sibling's issue closing can clear a blocker here.)
   */
  private concerns(path: string): boolean {
    const { config, siblings } = this.snapshot.value;
    return touches(path, {
      dir: this.dir,
      indexPath: this.indexFile.path,
      prefix: config.prefix,
      siblingPrefixes: siblings.map((s) => s.config.prefix!),
      listed: this.listed,
      siblingPaths: this.indexNotes,
      isTracker: (p) => this.isTrackerNote(p),
    });
  }

  private isTrackerNote(path: string): boolean {
    const file = this.app.vault.getFileByPath(path);
    return file !== null && this.app.metadataCache.getFileCache(file)?.frontmatter?.["bilinear"] === "tracker";
  }

  private touched(path: string): void {
    if (this.stopped || !this.concerns(path) || this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.reload();
    }, 40);
  }

  async reload(): Promise<void> {
    if (this.stopped) return;
    let text: string;
    try {
      text = await this.app.vault.cachedRead(this.indexFile);
    } catch {
      return; // The index note is gone; the view is about to close.
    }
    if (this.stopped) return;
    const lookup: NoteLookup = (path) => {
      const file = this.app.vault.getFileByPath(path);
      if (!file) return undefined;
      const cache = this.app.metadataCache.getFileCache(file);
      return { frontmatter: cache?.frontmatter ?? null, links: descriptionLinks(cache) };
    };
    const snapshot = buildSnapshot(text, this.dir, lookup);
    const others = await this.siblingIndexes();
    if (this.stopped) return;
    snapshot.siblings = buildSiblings(snapshot.config, this.dir, others, lookup);
    this.snapshot.value = snapshot;
    this.indexNotes = new Set(others.map((o) => o.path));
    this.listed = new Set([snapshot, ...snapshot.siblings].flatMap((t) => [...t.issues, ...t.archived]).map((r) => r.id));
    this.loaded.value = true;
  }

  /** The other index notes of the folder: its top-level notes, not named like an issue, that carry `bilinear: tracker`. */
  private async siblingIndexes(): Promise<IndexNote[]> {
    const out: IndexNote[] = [];
    for (const file of this.indexFile.parent?.children ?? []) {
      const note = file as TFile;
      if (note.extension !== "md" || note.path === this.indexFile.path || ID_RE.test(note.basename)) continue;
      if (!this.isTrackerNote(note.path)) continue;
      try {
        out.push({ path: note.path, text: await this.app.vault.cachedRead(note) });
      } catch {
        // Gone since the cache was read.
      }
    }
    return out;
  }

  async saveViews(views: SavedView[]): Promise<void> {
    await this.io.lock(this.dir, () => this.io.process(this.indexFile.path, (text) => writeViews(text, views)));
  }
}
