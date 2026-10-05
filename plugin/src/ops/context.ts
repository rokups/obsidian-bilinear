// The operations that record and read context entries. `recordContext` checks and writes a whole batch on the
// current text of one note, under the lock of the tracker, so a batch is all or nothing. Like the ops of
// issues.ts, none of them calls another.

import {
  checkEntry,
  fullId,
  insertEntry,
  formatEntry,
  LETTERS,
  nextNumber,
  normalizeLocal,
  parseContext,
  parseFullId,
  patchEntry,
  type ContextEntry,
  type RejectedFields,
} from "../format/context";
import { overlap } from "../format/context-view";
import { ID_RE, PREFIX_RE, cleanTitle, todayIso, validDate, type EntryType } from "../format/ids";
import { parseComments } from "../format/issue-note";
import { isBlank } from "../format/lines";
import { classify } from "../format/markdown";
import { OpError, type Tracker } from "./io";
import { locked, readIndex, requireItem, resolveNote } from "./tracker";
import type { Index } from "../format/index-note";

export interface RecordInput {
  type: EntryType;
  subject: string;
  content?: string;
  rationale?: string;
  alternatives?: string;
  evidence?: string[];
  /** Local IDs (`D1`) or full IDs of the same note, in any letter case. */
  supersedes?: string[];
  rejected?: Partial<RejectedFields>;
  /** The `--new` flag: permit an equal subject with different content. */
  isNew?: boolean;
}

export interface RecordResult {
  /** The full ID of the created entry, or of the existing entry for a skip. */
  id: string;
  action: "created" | "skipped";
  /** Full IDs that this record set to superseded or resolved. */
  superseded: string[];
  warnings: string[];
}

export interface RecordOptions {
  author?: string;
  /** `YYYY-MM-DD`; the date of today when it is not given. */
  today?: string;
}

const REJECTED_KEYS = ["attempted", "promising", "happened", "failed", "applies"] as const;
const SIMILAR = 0.5;

const lf = (s: string) => s.replace(/\r\n?/g, "\n");
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** The labels at the start of a line that `parseContext` reads as labels in an entry of this type. */
function labelRe(type: EntryType): RegExp {
  const names = type === "rejected" ? "Rationale|Alternatives|Attempted|Promising|Happened|Failed|Applies" : "Rationale|Alternatives";
  return new RegExp(`^(?:${names}):`);
}

/** The content: trimmed; a heading of level 1 to 3 goes down to level 4; a label at the start of a line gets a backslash. */
function normalizeContent(value: string | undefined, type: EntryType): string {
  const text = lf(value ?? "").trim();
  if (!text) return "";
  const lines = text.split("\n");
  const kinds = classify(lines);
  const label = labelRe(type);
  return lines
    .map((line, i) => {
      const k = kinds[i];
      if (k.kind === "heading" && k.level <= 3) return "#".repeat(4 - k.level) + line;
      if (k.kind === "text" && label.test(line)) return `\\${line}`;
      return line;
    })
    .join("\n");
}

/** A labelled value: trimmed, and no blank line outside a code fence. The first line is on the label line. */
function normalizeLabelled(value: string | undefined): string {
  const text = lf(value ?? "").trim();
  if (!text) return "";
  const lines = text.split("\n");
  // A first line that is a code fence stands on the lines under the label: the value starts with a line break.
  if (classify([lines[0]])[0].kind === "code") {
    const kinds = classify(lines);
    return "\n" + lines.filter((line, i) => kinds[i].kind === "code" || !isBlank(line)).join("\n");
  }
  const [first, ...rest] = lines;
  const kinds = classify(rest);
  return [first, ...rest.filter((line, i) => kinds[i].kind === "code" || !isBlank(line))].join("\n");
}

/** The text of an entry that decides if two entries are one: all free text, white space collapsed. */
function signature(e: Pick<ContextEntry, "content" | "rationale" | "alternatives" | "rejected">): string {
  const r = e.rejected;
  return [e.content, e.rationale, e.alternatives, ...(r ? REJECTED_KEYS.map((k) => r[k]) : [])].map(collapse).join("\u0000");
}

const EDGE_RE = /^[.,;:!?'"`()[\]{}<>]+|[.,;:!?'"`()[\]{}<>]+$/g;

/** Two subjects with the same key are the same subject: NFKC, lower case, white space collapsed, marks cut at the ends of words. */
function subjectKey(s: string): string {
  const words = cleanTitle(s).normalize("NFKC").toLowerCase().split(" ");
  return words.map((w) => w.replace(EDGE_RE, "")).filter((w) => w !== "").join(" ");
}

/** Check one evidence item and give the form to write. */
function checkEvidence(raw: string, noteId: string, entries: ContextEntry[], comments: string[]): string {
  const item = lf(raw).trim();
  const m = /^([a-z]+):(.*)$/.exec(item);
  const value = m ? m[2].trim() : "";
  if (!m || !value) throw new OpError(`evidence '${item}' must have the form kind:value, with kind in lower case letters`);
  const kind = m[1];
  if (kind === "comment") {
    const c = /^([0-9]{4}-[0-9]{2}-[0-9]{2})#([0-9]+)$/.exec(value);
    const n = c ? parseInt(c[2], 10) : 0;
    if (!c || !validDate(c[1]) || n < 1) throw new OpError(`evidence '${item}' must have the form comment:YYYY-MM-DD#n, with n from 1`);
    const have = comments.filter((d) => d === c[1]).length;
    if (have < n) throw new OpError(`evidence '${item}': ${noteId} has ${have} comment(s) dated ${c[1]}`);
    return `comment:${c[1]}#${n}`;
  }
  if (kind === "entry") {
    const full = value.includes("/") ? parseFullId(value) : null;
    const local = full ? full.local : value.includes("/") ? null : normalizeLocal(value);
    if (!local) throw new OpError(`evidence '${item}' does not name an entry`);
    const id = fullId(full ? full.noteId : noteId, local);
    // An entry of the other scope is not checked.
    if ((!full || full.noteId === noteId) && !entries.some((e) => e.local === local)) {
      throw new OpError(`evidence '${item}': ${id} does not exist`);
    }
    return `entry:${id}`;
  }
  return `${kind}:${value}`;
}

/** The path of the note of an issue, or of the index note for the prefix of the tracker. */
async function notePathOf(t: Tracker, idx: Index, noteId: string): Promise<string> {
  if (ID_RE.test(noteId)) {
    const item = requireItem(idx, noteId);
    const path = await resolveNote(t, noteId, item.archived);
    if (path === null) throw new OpError(`${noteId}: note missing`);
    return path;
  }
  if (PREFIX_RE.test(noteId) && noteId === idx.prefix) return t.indexPath;
  throw new OpError(`${noteId}: no such issue or tracker`);
}

/**
 * Record a batch of entries in the note of an issue (`BL-9`) or in the index note (`BL`). The checks and the writes
 * are made on the current text of the note in order, so an input sees the entries of the inputs before it. An error
 * in one input throws and the note stays as it was.
 */
export function recordContext(t: Tracker, target: string, inputs: RecordInput[], opts: RecordOptions = {}): Promise<RecordResult[]> {
  return locked(t, async () => {
    if (inputs.length === 0) throw new OpError("there is nothing to record");
    const noteId = cleanTitle(target).toUpperCase();
    const idx = await readIndex(t);
    const path = await notePathOf(t, idx, noteId);
    const author = cleanTitle(opts.author) || "unknown";
    const today = opts.today ?? todayIso();
    if (!validDate(today)) throw new OpError(`'${today}' is not a date in the form YYYY-MM-DD`);
    let results: RecordResult[] = [];

    // The callback can run more than once (the file changed before the write), so it keeps no state outside.
    await t.io.process(path, (text) => {
      results = [];
      let cur = text;
      /** Local ID -> number of the input of this batch that created it, or that set it to superseded or resolved. */
      const createdBy = new Map<string, number>();
      const supersededBy = new Map<string, number>();
      inputs.forEach((input, i) => {
        const label = `input ${i + 1} (${cleanTitle(input.subject)})`;
        const fail = (message: string): never => {
          throw new OpError(`${label}: ${message}`);
        };
        const parsed = parseContext(cur);
        if (parsed.duplicates.length) fail(`${noteId} has more than one entry with the ID ${parsed.duplicates.join(", ")}; a person must correct the note first`);
        const entries = parsed.entries;
        const type = input.type;
        const letter = LETTERS[type];
        if (!letter) fail(`unknown type: ${String(type)}`);

        // Rule 1 and 2: the fields.
        if (type !== "rejected" && input.rejected !== undefined) fail(`only an entry of type rejected has a rejected object`);
        const entry: ContextEntry = {
          local: "",
          type,
          number: nextNumber(cur, letter),
          subject: cleanTitle(input.subject),
          content: normalizeContent(input.content, type),
          rationale: normalizeLabelled(input.rationale),
          alternatives: normalizeLabelled(input.alternatives),
          evidence: [],
          created: today,
          updated: today,
          author,
          status: "active",
          supersedes: [],
          supersededBy: null,
          extra: [],
          range: [0, 0],
        };
        entry.local = `${letter}${entry.number}`;
        if (type === "rejected") {
          const r = input.rejected ?? {};
          entry.rejected = Object.fromEntries(REJECTED_KEYS.map((k) => [k, normalizeLabelled(r[k])])) as unknown as RejectedFields;
          for (const k of ["attempted", "failed", "applies"] as const) {
            if (!entry.rejected[k]) fail(`an entry of type rejected needs a non-empty ${k}`);
          }
        }
        const problems = checkEntry(entry);
        if (problems.length) fail(problems.join("; "));

        // Rule 3: the evidence.
        const dates = parseComments(cur).map((c) => c.date);
        try {
          entry.evidence = (input.evidence ?? []).map((item) => checkEvidence(item, noteId, entries, dates));
        } catch (e) {
          if (e instanceof OpError) fail(e.message);
          throw e;
        }

        // Rule 5: the entries that this one replaces.
        const explicit: string[] = [];
        for (const s of input.supersedes ?? []) {
          const full = s.includes("/") ? parseFullId(s.trim()) : null;
          if (s.includes("/") && (!full || full.noteId !== noteId)) fail(`'${s}' is not an entry of ${noteId}`);
          const local = full ? full.local : normalizeLocal(s);
          if (!local) fail(`'${s}' is not an entry ID`);
          const found = entries.find((e) => e.local === local);
          if (supersededBy.has(local!)) fail(`input ${supersededBy.get(local!)} of this batch already supersedes ${fullId(noteId, local!)}`);
          if (!found) fail(`${fullId(noteId, local!)} does not exist`);
          if (found!.status !== "active") fail(`${fullId(noteId, local!)} is already ${found!.status}`);
          if (!explicit.includes(local!)) explicit.push(local!);
        }
        // Rule 6: a new state replaces the active states.
        const auto = type === "state" ? entries.filter((e) => e.type === "state" && e.status === "active" && !explicit.includes(e.local)).map((e) => e.local) : [];

        // Rule 4: a duplicate, an equal subject, a similar entry, a rejected approach.
        const active = entries.filter((e) => e.type === type && e.status === "active" && !explicit.includes(e.local));
        const key = subjectKey(entry.subject);
        const same = active.filter((e) => subjectKey(e.subject) === key);
        const equal = same.find((e) => signature(e) === signature(entry));
        if (equal) {
          const id = fullId(noteId, equal.local);
          if (explicit.length) {
            fail(`${id} exists already with the same subject and content, so the supersession of ${explicit.map((l) => fullId(noteId, l)).join(", ")} was not applied; record a changed entry, or drop supersedes`);
          }
          const lost = entry.evidence.filter((x) => !equal.evidence.includes(x));
          results.push({
            id,
            action: "skipped",
            superseded: [],
            warnings: lost.length ? [`the evidence was not added to ${id}: ${lost.join(", ")}`] : [],
          });
          return;
        }
        const clash = same.find((e) => !auto.includes(e.local));
        if (clash && !input.isNew) {
          const id = fullId(noteId, clash.local);
          const by = createdBy.get(clash.local);
          if (by !== undefined) fail(`input ${by} of this batch has the same subject and different content; use --new to keep both`);
          fail(`${id} has the same subject and different content; use --supersedes ${id} to replace it, or --new to keep both`);
        }
        const warnings: string[] = [];
        const near = active.filter((e) => !auto.includes(e.local) && overlap(entry.subject, e.subject) >= SIMILAR);
        if (near.length) {
          warnings.push(`similar active ${type} entries: ${near.map((e) => `${fullId(noteId, e.local)} (${e.subject})`).join(", ")}`);
        }
        if (type === "decision") {
          for (const r of entries) {
            if (r.type !== "rejected" || r.status !== "active" || explicit.includes(r.local)) continue;
            if (overlap(entry.subject, r.subject) >= SIMILAR || overlap(entry.subject, r.rejected?.attempted ?? "") >= SIMILAR) {
              warnings.push(`${fullId(noteId, r.local)} (${r.subject}) was rejected. Applies: ${r.rejected?.applies ?? ""}`);
            }
          }
        }

        // The writes: the entry, then the links in the entries that it replaces.
        const targets = [...explicit, ...auto];
        entry.supersedes = targets;
        try {
          cur = insertEntry(cur, entry);
          for (const local of targets) {
            cur = patchEntry(cur, local, (e) => ({
              ...e,
              status: e.type === "question" ? "resolved" : "superseded",
              supersededBy: entry.local,
              updated: today,
            }));
          }
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e));
        }
        createdBy.set(entry.local, i + 1);
        for (const local of targets) supersededBy.set(local, i + 1);
        results.push({
          id: fullId(noteId, entry.local),
          action: "created",
          superseded: targets.map((l) => fullId(noteId, l)),
          warnings,
        });
      });
      return cur;
    });
    return results;
  });
}

/** The entries with the given full IDs (`BL-9/D3`, `BL/D1`), in the order of the IDs, each with its formatted text. */
export async function getContext(t: Tracker, ids: string[]): Promise<Array<{ id: string; entry: ContextEntry; text: string }>> {
  const idx = await readIndex(t);
  const notes = new Map<string, ContextEntry[]>();
  const out: Array<{ id: string; entry: ContextEntry; text: string }> = [];
  for (const raw of ids) {
    const parsed = parseFullId(raw);
    if (!parsed) throw new OpError(`${raw}: not the ID of a context entry (such as BL-9/D3)`);
    let entries = notes.get(parsed.noteId);
    if (!entries) {
      let path: string;
      try {
        path = await notePathOf(t, idx, parsed.noteId);
      } catch (e) {
        throw e instanceof OpError ? new OpError(`${raw}: ${e.message}`) : e;
      }
      const text = await t.io.read(path);
      if (text === null) throw new OpError(`${raw}: note missing`);
      entries = parseContext(text).entries;
      notes.set(parsed.noteId, entries);
    }
    const entry = entries.find((e) => e.local === parsed.local);
    if (!entry) throw new OpError(`${raw}: no such context entry`);
    out.push({ id: fullId(parsed.noteId, entry.local), entry, text: formatEntry(entry, "\n") });
  }
  return out;
}
