// bilinear: command-line client for Bilinear trackers.
//
// A tracker is a folder of Markdown notes: one index note (frontmatter
// `bilinear: tracker`), one note per issue in `issues/` and `archive/`. The
// format is specified in spec/FORMAT.md. The commands here are thin: the
// operations themselves are the plugin's (plugin/src/ops), run on Node's fs.

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { COLOR_NAMES, LIST_KEYS, STATE_SHAPES, linkId, makeLink, todayIso } from "../../plugin/src/format/ids";
import type { Index } from "../../plugin/src/format/index-note";
import type { IssueRecord } from "../../plugin/src/format/record";
import { Doc, type Value } from "../../plugin/src/format/yaml";
import { OpError, type Tracker } from "../../plugin/src/ops/io";
import { adoptIssue, archiveClosed, archiveIssues, commentIssue, createIssue, createTracker, deleteIssue, moveIssue, setLabel, setProps, setStateStyle, unarchiveIssues, type PropEdits } from "../../plugin/src/ops/issues";
import { lint } from "../../plugin/src/ops/lint";
import { LOCK_TIMES, LockTimeout } from "../../plugin/src/ops/lock-file";
import { indexNotes, issueRecord, locked, notePath, readIndex, requireItem, resolveNote } from "../../plugin/src/ops/tracker";
import { linkedProgress, type Progress } from "../../plugin/src/store/query";
import { version } from "../package.json";
import { ConflictError, NodeIO, slashed } from "./node-io";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_LINT = 2;
export const EXIT_CONFLICT = 3;

/** Where a command reads its surroundings from and writes to; tests supply their own. */
export interface Context {
  env: Record<string, string | undefined>;
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Bad arguments. Exit code 1, with the usage line. */
class UsageError extends Error {}

type Values = Record<string, string | boolean | string[] | undefined>;

interface Command {
  args: string;
  help: string;
  options?: NonNullable<ParseArgsConfig["options"]>;
  /** Fewest and most positional arguments. */
  takes: [number, number];
  /** The command only reads: it may run without the lock where none can be made. */
  reads?: (values: Values, positionals: string[]) => boolean;
  /** `init` makes the tracker; every other command runs in one. */
  run(inv: Invocation): Promise<number>;
}

interface Invocation {
  ctx: Context;
  values: Values;
  positionals: string[];
  /** Print a line. */
  out(line: string): void;
  io: NodeIO;
  tracker(): Promise<Tracker>;
}

const str = (v: Values[string]): string | undefined => (typeof v === "string" ? v : undefined);
const list = (v: Values[string]): string[] => (Array.isArray(v) ? v : []);
const json = (v: unknown): string => JSON.stringify(v, null, 2);
const native = (path: string): string => (nodePath.sep === "/" ? path : path.split("/").join(nodePath.sep));

/** Pad to a width counted in characters, not UTF-16 units. */
function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - [...s].length));
}

function width(values: string[]): number {
  return Math.max(0, ...values.map((v) => [...v].length));
}

/** Values given by repeating a flag, each of which may be comma-separated. */
function csv(values: string[]): string[] {
  return values.flatMap((v) => v.split(",").map((p) => p.trim()).filter((p) => p));
}

/** A record with the key names and order of the CLI's JSON. */
function toJson(r: IssueRecord, progress: Progress | null): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    labels: r.labels,
    assignee: r.assignee,
    due: r.due,
    parent: r.parent,
    "blocked-by": r.blockedBy,
    created: r.created,
    links: r.links,
    progress,
    archived: r.archived,
    missing: r.missing,
  };
}

/** A record for every issue, open and archived, and the progress of each. To be called holding the lock. */
async function allRecords(t: Tracker, idx: Index): Promise<{ records: IssueRecord[]; progress: Map<string, Progress> }> {
  const records: IssueRecord[] = [];
  for (const it of idx.unique()) records.push(await issueRecord(t, it));
  return { records, progress: linkedProgress(records, idx.closedStates) };
}

/** "none" and "auto" clear a colour or an icon; no flag leaves it alone. */
function styleValue(given: string | undefined): string | null | undefined {
  if (given === undefined) return undefined;
  return ["none", "auto"].includes(given.toLowerCase()) ? null : given;
}

const ASSIGN_RE = /^([^=+\-\s][^=\s]*?)(\+=|-=|=)([\s\S]*)$/;

const COMMANDS: Record<string, Command> = {
  init: {
    args: "<folder> --prefix PREFIX",
    help: "create a tracker folder, its index note, issues/ and archive/",
    options: { prefix: { type: "string" } },
    takes: [1, 1],
    async run({ ctx, values, positionals, out, io }) {
      const prefix = str(values["prefix"]);
      if (prefix === undefined) throw new UsageError("--prefix is required");
      const folder = nodePath.resolve(ctx.cwd, positionals[0]);
      const index = await createTracker(io, slashed(folder), prefix);
      out(nodePath.join(positionals[0], nodePath.basename(index)));
      return EXIT_OK;
    },
  },

  new: {
    args: "<title> [--status S] [--priority P] [--label L]... [--assignee A] [--due YYYY-MM-DD] [--parent ID] [--top] [--json]",
    help: "create an issue and print its ID",
    options: {
      status: { type: "string" },
      priority: { type: "string" },
      label: { type: "string", multiple: true },
      assignee: { type: "string" },
      due: { type: "string" },
      parent: { type: "string" },
      top: { type: "boolean" },
      json: { type: "boolean" },
    },
    takes: [1, 1],
    async run({ ctx, values, positionals, out, tracker }) {
      const t = await tracker();
      const id = await createIssue(
        t,
        {
          title: positionals[0],
          status: str(values["status"]),
          priority: str(values["priority"]),
          labels: csv(list(values["label"])),
          assignee: str(values["assignee"]),
          due: str(values["due"]),
          parent: str(values["parent"]),
          top: values["top"] === true,
        },
        ctx.env["BILINEAR_TODAY"] || todayIso(),
      );
      out(values["json"] ? JSON.stringify({ id, path: native(notePath(t, id, false)) }) : id);
      return EXIT_OK;
    },
  },

  list: {
    args: "[--status S]... [--label L]... [--assignee A]... [--priority P]... [--archived | --all] [--json]",
    help: "list issues in index order",
    options: {
      status: { type: "string", multiple: true },
      label: { type: "string", multiple: true },
      assignee: { type: "string", multiple: true },
      priority: { type: "string", multiple: true },
      archived: { type: "boolean" },
      all: { type: "boolean" },
      json: { type: "boolean" },
    },
    takes: [0, 0],
    reads: () => true,
    async run({ values, out, tracker }) {
      const t = await tracker();
      const { records, progress } = await locked(t, async () => allRecords(t, await readIndex(t)));
      const statuses = csv(list(values["status"]));
      const labels = csv(list(values["label"]));
      const assignees = csv(list(values["assignee"]));
      const priorities = csv(list(values["priority"]));
      const all = values["all"] === true;
      const shown = records.filter(
        (r) =>
          (all || r.archived === (values["archived"] === true)) &&
          (!statuses.length || (r.status !== null && statuses.includes(r.status))) &&
          (!labels.length || labels.some((l) => r.labels.includes(l))) &&
          (!assignees.length || (r.assignee !== null && assignees.includes(r.assignee))) &&
          (!priorities.length || priorities.includes(r.priority)),
      );
      if (values["json"]) {
        out(json(shown.map((r) => toJson(r, progress.get(r.id) ?? null))));
        return EXIT_OK;
      }
      const wId = width(shown.map((r) => r.id));
      const wStatus = width(shown.map((r) => r.status ?? "-"));
      const wPriority = width(shown.map((r) => r.priority));
      for (const r of shown) {
        const p = progress.get(r.id);
        let extra = "";
        if (r.missing) extra += "  (note missing)";
        if (p) extra += `  [${p.done}/${p.total}]`;
        if (r.assignee) extra += `  @${r.assignee}`;
        if (r.labels.length) extra += `  ${r.labels.map((l) => `#${l}`).join(" ")}`;
        if (r.archived && all) extra += "  [archived]";
        out(`${pad(r.id, wId)}  ${pad(r.status ?? "-", wStatus)}  ${pad(r.priority, wPriority)}  ${r.title}${extra}`);
      }
      return EXIT_OK;
    },
  },

  show: {
    args: "<id> [--json]",
    help: "print an issue's properties and body",
    options: { json: { type: "boolean" } },
    takes: [1, 1],
    reads: () => true,
    async run({ values, positionals, out, tracker }) {
      const t = await tracker();
      const id = positionals[0];
      const { records, progress, doc, path } = await locked(t, async () => {
        const idx = await readIndex(t);
        const item = requireItem(idx, id);
        const path = await resolveNote(t, id, item.archived);
        const text = path === null ? null : await t.io.read(path);
        return { ...(await allRecords(t, idx)), doc: text === null ? null : new Doc(text), path: text === null ? null : path };
      });
      const rec = records.find((r) => r.id === id)!;
      const p = progress.get(id) ?? null;
      if (values["json"]) {
        const properties: Record<string, Value> = {};
        for (const key of doc?.keys() ?? []) properties[key] = doc!.get(key);
        out(json({ ...toJson(rec, p), path: path === null ? null : native(path), properties, body: doc?.body ?? "" }));
        return EXIT_OK;
      }
      out(`${rec.id}  ${rec.title}`);
      if (doc === null) {
        out("(note missing)");
        return EXIT_OK;
      }
      for (const key of doc.keys()) {
        if (key === "title") continue;
        const value = doc.get(key);
        out(`${pad(`${key}:`, 12)} ${Array.isArray(value) ? value.join(", ") : (value ?? "")}`);
      }
      if (rec.archived) out(`${pad("archived:", 12)} yes`);
      if (p) {
        const linked = p.issues.map((other) => `${other} ${records.find((r) => r.id === other)?.status ?? "note missing"}`).join(", ");
        out(`${pad("progress:", 12)} ${p.done}/${p.total}  (${linked})`);
      }
      const body = doc.body.replace(/^[\r\n]+|[\r\n]+$/g, "");
      if (body) out(`\n${body}`);
      return EXIT_OK;
    },
  },

  set: {
    args: "<id> <key=value>...",
    help: "change properties: key=value, list+=value, list-=value, key= to remove",
    takes: [2, Infinity],
    async run({ positionals, tracker }) {
      const [id, ...assignments] = positionals;
      const edits = assignments.map((a) => {
        const m = ASSIGN_RE.exec(a);
        if (!m) throw new OpError(`'${a}' is not of the form key=value`);
        return { key: m[1], op: m[2], raw: m[3].trim() };
      });
      await setProps(await tracker(), id, (doc) => {
        const props: PropEdits = {};
        const current = (key: string): Value => (key in props ? props[key] : doc.get(key));
        for (const { key, op, raw } of edits) {
          if (!LIST_KEYS.includes(key) && op === "=" && !Array.isArray(current(key))) {
            props[key] = raw;
            continue;
          }
          if (key === "parent") throw new OpError("parent takes one issue: parent=ID");
          let given = csv([raw]);
          if (key === "blocked-by") {
            given = given.map((v) => {
              const target = linkId(v);
              if (target === null) throw new OpError(`'${v}' is not an issue ID`);
              return makeLink(target);
            });
          }
          const now = current(key);
          let value = op === "=" ? given : now === null ? [] : Array.isArray(now) ? [...now] : [now];
          if (op === "+=") value.push(...given.filter((v) => !value.includes(v)));
          if (op === "-=") value = value.filter((v) => !given.includes(v));
          props[key] = value;
        }
        return props;
      });
      return EXIT_OK;
    },
  },

  comment: {
    args: "<id> <text>",
    help: "append a comment",
    takes: [2, 2],
    async run({ ctx, values, positionals, tracker }) {
      const author = str(values["author"]) || ctx.env["BILINEAR_USER"] || ctx.env["USER"] || ctx.env["USERNAME"] || "unknown";
      await commentIssue(await tracker(), positionals[0], positionals[1], author, ctx.env["BILINEAR_TODAY"] || todayIso());
      return EXIT_OK;
    },
  },

  move: {
    args: "<id> (--before ID | --after ID | --top | --bottom)",
    help: "reorder an issue",
    options: { before: { type: "string" }, after: { type: "string" }, top: { type: "boolean" }, bottom: { type: "boolean" } },
    takes: [1, 1],
    async run({ values, positionals, tracker }) {
      const given = (["before", "after", "top", "bottom"] as const).filter((k) => values[k] !== undefined);
      if (given.length !== 1) throw new UsageError("give one of --before, --after, --top, --bottom");
      await moveIssue(await tracker(), positionals[0], given[0], str(values[given[0]]));
      return EXIT_OK;
    },
  },

  archive: {
    args: "(<id>... | --closed)",
    help: "archive the named issues, or all closed ones",
    options: { closed: { type: "boolean" } },
    takes: [0, Infinity],
    async run({ values, positionals, out, tracker }) {
      if (values["closed"] && positionals.length) throw new OpError("give either IDs or --closed");
      if (!values["closed"] && !positionals.length) throw new OpError("give one or more IDs, or --closed");
      const t = await tracker();
      for (const id of values["closed"] ? await archiveClosed(t) : await archiveIssues(t, positionals)) out(id);
      return EXIT_OK;
    },
  },

  unarchive: {
    args: "<id>...",
    help: "restore archived issues",
    takes: [1, Infinity],
    async run({ positionals, out, tracker }) {
      for (const id of await unarchiveIssues(await tracker(), positionals)) out(id);
      return EXIT_OK;
    },
  },

  rm: {
    args: "<id> [--force]",
    help: "remove an issue; its note goes to the vault's .trash/",
    options: { force: { type: "boolean" } },
    takes: [1, 1],
    async run({ positionals, tracker }) {
      await deleteIssue(await tracker(), positionals[0]);
      return EXIT_OK;
    },
  },

  adopt: {
    args: "<id>",
    help: "add an index line for an orphan note",
    takes: [1, 1],
    async run({ positionals, tracker }) {
      await adoptIssue(await tracker(), positionals[0]);
      return EXIT_OK;
    },
  },

  label: {
    args: "[<name> [--color COLOR]] [--json]",
    help: "list the labels, or add one and set its colour",
    options: { color: { type: "string" }, json: { type: "boolean" } },
    takes: [0, 1],
    reads: (_values, positionals) => positionals.length === 0,
    async run({ values, positionals, out, tracker }) {
      const t = await tracker();
      const color = str(values["color"]);
      if (positionals.length) {
        await setLabel(t, positionals[0], styleValue(color));
        return EXIT_OK;
      }
      if (color !== undefined) throw new OpError("--color needs a label name");
      const idx = await locked(t, () => readIndex(t));
      const colors = idx.labelColors;
      const names = [...idx.labels, ...Object.keys(colors).filter((n) => !idx.labels.includes(n))];
      if (values["json"]) {
        out(json(names.map((name) => ({ name, color: colors[name] ?? null }))));
        return EXIT_OK;
      }
      const w = width(names);
      for (const name of names) out(name in colors ? `${pad(name, w)}  ${colors[name]}` : name);
      return EXIT_OK;
    },
  },

  state: {
    args: "[<name> [--icon ICON] [--color COLOR]] [--json]",
    help: "list the states, or set a state's icon and colour",
    options: { icon: { type: "string" }, color: { type: "string" }, json: { type: "boolean" } },
    takes: [0, 1],
    reads: (_values, positionals) => positionals.length === 0,
    async run({ values, positionals, out, tracker }) {
      const t = await tracker();
      const icon = str(values["icon"]);
      const color = str(values["color"]);
      if (positionals.length) {
        if (icon === undefined && color === undefined) {
          const idx = await locked(t, () => readIndex(t));
          if (!idx.states.includes(positionals[0])) throw new OpError(`unknown state '${positionals[0]}' (states: ${idx.states.join(", ")})`);
          throw new OpError("give --icon, --color or both");
        }
        await setStateStyle(t, positionals[0], { icon: styleValue(icon), color: styleValue(color) });
        return EXIT_OK;
      }
      if (icon !== undefined || color !== undefined) throw new OpError("--icon and --color need a state name");
      const idx = await locked(t, () => readIndex(t));
      const rows = idx.states.map((name) => ({ name, icon: idx.stateIcons[name] ?? null, color: idx.stateColors[name] ?? null, closed: idx.closedStates.includes(name) }));
      if (values["json"]) {
        out(json(rows));
        return EXIT_OK;
      }
      const w = width(rows.map((r) => r.name));
      for (const r of rows) {
        const parts = [r.icon ? `icon=${r.icon}` : "", r.color ? `color=${r.color}` : "", r.closed ? "(closed)" : ""].filter((p) => p);
        out(`${pad(r.name, w)}  ${parts.join("  ")}`.trimEnd());
      }
      return EXIT_OK;
    },
  },

  lint: {
    args: "[--fix] [--json]",
    help: "check consistency; --fix repairs what is safe to repair",
    options: { fix: { type: "boolean" }, json: { type: "boolean" } },
    takes: [0, 0],
    reads: (values) => values["fix"] !== true,
    async run({ values, out, tracker }) {
      const t = await tracker();
      const problems = await lint(t, values["fix"] === true);
      if (values["json"]) {
        out(json({ problems }));
      } else {
        const index = t.indexPath.slice(t.indexPath.lastIndexOf("/") + 1);
        for (const p of problems) out(`${p.fixed ? "fixed" : p.severity}: ${p.id ?? index}: ${p.message} [${p.code}]`);
        if (!problems.length) out("no problems found");
      }
      return problems.some((p) => !p.fixed) ? EXIT_LINT : EXIT_OK;
    },
  },
};

const COMMON = "[--tracker PATH] [--author NAME]";

function usage(name?: string): string {
  if (name) return `usage: bilinear ${COMMON} ${name} ${COMMANDS[name].args}\n`;
  return `usage: bilinear ${COMMON} <command> [options]\n`;
}

function help(name?: string): string {
  const options =
    "options:\n" +
    "  --tracker PATH  tracker folder or index note (default: $BILINEAR_TRACKER, then search upward)\n" +
    "  --author NAME   author for comments (default: $BILINEAR_USER, then $USER)\n";
  if (name) {
    let text = `${usage(name)}\n${COMMANDS[name].help}\n\n${options}`;
    if (name === "label" || name === "state") {
      text += `\nCOLOR is one of ${COLOR_NAMES.join(", ")}, #rgb or #rrggbb; 'none' clears it.\n`;
    }
    if (name === "state") text += `ICON is one of ${STATE_SHAPES.join(", ")}, or a Lucide icon name; 'none' clears it.\n`;
    return text;
  }
  const w = width(Object.keys(COMMANDS));
  const commands = Object.entries(COMMANDS).map(([n, c]) => `  ${pad(n, w)}  ${c.help}\n`);
  return `${usage()}\nIssue tracker stored as Markdown notes in an Obsidian vault.\n\ncommands:\n${commands.join("")}\n${options}  --version       print the version\n  -h, --help      this text, or a command's with <command> --help\n`;
}

/** The tracker a command works on: the one named, or the one around the working directory. */
async function openTracker(io: NodeIO, ctx: Context, given: string | undefined): Promise<Tracker> {
  const warn = (message: string) => ctx.stderr(`bilinear: ${message}\n`);
  const at = (index: string): Tracker => {
    const real = slashed(fs.realpathSync(native(index)));
    return { io, dir: real.slice(0, real.lastIndexOf("/")), indexPath: real, warn };
  };
  if (given) {
    const path = nodePath.resolve(ctx.cwd, given);
    if (fs.statSync(path, { throwIfNoEntry: false })?.isFile()) {
      if (new Doc((await io.read(path)) ?? "").getStr("bilinear") !== "tracker") throw new OpError(`${given} is not a tracker index note`);
      return at(slashed(path));
    }
    const found = await indexNotes(io, slashed(path));
    if (!found.length) throw new OpError(`no tracker index note in ${given}`);
    return at(found[0]);
  }
  for (let dir = fs.realpathSync(ctx.cwd); ; dir = nodePath.dirname(dir)) {
    const found = await indexNotes(io, slashed(dir));
    if (found.length) return at(found[0]);
    if (dir === nodePath.dirname(dir)) break;
  }
  throw new OpError("no tracker found; use --tracker, BILINEAR_TRACKER or run inside a tracker folder");
}

/** Run one command line. Returns the exit code. */
export async function main(argv: string[], ctx: Context): Promise<number> {
  const fail = (message: string, exit: number): number => {
    ctx.stderr(`bilinear: ${message}\n`);
    return exit;
  };

  // The command is the first argument that is neither an option nor the
  // value of --tracker or --author, which may come before it.
  let at = 0;
  while (at < argv.length && argv[at].startsWith("-")) at += argv[at] === "--tracker" || argv[at] === "--author" ? 2 : 1;
  const name = argv[at];
  if (name === undefined) {
    if (argv.includes("--version")) {
      ctx.stdout(`bilinear ${version}\n`);
      return EXIT_OK;
    }
    if (argv.includes("--help") || argv.includes("-h")) {
      ctx.stdout(help());
      return EXIT_OK;
    }
    ctx.stderr(help());
    return EXIT_USAGE;
  }
  if (!Object.hasOwn(COMMANDS, name)) {
    ctx.stderr(usage());
    return fail(`error: unknown command '${name}' (one of: ${Object.keys(COMMANDS).join(", ")})`, EXIT_USAGE);
  }
  const command = COMMANDS[name];

  const lines: string[] = [];
  try {
    let parsed: { values: Values; positionals: string[] };
    try {
      parsed = parseArgs({
        args: [...argv.slice(0, at), ...argv.slice(at + 1)],
        options: { tracker: { type: "string" }, author: { type: "string" }, help: { type: "boolean", short: "h" }, ...command.options },
        allowPositionals: true,
        strict: true,
      }) as { values: Values; positionals: string[] };
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message.split("\n")[0] : String(e));
    }
    const { values, positionals } = parsed;
    if (values["help"]) {
      ctx.stdout(help(name));
      return EXIT_OK;
    }
    const [min, max] = command.takes;
    if (positionals.length < min) throw new UsageError("too few arguments");
    if (positionals.length > max) throw new UsageError(`unexpected argument '${positionals[max]}'`);

    const seconds = Number(ctx.env["BILINEAR_LOCK_TIMEOUT"] ?? "");
    const lockTimeout = ctx.env["BILINEAR_LOCK_TIMEOUT"] && Number.isFinite(seconds) ? seconds * 1000 : LOCK_TIMES.timeout;
    const io = new NodeIO({ lockTimeout, readOnly: command.reads?.(values, positionals) ?? false, force: values["force"] === true });
    let tracker: Tracker | null = null;
    try {
      // Output is collected and written when the command is done, after the
      // lock is released: a full pipe must not keep the tracker locked.
      return await command.run({
        ctx,
        values,
        positionals,
        io,
        out: (line) => lines.push(line),
        tracker: async () => (tracker ??= await openTracker(io, ctx, str(values["tracker"]) || ctx.env["BILINEAR_TRACKER"])),
      });
    } catch (e) {
      if (e instanceof LockTimeout) {
        const dir = (tracker as Tracker | null)?.dir ?? "the tracker";
        return fail(`${native(dir)} is locked by another bilinear process or by Obsidian; gave up after ${lockTimeout / 1000}s`, EXIT_CONFLICT);
      }
      throw e;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.stderr(usage(name));
      return fail(`error: ${e.message}`, EXIT_USAGE);
    }
    if (e instanceof OpError) return fail(e.message, EXIT_USAGE);
    if (e instanceof ConflictError) return fail(e.message, EXIT_CONFLICT);
    const { code, path } = e as { code?: string; path?: string };
    // A file that was there when the command looked is gone: Obsidian or a
    // sync tool moved or deleted it meanwhile.
    if (code === "ENOENT") return fail(`${path} was moved or deleted while the command ran; run the command again`, EXIT_CONFLICT);
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return fail(`${path}: permission denied`, EXIT_USAGE);
    throw e;
  } finally {
    if (lines.length) ctx.stdout(`${lines.join("\n")}\n`);
  }
}
