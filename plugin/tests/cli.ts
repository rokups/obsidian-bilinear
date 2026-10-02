import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { main } from "../../cli/src/cli";
import { NodeIO } from "../../cli/src/node-io";
import { LOCK_FILE, LOCK_TIMES } from "../src/ops/lock-file";

export interface Ran {
  code: number;
  out: string;
  err: string;
}

/** A scratch vault with one tracker, and the CLI run in-process against it. */
export class Sandbox {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "bilinear-cli-")));
  vault = join(this.root, "vault");
  dir = join(this.vault, "Trackers", "Bilinear");
  index = join(this.dir, "Bilinear.md");
  env: Record<string, string | undefined> = { BILINEAR_TODAY: "2026-10-01", USER: "rk" };
  cwd = this.dir;

  async init(): Promise<void> {
    fs.mkdirSync(join(this.vault, ".obsidian"), { recursive: true });
    const made = await this.run("init", this.index, "--prefix", "BL");
    if (made.code !== 0 || made.out !== `${this.index}\n`) throw new Error(`init failed: ${JSON.stringify(made)}`);
  }

  async run(...argv: string[]): Promise<Ran> {
    let out = "";
    let err = "";
    const code = await main(argv, { env: this.env, cwd: this.cwd, stdout: (s) => (out += s), stderr: (s) => (err += s) });
    return { code, out, err };
  }

  /** Run a command that must succeed; returns what it printed. */
  async ok(...argv: string[]): Promise<string> {
    const r = await this.run(...argv);
    if (r.code !== 0) throw new Error(`bilinear ${argv.join(" ")} exited ${r.code}: ${r.err}`);
    return r.out;
  }

  async code(...argv: string[]): Promise<number> {
    return (await this.run(...argv)).code;
  }

  async ids(...argv: string[]): Promise<string[]> {
    return (JSON.parse(await this.ok("list", "--json", ...argv)) as Array<{ id: string }>).map((i) => i.id);
  }

  /** Every file under the tracker folder, as sorted relative paths. */
  entries(): string[] {
    const out: string[] = [];
    const walk = (rel: string) => {
      for (const entry of fs.readdirSync(join(this.dir, rel), { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(child);
        else out.push(child);
      }
    };
    walk("");
    return out.sort();
  }

  note(id: string, where = "issues"): string {
    return join(this.dir, where, `${id}.md`);
  }

  read(path: string): string {
    return fs.readFileSync(path, "utf8");
  }

  /** Replace text in a file. */
  edit(path: string, from: string, to: string): void {
    const text = this.read(path);
    if (!text.includes(from)) throw new Error(`${path} does not contain ${from}`);
    fs.writeFileSync(path, text.replace(from, to));
  }

  get lockFile(): string {
    return join(this.dir, LOCK_FILE);
  }
}

/** A fresh sandbox for each test of the enclosing describe block. */
export function sandbox(): () => Sandbox {
  let current: Sandbox;
  beforeEach(async () => {
    current = new Sandbox();
    await current.init();
  });
  afterEach(() => {
    NodeIO.beforeWrite = null;
    NodeIO.lockTimes = LOCK_TIMES;
    fs.chmodSync(current.dir, 0o755);
    fs.rmSync(current.root, { recursive: true, force: true });
  });
  return () => current;
}
