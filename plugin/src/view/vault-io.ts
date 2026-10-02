import { FileSystemAdapter, Platform, TFile, type App, type EventRef } from "obsidian";
import type { TrackerIO } from "../ops/io";
import { inTurn, inUse, withFileLock, type LockFs } from "../ops/lock-file";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Tracker file operations on the vault API. Content writes go through
 * `vault.process`, moves through `fileManager.renameFile` (so links in other
 * notes are updated) and deletes through `fileManager.trashFile` (so the
 * user's trash setting is honoured).
 *
 * What exists is asked of the disk, not of the vault's file list: Obsidian
 * learns of a change made outside it (by the CLI) a moment after it happens,
 * and an operation that holds the lock must see the tracker as it is.
 */
export class VaultIO implements TrackerIO {
  constructor(private app: App) {}

  /**
   * The vault's entry for a file that is on disk, waiting a moment for
   * Obsidian to notice a file that was only just made or moved.
   */
  private async file(path: string): Promise<TFile | null> {
    for (let tries = 0; ; tries++) {
      if (!(await this.exists(path))) return null;
      const file = this.app.vault.getFileByPath(path);
      if (file || tries === 60) return file;
      await sleep(50);
    }
  }

  async read(path: string): Promise<string | null> {
    try {
      return await this.app.vault.adapter.read(path);
    } catch (e) {
      if (await this.exists(path)) throw e;
      return null;
    }
  }

  async process(path: string, fn: (text: string) => string): Promise<void> {
    const file = await this.file(path);
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
    if (await this.app.vault.adapter.exists(path)) return false;
    try {
      await this.app.vault.create(path, text);
      return true;
    } catch (e) {
      // The vault still lists a file that is gone from the disk.
      if (this.app.vault.getAbstractFileByPath(path)) return false;
      throw e;
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.app.vault.adapter.stat(path))?.type === "file";
  }

  async rename(from: string, to: string): Promise<void> {
    const file = await this.file(from);
    if (!file) throw new Error(`${from}: no such note`);
    const slash = to.lastIndexOf("/");
    if (slash > 0) await this.mkdir(to.slice(0, slash));
    // renameFile is done only when links in other notes have been updated,
    // and that can wait for the user to answer a dialog. The note itself has
    // moved as soon as the vault says so; the tracker need not wait longer.
    const { vault, fileManager } = this.app;
    let ref: EventRef | null = null;
    const moved = new Promise<void>((resolve) => {
      ref = vault.on("rename", (renamed) => {
        if (renamed === file) resolve();
      });
    });
    const done = fileManager.renameFile(file, to);
    done.catch(() => {});
    try {
      await Promise.race([moved, done]);
    } finally {
      if (ref) vault.offref(ref);
    }
  }

  async trash(path: string): Promise<void> {
    const file = await this.file(path);
    if (file) await this.app.fileManager.trashFile(file);
  }

  async mkdir(path: string): Promise<void> {
    if (!path || (await this.app.vault.adapter.stat(path))?.type === "folder") return;
    try {
      await this.app.vault.createFolder(path);
    } catch (e) {
      if ((await this.app.vault.adapter.stat(path))?.type !== "folder") throw e;
    }
  }

  async listNotes(folder: string): Promise<string[]> {
    let files: string[];
    try {
      files = (await this.app.vault.adapter.list(folder || "/")).files;
    } catch {
      return []; // No such folder.
    }
    return files.filter((p) => p.endsWith(".md")).map((p) => p.slice(p.lastIndexOf("/") + 1, -3));
  }

  /**
   * The title from the metadata cache, unless the note changed recently or
   * behind Obsidian's back: the cache follows the disk with a delay.
   */
  async title(path: string): Promise<string | null | undefined> {
    const file = this.app.vault.getFileByPath(path);
    const cache = file && this.app.metadataCache.getFileCache(file);
    if (!file || !cache) return undefined;
    const stat = await this.app.vault.adapter.stat(path);
    if (!stat || stat.mtime !== file.stat.mtime || stat.size !== file.stat.size || Date.now() - stat.mtime < 5000) return undefined;
    const title: unknown = cache.frontmatter?.["title"];
    return title === undefined || title === null ? null : String(title);
  }

  /**
   * One operation at a time per tracker: in turn within Obsidian, and on the
   * desktop under the lock file shared with the CLI. (On a phone there is no
   * other program to keep out.)
   */
  lock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const folder = this.lockKey(dir);
    if (folder === dir) return inTurn(dir, fn);
    const fs = (window as unknown as { require(name: "fs"): LockFs }).require("fs");
    return inTurn(folder, () => withFileLock(fs, folder, fn));
  }

  /** Is an operation on this tracker running, or waiting for its turn, in this Obsidian? */
  locking(dir: string): boolean {
    return inUse(this.lockKey(dir));
  }

  /** On the desktop, the tracker folder's path on disk; elsewhere the vault path as it is. */
  private lockKey(dir: string): string {
    const adapter = this.app.vault.adapter;
    if (!Platform.isDesktopApp || !(adapter instanceof FileSystemAdapter)) return dir;
    return dir ? adapter.getFullPath(dir) : adapter.getBasePath();
  }
}
