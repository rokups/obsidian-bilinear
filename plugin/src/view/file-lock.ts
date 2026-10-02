// The lock file of spec/FORMAT.md section 3.2: the lock the plugin and the
// CLI share. Whoever creates `.bilinear.lock` in a tracker folder holds the
// tracker until they remove it, and touches the file while they work. A lock
// file that goes untouched for LOCK_STALE was left by a program that died,
// and is taken over.

import { OpError } from "../ops/io";

export const LOCK_FILE = ".bilinear.lock";
export const WAIT_FILE = ".bilinear.lock.wait";

export interface LockTimes {
  /** How long to wait for the lock before giving up. */
  timeout: number;
  /** How long a lock file may go untouched before it is taken over. */
  stale: number;
  /** How often the holder touches its lock file. */
  heartbeat: number;
  /** How long to stand back for a program that is already waiting. */
  yield: number;
  /** How long between attempts to take the lock file. */
  poll: number;
}

export const LOCK_TIMES: LockTimes = { timeout: 10_000, stale: 8_000, heartbeat: 2_000, yield: 15, poll: 4 };

/** The part of Node's `fs` the lock needs. */
export interface LockFs {
  promises: {
    writeFile(path: string, data: string, options: { flag: string }): Promise<void>;
    appendFile(path: string, data: string): Promise<void>;
    readFile(path: string, encoding: "utf8"): Promise<string>;
    stat(path: string): Promise<{ mtimeMs: number }>;
    utimes(path: string, atime: Date, mtime: Date): Promise<void>;
    unlink(path: string): Promise<void>;
  };
}

function code(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Delete a file. On Windows that fails while another program has it open; try for a moment. */
async function remove(fs: LockFs, path: string): Promise<void> {
  for (let tries = 0; tries < 20; tries++) {
    try {
      return await fs.promises.unlink(path);
    } catch (e) {
      if (code(e) === "ENOENT") return;
      await sleep(5);
    }
  }
}

/** Run fn while holding the lock file of a tracker folder (an absolute path). */
export async function withFileLock<T>(fs: LockFs, folder: string, fn: () => Promise<T>, times: LockTimes = LOCK_TIMES): Promise<T> {
  const path = `${folder}/${LOCK_FILE}`;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  const content = `${JSON.stringify({ by: "plugin", pid: typeof process === "undefined" ? 0 : process.pid, token })}\n`;

  /** What identifies the lock file as it is now: its contents and its heartbeat. */
  const seen = async (): Promise<string | null> => {
    try {
      return `${await fs.promises.readFile(path, "utf8")}\0${(await fs.promises.stat(path)).mtimeMs}`;
    } catch {
      return null;
    }
  };

  // Someone is waiting for the lock already: let them have it first. A
  // waiter keeps touching the wait file; one that nobody touches was left by
  // a program that died.
  const wait = `${folder}/${WAIT_FILE}`;
  const touched = () => fs.promises.stat(wait).then(
    (s) => s.mtimeMs,
    () => null,
  );
  const mark = await touched();
  if (mark !== null) {
    await sleep(times.yield);
    if ((await touched()) === mark) await remove(fs, wait);
  }

  const started = Date.now();
  let waiting = false;
  let last: string | null = null;
  let since = started;
  try {
    for (;;) {
      try {
        await fs.promises.writeFile(path, content, { flag: "wx" });
        break;
      } catch (e) {
        // EPERM: on Windows, a lock file that is just being deleted.
        if (code(e) !== "EEXIST" && code(e) !== "EPERM") throw e;
      }
      const now = Date.now();
      const current = await seen();
      if (current !== last) {
        last = current;
        since = now;
      } else if (current !== null && now - since >= times.stale) {
        // Untouched for too long, on our own clock: its owner died.
        if ((await seen()) === current) await remove(fs, path);
        continue;
      }
      if (now - started >= times.timeout) throw new OpError("the tracker is in use by another program (the bilinear CLI?); try again");
      waiting = true;
      await fs.promises.appendFile(wait, "");
      await fs.promises.utimes(wait, new Date(), new Date()).catch(() => {});
      await sleep(times.poll);
    }
  } finally {
    if (waiting) await remove(fs, wait);
  }

  const beat = setInterval(() => {
    const now = new Date();
    void fs.promises.utimes(path, now, now).catch(() => {});
  }, times.heartbeat);
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    try {
      // Remove it only if it is still ours: after a long stall another
      // program may have taken the lock over.
      if ((await fs.promises.readFile(path, "utf8")) === content) await remove(fs, path);
    } catch {
      // Already gone.
    }
  }
}

const queues = new Map<string, Promise<void>>();

/** Is a call with this key running or waiting its turn? */
export function inUse(key: string): boolean {
  return queues.has(key);
}

/** Run fn after every earlier call with the same key has finished. */
export function inTurn<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).then(fn);
  const tail = result.then(
    () => {},
    () => {},
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}
