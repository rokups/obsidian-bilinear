// Saved views live in a `bilinear-views` JSON code block in the index body.
// The CLI ignores the block; everything outside it is left untouched.

import { ISSUES } from "../format/ids";
import { chomp, hasEol, isBlank, splitLines, trimBlank } from "../format/lines";
import { findSections } from "../format/markdown";
import { Doc } from "../format/yaml";
import { normalizeSpec, type ViewSpec } from "./query";

export interface SavedView extends ViewSpec {
  name: string;
}

const BLOCK = "bilinear-views";
const OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*bilinear-views[ \t]*$/;

/** [first content line, closing fence line] of the block in body lines. */
function findBlock(lines: string[]): [number, number] | null {
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN_RE.exec(chomp(lines[i]));
    if (!m) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const t = trimBlank(chomp(lines[j]));
      if (t.length >= m[1].length && [...t].every((c) => c === m[1][0])) return [i + 1, j];
    }
    return [i + 1, lines.length];
  }
  return null;
}

export function readViews(indexText: string): SavedView[] {
  const lines = splitLines(new Doc(indexText).body);
  const block = findBlock(lines);
  if (!block) return [];
  let data: unknown;
  try {
    data = JSON.parse(lines.slice(block[0], block[1]).join(""));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: SavedView[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object" || typeof (raw as { name?: unknown }).name !== "string") continue;
    const name = (raw as { name: string }).name.trim();
    if (name && !out.some((v) => v.name === name)) out.push({ name, ...normalizeSpec(raw) });
  }
  return out;
}

/** Replace the block's contents, or add the block just before `## Issues`. */
export function writeViews(indexText: string, views: SavedView[]): string {
  const doc = new Doc(indexText);
  const eol = doc.eol;
  const lines = splitLines(doc.body);
  const json = JSON.stringify(views, null, 2)
    .split("\n")
    .map((l) => l + eol);
  const block = findBlock(lines);
  if (block) {
    lines.splice(block[0], block[1] - block[0], ...json);
  } else {
    if (!views.length) return indexText;
    const section = findSections(lines, [ISSUES]).sections.get(ISSUES);
    const added = ["```" + BLOCK + eol, ...json, "```" + eol, eol];
    if (section) {
      const pos = section[0];
      if (pos > 0 && !isBlank(lines[pos - 1])) added.unshift(eol);
      lines.splice(pos, 0, ...added);
    } else {
      const n = lines.length;
      if (n && !hasEol(lines[n - 1])) lines[n - 1] += eol;
      if (n && !isBlank(lines[n - 1])) lines.push(eol);
      lines.push(...added.slice(0, -1));
    }
  }
  doc.body = lines.join("");
  return doc.text();
}
