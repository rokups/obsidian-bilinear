import { type App, type EventRef, type TAbstractFile, type TFile } from "obsidian";
import { ref, shallowRef } from "vue";
import { ID_RE, LOCATIONS } from "../format/ids";
import { folderOf as locationFolder } from "../ops/tracker";
import type { Tracker } from "../ops/io";
import { VaultIO } from "../view/vault-io";
import { buildSnapshot, descriptionLinks, emptySnapshot, type Snapshot } from "./snapshot";
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
   * Is this path the index, or a note of this tracker in issues/, archive/
   * or the tracker folder? Other trackers may keep their notes there too:
   * a note is this tracker's if it has its prefix or is listed in it.
   */
  private concerns(path: string): boolean {
    if (path === this.indexFile.path) return true;
    const slash = path.lastIndexOf("/");
    const parent = slash < 0 ? "" : path.slice(0, slash);
    if (!LOCATIONS.some((where) => parent === locationFolder(this.dir, where))) return false;
    const { prefix } = this.snapshot.value.config;
    const id = path.slice(slash + 1).replace(/\.md$/, "");
    return prefix === null || ID_RE.exec(id)?.[1] === prefix || this.listed.has(id);
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
    this.snapshot.value = buildSnapshot(text, this.dir, (path) => {
      const file = this.app.vault.getFileByPath(path);
      if (!file) return undefined;
      const cache = this.app.metadataCache.getFileCache(file);
      return { frontmatter: cache?.frontmatter ?? null, links: descriptionLinks(cache) };
    });
    this.listed = new Set([...this.snapshot.value.issues, ...this.snapshot.value.archived].map((r) => r.id));
    this.loaded.value = true;
  }

  async saveViews(views: SavedView[]): Promise<void> {
    await this.io.lock(this.dir, () => this.io.process(this.indexFile.path, (text) => writeViews(text, views)));
  }
}
