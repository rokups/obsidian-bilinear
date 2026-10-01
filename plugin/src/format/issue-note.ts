import { COMMENTS, cleanTitle } from "./ids";
import { hasEol, isBlank, splitLines } from "./lines";
import { findSections } from "./markdown";
import { Doc, type Value } from "./yaml";

export const NOTE_KEY_ORDER = ["title", "status", "priority", "labels", "assignee", "due", "parent", "blocked-by", "created"];

export function newNoteText(props: Record<string, Value | undefined>): string {
  const doc = new Doc("");
  for (const key of NOTE_KEY_ORDER) {
    const value = props[key];
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) continue;
    doc.set(key, value);
  }
  return doc.text();
}

/** Append `- <date> <author>: <text>` under `## Comments`, creating the section if needed. */
export function addComment(text: string, date: string, author: string, comment: string): string {
  const doc = new Doc(text);
  const eol = doc.eol;
  const lines = splitLines(doc.body);
  const entry = `- ${date} ${author}: ${cleanTitle(comment)}${eol}`;
  const section = findSections(lines, [COMMENTS]).sections.get(COMMENTS);
  if (section) {
    const [start, end] = section;
    let pos = start + 1;
    for (let i = start + 1; i < end; i++) {
      if (!isBlank(lines[i])) pos = i + 1;
    }
    if (!hasEol(lines[pos - 1])) lines[pos - 1] += eol;
    lines.splice(pos, 0, entry);
  } else {
    const n = lines.length;
    if (n && !hasEol(lines[n - 1])) lines[n - 1] += eol;
    if ((n && !isBlank(lines[n - 1])) || (!n && doc.hasFm)) lines.push(eol);
    lines.push(`## ${COMMENTS}${eol}`, entry);
  }
  doc.body = lines.join("");
  return doc.text();
}

export interface Comment {
  date: string;
  author: string;
  text: string;
}

const COMMENT_RE = /^[ \t]*[-*+][ \t]+([0-9]{4}-[0-9]{2}-[0-9]{2})[ \t]+([^:]+?):[ \t]*(.*)$/;

export function parseComments(text: string): Comment[] {
  const lines = splitLines(new Doc(text).body);
  const section = findSections(lines, [COMMENTS]).sections.get(COMMENTS);
  if (!section) return [];
  const out: Comment[] = [];
  for (let i = section[0] + 1; i < section[1]; i++) {
    const m = COMMENT_RE.exec(lines[i].replace(/\r?\n$/, ""));
    if (m) out.push({ date: m[1], author: m[2], text: m[3] });
  }
  return out;
}
