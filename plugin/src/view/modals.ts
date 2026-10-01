import { Modal, Setting, type App } from "obsidian";
import { createApp, type App as VueApp } from "vue";
import type { NewIssue } from "../ops/issues";
import type { Problem } from "../ops/lint";
import NewIssueForm, { type TrackerChoice } from "../ui/NewIssueForm.vue";

export class ConfirmModal extends Modal {
  private result = false;

  constructor(
    app: App,
    private heading: string,
    private message: string,
    private action: string,
    private done: (ok: boolean) => void,
  ) {
    super(app);
  }

  static ask(app: App, heading: string, message: string, action: string): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModal(app, heading, message, action, resolve).open());
  }

  onOpen(): void {
    this.setTitle(this.heading);
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.action)
          .setWarning()
          .onClick(() => {
            this.result = true;
            this.close();
          }),
      );
  }

  onClose(): void {
    this.done(this.result);
  }
}

export class PromptModal extends Modal {
  private result: string | null = null;

  constructor(
    app: App,
    private heading: string,
    private placeholder: string,
    private initial: string,
    private done: (text: string | null) => void,
  ) {
    super(app);
  }

  static ask(app: App, heading: string, placeholder: string, initial = ""): Promise<string | null> {
    return new Promise((resolve) => new PromptModal(app, heading, placeholder, initial, resolve).open());
  }

  onOpen(): void {
    this.setTitle(this.heading);
    const input = this.contentEl.createEl("input", { type: "text", cls: "bl-prompt-input" });
    input.placeholder = this.placeholder;
    input.value = this.initial;
    const submit = () => {
      this.result = input.value.trim() || null;
      this.close();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("OK").setCta().onClick(submit));
    input.focus();
    input.select();
  }

  onClose(): void {
    this.done(this.result);
  }
}

export class NewIssueModal extends Modal {
  private vue: VueApp | null = null;

  constructor(
    app: App,
    private trackers: TrackerChoice[],
    private tracker: string,
    private defaults: Partial<NewIssue>,
    private submit: (indexPath: string, issue: NewIssue, open: boolean) => Promise<boolean>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("New issue");
    this.modalEl.addClass("bl-modal");
    this.vue = createApp(NewIssueForm, {
      trackers: this.trackers,
      tracker: this.tracker,
      defaults: this.defaults,
      onSubmit: async (indexPath: string, issue: NewIssue, open: boolean) => {
        if (await this.submit(indexPath, issue, open)) this.close();
      },
      onCancel: () => this.close(),
    });
    this.vue.mount(this.contentEl);
  }

  onClose(): void {
    this.vue?.unmount();
    this.vue = null;
    this.contentEl.empty();
  }
}

export class CreateTrackerModal extends Modal {
  constructor(
    app: App,
    private parent: string,
    private submit: (folder: string, prefix: string) => Promise<boolean>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Create tracker");
    let name = "";
    let parent = this.parent;
    let prefix = "";
    let prefixEdited = false;
    let prefixInput: HTMLInputElement | null = null;
    const suggest = (n: string) => {
      const words = n.split(/[^A-Za-z0-9]+/).filter(Boolean);
      const caps = n.replace(/[^A-Z]/g, "");
      const guess = caps.length >= 2 ? caps : words.length >= 2 ? words.map((w) => w[0]).join("") : (words[0] ?? "").slice(0, 3);
      return guess.toUpperCase().replace(/^[0-9]+/, "").slice(0, 4);
    };
    const go = async () => {
      const folder = [parent.trim().replace(/^\/+|\/+$/g, ""), name.trim()].filter(Boolean).join("/");
      if (name.trim() && (await this.submit(folder, prefix.trim()))) this.close();
    };
    new Setting(this.contentEl).setName("Name").setDesc("The tracker's folder and index note are named after it.").addText((t) => {
      t.setPlaceholder("RedBolt").onChange((v) => {
        name = v;
        if (!prefixEdited && prefixInput) prefixInput.value = prefix = suggest(v);
      });
      window.setTimeout(() => t.inputEl.focus());
    });
    new Setting(this.contentEl).setName("Parent folder").setDesc("Leave empty for the vault root.").addText((t) => t.setValue(parent).onChange((v) => (parent = v)));
    new Setting(this.contentEl).setName("ID prefix").setDesc("Capital letters and digits, starting with a letter. Issues are numbered RB-1, RB-2, …").addText((t) => {
      prefixInput = t.inputEl;
      t.setPlaceholder("RB").onChange((v) => {
        prefix = v;
        prefixEdited = true;
      });
    });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Create tracker").setCta().onClick(() => void go()));
    this.contentEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && (e.target as HTMLElement).tagName === "INPUT") {
        e.preventDefault();
        void go();
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class LintModal extends Modal {
  constructor(
    app: App,
    private name: string,
    private run: (fix: boolean) => Promise<Problem[]>,
    private openIssue: (id: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(`Lint: ${this.name}`);
    this.modalEl.addClass("bl-modal");
    void this.show(false);
  }

  private async show(fix: boolean): Promise<void> {
    const el = this.contentEl;
    let problems: Problem[];
    try {
      problems = await this.run(fix);
    } catch (e) {
      el.empty();
      el.createEl("p", { text: e instanceof Error ? e.message : String(e), cls: "bl-lint-error" });
      return;
    }
    el.empty();
    if (!problems.length) {
      el.createEl("p", { text: "No problems found." });
      return;
    }
    const open = problems.filter((p) => !p.fixed);
    const fixed = problems.length - open.length;
    el.createEl("p", {
      text: fix
        ? `Fixed ${fixed} problem${fixed === 1 ? "" : "s"}; ${open.length} need${open.length === 1 ? "s" : ""} attention.`
        : `${problems.length} problem${problems.length === 1 ? "" : "s"} found.`,
    });
    const list = el.createEl("ul", { cls: "bl-lint" });
    for (const p of problems) {
      const li = list.createEl("li", { cls: `is-${p.fixed ? "fixed" : p.severity}` });
      li.createSpan({ text: p.fixed ? "fixed" : p.severity, cls: "bl-lint-tag" });
      if (p.id) {
        const id = p.id;
        const link = li.createEl("a", { text: id });
        link.addEventListener("click", () => this.openIssue(id));
      } else {
        li.createSpan({ text: "index", cls: "bl-lint-subject" });
      }
      li.createSpan({ text: ` ${p.message} ` });
      li.createEl("code", { text: p.code });
    }
    const fixable = problems.filter((p) => p.fixable && !p.fixed).length;
    const row = new Setting(el);
    if (fixable) {
      row.setDesc("Fixing moves misplaced notes, rewrites index lines and raises the next number. It never adds or removes issues.");
      row.addButton((b) => b.setButtonText(`Fix ${fixable} problem${fixable === 1 ? "" : "s"}`).setCta().onClick(() => void this.show(true)));
    }
    row.addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
