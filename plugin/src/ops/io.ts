/**
 * The file operations the tracker ops need. The plugin implements this on the
 * vault API (src/view/vault-io.ts); tests use an in-memory folder.
 * Paths are vault-relative with `/` separators.
 */
export interface TrackerIO {
  /** File contents, or null if there is no such file. */
  read(path: string): Promise<string | null>;
  /** Replace the contents with fn(contents). */
  process(path: string, fn: (text: string) => string): Promise<void>;
  /** Create a file that must not exist yet. Returns false if it does. */
  createExclusive(path: string, text: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  /** Move a note, creating the destination folder if needed. */
  rename(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Names (without `.md`) of the Markdown files directly in a folder. */
  listNotes(folder: string): Promise<string[]>;
  /**
   * Optional shortcut for a note's `title` property. Resolve to undefined
   * when it is unknown or may be out of date, and the note is read instead.
   */
  title?(path: string): Promise<string | null | undefined>;
  /**
   * Optional: run fn while holding the lock on a tracker folder, which keeps
   * out every other operation, in this program and in others.
   */
  lock?<T>(dir: string, fn: () => Promise<T>): Promise<T>;
}

export interface Tracker {
  io: TrackerIO;
  /** Tracker folder; "" for the vault root. */
  dir: string;
  indexPath: string;
  /** Told of things that are allowed but probably a mistake, such as a label the tracker does not list. */
  warn?(message: string): void;
}

/** An operation refused: bad arguments, unknown issue, invalid tracker. */
export class OpError extends Error {}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}
