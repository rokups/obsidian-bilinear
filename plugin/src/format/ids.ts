import { trimBlank } from "./lines";

export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export const DEFAULT_STATES = ["backlog", "todo", "in-progress", "in-review", "done", "canceled"];
export const DEFAULT_CLOSED = ["done", "canceled"];
export const ISSUES = "Issues";
export const ARCHIVE = "Archive";
export const COMMENTS = "Comments";
export const ARCHIVE_DIR = "archive";
export const LIST_KEYS = ["labels", "blocked-by"];

export const ID_RE = /^([A-Z][A-Z0-9]*)-([0-9]+)$/;
export const PREFIX_RE = /^[A-Z][A-Z0-9]*$/;
const LINK_RE = /^\[\[([^[\]]*)\]\]$/;

/** Reduce a wikilink body (`path/RB-4.md#h|alias`) to its note name. */
export function linkTarget(inner: string): string {
  let s = trimBlank(inner.split(/[|#]/, 1)[0]);
  s = s.slice(s.lastIndexOf("/") + 1);
  if (s.endsWith(".md")) s = s.slice(0, -3);
  return s;
}

/** Issue ID named by a property value: `[[RB-9]]` or a bare `RB-9`. */
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
