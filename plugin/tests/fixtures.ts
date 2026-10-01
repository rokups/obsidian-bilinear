import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IssueRecord } from "../src/format/record";
import type { Tracker } from "../src/ops/io";
import { adoptIssue, archiveClosed, archiveIssues, commentIssue, createIssue, deleteIssue, moveIssue, setProps, unarchiveIssues } from "../src/ops/issues";
import { lint } from "../src/ops/lint";
import { indexNotes, listIssues } from "../src/ops/tracker";
import { MemoryIO } from "./memory-io";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "spec", "fixtures");
export const TRACKER_DIR = "Trackers/Tracker";

export interface Op {
  op: string;
  args: Record<string, any>;
  today?: string;
  author?: string;
  expect?: { id?: string; problems?: string[]; issues?: Array<Record<string, unknown>> };
}

export interface Case {
  name: string;
  dir: string;
  op: Op;
}

export function cases(): Case[] {
  return readdirSync(FIXTURES)
    .sort()
    .filter((name) => existsSync(join(FIXTURES, name, "op.json")))
    .map((name) => ({ name, dir: join(FIXTURES, name), op: JSON.parse(readFileSync(join(FIXTURES, name, "op.json"), "utf8")) }));
}

export async function openTracker(io: MemoryIO, dir = TRACKER_DIR): Promise<Tracker> {
  const found = await indexNotes(io, dir);
  if (!found.length) throw new Error(`no index note in ${dir}`);
  return { io, dir, indexPath: found[0] };
}

/** A record with the key names the fixtures and the CLI's JSON use. */
export function toFixtureRecord(r: IssueRecord): Record<string, unknown> {
  const { blockedBy, path: _path, ...rest } = r;
  return { ...rest, "blocked-by": blockedBy };
}

export interface Result {
  id?: string;
  problems?: string[];
  issues?: Array<Record<string, unknown>>;
}

/** Apply one fixture operation with the plugin's ops. */
export async function apply(t: Tracker, op: Op): Promise<Result> {
  const a = op.args ?? {};
  const today = op.today ?? "2026-01-01";
  switch (op.op) {
    case "create":
      return { id: await createIssue(t, a as any, today) };
    case "set":
      await setProps(t, a.id, a.props);
      return {};
    case "move":
      await moveIssue(t, a.id, a.before ? "before" : a.after ? "after" : a.top ? "top" : "bottom", a.before ?? a.after);
      return {};
    case "archive":
      if (a.closed) await archiveClosed(t);
      else await archiveIssues(t, a.ids);
      return {};
    case "unarchive":
      await unarchiveIssues(t, a.ids);
      return {};
    case "delete":
      await deleteIssue(t, a.id);
      return {};
    case "comment":
      await commentIssue(t, a.id, a.text, op.author ?? "rk", today);
      return {};
    case "adopt":
      await adoptIssue(t, a.id);
      return {};
    case "lint":
      return { problems: (await lint(t, !!a.fix)).map((p) => `${p.code}:${p.id ?? "-"}`).sort() };
    case "list":
      return { issues: (await listIssues(t)).map(toFixtureRecord) };
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}
