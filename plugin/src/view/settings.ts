import { PluginSettingTab, Setting, type App } from "obsidian";
import type BilinearPlugin from "../main";

export interface BilinearSettings {
  /** Author name written on comments. */
  author: string;
  /** Folder in which "Create tracker" puts the index notes of new trackers. */
  trackerFolder: string;
}

export const DEFAULT_SETTINGS: BilinearSettings = { author: "", trackerFolder: "Trackers" };

export class BilinearSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: BilinearPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Comment author")
      .setDesc("The name written on comments you add from Obsidian. The CLI uses --author, BILINEAR_USER or your login name.")
      .addText((t) =>
        t
          .setPlaceholder("me")
          .setValue(this.plugin.settings.author)
          .onChange(async (v) => {
            this.plugin.settings.author = v.trim();
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName("Default tracker folder")
      .setDesc("Where the 'Create tracker' command puts new trackers. The trackers of a folder share its issues/ and archive/. Leave empty for the vault root.")
      .addText((t) =>
        t
          .setPlaceholder("Trackers")
          .setValue(this.plugin.settings.trackerFolder)
          .onChange(async (v) => {
            this.plugin.settings.trackerFolder = v.trim().replace(/^\/+|\/+$/g, "");
            await this.plugin.saveSettings();
          }),
      );
  }
}
