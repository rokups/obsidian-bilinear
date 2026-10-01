import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf, type ViewState } from "obsidian";
import { ARCHIVE_DIR, ID_RE, ISSUES_DIR, todayIso } from "./format/ids";
import type { Tracker } from "./ops/io";
import { archiveClosed, commentIssue, createIssue, createTracker, type NewIssue } from "./ops/issues";
import { lint } from "./ops/lint";
import { notePath } from "./ops/tracker";
import { folderOf } from "./store/tracker-store";
import "./styles.css";
import type { TrackerChoice } from "./ui/NewIssueForm.vue";
import { EmbedChild } from "./view/embed";
import { CreateTrackerModal, LintModal, NewIssueModal, PromptModal } from "./view/modals";
import { BilinearSettingTab, DEFAULT_SETTINGS, type BilinearSettings } from "./view/settings";
import { TrackerView, VIEW_TYPE } from "./view/tracker-view";
import { VaultIO } from "./view/vault-io";

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : v === null || v === undefined || v === "" ? [] : [String(v)];
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default class BilinearPlugin extends Plugin {
  settings: BilinearSettings = { ...DEFAULT_SETTINGS };
  /** Leaves in which the user chose to see a tracker's index as Markdown. */
  private asMarkdown = new WeakMap<WorkspaceLeaf, string>();
  private markdownActions = new WeakMap<MarkdownView, HTMLElement>();
  private active = false;

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<BilinearSettings> | null) };
    this.active = true;

    this.registerView(VIEW_TYPE, (leaf) => new TrackerView(leaf, this));
    this.patchSetViewState();
    this.addSettingTab(new BilinearSettingTab(this.app, this));
    this.registerMarkdownCodeBlockProcessor("bilinear", (source, el, ctx) => {
      ctx.addChild(new EmbedChild(el, this, source, ctx.sourcePath));
    });

    this.addCommand({ id: "create-tracker", name: "Create tracker", callback: () => this.createTracker() });
    this.addCommand({ id: "new-issue", name: "New issue", callback: () => this.newIssue({}) });
    this.addCommand({
      id: "toggle-view",
      name: "Toggle tracker / Markdown view",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        const view = leaf?.view;
        if (leaf && view instanceof TrackerView) {
          if (!checking) void this.showAsMarkdown(leaf);
          return true;
        }
        if (leaf && view instanceof MarkdownView && view.file && this.isTracker(view.file)) {
          if (!checking) void this.showAsTracker(leaf);
          return true;
        }
        return false;
      },
    });
    this.addCommand({
      id: "archive-closed",
      name: "Archive closed issues",
      checkCallback: (checking) => this.withTracker(checking, (file) => void this.archiveClosed(file)),
    });
    this.addCommand({
      id: "lint",
      name: "Lint tracker",
      checkCallback: (checking) => this.withTracker(checking, (file) => this.lintTracker(file)),
    });
    this.addCommand({
      id: "comment",
      name: "Add comment to this issue",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const index = file && ID_RE.test(file.basename) ? this.trackerContaining(file.path) : null;
        if (!file || !index) return false;
        if (!checking) void this.comment(index, file.basename);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
        if (!(file instanceof TFile) || !leaf || !this.isTracker(file) || !(leaf.view instanceof MarkdownView)) return;
        menu.addItem((item) => item.setTitle("Open as tracker").setIcon("list-checks").setSection("pane").onClick(() => void this.showAsTracker(leaf)));
      }),
    );
    this.registerEvent(this.app.workspace.on("layout-change", () => this.decorateMarkdownViews()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.decorateMarkdownViews()));
    // A note that gains the marker (a tracker created by the CLI, or typed by
    // hand) becomes a tracker view the next time it is opened.
    this.registerEvent(this.app.metadataCache.on("changed", () => this.decorateMarkdownViews()));
    this.app.workspace.onLayoutReady(() => {
      this.adoptOpenIndexNotes();
      this.decorateMarkdownViews();
    });
  }

  onunload(): void {
    this.active = false;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const file = leaf.getViewState().state?.["file"];
      if (typeof file === "string") void leaf.setViewState({ type: "markdown", state: { file }, active: false });
    }
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView) this.markdownActions.get(leaf.view)?.remove();
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  author(): string {
    return this.settings.author || "me";
  }

  // -- finding trackers

  isTracker(file: TFile): boolean {
    return file.extension === "md" && this.app.metadataCache.getFileCache(file)?.frontmatter?.["bilinear"] === "tracker";
  }

  findTrackers(): TFile[] {
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => this.isTracker(f))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** The index note of the tracker a path belongs to: itself, its folder's, or (from issues/ or archive/) the one above. */
  trackerContaining(path: string): TFile | null {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return null;
    if (this.isTracker(file)) return file;
    const trackers = this.findTrackers();
    const dir = folderOf(file);
    const sub = [ISSUES_DIR, ARCHIVE_DIR].find((name) => dir === name || dir.endsWith(`/${name}`));
    const above = sub === undefined ? null : dir.slice(0, Math.max(0, dir.length - sub.length - 1));
    return trackers.find((t) => folderOf(t) === dir) ?? (above !== null ? trackers.find((t) => folderOf(t) === above) : undefined) ?? null;
  }

  /** The tracker a command should act on: the one in view, the one around the active note, or the only one. */
  currentTracker(): TFile | null {
    const view = this.app.workspace.getMostRecentLeaf()?.view;
    if (view instanceof TrackerView && view.file) return view.file;
    const file = this.app.workspace.getActiveFile();
    const around = file ? this.trackerContaining(file.path) : null;
    if (around) return around;
    const all = this.findTrackers();
    return all.length === 1 ? all[0] : null;
  }

  private withTracker(checking: boolean, fn: (file: TFile) => void): boolean {
    const file = this.currentTracker();
    if (!file) return false;
    if (!checking) fn(file);
    return true;
  }

  tracker(index: TFile): Tracker {
    return { io: new VaultIO(this.app), dir: folderOf(index), indexPath: index.path };
  }

  // -- tracker view in place of the Markdown view

  /**
   * Open index notes in the tracker view: whenever a leaf is about to show a
   * note with `bilinear: tracker` as Markdown, switch the view type, unless
   * the user asked for Markdown in that leaf. (The Kanban plugin's approach.)
   */
  private patchSetViewState(): void {
    const plugin = this;
    const proto = WorkspaceLeaf.prototype;
    const original = proto.setViewState;
    const patched = function (this: WorkspaceLeaf, state: ViewState, eState?: unknown): Promise<void> {
      const path: unknown = state.state?.["file"];
      if (plugin.active && state.type === "markdown" && typeof path === "string" && plugin.asMarkdown.get(this) !== path) {
        const file = plugin.app.vault.getFileByPath(path);
        if (file && plugin.isTracker(file)) state = { ...state, type: VIEW_TYPE };
      }
      return original.call(this, state, eState);
    };
    proto.setViewState = patched;
    this.register(() => {
      if (proto.setViewState === patched) proto.setViewState = original;
    });
  }

  async showAsMarkdown(leaf: WorkspaceLeaf): Promise<void> {
    const path = leaf.getViewState().state?.["file"];
    if (typeof path !== "string") return;
    this.asMarkdown.set(leaf, path);
    await leaf.setViewState({ type: "markdown", state: { file: path }, active: true });
  }

  async showAsTracker(leaf: WorkspaceLeaf): Promise<void> {
    const path = leaf.getViewState().state?.["file"];
    if (typeof path !== "string") return;
    this.asMarkdown.delete(leaf);
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: path }, active: true });
  }

  /** On startup, switch index notes that are already open as Markdown. */
  private adoptOpenIndexNotes(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const path = leaf.getViewState().state?.["file"];
      const file = typeof path === "string" ? this.app.vault.getFileByPath(path) : null;
      if (file && this.isTracker(file) && this.asMarkdown.get(leaf) !== file.path) void this.showAsTracker(leaf);
    }
  }

  /** Markdown views of index notes get an "Open as tracker" header button. */
  private decorateMarkdownViews(): void {
    if (!this.active) return;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      const wanted = !!view.file && this.isTracker(view.file);
      const action = this.markdownActions.get(view);
      if (wanted && !action?.isConnected) {
        this.markdownActions.set(view, view.addAction("list-checks", "Open as tracker", () => void this.showAsTracker(leaf)));
      } else if (!wanted && action) {
        action.remove();
        this.markdownActions.delete(view);
      }
    });
  }

  private async openIndex(index: TFile): Promise<TrackerView | null> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE).find((l) => l.view instanceof TrackerView && l.view.file === index);
    const leaf = existing ?? this.app.workspace.getLeaf(false);
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE, state: { file: index.path }, active: true });
    else this.app.workspace.setActiveLeaf(leaf, { focus: true });
    return leaf.view instanceof TrackerView ? leaf.view : null;
  }

  // -- commands

  private createTracker(): void {
    new CreateTrackerModal(this.app, this.settings.trackerFolder, async (folder, prefix) => {
      try {
        const path = await createTracker(new VaultIO(this.app), folder, prefix);
        const file = this.app.vault.getFileByPath(path);
        if (file) await this.openIndex(file);
        return true;
      } catch (e) {
        new Notice(message(e));
        return false;
      }
    }).open();
  }

  /** Ask for a new issue's details and create it. `preferred` preselects the tracker. */
  newIssue(defaults: Partial<NewIssue>, preferred?: TFile): void {
    const trackers = this.findTrackers();
    if (!trackers.length) {
      new Notice("No tracker yet. Use 'Bilinear: Create tracker' first.");
      return;
    }
    const choices: TrackerChoice[] = trackers.map((t) => {
      const fm = this.app.metadataCache.getFileCache(t)?.frontmatter ?? {};
      return { indexPath: t.path, name: t.basename, states: strings(fm["states"]), labels: strings(fm["labels"]) };
    });
    const chosen = preferred ?? this.currentTracker() ?? trackers[0];
    new NewIssueModal(this.app, choices, chosen.path, defaults, async (indexPath, issue, open) => {
      const index = this.app.vault.getFileByPath(indexPath);
      if (!index) return false;
      try {
        const id = await createIssue(this.tracker(index), issue, todayIso());
        new Notice(`Created ${id}`);
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
          if (leaf.view instanceof TrackerView && leaf.view.file === index) leaf.view.reveal(id);
        }
        if (open) {
          const note = this.app.vault.getFileByPath(notePath({ dir: folderOf(index) }, id, false));
          if (note) await this.app.workspace.getLeaf("tab").openFile(note);
        }
        return true;
      } catch (e) {
        new Notice(message(e));
        return false;
      }
    }).open();
  }

  private async archiveClosed(index: TFile): Promise<void> {
    try {
      const done = await archiveClosed(this.tracker(index));
      new Notice(done.length ? `Archived ${done.length} closed issue${done.length === 1 ? "" : "s"}` : "No closed issues to archive");
    } catch (e) {
      new Notice(message(e));
    }
  }

  lintTracker(index: TFile): void {
    const t = this.tracker(index);
    new LintModal(
      this.app,
      index.basename,
      (fix) => lint(t, fix),
      (id) => void this.app.workspace.openLinkText(id, index.path),
    ).open();
  }

  private async comment(index: TFile, id: string): Promise<void> {
    const text = await PromptModal.ask(this.app, `Comment on ${id}`, "Write a comment");
    if (!text) return;
    try {
      await commentIssue(this.tracker(index), id, text, this.author(), todayIso());
    } catch (e) {
      new Notice(message(e));
    }
  }
}
