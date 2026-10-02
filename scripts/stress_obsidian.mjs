// Race the CLI against the plugin in a real Obsidian and report what was lost.
//
//   node scripts/stress_obsidian.mjs --vault <vault dir> [--port 9333] [--seconds 8] [--keep] [phase ...]
//
// Build first (`pnpm build` in plugin/): the script runs cli/dist/bilinear.js.
// Obsidian must be running on that vault with the plugin enabled and
// --remote-debugging-port=<port>. Each phase makes a tracker `Stress-...` in
// the vault and removes it afterwards (--keep leaves it). The vault must not
// hold other notes named ST-<n>: with two notes of one name Obsidian stops
// every move to ask about updating links. Phases (default: all):
//
//   plugin-writes   the plugin edits, the CLI reads
//   cli-writes      the CLI edits, the plugin reads
//   both-write      both edit the same notes and the index
//   editor          text typed into an open note while the CLI edits it
//   editor-plugin   text typed into an open note while the plugin edits,
//                   archives and deletes it
//
// Every edit carries its own marker, so an edit that reported success and is
// missing at the end is a lost update. Exits 1 if anything was lost or read
// wrongly.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./cdp.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "dist", "bilinear.js");
const PHASES = ["plugin-writes", "cli-writes", "both-write", "editor", "editor-plugin"];
const TODAY = "2026-10-02";
const SEEDS = 6;
const CLI_WORKERS = 4;

const opts = { port: 9333, seconds: 8, vault: null, keep: false, phases: [] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--port") opts.port = Number(process.argv[++i]);
  else if (a === "--seconds") opts.seconds = Number(process.argv[++i]);
  else if (a === "--keep") opts.keep = true;
  else if (a === "--vault") opts.vault = resolve(process.argv[++i]);
  else if (PHASES.includes(a)) opts.phases.push(a);
  else usage(`unknown argument ${a}`);
}
if (!opts.vault) usage("--vault is required");
if (!existsSync(CLI)) usage(`${CLI} is not built; run pnpm build in plugin/`);
if (!opts.phases.length) opts.phases = PHASES;

function usage(problem) {
  console.error(`${problem}\nusage: node scripts/stress_obsidian.mjs --vault <dir> [--port n] [--seconds n] [--keep] [${PHASES.join("|")} ...]`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const obsidian = await connect(opts.port);
let failures = 0;

function report(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

/** Group messages and show each once with its count. */
function tally(messages) {
  const counts = new Map();
  for (const m of messages) counts.set(m, (counts.get(m) ?? 0) + 1);
  return [...counts].map(([m, n]) => `${n}x ${m}`).join(" | ");
}

class Run {
  constructor(name) {
    this.name = `Stress-${Date.now().toString(36)}-${name}`;
    this.dir = join(opts.vault, this.name);
    this.indexPath = `${this.name}/${this.name}.md`;
  }

  cli(...args) {
    return new Promise((done) => {
      execFile(process.execPath, [CLI, "--tracker", join(this.dir, `${this.name}.md`), ...args], { env: { ...process.env, BILINEAR_USER: "cli", BILINEAR_TODAY: TODAY } }, (error, out, err) => {
        done({ code: error ? (error.code ?? -1) : 0, out, err: err.trim() });
      });
    });
  }

  async setup() {
    // A second tracker in the folder, as trackers usually share one: its notes lie among those under test.
    for (const [note, prefix] of [[`${this.name}.md`, "ST"], ["Neighbour.md", "NB"]]) {
      const made = await new Promise((done) => execFile(process.execPath, [CLI, "init", join(this.dir, note), "--prefix", prefix], (e, out, err) => done(e ? err : "")));
      if (made) throw new Error(`init failed: ${made}`);
    }
    const neighbour = await new Promise((done) => execFile(process.execPath, [CLI, "--tracker", join(this.dir, "Neighbour.md"), "new", "not under test"], (e, out, err) => done(e ? err : "")));
    if (neighbour) throw new Error(`seeding the neighbour failed: ${neighbour}`);
    for (let i = 1; i <= SEEDS; i++) {
      const r = await this.cli("new", `seed ${i}`);
      if (r.code) throw new Error(`seeding failed: ${r.err}`);
    }
    // Wait until Obsidian has indexed the tracker and its notes.
    for (let i = 0; i < 100; i++) {
      const ready = await obsidian.run(
        (indexPath, dir, seeds) => {
          const index = app.vault.getFileByPath(indexPath);
          if (!index || app.metadataCache.getFileCache(index)?.frontmatter?.bilinear !== "tracker") return false;
          for (let n = 1; n <= seeds; n++) {
            const note = app.vault.getFileByPath(`${dir}/issues/ST-${n}.md`);
            if (!note || !app.metadataCache.getFileCache(note)?.frontmatter) return false;
          }
          return true;
        },
        this.indexPath,
        this.name,
        SEEDS,
      );
      if (ready) return;
      await sleep(100);
    }
    throw new Error("Obsidian did not pick up the new tracker");
  }

  /** Start a loop in Obsidian; `body(t, ops, i, log)` runs until stop() and its log comes back. */
  async plugin(body, pause = 0) {
    const flag = `__bilinearStress_${Math.random().toString(36).slice(2)}`;
    const finished = obsidian.run(
      async (indexPath, flag, today, pause, body) => {
        const plugin = app.plugins.plugins.bilinear;
        const t = plugin.tracker(app.vault.getFileByPath(indexPath));
        const log = { done: [], errors: [], notes: [] };
        const step = eval(`(${body})`);
        window[flag] = false;
        for (let i = 0; !window[flag]; i++) {
          await step(t, plugin.ops, i, log, today);
          await new Promise((r) => setTimeout(r, pause));
        }
        delete window[flag];
        return log;
      },
      this.indexPath,
      flag,
      TODAY,
      pause,
      body.toString(),
    );
    return { stop: () => obsidian.run((flag) => void (window[flag] = true), flag).then(() => finished) };
  }

  /** Run `step(worker, i, log)` in several CLI loops until the deadline. */
  async cliWorkers(count, step) {
    const log = { done: [], errors: [], notes: [] };
    const deadline = Date.now() + opts.seconds * 1000;
    await Promise.all(
      Array.from({ length: count }, async (_, w) => {
        for (let i = 0; Date.now() < deadline; i++) await step(w, i, log);
      }),
    );
    return log;
  }

  index() {
    return readFileSync(join(this.dir, `${this.name}.md`), "utf8");
  }

  note(id) {
    for (const where of ["issues", "archive", "."]) {
      const p = join(this.dir, where, `${id}.md`);
      if (existsSync(p)) return readFileSync(p, "utf8");
    }
    return null;
  }

  /** What the plugin's own reader makes of the tracker, once Obsidian has caught up. */
  async pluginList() {
    await sleep(1500);
    return obsidian.run(async (indexPath) => {
      const plugin = app.plugins.plugins.bilinear;
      const issues = await plugin.ops.listIssues(plugin.tracker(app.vault.getFileByPath(indexPath)));
      return issues.map((i) => ({ id: i.id, title: i.title, status: i.status, archived: i.archived, missing: i.missing }));
    }, this.indexPath);
  }

  /** Checks every phase ends with: the tracker is whole and both readers agree. */
  async consistent() {
    const lint = await this.cli("lint");
    report("lint is clean", lint.code === 0, lint.out.trim().split("\n").slice(0, 6).join(" / "));
    const fromCli = JSON.parse((await this.cli("list", "--all", "--json")).out).map((i) => `${i.id} ${i.title} ${i.status}`);
    const fromPlugin = (await this.pluginList()).map((i) => `${i.id} ${i.title} ${i.status}`);
    report("CLI and plugin list the same issues", JSON.stringify(fromCli) === JSON.stringify(fromPlugin), `${fromCli.length} vs ${fromPlugin.length}`);
    const leftovers = ["", "issues", "archive"].flatMap((d) => readdirSync(join(this.dir, d)).filter((n) => n.endsWith(".tmp") || n.includes(".lock")));
    report("no temp or lock files left", leftovers.length === 0, leftovers.join(", "));
  }
}

/** Markers an edit left in ST-1's note and the index, compared with what was acknowledged. */
function lost(run, log, kind) {
  const note = run.note("ST-1") ?? "";
  const index = run.index();
  const missing = [];
  for (const mark of log.done) {
    const [what, value] = mark.split(":");
    if (what === "prop" && !new RegExp(`^${value}: `, "m").test(note)) missing.push(mark);
    if (what === "comment" && note.split(`: ${value}\n`).length !== 2) missing.push(mark);
    if (what === "new") {
      const [id, title] = value.split("=");
      const line = index.split("\n").filter((l) => l.includes(`[[${id}]]`));
      const text = run.note(id);
      if (line.length !== 1 || !line[0].endsWith(title) || text === null || !text.includes(`title: ${title}\n`)) missing.push(mark);
    }
  }
  report(`${kind}: ${log.done.length} acknowledged edits all present`, missing.length === 0, missing.length ? `${missing.length} lost, e.g. ${missing.slice(0, 5).join(", ")}` : "");
  report(`${kind}: no edit failed`, log.errors.length === 0, tally(log.errors));
}

const phases = {
  /** The plugin edits; CLI readers must always see a whole, valid tracker. */
  async "plugin-writes"(run) {
    const writer = await run.plugin(async (t, ops, i, log, today) => {
      try {
        await ops.setProps(t, "ST-1", { [`p${i}`]: "1" });
        log.done.push(`prop:p${i}`);
        await ops.commentIssue(t, "ST-1", `p${i}`, "plugin", today);
        log.done.push(`comment:p${i}`);
        await ops.setProps(t, "ST-2", { status: i % 2 ? "todo" : "in-progress", title: `seed 2 v${i}` });
        await ops.moveIssue(t, "ST-3", i % 2 ? "top" : "bottom");
        if (i % 2) await ops.unarchiveIssues(t, ["ST-4"]);
        else await ops.archiveIssues(t, ["ST-4"]);
        if (i % 5 === 0) log.done.push(`new:${await ops.createIssue(t, { title: `plugin ${i}` }, today)}=plugin ${i}`);
      } catch (e) {
        log.errors.push(String(e.message ?? e));
      }
    });
    let reads = 0;
    let known = SEEDS;
    const reader = await run.cliWorkers(CLI_WORKERS, async (w, i, log) => {
      reads++;
      const what = ["list", "show", "lint"][i % 3];
      if (what === "list") {
        const r = await run.cli("list", "--all", "--json");
        if (r.code) return void log.errors.push(`list exit ${r.code}: ${r.err.split("\n").pop()}`);
        const issues = JSON.parse(r.out);
        if (issues.length < known) log.errors.push(`list returned ${issues.length} issues after ${known} were seen`);
        known = Math.max(known, issues.length);
        for (const it of issues) {
          if (it.missing) log.errors.push(`list: ${it.id <= "ST-6" ? it.id : "new issue"} note missing`);
          else if (!it.title || !it.status) log.errors.push(`list: ${it.id <= "ST-6" ? it.id : "new issue"} without title or status`);
        }
      } else if (what === "show") {
        const r = await run.cli("show", "ST-1", "--json");
        if (r.code) return void log.errors.push(`show exit ${r.code}: ${r.err.split("\n").pop()}`);
        const it = JSON.parse(r.out);
        if (it.title !== "seed 1" || it.status !== "backlog") log.errors.push(`show: ST-1 read as title=${it.title} status=${it.status}`);
      } else {
        const r = await run.cli("lint", "--json");
        if (r.code === 2) for (const p of JSON.parse(r.out).problems) log.notes.push(`lint ${p.code}`);
        else if (r.code) log.errors.push(`lint exit ${r.code}: ${r.err.split("\n").pop()}`);
      }
    });
    const written = await writer.stop();
    console.log(`  plugin made ${written.done.length} edits; CLI read ${reads} times`);
    report("every CLI read saw a whole tracker", reader.errors.length === 0, tally(reader.errors));
    if (reader.notes.length) console.log(`  note transient lint reports while an operation was in flight: ${tally(reader.notes)}`);
    lost(run, written, "plugin");
  },

  /** The CLI edits; the plugin's reader and its open view must stay valid and end up right. */
  async "cli-writes"(run) {
    await obsidian.run(async (indexPath) => void (await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(indexPath))), run.indexPath);
    const reader = await run.plugin(async (t, ops, i, log) => {
      try {
        const issues = await ops.listIssues(t);
        log.done.push(issues.length);
        if (issues.length < 6) log.errors.push(`listIssues returned ${issues.length} issues`);
        for (const it of issues) {
          if (it.missing) log.errors.push(`listIssues: ${it.id <= "ST-6" ? it.id : "new issue"} note missing`);
          else if (!it.title || !it.status) log.errors.push(`listIssues: ${it.id <= "ST-6" ? it.id : "new issue"} without title or status`);
        }
        if (i % 4 === 0) for (const p of await ops.lint(t, false)) log.notes.push(`lint ${p.code}`);
      } catch (e) {
        log.errors.push(String(e.message ?? e));
      }
    }, 2);
    const written = await run.cliWorkers(CLI_WORKERS, async (w, i, log) => {
      const key = `c${w}x${i}`;
      const steps = [
        [["set", "ST-1", `${key}=1`], `prop:${key}`],
        [["comment", "ST-1", key], `comment:${key}`],
        [["set", "ST-2", `status=${i % 2 ? "todo" : "in-progress"}`, `title=seed 2 ${key}`], null],
        [["move", "ST-3", i % 2 ? "--top" : "--bottom"], null],
        [[i % 2 ? "unarchive" : "archive", "ST-4"], null],
      ];
      if (i % 3 === 0) steps.push([["new", `cli ${key}`], "new"]);
      for (const [argv, mark] of steps) {
        const r = await run.cli(...argv);
        if (r.code) log.errors.push(`${argv[0]} exit ${r.code}: ${r.err.split("\n").pop().replace(run.dir, "")}`);
        else if (mark === "new") log.done.push(`new:${r.out.trim()}=cli ${key}`);
        else if (mark) log.done.push(mark);
      }
    });
    const read = await reader.stop();
    console.log(`  CLI made ${written.done.length} edits; plugin read ${read.done.length} times`);
    report("every plugin read saw a whole tracker", read.errors.length === 0, tally(read.errors));
    if (read.notes.length) console.log(`  note transient lint reports while an operation was in flight: ${tally(read.notes)}`);
    lost(run, written, "CLI");
    await sleep(1500);
    const shown = await obsidian.run(() => [...document.querySelectorAll(".bl-row")].map((r) => r.dataset.id));
    const open = JSON.parse((await run.cli("list", "--json")).out).map((i) => i.id);
    report("the open tracker view shows the final list", JSON.stringify([...new Set(shown)].sort()) === JSON.stringify([...open].sort()), `${new Set(shown).size} rows vs ${open.length} open issues`);
  },

  /** Both edit the same note and the index at once; nothing acknowledged may be lost. */
  async "both-write"(run) {
    const pluginWriter = await run.plugin(async (t, ops, i, log, today) => {
      const attempt = async (mark, fn) => {
        try {
          const made = await fn();
          log.done.push(mark === "new" ? `new:${made}=plugin ${i}` : mark);
        } catch (e) {
          log.errors.push(String(e.message ?? e));
        }
      };
      await attempt(`prop:p${i}`, () => ops.setProps(t, "ST-1", { [`p${i}`]: "1" }));
      await attempt(`comment:p${i}`, () => ops.commentIssue(t, "ST-1", `p${i}`, "plugin", today));
      await attempt("new", () => ops.createIssue(t, { title: `plugin ${i}` }, today));
      await attempt(null, () => ops.moveIssue(t, "ST-3", i % 2 ? "top" : "bottom"));
      await attempt(null, () => (i % 2 ? ops.unarchiveIssues(t, ["ST-4"]) : ops.archiveIssues(t, ["ST-4"])));
      log.done = log.done.filter((m) => m !== null);
    }, 5);
    const cliLog = await run.cliWorkers(CLI_WORKERS, async (w, i, log) => {
      const key = `c${w}x${i}`;
      for (const [argv, mark] of [
        [["set", "ST-1", `${key}=1`], `prop:${key}`],
        [["comment", "ST-1", key], `comment:${key}`],
        [["new", `cli ${key}`], "new"],
        [["move", "ST-5", i % 2 ? "--top" : "--bottom"], null],
        [[i % 2 ? "unarchive" : "archive", "ST-6"], null],
      ]) {
        const r = await run.cli(...argv);
        if (r.code) log.errors.push(`${argv[0]} exit ${r.code}: ${r.err.split("\n").pop().replace(run.dir, "")}`);
        else if (mark === "new") log.done.push(`new:${r.out.trim()}=cli ${key}`);
        else if (mark) log.done.push(mark);
      }
    });
    const pluginLog = await pluginWriter.stop();
    lost(run, pluginLog, "plugin");
    lost(run, cliLog, "CLI");
    const ids = [...pluginLog.done, ...cliLog.done].filter((m) => m.startsWith("new:")).map((m) => m.slice(4).split("=")[0]);
    report(`${ids.length} new issues got distinct IDs`, new Set(ids).size === ids.length, `${ids.length - new Set(ids).size} shared`);
  },

  /** Text typed into an open note while the CLI edits the same note. */
  async editor(run) {
    const typing = await startTyping(run);
    const cliLog = await run.cliWorkers(1, async (w, i, log) => {
      const r = await run.cli("set", "ST-1", `e${i}=1`);
      if (r.code) log.errors.push(`set exit ${r.code}: ${r.err.split("\n").pop().replace(run.dir, "")}`);
      else log.done.push(`prop:e${i}`);
      await sleep(Math.random() * 150);
    });
    await typing.stop();
    lost(run, cliLog, "CLI");
  },

  /** Text typed into an open note while the plugin edits, moves and finally deletes it. */
  async "editor-plugin"(run) {
    const typing = await startTyping(run);
    const writer = await run.plugin(async (t, ops, i, log) => {
      try {
        await ops.setProps(t, "ST-1", { [`p${i}`]: "1" });
        log.done.push(`prop:p${i}`);
        if (i % 7 === 3) await ops.archiveIssues(t, ["ST-1"]);
        if (i % 7 === 5) await ops.unarchiveIssues(t, ["ST-1"]);
      } catch (e) {
        log.errors.push(String(e.message ?? e));
      }
    }, 60);
    await sleep(opts.seconds * 1000);
    const written = await writer.stop();
    await typing.stop();
    lost(run, written, "plugin");
    // Deleting a note that is open with unsaved text must not hang.
    await obsidian.run((path) => {
      const editor = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === path)?.view.editor;
      editor?.replaceRange("\nunsaved", { line: editor.lastLine(), ch: 0 });
    }, `${run.name}/issues/ST-1.md`);
    const removed = await Promise.race([
      obsidian.run(async (indexPath) => {
        const plugin = app.plugins.plugins.bilinear;
        await plugin.ops.deleteIssue(plugin.tracker(app.vault.getFileByPath(indexPath)), "ST-1");
        return "done";
      }, run.indexPath),
      sleep(5000).then(() => "still waiting after 5s"),
    ]);
    report("deleting the open note finishes", removed === "done" && run.note("ST-1") === null, removed);
  },
};

/** Type lines into ST-1's note in an editor until stop(), which checks none was lost. */
async function startTyping(run) {
  const path = `${run.name}/issues/ST-1.md`;
  await obsidian.run(async (path) => void (await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(path))), path);
  await sleep(500);
  const flag = "__bilinearStressTyping";
  const typing = obsidian.run(
    async (flag, id) => {
      const typed = [];
      window[flag] = false;
      for (let i = 0; !window[flag]; i++) {
        const editor = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.basename === id)?.view.editor;
        if (!editor) return { typed, error: "no editor" };
        const last = editor.lastLine();
        editor.replaceRange(`\ntyped ${i} here`, { line: last, ch: editor.getLine(last).length });
        typed.push(i);
        await new Promise((r) => setTimeout(r, 30 + Math.random() * 170));
      }
      await new Promise((r) => setTimeout(r, 3000));
      return { typed };
    },
    flag,
    "ST-1",
  );
  return {
    async stop() {
      await obsidian.run((flag) => void (window[flag] = true), flag);
      const { typed, error } = await typing;
      if (error) return report("typing", false, error);
      const note = run.note("ST-1") ?? "";
      const gone = typed.filter((i) => !note.includes(`typed ${i} here`));
      report(`${typed.length} typed lines all present`, gone.length === 0, `${gone.length} lost`);
    },
  };
}

for (const name of opts.phases) {
  const run = new Run(name);
  console.log(`${name} (${opts.seconds}s, ${run.name})`);
  try {
    await run.setup();
    await phases[name](run);
    await run.consistent();
  } finally {
    // Stop any loop a failed phase left running in Obsidian.
    await obsidian.run(() => Object.keys(window).filter((k) => k.startsWith("__bilinearStress")).forEach((k) => (window[k] = true)));
    if (!opts.keep) {
      rmSync(run.dir, { recursive: true, force: true });
      await sleep(1000);
    }
  }
}
obsidian.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
