import { trimBlank } from "./lines";

export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export const DEFAULT_STATES = ["triage", "backlog", "todo", "in-progress", "in-review", "done", "canceled"];
/** Of DEFAULT_STATES, the one for issues that wait for the user to accept or reject them. */
export const DEFAULT_TRIAGE = "triage";
export const DEFAULT_CLOSED = ["done", "canceled"];
export const ISSUES = "Issues";
export const ARCHIVE = "Archive";
export const COMMENTS = "Comments";
export const CONTEXT = "Context log";
/** Sections of an issue note whose links are not those of the description. */
export const NON_DESCRIPTION_SECTIONS = [COMMENTS, CONTEXT];
export const ISSUES_DIR = "issues";
export const ARCHIVE_DIR = "archive";

/**
 * Where a note can be: the folder for open issues, the archive, or directly
 * in the tracker folder (the layout before issues/ existed; still read).
 */
export type Location = "issues" | "archive" | "root";
export const LOCATIONS: Location[] = ["issues", "archive", "root"];

export const COLOR_NAMES = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray"];
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** A colour name from COLOR_NAMES (any letter case) or #rgb / #rrggbb; else null. */
export function normalizeColor(color: string): string | null {
  const c = trimBlank(color);
  if (COLOR_NAMES.includes(c.toLowerCase())) return c.toLowerCase();
  return HEX_COLOR_RE.test(c) ? c : null;
}

/** Shapes the plugin draws itself. Any other icon value names a Lucide icon. */
export const STATE_SHAPES = ["dashed", "circle", "quarter", "half", "three-quarters", "check", "cross"];
const ICON_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** One of STATE_SHAPES, or a Lucide icon name such as `rocket` (a `lucide-` prefix is dropped). */
export function normalizeIcon(icon: string): string | null {
  let i = trimBlank(icon).toLowerCase();
  if (i.startsWith("lucide-")) i = i.slice("lucide-".length);
  return ICON_RE.test(i) ? i : null;
}

export type Normalize = (value: string) => string | null;

/** Split a `name=value` entry at its last `=` and normalize the value. */
export function parsePair(entry: string, normalize: Normalize): [string, string] | null {
  const at = entry.lastIndexOf("=");
  if (at < 0) return null;
  const name = trimBlank(entry.slice(0, at));
  const value = normalize(entry.slice(at + 1));
  return name && value !== null ? [name, value] : null;
}
/** The type of a context entry, by the letter of its local ID (`D3` is a decision). */
export const TYPE_LETTERS = {
  D: "decision",
  C: "constraint",
  F: "finding",
  R: "rejected",
  Q: "question",
  S: "state",
  A: "artifact",
} as const;
export type EntryType = (typeof TYPE_LETTERS)[keyof typeof TYPE_LETTERS];
export const ENTRY_STATUSES = ["active", "superseded", "resolved"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const LIST_KEYS = ["labels", "blocked-by", "related-to"];
/** The list properties whose values are links to issues. */
export const LINK_LIST_KEYS = ["blocked-by", "related-to"];

export const ID_RE = /^([A-Z][A-Z0-9]*)-([0-9]+)$/;
export const PREFIX_RE = /^[A-Z][A-Z0-9]*$/;
const LINK_RE = /^\[\[([^[\]]*)\]\]$/;

/** Reduce a wikilink body (`path/BL-4.md#h|alias`) to its note name. */
export function linkTarget(inner: string): string {
  let s = trimBlank(inner.split(/[|#]/, 1)[0]);
  s = s.slice(s.lastIndexOf("/") + 1);
  if (s.endsWith(".md")) s = s.slice(0, -3);
  return s;
}

/** Issue ID named by a property value: `[[BL-9]]` or a bare `BL-9`. */
export function linkId(value: string | null | undefined): string | null {
  if (!value) return null;
  let s = trimBlank(value);
  const m = LINK_RE.exec(s);
  if (m) s = linkTarget(m[1]);
  return ID_RE.test(s) ? s : null;
}

export function makeLink(id: string): string {
  return `[[${id}]]`;
}

export function idNumber(id: string, prefix: string | null): number | null {
  const m = ID_RE.exec(id);
  if (m && (prefix === null || m[1] === prefix)) return parseInt(m[2], 10);
  return null;
}

/** Titles and comments are single-line: collapse whitespace, trim. */
export function cleanTitle(title: string | null | undefined): string {
  return (title ?? "").replace(/\s+/g, " ").trim();
}

export function formatLine(id: string, title: string): string {
  return title ? `- [[${id}]] ${title}` : `- [[${id}]]`;
}

export function validDate(s: string | null | undefined): boolean {
  if (!s || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (y < 1) return false;
  const date = new Date(Date.UTC(2000, m - 1, d));
  date.setUTCFullYear(y);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function todayIso(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
