// bilinear: command-line client for Bilinear trackers.
//
// A tracker is Markdown notes: an index note (frontmatter `bilinear: tracker`)
// and, beside it, one note per issue in `issues/` and `archive/`, which the
// trackers of a folder share. The format is specified in spec/FORMAT.md. The commands here are thin: the
// operations themselves are the plugin's (plugin/src/ops), run on Node's fs.

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { COLOR_NAMES, ENTRY_STATUSES, LINK_LIST_KEYS, LIST_KEYS, STATE_SHAPES, TYPE_LETTERS, linkId, makeLink, todayIso, ID_RE, PREFIX_RE, cleanTitle, type EntryType } from "../../plugin/src/format/ids";
import type { IssueRecord } from "../../plugin/src/format/record";
import { Doc, type Value } from "../../plugin/src/format/yaml";
import { OpError, type Tracker } from "../../plugin/src/ops/io";
import { adoptIssue, archiveClosed, archiveIssues, commentIssue, createIssue, createTracker, deleteIssue, moveIssue, setLabel, setProps, setStateStyle, setTriageState, unarchiveIssues, unrelate, type PropEdits } from "../../plugin/src/ops/issues";
import { buildContextView, getContext, listContext, recordContext, type RecordInput } from "../../plugin/src/ops/context";
import { parseContext, stripEntries, type ContextEntry } from "../../plugin/src/format/context";
import { parseComments } from "../../plugin/src/format/issue-note";
import { lint } from "../../plugin/src/ops/lint";
import { LOCK_TIMES, LockTimeout } from "../../plugin/src/ops/lock-file";
import { allRecords, linkTargets, locked, notePath, readIndex, requireItem, resolveNote } from "../../plugin/src/ops/tracker";
import type { Progress, Relations } from "../../plugin/src/store/query";
import { version } from "../package.json";
import { SKILL, SetupError, blockSkill, blockTracker, checkpointText, exclude, excludePatterns, hasFollowups, instructions, instructionsBlock, isTracked, plan, realPath, repositoryRoot, shellWord, trackerPath, withInstructions, writeFile } from "./agent";
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
  /** All of the standard input, as text. */
  stdin(): Promise<string>;
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
  /** The command can run without a board file, because it may not need a tracker. */
  boardless?: true;
  /** `init` makes the tracker; every other command runs in one. */
  run(inv: Invocation): Promise<number>;
}

interface Invocation {
  ctx: Context;
  /** The board file as given, the tracker's index note. Fails for a boardless command run without one. */
  board(): string;
  values: Values;
  positionals: string[];
  /** Print a line. */
  out(line: string): void;
  io: NodeIO;
  tracker(): Promise<Tracker>;
  /** Open the tracker whose index note is at a path. */
  open(given: string): Promise<Tracker>;
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
function toJson(r: IssueRecord, progress: Progress | null, rel: Relations | undefined): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    labels: r.labels,
    assignee: r.assignee,
    due: r.due,
    "blocked-by": r.blockedBy,
    related: rel?.related ?? [],
    blocks: rel?.blocks ?? [],
    blocked: rel?.blocked ?? false,
    created: r.created,
    links: r.links,
    progress,
    archived: r.archived,
    missing: r.missing,
  };
}

/** "none" and "auto" clear a colour or an icon; no flag leaves it alone. */
function styleValue(given: string | undefined): string | null | undefined {
  if (given === undefined) return undefined;
  return ["none", "auto"].includes(given.toLowerCase()) ? null : given;
}

const ASSIGN_RE = /^([^=+\-\s][^=\s]*?)(\+=|-=|=)([\s\S]*)$/;

const ENTRY_TYPES = Object.values(TYPE_LETTERS) as EntryType[];
const REJECTED_KEYS = ["attempted", "promising", "happened", "failed", "applies"] as const;
const TEXT_KEYS = ["content", "rationale", "alternatives"] as const;
/** The flags of `context record` that describe one entry. */
const ENTRY_FLAGS = ["type", "subject", "content", "rationale", "alternatives", "evidence", "supersedes", "new", ...REJECTED_KEYS] as const;

/** A type given as its name or its letter, in any letter case; null if it is neither. */
function entryType(given: string): EntryType | null {
  const g = given.trim().toLowerCase();
  const byLetter = (TYPE_LETTERS as Record<string, EntryType>)[g.toUpperCase()];
  if (g.length === 1) return byLetter ?? null;
  return ENTRY_TYPES.find((t) => t === g) ?? null;
}

const typeList = (): string => Object.entries(TYPE_LETTERS).map(([letter, name]) => `${name} (${letter})`).join(", ");

/** Check the JSON of `--file` and turn it into the entries to record. Each problem names the item (from 1) and the key. */
function parseEntries(text: string, source: string): RecordInput[] {
  if (!text.trim()) throw new OpError(`${source} is empty; give one JSON object or an array of objects`);
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new OpError(`${source} is not valid JSON (${e instanceof Error ? e.message : String(e)}); give one object or an array of objects`);
  }
  const items = Array.isArray(data) ? data : [data];
  if (items.length === 0) throw new OpError(`${source} has no entries; give one object or an array of objects`);
  const known = ["type", "subject", ...TEXT_KEYS, "evidence", "supersedes", "new", "rejected", ...REJECTED_KEYS];
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  return items.map((item, i): RecordInput => {
    const at = `item ${i + 1}`;
    if (!isObject(item)) throw new OpError(`${at}: must be an object with the keys ${known.join(", ")}`);
    for (const key of Object.keys(item)) {
      if (!known.includes(key)) throw new OpError(`${at}: unknown key '${key}'; the keys are ${known.join(", ")}`);
    }
    const string = (key: string, value: unknown, where = at): string => {
      if (typeof value !== "string") throw new OpError(`${where}: '${key}' must be a string`);
      return value;
    };
    if (item["type"] === undefined) throw new OpError(`${at}: 'type' is required; it is one of ${typeList()}`);
    const type = entryType(string("type", item["type"]));
    if (type === null) throw new OpError(`${at}: '${String(item["type"])}' is not a type in key 'type'; use one of ${typeList()}`);
    if (item["subject"] === undefined) throw new OpError(`${at}: 'subject' is required`);
    const input: RecordInput = { type, subject: string("subject", item["subject"]) };
    for (const key of TEXT_KEYS) if (item[key] !== undefined) input[key] = string(key, item[key]);
    if (item["evidence"] !== undefined) {
      const v = item["evidence"];
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new OpError(`${at}: 'evidence' must be an array of strings of the form kind:value`);
      input.evidence = v as string[];
    }
    if (item["supersedes"] !== undefined) {
      const v = item["supersedes"];
      if (typeof v === "string") input.supersedes = [v];
      else if (Array.isArray(v) && v.every((x) => typeof x === "string")) input.supersedes = v as string[];
      else throw new OpError(`${at}: 'supersedes' must be a string or an array of strings`);
    }
    if (item["new"] !== undefined) {
      if (typeof item["new"] !== "boolean") throw new OpError(`${at}: 'new' must be true or false`);
      input.isNew = item["new"];
    }
    const given = item["rejected"];
    if (given !== undefined && !isObject(given)) throw new OpError(`${at}: 'rejected' must be an object with the keys ${REJECTED_KEYS.join(", ")}`);
    const rejected: Record<string, string> = {};
    for (const key of Object.keys(given ?? {})) {
      if (!(REJECTED_KEYS as readonly string[]).includes(key)) throw new OpError(`${at}: unknown key '${key}' in 'rejected'; the keys are ${REJECTED_KEYS.join(", ")}`);
      rejected[key] = string(key, (given as Record<string, unknown>)[key], `${at}: 'rejected'`);
    }
    for (const key of REJECTED_KEYS) {
      if (item[key] === undefined) continue;
      if (key in rejected) throw new OpError(`${at}: key '${key}' is given twice, at the top level and in 'rejected'`);
      rejected[key] = string(key, item[key]);
    }
    if (Object.keys(rejected).length || given !== undefined) input.rejected = rejected;
    return input;
  });
}

/** The one entry that the flags of `context record` describe. */
function flagEntry(values: Values): RecordInput {
  const type = str(values["type"]);
  const subject = str(values["subject"]);
  if (type === undefined) throw new UsageError(`--type is required (one of ${typeList()}), or give --file`);
  if (subject === undefined) throw new UsageError("--subject is required, or give --file");
  const kind = entryType(type);
  if (kind === null) throw new UsageError(`'${type}' is not a type; use one of ${typeList()}`);
  const input: RecordInput = { type: kind, subject };
  for (const key of TEXT_KEYS) if (str(values[key]) !== undefined) input[key] = str(values[key]);
  if (values["evidence"] !== undefined) input.evidence = list(values["evidence"]);
  if (values["supersedes"] !== undefined) input.supersedes = csv(list(values["supersedes"]));
  if (values["new"]) input.isNew = true;
  const given = REJECTED_KEYS.filter((k) => str(values[k]) !== undefined);
  if (kind !== "rejected") {
    if (given.length) throw new UsageError(`--${given[0]} is only for --type rejected`);
  } else {
    const missing = (["attempted", "failed", "applies"] as const).filter((k) => !str(values[k])?.trim());
    if (missing.length) throw new UsageError(`--type rejected needs ${missing.map((k) => `--${k}`).join(", ")}`);
    input.rejected = Object.fromEntries(given.map((k) => [k, str(values[k])]));
  }
  return input;
}

/** A labelled value of an entry, without the line break that puts it on the lines under its label. */
const labelled = (v: string): string => v.replace(/^\n/, "");

/** An entry with the key names and order of the CLI's JSON; `id` is its full ID. */
function entryJson(id: string, e: ContextEntry): Record<string, unknown> {
  const note = id.slice(0, id.indexOf("/"));
  return {
    id,
    type: e.type,
    number: e.number,
    subject: e.subject,
    status: e.status,
    author: e.author,
    created: e.created,
    updated: e.updated,
    content: e.content,
    rationale: labelled(e.rationale),
    alternatives: labelled(e.alternatives),
    evidence: e.evidence,
    supersedes: e.supersedes.map((l) => `${note}/${l}`),
    supersededBy: e.supersededBy === null ? null : `${note}/${e.supersededBy}`,
    rejected: e.rejected ? Object.fromEntries(REJECTED_KEYS.map((k) => [k, labelled(e.rejected![k])])) : null,
  };
}

/** The flags that each subcommand of `context` uses, besides --author; every other flag of `context` is refused. */
const CONTEXT_FLAGS: Record<string, readonly string[]> = {
  record: [...ENTRY_FLAGS, "file", "json"],
  get: ["json"],
  list: ["type", "status", "all", "json"],
  checkpoint: [],
};

/** The target of a context command: an issue ID (BL-9) or the prefix of the tracker (BL), in upper case. */
function contextTarget(given: string): string {
  const target = cleanTitle(given).toUpperCase();
  if (!ID_RE.test(target) && !PREFIX_RE.test(target)) throw new UsageError(`'${given}' is not an issue ID such as BL-9 or a tracker prefix such as BL`);
  return target;
}

const LIST_LINE_MAX = 220;

/** The line of `context list` for an entry: full ID, status, date, subject, and for a rejected entry why it failed. */
function listLine(id: string, e: ContextEntry): string {
  const failed = e.rejected ? labelled(e.rejected.failed).split("\n")[0].trim() : "";
  const line = `${id}  ${e.status}  ${e.updated ?? e.created ?? "-"}  ${e.subject}${failed ? ` - failed: ${failed}` : ""}`;
  const chars = [...line];
  return chars.length > LIST_LINE_MAX ? `${chars.slice(0, LIST_LINE_MAX - 1).join("")}…` : line;
}

const COMMANDS: Record<string, Command> = {
  init: {
    args: "--prefix PREFIX",
    help: "create a tracker: the board file is its index note, with issues/ and archive/ beside it, which the trackers of a folder share",
    options: { prefix: { type: "string" } },
    takes: [0, 0],
    async run({ ctx, board, values, out, io }) {
      const prefix = str(values["prefix"]);
      if (prefix === undefined) throw new UsageError("--prefix is required");
      const note = board();
      await createTracker(io, slashed(nodePath.resolve(ctx.cwd, note)), prefix);
      out(note);
      return EXIT_OK;
    },
  },

  new: {
    args: "<title> [--status S] [--priority P] [--label L]... [--assignee A] [--due YYYY-MM-DD] [--blocked-by ID]... [--related-to ID]... [--description TEXT] [--top] [--json]",
    help: "create an issue and print its ID",
    options: {
      status: { type: "string" },
      priority: { type: "string" },
      label: { type: "string", multiple: true },
      assignee: { type: "string" },
      due: { type: "string" },
      "blocked-by": { type: "string", multiple: true },
      "related-to": { type: "string", multiple: true },
      description: { type: "string" },
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
          blockedBy: csv(list(values["blocked-by"])),
          relatedTo: csv(list(values["related-to"])),
          description: str(values["description"]),
          top: values["top"] === true,
        },
        ctx.env["BILINEAR_TODAY"] || todayIso(),
      );
      out(values["json"] ? JSON.stringify({ id, path: native(notePath(t, id, false)) }) : id);
      return EXIT_OK;
    },
  },

  list: {
    args: "[--status S]... [--label L]... [--assignee A]... [--priority P]... [--blocked] [--blocked-by ID] [--related-to ID] [--archived | --all] [--json]",
    help: "list issues in index order",
    options: {
      status: { type: "string", multiple: true },
      label: { type: "string", multiple: true },
      assignee: { type: "string", multiple: true },
      priority: { type: "string", multiple: true },
      blocked: { type: "boolean" },
      "blocked-by": { type: "string" },
      "related-to": { type: "string" },
      archived: { type: "boolean" },
      all: { type: "boolean" },
      json: { type: "boolean" },
    },
    takes: [0, 0],
    reads: () => true,
    async run({ values, out, tracker }) {
      const t = await tracker();
      const issue = (key: string): string | undefined => {
        const given = str(values[key]);
        return given === undefined ? undefined : (linkId(given) ?? given);
      };
      const blockedBy = issue("blocked-by");
      const relatedTo = issue("related-to");
      const { records, progress, relations } = await locked(t, async () => {
        const idx = await readIndex(t);
        // The issue may be one of another tracker in the folder.
        const listed = await linkTargets(t, idx);
        for (const id of [blockedBy, relatedTo]) if (id !== undefined && !listed(id)) requireItem(idx, id);
        return allRecords(t, idx);
      });
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
          (!priorities.length || priorities.includes(r.priority)) &&
          (values["blocked"] !== true || relations.get(r.id)?.blocked === true) &&
          (blockedBy === undefined || r.blockedBy.includes(blockedBy)) &&
          (relatedTo === undefined || relations.get(r.id)?.related.includes(relatedTo) === true),
      );
      if (values["json"]) {
        out(json(shown.map((r) => toJson(r, progress.get(r.id) ?? null, relations.get(r.id)))));
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
      const { records, foreign, progress, relations, doc, path, text, idx } = await locked(t, async () => {
        const idx = await readIndex(t);
        const item = requireItem(idx, id);
        const path = await resolveNote(t, id, item.archived);
        const text = path === null ? null : await t.io.read(path);
        return { ...(await allRecords(t, idx)), doc: text === null ? null : new Doc(text), path: text === null ? null : path, text, idx };
      });
      const rec = records.find((r) => r.id === id)!;
      const view = buildContextView({ issueId: id, title: rec.title, noteText: text, indexText: idx.doc.text(), prefix: idx.prefix });
      const p = progress.get(id) ?? null;
      // A linked issue may belong to another tracker of the folder.
      const status = (other: string): string => records.find((r) => r.id === other)?.status ?? foreign.find((r) => r.id === other)?.status ?? "note missing";
      if (values["json"]) {
        const properties: Record<string, Value> = {};
        for (const key of doc?.keys() ?? []) properties[key] = doc!.get(key);
        const context = { l0: view.text, chars: view.chars, cap: view.cap, counts: view.counts, shown: view.shown, omitted: view.omitted };
        out(json({ ...toJson(rec, p, relations.get(id)), path: path === null ? null : native(path), properties, body: doc?.body ?? "", context }));
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
        const linked = p.issues.map((other) => `${other} ${status(other)}`).join(", ");
        out(`${pad("progress:", 12)} ${p.done}/${p.total}  (${linked})`);
      }
      const states = (ids: string[]) => ids.map((other) => `${other} ${status(other)}`).join(", ");
      const rel = relations.get(id);
      if (rel?.blocks.length) out(`${pad("blocks:", 12)} ${states(rel.blocks)}`);
      if (rel?.related.length) out(`${pad("related:", 12)} ${states(rel.related)}`);
      // With entries, the L0 text takes the place of the `## Context log` section and comes before the description.
      const l0 = view.text !== "";
      if (l0) out(`\n${view.text.replace(/\n+$/, "")}`);
      const body = (l0 ? new Doc(stripEntries(text!)).body : doc.body).replace(/^[\r\n]+|[\r\n]+$/g, "");
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
      const t = await tracker();
      // The callback can run more than once, so each run sets the flag again.
      let remind = false;
      await setProps(t, id, (doc) => {
        const props: PropEdits = {};
        const current = (key: string): Value => (key in props ? props[key] : doc.get(key));
        for (const { key, op, raw } of edits) {
          if (!LIST_KEYS.includes(key) && op === "=" && !Array.isArray(current(key))) {
            props[key] = raw;
            continue;
          }
          let given = csv([raw]);
          if (LINK_LIST_KEYS.includes(key)) {
            given = given.map((v) => {
              const target = linkId(v);
              if (target === null) throw new OpError(`'${v}' is not an issue ID`);
              return makeLink(target);
            });
          }
          const now = current(key);
          // Links are the same when they name the same issue, however they are written.
          const same = LINK_LIST_KEYS.includes(key) ? (a: string, b: string) => linkId(a) === linkId(b) : (a: string, b: string) => a === b;
          let value = op === "=" ? given : now === null ? [] : Array.isArray(now) ? [...now] : [now];
          if (op === "+=") value.push(...given.filter((v) => !value.some((h) => same(h, v))));
          if (op === "-=") value = value.filter((v) => !given.some((g) => same(v, g)));
          props[key] = value;
        }
        const text = doc.text();
        remind = typeof props["status"] === "string" && props["status"] !== doc.get("status") && (parseComments(text).length > 0 || parseContext(text).entries.length > 0);
        return props;
      });
      // The relation may be in the other issue's note only: end it there too.
      for (const { key, op, raw } of edits) {
        if (key !== "related-to" || op !== "-=") continue;
        for (const other of csv([raw])) await unrelate(t, id, linkId(other)!);
      }
      // On stderr, with the other warnings, so that a script that reads stdout sees no change.
      if (remind) t.warn?.(`${id}: status changed; record what the next session needs: context checkpoint ${id}`);
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

  context: {
    args: "record <ID|PREFIX> (--type T --subject TEXT [...] | --file <path|->) [--json] | get <FULLID>... [--json] | list <ID|PREFIX> [--type T] [--status S] [--all] [--json] | checkpoint <ID>",
    help: "record context entries (decisions, findings, ...) in an issue or the tracker, read them, or list them",
    options: {
      json: { type: "boolean" },
      all: { type: "boolean" },
      status: { type: "string" },
      file: { type: "string" },
      type: { type: "string" },
      subject: { type: "string" },
      content: { type: "string" },
      rationale: { type: "string" },
      alternatives: { type: "string" },
      evidence: { type: "string", multiple: true },
      supersedes: { type: "string", multiple: true },
      new: { type: "boolean" },
      attempted: { type: "string" },
      promising: { type: "string" },
      happened: { type: "string" },
      failed: { type: "string" },
      applies: { type: "string" },
    },
    takes: [0, Infinity],
    reads: (_values, positionals) => ["get", "list", "checkpoint"].includes(positionals[0]),
    async run({ ctx, values, positionals, out, tracker }) {
      const sub = positionals[0];
      const used = sub !== undefined && Object.hasOwn(CONTEXT_FLAGS, sub) ? CONTEXT_FLAGS[sub] : undefined;
      if (used) {
        for (const flag of Object.keys(values)) {
          if (flag === "author" || flag === "help" || used.includes(flag)) continue;
          if (sub === "record" && (flag === "status" || flag === "all")) {
            throw new UsageError(`--${flag} belongs to context list; a new entry is always active, so use --supersedes ID to end an entry`);
          }
          throw new UsageError(`--${flag} is not a flag of context ${sub}${used.length ? `; it takes ${used.map((f) => `--${f}`).join(", ")}` : "; it takes no flag"}`);
        }
      }
      if (sub === "record") {
        if (positionals.length !== 2) throw new UsageError("record needs one target: an issue ID such as BL-9, or the prefix of the tracker such as BL");
        contextTarget(positionals[1]);
        const file = str(values["file"]);
        const flags = ENTRY_FLAGS.filter((k) => values[k] !== undefined);
        if (file !== undefined && flags.length) throw new UsageError(`--file cannot go with --${flags[0]}; put the entry in the file, or drop --file`);
        let inputs: RecordInput[];
        if (file !== undefined) {
          let text: string;
          if (file === "-") text = await ctx.stdin();
          else {
            try {
              text = fs.readFileSync(nodePath.resolve(ctx.cwd, file), "utf8");
            } catch {
              throw new OpError(`cannot read the file '${file}'; give the path of a JSON file, or - for the standard input`);
            }
          }
          inputs = parseEntries(text, file === "-" ? "the standard input" : `the file '${file}'`);
        } else {
          inputs = [flagEntry(values)];
        }
        const author = str(values["author"]) || ctx.env["BILINEAR_USER"] || ctx.env["USER"] || ctx.env["USERNAME"] || "unknown";
        const results = await recordContext(await tracker(), positionals[1], inputs, { author, today: ctx.env["BILINEAR_TODAY"] || todayIso() });
        if (values["json"]) {
          out(json(results));
          return EXIT_OK;
        }
        for (const r of results) {
          out(`${r.id} ${r.action === "created" ? "created" : "skipped (duplicate)"}`);
          if (r.superseded.length) out(`  superseded: ${r.superseded.join(" ")}`);
          for (const w of r.warnings) out(`  warning: ${w}`);
        }
        return EXIT_OK;
      }
      if (sub === "get") {
        const ids = csv(positionals.slice(1));
        if (!ids.length) throw new UsageError("get needs one or more full entry IDs, such as BL-9/D3 or BL/D1");
        const t = await tracker();
        const found = await locked(t, () => getContext(t, ids));
        if (values["json"]) {
          out(json(found.map(({ id, entry }) => entryJson(id, entry))));
          return EXIT_OK;
        }
        found.forEach(({ id, text }, i) => {
          if (i) out("");
          out(`## ${id}`);
          out(text.replace(/\n+$/, ""));
        });
        return EXIT_OK;
      }
      if (sub === "list") {
        if (positionals.length !== 2) throw new UsageError("list needs one target: an issue ID such as BL-9, or the prefix of the tracker such as BL");
        const target = contextTarget(positionals[1]);
        const given = str(values["type"]);
        const type = given === undefined ? null : entryType(given);
        if (given !== undefined && type === null) throw new UsageError(`'${given}' is not a type; use one of ${typeList()}`);
        const status = str(values["status"])?.trim().toLowerCase();
        if (status !== undefined && values["all"]) throw new UsageError("--status cannot go with --all; give one of them");
        if (status !== undefined && !(ENTRY_STATUSES as readonly string[]).includes(status)) {
          throw new UsageError(`'${str(values["status"])}' is not a status; use one of ${ENTRY_STATUSES.join(", ")}`);
        }
        const t = await tracker();
        const found = (await locked(t, () => listContext(t, target))).filter(
          ({ entry: e }) => (type === null || e.type === type) && (values["all"] === true || e.status === (status ?? "active")),
        );
        if (values["json"]) out(json(found.map(({ id, entry }) => entryJson(id, entry))));
        else if (!found.length) out("no context entries");
        else for (const { id, entry } of found) out(listLine(id, entry));
        return EXIT_OK;
      }
      if (sub === "checkpoint") {
        if (positionals.length !== 2) throw new UsageError("checkpoint needs one issue ID, such as BL-9");
        const target = cleanTitle(positionals[1]).toUpperCase();
        if (!ID_RE.test(target)) throw new UsageError(`'${positionals[1]}' is not an issue ID such as BL-9; checkpoint takes one issue, not a tracker prefix`);
        const t = await tracker();
        const found = await locked(t, () => listContext(t, target));
        out(checkpointText(target, found.map(({ entry }) => entry)));
        return EXIT_OK;
      }
      throw new UsageError(`${sub === undefined ? "missing subcommand" : `unknown subcommand '${sub}'`}; use one of: record, get, list, checkpoint`);
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
    args: "[<name> [--icon ICON] [--color COLOR] [--triage]] [--json]",
    help: "list the states, or set a state's icon and colour, or make it the triage state",
    options: { icon: { type: "string" }, color: { type: "string" }, triage: { type: "boolean" }, json: { type: "boolean" } },
    takes: [0, 1],
    reads: (_values, positionals) => positionals.length === 0,
    async run({ values, positionals, out, tracker }) {
      const t = await tracker();
      const icon = str(values["icon"]);
      const color = str(values["color"]);
      if (positionals.length) {
        // --triage comes first: it may add the state that the style is for.
        if (values["triage"]) await setTriageState(t, positionals[0]);
        if (icon === undefined && color === undefined) {
          if (values["triage"]) return EXIT_OK;
          const idx = await locked(t, () => readIndex(t));
          if (!idx.states.includes(positionals[0])) throw new OpError(`unknown state '${positionals[0]}' (states: ${idx.states.join(", ")})`);
          throw new OpError("give --icon, --color, --triage or several");
        }
        await setStateStyle(t, positionals[0], { icon: styleValue(icon), color: styleValue(color) });
        return EXIT_OK;
      }
      if (icon !== undefined || color !== undefined || values["triage"]) throw new OpError("--icon, --color and --triage need a state name");
      const idx = await locked(t, () => readIndex(t));
      const rows = idx.states.map((name) => ({ name, icon: idx.stateIcons[name] ?? null, color: idx.stateColors[name] ?? null, closed: idx.closedStates.includes(name), triage: name === idx.triageState }));
      if (values["json"]) {
        out(json(rows));
        return EXIT_OK;
      }
      const w = width(rows.map((r) => r.name));
      for (const r of rows) {
        const parts = [r.icon ? `icon=${r.icon}` : "", r.color ? `color=${r.color}` : "", r.closed ? "(closed)" : "", r.triage ? "(triage)" : ""].filter((p) => p);
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

  "agent-setup": {
    args: "<dir> [--codex] [--claude] [--global-skill] [--local] [--followups] | <dir> --update",
    boardless: true,
    help: "set an LLM agent up to track its work here: a skill, and a section in CLAUDE.md or AGENTS.md",
    options: { codex: { type: "boolean" }, claude: { type: "boolean" }, "global-skill": { type: "boolean" }, local: { type: "boolean" }, followups: { type: "boolean" }, update: { type: "boolean" } },
    takes: [1, 1],
    reads: () => true,
    async run({ ctx, board, values, positionals, out, tracker, open }) {
      const home = ctx.env["HOME"] || ctx.env["USERPROFILE"] || os.homedir();
      const local = values["local"] === true;
      const update = values["update"] === true;
      if (update) {
        const flag = ["codex", "claude", "global-skill", "local", "followups"].find((name) => values[name] === true);
        if (flag) throw new UsageError(`--${flag} does not go with --update: what is there decides`);
      }
      let p;
      try {
        p = plan(positionals[0], { cwd: ctx.cwd, home, claudeHome: ctx.env["CLAUDE_CONFIG_DIR"] || undefined, codexHome: ctx.env["CODEX_HOME"] || undefined }, { codex: values["codex"] === true, claude: values["claude"] === true, local, followups: values["followups"] === true, globalSkill: values["global-skill"] === true, update });
      } catch (e) {
        throw e instanceof SetupError ? new UsageError(e.message) : e;
      }
      const real = realPath(p.dir);
      const root = p.home ? null : repositoryRoot(real);
      if (update) {
        // What is there decides: each instructions file with a block is
        // refreshed, with the tracker the block names and the rule about
        // follow-ups if it had it, and each skill that is there, or whose
        // instructions are: the skill a block refers to, which is in the
        // home folder for a project that was set up with --global-skill.
        // All of it is read before anything is written.
        const read = (file: string | null) => (file !== null && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
        const found = p.targets.map((target) => {
          const old = read(target.file);
          const block = old === null ? null : instructionsBlock(old);
          const named = block === null ? null : blockSkill(block, p.dir, home);
          return { ...target, ...(named === null ? {} : { skill: named.path, ref: named.ref }), old, block };
        });
        const skills = new Set(found.filter((f) => f.block !== null || fs.existsSync(f.skill)).map((f) => f.skill));
        if (!skills.size) throw new OpError(`nothing to update in ${positionals[0]}: no bilinear skill or instructions section there`);
        const texts = new Map<string, string>();
        for (const { file, ref, old, block } of found) {
          if (file === null || old === null || block === null) continue;
          const recorded = blockTracker(block);
          if (recorded === null) throw new OpError(`${file} names no tracker; run agent-setup without --update`);
          const wrong = notBoard(recorded);
          if (wrong !== null) throw new OpError(`${file} names the tracker ${recorded}, which cannot be read: it is ${wrong}; run agent-setup without --update`);
          let triage: string | undefined;
          if (hasFollowups(block)) {
            const from = `${file} names the tracker ${recorded}`;
            let t: Tracker;
            try {
              t = await open(nodePath.isAbsolute(recorded) ? recorded : nodePath.resolve(root ?? real, recorded));
            } catch (e) {
              throw new OpError(`${from}, which cannot be read: ${e instanceof Error ? e.message : String(e)}; run agent-setup without --update`);
            }
            const idx = await locked(t, () => readIndex(t));
            if (idx.triageState === null) throw new OpError(`${from}, which has no triage state for follow-ups to wait in; run agent-setup without --update`);
            triage = idx.triageState;
          }
          texts.set(file, withInstructions(old, instructions(recorded, ref, triage)));
        }
        for (const { skill, file } of found) {
          if (skills.delete(skill)) out(`${writeFile(skill, SKILL)} ${skill}`);
          const text = file === null ? undefined : texts.get(file);
          if (file !== null && text !== undefined) out(`${writeFile(file, text)} ${file}`);
        }
        return EXIT_OK;
      }
      let where = "";
      let triage: string | undefined;
      if (p.targets.some((target) => target.file !== null)) {
        const t = await tracker();
        if (values["followups"]) {
          const idx = await locked(t, () => readIndex(t));
          if (idx.triageState === null) throw new OpError(`the tracker has no triage state for follow-ups to wait in; make one with: bilinear ${shellWord(board())} state triage --triage`);
          triage = idx.triageState;
        }
        // The index note, not its folder, which may hold other trackers too.
        where = root === null ? native(t.indexPath) : trackerPath(native(t.indexPath), root);
      }
      if (local && !p.home) {
        for (const file of p.targets.flatMap((target) => [target.global ? null : target.skill, target.file])) {
          if (file === null || !isTracked(file, p.dir)) continue;
          const codex = nodePath.basename(file) === "AGENTS.md" ? "; Codex has no local instructions file, and ~/.codex is the alternative" : "";
          throw new OpError(`${file} is committed to git, so it cannot be kept local${codex}`);
        }
      }
      for (const { skill, file, ref } of p.targets) {
        out(`${writeFile(skill, SKILL)} ${skill}`);
        if (file === null) continue;
        const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
        out(`${writeFile(file, withInstructions(old, instructions(where, ref, triage)))} ${file}`);
      }
      if (local && !p.home) {
        const git = root === null ? "" : nodePath.join(root, ".git");
        if (root === null) out(`not excluded: ${p.dir} is in no git repository`);
        else if (!fs.statSync(git).isDirectory()) out(`not excluded: ${git} is not a folder`);
        else {
          const file = nodePath.join(git, "info", "exclude");
          for (const pattern of exclude(file, excludePatterns(p.targets, p.dir, real, root))) out(`excluded ${pattern} in ${file}`);
        }
      }
      return EXIT_OK;
    },
  },
};

function usage(name?: string): string {
  if (name) return `usage: bilinear ${COMMANDS[name].boardless ? "[<board.md>]" : "<board.md>"} ${name} ${COMMANDS[name].args}\n`;
  return "usage: bilinear <board.md> <command> [options]\n";
}

function help(name?: string): string {
  const options =
    "<board.md> is the tracker's index note, a file that ends in .md. It comes first, before the command,\n" +
    "and is the only tracker the command works on; nothing is guessed from the working folder or from\n" +
    "the issues a command names. Set $BILINEAR_TRACKER to it, as a path to the file, to leave it out of\n" +
    "the command line; one given there wins.\n" +
    "\n" +
    "options, after the command:\n" +
    "  --author NAME   author for comments and context entries (default: $BILINEAR_USER, then $USER)\n";
  if (name) {
    let text = `${usage(name)}\n${COMMANDS[name].help}\n\n${options}`;
    if (name === "label" || name === "state") {
      text += `\nCOLOR is one of ${COLOR_NAMES.join(", ")}, #rgb or #rrggbb; 'none' clears it.\n`;
    }
    if (name === "state") {
      text +=
        `ICON is one of ${STATE_SHAPES.join(", ")}, or a Lucide icon name; 'none' clears it.\n` +
        "--triage makes the state the triage state, where new issues wait for the user to accept or\n" +
        "reject them; a state the tracker does not have yet is added in front of the others.\n";
    }
    if (name === "context") {
      text +=
        "\ncontext record writes one entry from flags, or a batch from JSON (--file, - is the standard input).\n" +
        "The target is an issue ID (BL-9) or the tracker's prefix (BL). The batch is all or nothing.\n" +
        `TYPE is one of ${typeList()}, or its letter.\n` +
        "An entry with the same subject and content as an active one is skipped. The same subject with other\n" +
        "content is refused: give --supersedes ID to replace the old entry, or --new to keep both.\n" +
        "--evidence takes kind:value (commit:abc, comment:2026-10-01#1, entry:D2); repeat it. --supersedes\n" +
        "takes IDs, repeated or comma separated. Type rejected needs --attempted, --failed and --applies,\n" +
        "and takes --promising and --happened.\n" +
        "The JSON has the keys type, subject, content, rationale, alternatives, evidence (array), supersedes,\n" +
        "new (boolean) and rejected (object with the five keys of the flags, which may also stand at the top).\n" +
        "A value that starts with '-' needs an equals sign: --content=\"- first item\", or use --file.\n" +
        "context get prints the entries with the given full IDs (BL-9/D3, BL/D1); --json gives their fields.\n" +
        "context list prints one line for each entry of an issue or of the tracker, in the order of the types and\n" +
        "then by number: ID, status, date, subject. It shows the active entries; --all shows each status, and\n" +
        "--status S (active, superseded, resolved) one status. --type T shows one type; --json gives the fields.\n" +
        "context checkpoint prints, for an agent, what to record in an issue now. It writes nothing.\n";
    }
    if (name === "agent-setup") {
      text +=
        "\n<dir> is a project's folder, or one of ~/.claude, ~/.codex and ~/.agents. Each agent gets a skill,\n" +
        "which teaches it how work is tracked, and a section in its instructions file that names this\n" +
        "tracker and refers to the skill, where it reads them:\n" +
        "\n" +
        "  <dir>            instructions                 skill\n" +
        "  ~/.claude        ~/.claude/CLAUDE.md          ~/.claude/skills/bilinear/SKILL.md\n" +
        "  ~/.codex         ~/.codex/AGENTS.md           ~/.agents/skills/bilinear/SKILL.md\n" +
        "  ~/.agents        none                         ~/.agents/skills/bilinear/SKILL.md\n" +
        "  project --claude <dir>/CLAUDE.md              <dir>/.claude/skills/bilinear/SKILL.md\n" +
        "  project --codex  <dir>/AGENTS.md              <dir>/.agents/skills/bilinear/SKILL.md\n" +
        "\n" +
        "The home folders mean their agent, so they need no option; CLAUDE_CONFIG_DIR and CODEX_HOME\n" +
        "move the first two. ~/.agents is read by Codex and others, takes only the skill, and needs no\n" +
        "tracker. For a project give --codex, --claude or both.\n" +
        "\nA tracker is named by its board file, given first or in $BILINEAR_TRACKER. Only a run that writes\n" +
        "no instructions file, with --update or in ~/.agents, may do without it.\n" +
        "\n--global-skill keeps the skill out of a project: it goes to the agent's folder in your home, as in\n" +
        "the table (~/.claude, and ~/.agents for Codex), where it serves every project, and the project\n" +
        "gets only its instructions, which name its tracker. It suits several projects that each track\n" +
        "their work in a tracker of their own. In the home folders, where the skill already is, it does\n" +
        "nothing.\n" +
        "\n--local keeps a project's files out of git: the instructions go to CLAUDE.local.md instead of\n" +
        "CLAUDE.md (Codex has no local file, so AGENTS.md is used), and the files are added to the\n" +
        "repository's .git/info/exclude. A file that is already committed is refused; in the home\n" +
        "folders, which are in no project, --local does nothing. The rest of the\n" +
        "instructions file is kept. The tracker is named by its path\n" +
        "from the root of the repository if it is inside the repository or one level above it, else by\n" +
        "its absolute path, as it is when <dir> is in no repository, and always in a home folder.\n" +
        "\n--followups adds the rule that whatever a task skips becomes a follow-up issue in the backlog,\n" +
        "and that only one that needs a decision of high importance about the architecture waits in\n" +
        "the tracker's triage state for the user to accept or reject, assigned to the user and written\n" +
        "with the ways to do it as options, which the user deletes down to one.\n" +
        "\n--update refreshes what an earlier run wrote in <dir>: the skill, and each section it finds in\n" +
        "CLAUDE.md, CLAUDE.local.md and AGENTS.md. Each section keeps the tracker it names, and the\n" +
        "follow-ups rule if it had it. Run it after upgrading bilinear. It takes none of the other\n" +
        "options, and needs no board file.\n";
    }
    return text;
  }
  const w = width(Object.keys(COMMANDS));
  const commands = Object.entries(COMMANDS).map(([n, c]) => `  ${pad(n, w)}  ${c.help}\n`);
  return `${usage()}\nIssue tracker stored as Markdown notes in an Obsidian vault.\n\ncommands:\n${commands.join("")}\n${options}\nwith no command or board file:\n  --version       print the version\n  -h, --help      this text, or a command's with <command> --help\n`;
}

/** Why `given` cannot be the board file, null if it can: it is the tracker's index note, so a path that ends in .md. */
function notBoard(given: string): string | null {
  return given.endsWith(".md") ? null : "not the path of a tracker's index note, which ends in .md";
}

/**
 * The tracker a command works on: the one whose index note is at `given`,
 * and no other. `named` is how messages call the path.
 */
async function openTracker(io: NodeIO, ctx: Context, given: string, named = given): Promise<Tracker> {
  const wrong = notBoard(given);
  if (wrong !== null) throw new OpError(`${named} is ${wrong}`);
  const path = nodePath.resolve(ctx.cwd, given);
  const stat = fs.statSync(path, { throwIfNoEntry: false });
  if (!stat) throw new OpError(`no tracker index note ${named}`);
  if (!stat.isFile()) throw new OpError(`${named} is not a file; a tracker's index note is expected`);
  if (new Doc((await io.read(slashed(path))) ?? "").getStr("bilinear") !== "tracker") throw new OpError(`${named} is not a tracker index note`);
  const real = slashed(fs.realpathSync(path));
  return { io, dir: real.slice(0, real.lastIndexOf("/")), indexPath: real, warn: (message) => ctx.stderr(`bilinear: ${message}\n`) };
}

/** Run one command line. Returns the exit code. */
export async function main(argv: string[], ctx: Context): Promise<number> {
  const fail = (message: string, exit: number): number => {
    ctx.stderr(`bilinear: ${message}\n`);
    return exit;
  };

  // The board file is the first argument if it ends in .md, else
  // $BILINEAR_TRACKER; no command name ends in .md.
  const first = argv[0] ?? "";
  const positional = first.endsWith(".md");
  const configured = ctx.env["BILINEAR_TRACKER"] || null;
  const given = positional ? first : configured;
  const named = positional || given === null ? first : `$BILINEAR_TRACKER (${given})`;
  const at = positional ? 1 : 0;
  const name = argv[at];
  if (name === undefined || ["--version", "--help", "-h"].includes(name)) {
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
  // A known command's missing board file is reported after --help, which
  // needs none; with an unknown first argument it is the board file that is
  // missing, as in `bilinear Trackers/Bilinear list`.
  const noBoard = (): number => {
    ctx.stderr(usage());
    return fail("error: no board file; give the tracker's index note, ending in .md, as the first argument, or set BILINEAR_TRACKER to it", EXIT_USAGE);
  };
  const boardMissing = given === null && !COMMANDS[name]?.boardless;
  if (boardMissing && !Object.hasOwn(COMMANDS, name)) return noBoard();
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
        args: argv.slice(at + 1),
        options: { author: { type: "string" }, help: { type: "boolean", short: "h" }, ...command.options },
        allowPositionals: true,
        strict: true,
      }) as { values: Values; positionals: string[] };
    } catch (e) {
      if (boardMissing && !argv.includes("--help") && !argv.includes("-h")) return noBoard();
      const message = e instanceof Error ? e.message.split("\n")[0] : String(e);
      const ambiguous = /^Option '(--[^']+)' argument is ambiguous/.exec(message);
      if (!ambiguous) throw new UsageError(message);
      const file = command.options && "file" in command.options ? ", or give the entry with --file" : "";
      throw new UsageError(
        `${message} A value that starts with '-' must stand in one argument with its option: write ${ambiguous[1]}=VALUE${file}`,
      );
    }
    const { values, positionals } = parsed;
    if (values["help"]) {
      ctx.stdout(help(name));
      return EXIT_OK;
    }
    if (boardMissing) return noBoard();
    const [min, max] = command.takes;
    if (positionals.length < min) throw new UsageError("too few arguments");
    if (positionals.length > max) throw new UsageError(`unexpected argument '${positionals[max]}'`);

    const seconds = Number(ctx.env["BILINEAR_LOCK_TIMEOUT"] ?? "");
    const lockTimeout = ctx.env["BILINEAR_LOCK_TIMEOUT"] && Number.isFinite(seconds) ? seconds * 1000 : LOCK_TIMES.timeout;
    const io = new NodeIO({ lockTimeout, readOnly: command.reads?.(values, positionals) ?? false, force: values["force"] === true });
    let tracker: Tracker | null = null;
    const board = (): string => {
      if (given === null) throw new UsageError(`${name} needs a board file for this: give the tracker's index note, ending in .md, first, or set BILINEAR_TRACKER to it`);
      const wrong = notBoard(given);
      if (wrong !== null) throw new OpError(`${named} is ${wrong}`);
      return given;
    };
    try {
      // Output is collected and written when the command is done, after the
      // lock is released: a full pipe must not keep the tracker locked.
      return await command.run({
        ctx,
        values,
        positionals,
        io,
        out: (line) => lines.push(line),
        board,
        tracker: async () => (tracker ??= await openTracker(io, ctx, board(), named)),
        open: (path) => openTracker(io, ctx, path),
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
