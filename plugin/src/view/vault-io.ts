import { TFile, TFolder, type App } from "obsidian";
import type { TrackerIO } from "../ops/io";

/**
 * Tracker file operations on the vault API. Content writes go through
 * `vault.process`, moves through `fileManager.renameFile` (so links in other
 * notes are updated) and deletes through `fileManager.trashFile` (so the
 * user's trash setting is honoured).
 */
export class VaultIO implements TrackerIO {
  constructor(private app: App) {}

  private file(path: string): TFile | null {
    return this.app.vault.getFileByPath(path);
  }

  async read(path: string): Promise<string | null> {
    const file = this.file(path);
    return file ? this.app.vault.read(file) : null;
  }

  async process(path: string, fn: (text: string) => string): Promise<void> {
    const file = this.file(path);
    if (!file) throw new Error(`${path}: no such note`);
    // vault.process must be given a function that does not throw; carry a
    // failure out and leave the note as it was.
    let failure: unknown = null;
    await this.app.vault.process(file, (text) => {
      try {
        return fn(text);
      } catch (e) {
        failure = e;
        return text;
      }
    });
    if (failure) throw failure;
  }

  async createExclusive(path: string, text: string): Promise<boolean> {
    if (this.app.vault.getAbstractFileByPath(path)) return false;
    try {
      await this.app.vault.create(path, text);
      return true;
    } catch (e) {
      // Created by someone else between the check and the create.
      if (this.app.vault.getAbstractFileByPath(path) || (await this.app.vault.adapter.exists(path))) return false;
      throw e;
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.file(path) !== null;
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.file(from);
    if (!file) throw new Error(`${from}: no such note`);
    const slash = to.lastIndexOf("/");
    if (slash > 0) await this.mkdir(to.slice(0, slash));
    await this.app.fileManager.renameFile(file, to);
  }

  async trash(path: string): Promise<void> {
    const file = this.file(path);
    if (file) await this.app.fileManager.trashFile(file);
  }

  async mkdir(path: string): Promise<void> {
    if (!path || this.app.vault.getAbstractFileByPath(path) instanceof TFolder) return;
    try {
      await this.app.vault.createFolder(path);
    } catch (e) {
      if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder)) throw e;
    }
  }

  async listNotes(folder: string): Promise<string[]> {
    const dir = folder ? this.app.vault.getFolderByPath(folder) : this.app.vault.getRoot();
    if (!dir) return [];
    return dir.children.filter((f): f is TFile => f instanceof TFile && f.extension === "md").map((f) => f.basename);
  }

  title(path: string): string | null | undefined {
    const file = this.file(path);
    if (!file) return undefined;
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return undefined;
    const title: unknown = cache.frontmatter?.["title"];
    return title === undefined || title === null ? null : String(title);
  }
}
