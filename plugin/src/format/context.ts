import {
  ENTRY_STATUSES,
  ID_RE,
  PREFIX_RE,
  CONTEXT,
  TYPE_LETTERS,
  validDate,
  type EntryStatus,
  type EntryType,
} from "./ids";
import { chomp, isBlank, splitLines, trimBlank } from "./lines";
import { findSections, type LineKind } from "./markdown";
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
  /** [heading line, end line (exclusive)] of `## Context`, or null if there is none. */
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
const LETTERS = Object.fromEntries(Object.entries(TYPE_LETTERS).map(([letter, type]) => [type, letter])) as Record<
  EntryType,
  string
>;

/** `d3` -> `D3`; null when it is not a local ID of a known type. */
function normalizeLocal(s: string): string | null {
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
 * Entries under `## Context` of a note's text (frontmatter allowed). Ranges and
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
  const labels = type === "rejected" ? [...REJECTED_LABELS, "Rationale", "Alternatives"] : ["Rationale", "Alternatives"];
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
  e.content = content.join("\n").replace(/^\n+|\n+$/g, "");
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
  const badStatus = e.statusInExtra === true && (v === e.status || (!valid && e.status === "active"));
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
