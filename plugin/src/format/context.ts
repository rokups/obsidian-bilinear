import {
  COMMENTS,
  ENTRY_STATUSES,
  ID_RE,
  PREFIX_RE,
  CONTEXT,
  TYPE_LETTERS,
  validDate,
  type EntryStatus,
  type EntryType,
} from "./ids";
import { chomp, detectEol, hasEol, isBlank, splitLines, trimBlank } from "./lines";
import { classify, findSections, type LineKind } from "./markdown";
import { Doc } from "./yaml";

export interface RejectedFields {
  attempted: string;
  promising: string;
  happened: string;
  failed: string;
  applies: string;
}

export interface ContextEntry {
  /** Local ID, such as `D3`. */
  local: string;
  type: EntryType;
  number: number;
  subject: string;
  content: string;
  rationale: string;
  alternatives: string;
  evidence: string[];
  created: string | null;
  updated: string | null;
  author: string | null;
  status: EntryStatus;
  supersedes: string[];
  supersededBy: string | null;
  /** Only on entries of type `rejected`. */
  rejected?: RejectedFields;
  /**
   * True when the status line of the entry is a bullet kept in `extra` (one that does not parse, or has lines
   * under it). `formatEntry` then writes no status line of its own.
   */
  statusInExtra?: true;
  /** Metadata bullets this code does not know, as raw lines without terminator. */
  extra: string[];
  /** Lines of the entry in the text given to the parser: start inclusive, end exclusive. */
  range: [number, number];
}

export interface ParsedContext {
  entries: ContextEntry[];
  /** [heading line, end line (exclusive)] of `## Context log`, or null if there is none. */
  section: [number, number] | null;
  /** Local IDs that occur more than once. */
  duplicates: string[];
  problems: string[];
}

const ENTRY_HEADING_RE = /^([A-Za-z])([0-9]+):[ \t]*(.*)$/;
const LOCAL_RE = /^([A-Za-z])([0-9]+)$/;
const BULLET_RE = /^[-*+][ \t]+(.*)$/;
const KEY_RE = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*:[ \t]*(.*)$/;
const LABEL_RE = /^(Rationale|Alternatives|Attempted|Promising|Happened|Failed|Applies):[ \t]*(.*)$/;
const KNOWN_KEYS = ["status", "author", "created", "updated", "supersedes", "superseded-by"];
const STATUS_BULLET_RE = /^[-*+][ \t]+status[ \t]*:[ \t]*(.*)$/i;
const REJECTED_LABELS = ["Attempted", "Promising", "Happened", "Failed", "Applies"];
export const LETTERS = Object.fromEntries(Object.entries(TYPE_LETTERS).map(([letter, type]) => [type, letter])) as Record<
  EntryType,
  string
>;

/** The labels an entry of a type can have. */
function labelsOf(type: EntryType): string[] {
  return type === "rejected" ? [...REJECTED_LABELS, "Rationale", "Alternatives"] : ["Rationale", "Alternatives"];
}

/** `d3` -> `D3`; null when it is not a local ID of a known type. */
export function normalizeLocal(s: string): string | null {
  const m = LOCAL_RE.exec(trimBlank(s));
  if (!m || !(m[1].toUpperCase() in TYPE_LETTERS)) return null;
  return `${m[1].toUpperCase()}${parseInt(m[2], 10)}`;
}

/** Full ID of an entry: `BL-9/D3`. The note ID is that of the issue, or the prefix of the tracker. */
export function fullId(noteId: string, local: string): string {
  return `${trimBlank(noteId).toUpperCase()}/${trimBlank(local).toUpperCase()}`;
}

/** Split a full ID (any letter case) into its note ID and local ID, both upper case. */
export function parseFullId(s: string): { noteId: string; local: string } | null {
  const at = s.indexOf("/");
  if (at < 0) return null;
  const noteId = trimBlank(s.slice(0, at)).toUpperCase();
  const local = normalizeLocal(s.slice(at + 1));
  if (!local || !(ID_RE.test(noteId) || PREFIX_RE.test(noteId))) return null;
  return { noteId, local };
}

/**
 * Entries under `## Context log` of a note's text (frontmatter allowed). Ranges and
 * `section` are line numbers of that text. Never throws on odd input.
 */
export function parseContext(text: string): ParsedContext {
  const doc = new Doc(text);
  const lines = splitLines(doc.body);
  const base = splitLines(text).length - lines.length;
  const { sections, kinds } = findSections(lines, [CONTEXT]);
  const found = sections.get(CONTEXT);
  const out: ParsedContext = { entries: [], section: null, duplicates: [], problems: [] };
  if (!found) return out;
  out.section = [found[0] + base, found[1] + base];
  const [start, end] = found;

  // Level 1 to 3 headings split the section into blocks. Only some are entries.
  const heads: number[] = [];
  for (let i = start + 1; i < end; i++) {
    const k = kinds[i];
    if (k.kind === "heading" && k.level <= 3) heads.push(i);
  }
  heads.push(end);
  const seen = new Set<string>();
  heads.slice(0, -1).forEach((h, n) => {
    const k = kinds[h];
    if (k.kind !== "heading" || k.level !== 3) return;
    const m = ENTRY_HEADING_RE.exec(k.name);
    if (!m || !(m[1].toUpperCase() in TYPE_LETTERS)) return;
    const to = heads[n + 1];
    const entry = parseEntry(lines, kinds, h, to, m, out.problems);
    entry.range = [h + base, to + base];
    if (seen.has(entry.local) && !out.duplicates.includes(entry.local)) out.duplicates.push(entry.local);
    seen.add(entry.local);
    out.entries.push(entry);
  });
  return out;
}

function parseEntry(
  lines: string[],
  kinds: LineKind[],
  head: number,
  end: number,
  m: RegExpExecArray,
  problems: string[],
): ContextEntry {
  const letter = m[1].toUpperCase();
  const number = parseInt(m[2], 10);
  const local = `${letter}${number}`;
  const type = TYPE_LETTERS[letter as keyof typeof TYPE_LETTERS];
  const e: ContextEntry = {
    local,
    type,
    number,
    subject: trimBlank(m[3]),
    content: "",
    rationale: "",
    alternatives: "",
    evidence: [],
    created: null,
    updated: null,
    author: null,
    status: "active",
    supersedes: [],
    supersededBy: null,
    extra: [],
    range: [head, end],
  };
  const problem = (msg: string) => problems.push(`${local}: ${msg}`);

  // The metadata block: bullets, and the indented lines under them.
  let i = head + 1;
  while (i < end && isBlank(lines[i])) i++;
  let statusFound = false;
  let statusBad: string | null = null;
  const keys = new Set<string>();
  while (i < end && kinds[i].kind === "text") {
    const s = chomp(lines[i]);
    const b = BULLET_RE.exec(s);
    if (!b) break;
    const nested: string[] = [];
    i++;
    while (i < end && kinds[i].kind === "text" && /^[ \t]+\S/.test(chomp(lines[i]))) nested.push(chomp(lines[i++]));
    const km = KEY_RE.exec(b[1]);
    const key = km ? km[1].toLowerCase() : "";
    const value = km ? trimBlank(km[2]) : "";
    const raw = [s, ...nested];
    if (!km || keys.has(key)) {
      e.extra.push(...raw);
      continue;
    }
    // A bullet is kept as it is when its lines or its value are not understood. Its key is then not taken.
    const keep = (why: string) => {
      e.extra.push(...raw);
      problem(why);
    };
    let ok = false;
    if (nested.length && key !== "evidence") {
      if (KNOWN_KEYS.includes(key)) keep(`${key} has lines under it`);
      else e.extra.push(...raw);
      if (key === "status") {
        const v = value.toLowerCase();
        if ((ENTRY_STATUSES as readonly string[]).includes(v)) {
          e.status = v as EntryStatus;
          statusFound = ok = true;
          e.statusInExtra = true;
        } else statusBad = value;
      }
    } else {
      switch (key) {
        case "status": {
          const v = value.toLowerCase();
          if ((ENTRY_STATUSES as readonly string[]).includes(v)) {
            e.status = v as EntryStatus;
            statusFound = ok = true;
          } else {
            e.extra.push(...raw);
            statusBad = value;
          }
          break;
        }
        case "author":
          if (value) e.author = value;
          ok = value !== "";
          break;
        case "created":
        case "updated":
          if (!value) break;
          if (validDate(value)) e[key] = value;
          else keep(`${key} is not a date: ${value}`);
          ok = e[key] === value;
          break;
        case "supersedes": {
          if (!value) break;
          const ids = value.split(",").map(normalizeLocal);
          if (ids.every((x) => x !== null)) e.supersedes = ids as string[];
          else keep(`supersedes is not a list of IDs: ${value}`);
          ok = e.supersedes.length > 0;
          break;
        }
        case "superseded-by": {
          if (!value) break;
          const id = normalizeLocal(value);
          if (id) e.supersededBy = id;
          else keep(`superseded-by is not an ID: ${value}`);
          ok = id !== null;
          break;
        }
        case "evidence": {
          const items = [...(value ? value.split(",") : []), ...nested.map((n) => n.replace(/^[ \t]*(?:[-*+][ \t]+)?/, ""))];
          e.evidence = items.map(trimBlank).filter((x) => x !== "");
          ok = true;
          break;
        }
        default:
          e.extra.push(...raw);
      }
    }
    if (ok) keys.add(key);
  }
  if (!statusFound) {
    problem(statusBad ? `unknown status: ${statusBad}` : "status is missing");
    if (e.extra.some((l) => STATUS_BULLET_RE.test(l))) e.statusInExtra = true;
  }

  // The free text, then the labelled lines. Text after a label's value goes to the content.
  const labels = labelsOf(type);
  const content: string[] = [];
  const values = new Map<string, string[]>();
  let cur: string[] | null = null;
  let seenLabel = false;
  for (; i < end; i++) {
    const s = chomp(lines[i]);
    const lm = kinds[i].kind === "text" ? LABEL_RE.exec(s) : null;
    if (lm && labels.includes(lm[1])) {
      cur = values.get(lm[1]) ?? [];
      values.set(lm[1], cur);
      // An empty label line is kept as an empty first line: the value then starts with a line break.
      if (cur.length === 0 || lm[2] !== "") cur.push(trimBlank(lm[2]));
      seenLabel = true;
    } else if (cur && (kinds[i].kind === "code" || !isBlank(s))) {
      cur.push(s);
    } else {
      cur = null;
      if (seenLabel || content.length || !isBlank(s)) content.push(s);
    }
  }
  // Lines of only spaces at either end of the content are blank lines too.
  while (content.length && isBlank(content[0])) content.shift();
  while (content.length && isBlank(content[content.length - 1])) content.pop();
  e.content = content.join("\n");
  const value = (label: string) => (values.get(label) ?? []).join("\n");
  e.rationale = value("Rationale");
  e.alternatives = value("Alternatives");
  if (type === "rejected") {
    e.rejected = {
      attempted: value("Attempted"),
      promising: value("Promising"),
      happened: value("Happened"),
      failed: value("Failed"),
      applies: value("Applies"),
    };
  }
  return e;
}

/** The canonical text of an entry: heading, metadata bullets, content, labelled lines. */
export function formatEntry(e: ContextEntry, eol: string): string {
  const out = [`### ${LETTERS[e.type]}${e.number}: ${e.subject}`];
  // A status bullet kept in `extra` is the status line, unless the status was changed since: no second line hides it.
  const isValid = (x: string) => (ENTRY_STATUSES as readonly string[]).includes(x);
  const bullets = e.extra.map((l) => STATUS_BULLET_RE.exec(l)).filter((m) => m !== null);
  const kept = bullets.find((m) => isValid(trimBlank(m[1]).toLowerCase())) ?? bullets[0];
  const v = kept ? trimBlank(kept[1]).toLowerCase() : null;
  const valid = v !== null && isValid(v);
  const badStatus = kept !== undefined && e.statusInExtra === true && (v === e.status || (!valid && e.status === "active"));
  if (!badStatus) out.push(`- status: ${e.status}`);
  if (e.author) out.push(`- author: ${e.author}`);
  if (e.created) out.push(`- created: ${e.created}`);
  if (e.updated) out.push(`- updated: ${e.updated}`);
  if (e.supersedes.length) out.push(`- supersedes: ${e.supersedes.join(", ")}`);
  if (e.supersededBy) out.push(`- superseded-by: ${e.supersededBy}`);
  if (e.evidence.length) out.push("- evidence:", ...e.evidence.map((x) => `  - ${x}`));
  out.push(...e.extra);
  const labelled: string[] = [];
  const label = (name: string, value: string) => {
    if (!value) return;
    // A value that starts with a line break stands on the lines under its label, so a fence there opens as one.
    labelled.push(value.startsWith("\n") ? `${name}:${value}` : `${name}: ${value}`);
  };
  label("Rationale", e.rationale);
  label("Alternatives", e.alternatives);
  if (e.type === "rejected" && e.rejected) {
    label("Attempted", e.rejected.attempted);
    label("Promising", e.rejected.promising);
    label("Happened", e.rejected.happened);
    label("Failed", e.rejected.failed);
    label("Applies", e.rejected.applies);
  }
  if (e.content) out.push("", ...e.content.split("\n"));
  if (labelled.length) out.push("", ...labelled.flatMap((l) => l.split("\n")));
  return out.map((l) => l + eol).join("");
}

/** One more than the highest number of an entry with this letter (any case); 1 when there is none. Duplicates count. */
export function nextNumber(text: string, letter: string): number {
  const l = letter.toUpperCase();
  let max = 0;
  for (const e of parseContext(text).entries) if (e.local[0] === l && e.number > max) max = e.number;
  return max + 1;
}

const BAD_BREAK_RE = /[\r\n]/;

/** Problems of one free text field, `content` or a labelled value. See `checkEntry`. */
function checkField(name: string, value: string, labels: string[], labelled: boolean, out: string[]): void {
  if (value === "") return;
  if (value.includes("\r")) out.push(`${name} has a carriage return`);
  const all = value.split("\n");
  // The first line of a value that does not start with a line break stands on the label line, not at column 0.
  const own = labelled && !value.startsWith("\n");
  if (own) {
    if (all[0] !== trimBlank(all[0])) out.push(`${name} starts or ends with a space or tab`);
  } else if (!labelled && (isBlank(all[0]) || isBlank(all[all.length - 1]))) {
    out.push(`${name} starts or ends with a blank line`);
  }
  const rest = labelled ? all.slice(1) : all;
  const text = rest.map((l) => l + "\n");
  const kinds = classify(text);
  if (classify([...text, "x\n"])[text.length].kind === "code") out.push(`${name} has a code fence that is not closed`);
  rest.forEach((line, i) => {
    const k = kinds[i];
    if (k.kind === "heading" && k.level <= 3) out.push(`${name} has a heading of level ${k.level}: ${line}`);
    if (k.kind === "text") {
      const lm = LABEL_RE.exec(line);
      if (lm && labels.includes(lm[1])) out.push(`${name} has a line that starts with a label: ${line}`);
    }
    if (labelled && k.kind !== "code" && isBlank(line)) out.push(`${name} has a blank line`);
  });
}

/**
 * Problems that make an entry unsafe to write, as texts; empty when it is safe. An entry that passes is read back
 * as the same entry by `parseContext`.
 */
export function checkEntry(e: ContextEntry): string[] {
  const out: string[] = [];
  const letter = (Object.keys(TYPE_LETTERS) as string[]).find((l) => TYPE_LETTERS[l as keyof typeof TYPE_LETTERS] === e.type);
  if (!letter) out.push(`unknown type: ${String(e.type)}`);
  else if (!Number.isInteger(e.number) || e.number < 0) out.push(`number is not a whole number: ${e.number}`);
  else if (e.local !== `${letter}${e.number}`) out.push(`local ID ${e.local} does not match the type and number`);
  if (BAD_BREAK_RE.test(e.subject) || trimBlank(e.subject) === "") out.push("subject is empty or has a line break");
  else if (e.subject !== trimBlank(e.subject)) out.push("subject starts or ends with a space or tab");
  else if (/(^|[ \t])#+$/.test(e.subject)) out.push("subject ends with a # that reads as a closing mark of the heading");
  if (!(ENTRY_STATUSES as readonly string[]).includes(e.status)) out.push(`unknown status: ${String(e.status)}`);
  if (e.author !== null && (BAD_BREAK_RE.test(e.author) || e.author === "" || e.author !== trimBlank(e.author))) {
    out.push("author is empty, has a line break, or starts or ends with a space or tab");
  }
  for (const key of ["created", "updated"] as const) {
    if (e[key] !== null && !validDate(e[key])) out.push(`${key} is not a date: ${String(e[key])}`);
  }
  for (const id of e.supersedes) if (normalizeLocal(id) !== id) out.push(`supersedes has a bad ID: ${id}`);
  if (e.supersededBy !== null && normalizeLocal(e.supersededBy) !== e.supersededBy) {
    out.push(`superseded-by is not an ID: ${e.supersededBy}`);
  }
  for (const item of e.evidence) {
    if (BAD_BREAK_RE.test(item) || trimBlank(item) === "") out.push("an evidence item is empty or has a line break");
    else if (item !== trimBlank(item) || /^[-*+][ \t]/.test(item)) out.push(`evidence item is not safe to write: ${item}`);
  }
  if (e.extra.some((l) => BAD_BREAK_RE.test(l))) out.push("an extra line has a line break");
  const labels = labelsOf(e.type);
  checkField("content", e.content, labels, false, out);
  checkField("rationale", e.rationale, labels, true, out);
  checkField("alternatives", e.alternatives, labels, true, out);
  if (e.type === "rejected" && e.rejected) {
    for (const key of ["attempted", "promising", "happened", "failed", "applies"] as const) {
      checkField(key, e.rejected[key], labels, true, out);
    }
  }
  // The safety net: what is written must read back as the same entry, and as one entry only.
  if (out.length === 0) {
    const back = parseContext(`## ${CONTEXT}\n\n${formatEntry(e, "\n")}`).entries;
    if (back.length !== 1) out.push(`it is written as ${back.length} entries, not one`);
    else if (!sameEntry(back[0], e)) out.push("it does not read back as the same entry when it is written");
  }
  return out;
}

/** The entry as a value to compare: no range, and no `statusInExtra`, which only steers how the entry is written. */
function canonical(e: ContextEntry): string {
  const { range, statusInExtra, ...rest } = e;
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sort(x)]))
        : v;
  return JSON.stringify(sort(rest));
}

function sameEntry(a: ContextEntry, b: ContextEntry): boolean {
  return canonical(a) === canonical(b);
}

function assertEntry(e: ContextEntry): void {
  const problems = checkEntry(e);
  if (problems.length) throw new Error(`Context entry ${e.local} is not safe to write: ${problems.join("; ")}`);
}

/**
 * Add an entry at the end of the `## Context log` section of a note (frontmatter allowed). Without the section, it is
 * created before `## Comments`, or at the end of the note when there is no such section. The tracker index note
 * has no `## Comments`, so there the section goes at the end.
 */
export function insertEntry(text: string, e: ContextEntry): string {
  assertEntry(e);
  const doc = new Doc(text);
  const eol = doc.eol;
  const lines = splitLines(doc.body);
  const block = formatEntry(e, eol);
  const { sections } = findSections(lines, [CONTEXT, COMMENTS]);
  const context = sections.get(CONTEXT);
  const comments = sections.get(COMMENTS);
  if (context) {
    const [start, end] = context;
    let pos = start + 1;
    for (let i = start + 1; i < end; i++) {
      if (!isBlank(lines[i])) pos = i + 1;
    }
    if (!hasEol(lines[pos - 1])) lines[pos - 1] += eol;
    // A heading directly after the section gets its blank line.
    const after = pos < lines.length && !isBlank(lines[pos]) ? eol : "";
    lines.splice(pos, 0, eol, block + after);
  } else if (comments) {
    const at = comments[0];
    const before = at > 0 && !isBlank(lines[at - 1]) ? [eol] : [];
    lines.splice(at, 0, ...before, `## ${CONTEXT}${eol}`, eol, block, eol);
  } else {
    const n = lines.length;
    if (n && !hasEol(lines[n - 1])) lines[n - 1] += eol;
    if ((n && !isBlank(lines[n - 1])) || (!n && doc.hasFm)) lines.push(eol);
    lines.push(`## ${CONTEXT}${eol}`, eol, block);
  }
  doc.body = lines.join("");
  const out = doc.text();
  const back = parseContext(out).entries.filter((x) => x.local === e.local);
  if (back.length === 0 || !sameEntry(back[back.length - 1], e)) {
    throw new Error(`Context entry ${e.local} is not found after it is written: a code fence in the note is not closed`);
  }
  return out;
}

/**
 * Change the first entry with a local ID. Only the lines of that entry are replaced; the blank lines after it, the
 * other lines and a missing final line break stay as they are. Throws when there is no such entry or when the
 * changed entry is not safe to write.
 */
export function patchEntry(text: string, local: string, patch: (e: ContextEntry) => ContextEntry): string {
  const want = normalizeLocal(local) ?? local;
  const found = parseContext(text).entries.find((x) => x.local === want);
  if (!found) throw new Error(`There is no context entry ${local}`);
  const [from, to] = found.range;
  const changed = patch(found);
  assertEntry(changed);
  const eol = detectEol(text);
  const lines = splitLines(text);
  const old = lines.slice(from, to);
  let keep = old.length;
  while (keep > 0 && isBlank(old[keep - 1])) keep--;
  const tail = old.slice(keep);
  let block = formatEntry(changed, eol);
  // The last line of the note had no terminator, and it still has none.
  if (tail.length === 0 && old.length > 0 && !hasEol(old[old.length - 1])) block = block.slice(0, -eol.length);
  lines.splice(from, to - from, block, ...tail);
  return lines.join("");
}

/**
 * The note without its `## Context log` section, heading and content. It takes the whole note, as `parseContext` does,
 * so the section is found with the frontmatter in the way of nothing. When the section was the last of the note,
 * the blank lines before it go too.
 */
export function stripContext(text: string): string {
  const doc = new Doc(text);
  const lines = splitLines(doc.body);
  const found = findSections(lines, [CONTEXT]).sections.get(CONTEXT);
  if (!found) return text;
  let [start, end] = found;
  if (end >= lines.length) while (start > 0 && isBlank(lines[start - 1])) start--;
  lines.splice(start, end - start);
  doc.body = lines.join("");
  return doc.text();
}

/**
 * The note without the lines of its context entries. Text of the `## Context log` section that is not an entry
 * (prose, a `### Notes` block) stays. The heading goes only when the rest of the section is blank. A note
 * without entries is returned as it is. Like `stripContext`, it takes the whole note.
 */
export function stripEntries(text: string): string {
  const parsed = parseContext(text);
  if (!parsed.section || parsed.entries.length === 0) return text;
  const lines = splitLines(text);
  const [from, to] = parsed.section;
  let removed = 0;
  for (const [a, b] of parsed.entries.map((e) => e.range).sort((x, y) => y[0] - x[0])) {
    lines.splice(a, b - a);
    removed += b - a;
  }
  const end = to - removed;
  if (lines.slice(from + 1, end).every(isBlank)) {
    let start = from;
    if (end >= lines.length) while (start > 0 && isBlank(lines[start - 1])) start--;
    lines.splice(start, end - start);
  }
  return lines.join("");
}
