import { FileView, Menu, Notice, Platform, setIcon, type TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { createApp, type App as VueApp } from "vue";
import type { IssueRecord } from "../format/record";
import type { NewIssue } from "../ops/issues";
import type BilinearPlugin from "../main";
import { defaultSpec, normalizeSpec, type ViewSpec } from "../store/query";
import { TrackerStore } from "../store/tracker-store";
import { CTRL, createController, type Controller } from "../ui/controller";
import { HOST, SET_ICON, type Host, type MenuEntry } from "../ui/host";
import TrackerApp from "../ui/TrackerApp.vue";
import { ConfirmModal, PromptModal } from "./modals";

export const VIEW_TYPE = "bilinear-tracker";

/**
 * Shows a tracker's index note as a list or board. It stands in for the
 * Markdown view of notes with `bilinear: tracker`; "Open as Markdown" switches
 * back. One Vue app is mounted per view and unmounted when the file unloads.
 */
export class TrackerView extends FileView implements Host {
  allowNoFile = false;
  private store: TrackerStore | null = null;
  private vue: VueApp | null = null;
  private controller: Controller | null = null;
  private rootVm: { focus(): void } | null = null;
  private spec: ViewSpec = defaultSpec();
  /** The split that issue notes open in, reused while it stays open. */
  private detail: WorkspaceLeaf | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: BilinearPlugin,
  ) {
    super(leaf);
    this.addAction("file-text", "Open as Markdown", () => this.openAsMarkdown());
    this.addAction("plus", "New issue", () => this.newIssue({}));
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "Tracker";
  }

  getIcon(): string {
    return "list-checks";
  }

  canAcceptExtension(extension: string): boolean {
    return extension === "md";
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.unmount();
    this.contentEl.empty();
    this.contentEl.addClass("bilinear-view");
    const store = new TrackerStore(this.app, file);
    const controller = createController(store, this, this.spec);
    const vue = createApp(TrackerApp);
    vue.provide(HOST, this);
    vue.provide(SET_ICON, setIcon);
    vue.provide(CTRL, controller);
    this.store = store;
    this.controller = controller;
    this.vue = vue;
    store.start();
    this.rootVm = vue.mount(this.contentEl) as unknown as { focus(): void };
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    this.unmount();
  }

  async onClose(): Promise<void> {
    this.unmount();
  }

  private unmount(): void {
    this.vue?.unmount();
    this.store?.stop();
    this.vue = null;
    this.store = null;
    this.controller = null;
    this.rootVm = null;
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), spec: this.spec };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    if (state && typeof state === "object" && "spec" in state) {
      this.spec = normalizeSpec((state as { spec: unknown }).spec);
      this.controller?.applySpec(this.spec);
    }
    await super.setState(state, result);
  }

  onPaneMenu(menu: Menu, source: string): void {
    menu.addItem((item) => item.setTitle("Open as Markdown").setIcon("file-text").setSection("pane").onClick(() => this.openAsMarkdown()));
    super.onPaneMenu(menu, source);
  }

  /** Put the cursor on an issue, e.g. one that was just created. */
  reveal(id: string): void {
    this.controller?.reveal(id);
    this.rootVm?.focus();
  }

  // -- Host

  showMenu(event: MouseEvent, entries: MenuEntry[]): void {
    const menu = new Menu();
    for (const e of entries) {
      if (e.separator) {
        menu.addSeparator();
        continue;
      }
      menu.addItem((item) => {
        item.setTitle(e.title ?? "");
        if (e.icon) item.setIcon(e.icon);
        if (e.checked !== undefined) item.setChecked(e.checked);
        if (e.danger) item.setWarning(true);
        if (e.action) item.onClick(e.action);
      });
    }
    menu.showAtMouseEvent(event);
  }

  notice(message: string): void {
    new Notice(message);
  }

  confirm(title: string, message: string, action: string): Promise<boolean> {
    return ConfirmModal.ask(this.app, title, message, action);
  }

  prompt(title: string, placeholder: string, initial = ""): Promise<string | null> {
    return PromptModal.ask(this.app, title, placeholder, initial);
  }

  openIssue(issue: IssueRecord, focus: boolean): void {
    const file = issue.path ? this.app.vault.getFileByPath(issue.path) : null;
    if (!file) return;
    if (Platform.isMobile) {
      void this.app.workspace.getLeaf("tab").openFile(file);
      return;
    }
    let attached = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf === this.detail) attached = true;
    });
    if (!this.detail || !attached) this.detail = this.app.workspace.createLeafBySplit(this.leaf, "vertical");
    void this.detail.openFile(file, { active: focus }).then(() => {
      if (!focus) this.rootVm?.focus();
    });
  }

  newIssue(defaults: Partial<NewIssue>): void {
    if (this.file) this.plugin.newIssue(defaults, this.file);
  }

  openAsMarkdown(): void {
    void this.plugin.showAsMarkdown(this.leaf);
  }

  lint(): void {
    if (this.file) this.plugin.lintTracker(this.file);
  }

  customize(): void {
    if (this.file) this.plugin.customize(this.file);
  }

  author(): string {
    return this.plugin.author();
  }

  specChanged(spec: ViewSpec): void {
    this.spec = spec;
    this.app.workspace.requestSaveLayout();
  }
}
