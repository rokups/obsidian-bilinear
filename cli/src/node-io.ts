// Tracker file operations on Node's fs, for the command line. The rules are
// those of spec/FORMAT.md section 3.2: every operation holds the tracker's
// lock file, a file caught in the middle of being written is read again, and
// a file is replaced in one step, after checking that nobody changed it.

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { OpError, type TrackerIO } from "../../plugin/src/ops/io";
import { LOCK_TIMES, withFileLock, type LockTimes } from "../../plugin/src/ops/lock-file";

/** A file kept changing underneath us. */
export class ConflictError extends Error {}

const RETRIES = 3;

function code(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Call fn, retrying briefly on Windows when the file is in use. There a
 * rename fails while another process has the destination open, and opening
 * a file fails while it is being replaced. Elsewhere this is a plain call.
 */
function patiently<T>(fn: () => T): T {
  let delay = 10;
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (process.platform !== "win32" || attempt === 7 || !["EPERM", "EBUSY", "EACCES"].includes(code(e) ?? "")) throw e;
      sleepSync(delay);
      delay *= 2;
    }
  }
}

/** A path with forward slashes, as the tracker operations join and split them. */
export function slashed(path: string): string {
  return nodePath.sep === "/" ? path : path.split(nodePath.sep).join("/");
}

/**
 * Read a whole file, not one caught in the middle of being written. The CLI
 * and the plugin replace files in one step, but Obsidian's editor and other
 * tools write in place: the file is emptied, then filled. A file found
 * empty, or one that changed while it was read, is read again.
 */
export function readSettled(path: string): Buffer {
  let data = Buffer.alloc(0);
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = fs.statSync(path);
    data = patiently(() => fs.readFileSync(path));
    const after = fs.statSync(path);
    if (data.length && data.length === after.size && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs) break;
    sleepSync(2 * (attempt + 1));
  }
  return data;
}

export class NodeIO implements TrackerIO {
  /** Tests: called with the path just before a file is compared for the last time and replaced. */
  static beforeWrite: ((path: string) => void) | null = null;
  static lockTimes: LockTimes = LOCK_TIMES;

  constructor(
    private options: {
      /** Milliseconds to wait for the lock. */
      lockTimeout?: number;
      /** The command only reads: where no lock file can be made (read-only media) it goes ahead without. */
      readOnly?: boolean;
      /** `rm` without a vault: delete the note instead of refusing. */
      force?: boolean;
    } = {},
  ) {}

  async read(path: string): Promise<string | null> {
    try {
      return readSettled(path).toString("utf8");
    } catch (e) {
      if (code(e) === "ENOENT" || code(e) === "EISDIR") return null;
      throw e;
    }
  }

  /**
   * Read, transform and write back unless the file changed meanwhile, in
   * which case the whole thing is done again on what is there now. The lock
   * keeps other bilinear processes and the plugin out; this is for writers
   * that take no lock (Obsidian's editor, sync). The new contents are written
   * to a temporary file first and the file is compared last, so only a
   * change landing between that comparison and the rename goes unnoticed.
   */
  async process(path: string, fn: (text: string) => string): Promise<void> {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const old = readSettled(path);
      const data = Buffer.from(fn(old.toString("utf8")), "utf8");
      let tmp = data.equals(old) ? null : this.writeTemp(path, data);
      try {
        NodeIO.beforeWrite?.(path);
        if (!readSettled(path).equals(old)) continue;
        if (tmp !== null) {
          const ready = tmp;
          patiently(() => fs.renameSync(ready, path));
          tmp = null;
          this.syncDir(nodePath.dirname(path));
        }
        return;
      } finally {
        if (tmp !== null) fs.rmSync(tmp, { force: true });
      }
    }
    throw new ConflictError(`${path} kept changing; gave up after ${RETRIES} attempts`);
  }

  /** Write data to a temporary file next to path, ready to be moved over it. */
  private writeTemp(path: string, data: Buffer): string {
    const tmp = nodePath.join(nodePath.dirname(path), `.${nodePath.basename(path)}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`);
    try {
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.chmodSync(tmp, fs.statSync(path).mode & 0o7777);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    return tmp;
  }

  /** Make a rename in this folder durable. Not possible on Windows. */
  private syncDir(dir: string): void {
    try {
      const fd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Best effort.
    }
  }

  async createExclusive(path: string, text: string): Promise<boolean> {
    try {
      fs.writeFileSync(path, text, { flag: "wx" });
      return true;
    } catch (e) {
      if (code(e) === "EEXIST") return false;
      throw e;
    }
  }

  async exists(path: string): Promise<boolean> {
    return fs.statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  }

  async rename(from: string, to: string): Promise<void> {
    fs.mkdirSync(nodePath.dirname(to), { recursive: true });
    patiently(() => fs.renameSync(from, to));
  }

  /** Move a note to the `.trash` folder of the vault it is in, as Obsidian does. */
  async trash(path: string): Promise<void> {
    let vault: string | null = null;
    for (let dir = nodePath.dirname(path); ; dir = nodePath.dirname(dir)) {
      if (fs.statSync(nodePath.join(dir, ".obsidian"), { throwIfNoEntry: false })?.isDirectory()) {
        vault = dir;
        break;
      }
      if (dir === nodePath.dirname(dir)) break;
    }
    if (vault === null) {
      if (!this.options.force) throw new OpError("no vault (.obsidian/) found above the tracker; use --force to delete the note for good");
      patiently(() => fs.unlinkSync(path));
      return;
    }
    const trash = nodePath.join(vault, ".trash");
    fs.mkdirSync(trash, { recursive: true });
    const { name, ext } = nodePath.parse(path);
    let to = nodePath.join(trash, name + ext);
    for (let n = 2; fs.existsSync(to); n++) to = nodePath.join(trash, `${name} ${n}${ext}`);
    try {
      patiently(() => fs.renameSync(path, to));
    } catch (e) {
      if (code(e) !== "EXDEV") throw e;
      fs.copyFileSync(path, to);
      fs.unlinkSync(path);
    }
  }

  async mkdir(path: string): Promise<void> {
    fs.mkdirSync(path, { recursive: true });
  }

  async listNotes(folder: string): Promise<string[]> {
    try {
      return fs
        .readdirSync(folder, { withFileTypes: true })
        .filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || (entry.isSymbolicLink() && fs.statSync(nodePath.join(folder, entry.name), { throwIfNoEntry: false })?.isFile())))
        .map((entry) => entry.name.slice(0, -3));
    } catch {
      return [];
    }
  }

  async lock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    let entered = false;
    const times = { ...NodeIO.lockTimes, timeout: this.options.lockTimeout ?? NodeIO.lockTimes.timeout };
    try {
      return await withFileLock(
        fs,
        dir,
        () => {
          entered = true;
          return fn();
        },
        times,
      );
    } catch (e) {
      if (!entered && this.options.readOnly && ["EACCES", "EROFS"].includes(code(e) ?? "")) return fn();
      throw e;
    }
  }
}
