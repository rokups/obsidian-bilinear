import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpError } from "../src/ops/io";
import { LOCK_FILE, WAIT_FILE, inTurn, withFileLock, type LockTimes } from "../src/ops/lock-file";

const quick: LockTimes = { timeout: 300, stale: 150, heartbeat: 40, yield: 15, poll: 4 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "bilinear-lock-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const lockFile = () => join(dir, LOCK_FILE);

describe("the lock file", () => {
  it("exists while held and is removed afterwards, also after a failure", async () => {
    expect(await withFileLock(fs, dir, async () => fs.existsSync(lockFile()))).toBe(true);
    expect(fs.existsSync(lockFile())).toBe(false);
    await expect(withFileLock(fs, dir, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it("lets one holder in at a time", async () => {
    let inside = 0;
    let most = 0;
    const work = () =>
      withFileLock(fs, dir, async () => {
        most = Math.max(most, ++inside);
        await sleep(5);
        inside--;
      });
    await Promise.all(Array.from({ length: 12 }, work));
    expect(most).toBe(1);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it("is not taken over while its holder keeps touching it", async () => {
    let release = () => {};
    const held = withFileLock(fs, dir, () => new Promise<void>((resolve) => (release = resolve)), quick);
    await sleep(20);
    await expect(withFileLock(fs, dir, async () => {}, quick)).rejects.toThrow(OpError);
    expect(fs.existsSync(lockFile())).toBe(true);
    release();
    await held;
  });

  it("is taken over once it has gone untouched", async () => {
    fs.writeFileSync(lockFile(), '{"by":"cli","pid":1,"token":"dead"}\n');
    const started = Date.now();
    expect(await withFileLock(fs, dir, async () => "mine", quick)).toBe("mine");
    expect(Date.now() - started).toBeGreaterThanOrEqual(quick.stale);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it("is handed to a waiter before its last holder takes it again", async () => {
    const order: string[] = [];
    let waiterStarted = false;
    const hold = (name: string) => withFileLock(fs, dir, async () => void order.push(name));
    const busy = (async () => {
      for (let i = 0; i < 40; i++) {
        await withFileLock(fs, dir, async () => {
          order.push("busy");
          await sleep(2);
        });
        if (i === 3 && !waiterStarted) {
          waiterStarted = true;
          void hold("waiter");
        }
      }
    })();
    await busy;
    expect(order.indexOf("waiter")).toBeGreaterThan(0);
    expect(order.indexOf("waiter")).toBeLessThan(12);
    expect(fs.existsSync(join(dir, WAIT_FILE))).toBe(false);
  });

  it("is left alone on release if someone else took it over", async () => {
    await withFileLock(fs, dir, async () => fs.writeFileSync(lockFile(), "theirs\n"));
    expect(fs.readFileSync(lockFile(), "utf8")).toBe("theirs\n");
  });
});

describe("a lock file held by another program", () => {
  it("is waited for", async () => {
    fs.writeFileSync(lockFile(), '{"by":"cli","pid":1,"token":"busy"}\n');
    setTimeout(() => fs.unlinkSync(lockFile()), 60);
    const started = Date.now();
    await withFileLock(fs, dir, async () => {}, quick);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });
});

describe("inTurn", () => {
  it("runs calls with one key one after another, and carries on after a failure", async () => {
    const order: string[] = [];
    const job = (name: string, ms: number, fail = false) =>
      inTurn("k", async () => {
        order.push(`${name} in`);
        await sleep(ms);
        order.push(`${name} out`);
        if (fail) throw new Error(name);
      });
    const results = await Promise.allSettled([job("a", 15), job("b", 5, true), job("c", 1)]);
    expect(order).toEqual(["a in", "a out", "b in", "b out", "c in", "c out"]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});
