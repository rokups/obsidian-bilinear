import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TrackerIO } from "../src/ops/io";

/** An in-memory vault: path -> contents. Folders are implied by file paths. */
export class MemoryIO implements TrackerIO {
  files = new Map<string, string>();
  trashed: string[] = [];
  /** Called just before process() applies its function; tests use it to race. */
  beforeProcess: ((path: string) => void) | null = null;

  static fromDisk(dir: string, prefix: string): MemoryIO {
    const io = new MemoryIO();
    const walk = (rel: string) => {
      for (const name of readdirSync(join(dir, rel))) {
        const child = rel ? `${rel}/${name}` : name;
        if (statSync(join(dir, child)).isDirectory()) walk(child);
        else io.files.set(`${prefix}/${child}`, readFileSync(join(dir, child), "utf8"));
      }
    };
    walk("");
    return io;
  }

  /** Files under a folder, keyed by path relative to it. */
  snapshot(prefix: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, text] of [...this.files].sort()) {
      if (path.startsWith(prefix + "/")) out[path.slice(prefix.length + 1)] = text;
    }
    return out;
  }

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async process(path: string, fn: (text: string) => string): Promise<void> {
    this.beforeProcess?.(path);
    const text = this.files.get(path);
    if (text === undefined) throw new Error(`no such file: ${path}`);
    this.files.set(path, fn(text));
  }

  async createExclusive(path: string, text: string): Promise<boolean> {
    if (this.files.has(path)) return false;
    this.files.set(path, text);
    return true;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const text = this.files.get(from);
    if (text === undefined || this.files.has(to)) throw new Error(`cannot rename ${from} to ${to}`);
    this.files.delete(from);
    this.files.set(to, text);
  }

  async trash(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error(`no such file: ${path}`);
    this.trashed.push(path);
  }

  async mkdir(): Promise<void> {}

  async listNotes(folder: string): Promise<string[]> {
    const out: string[] = [];
    for (const path of this.files.keys()) {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir === folder && path.endsWith(".md")) out.push(path.slice(dir ? dir.length + 1 : 0, -3));
    }
    return out;
  }
}
