// What a tracker view shows: the index list resolved against the notes.

import { COMMENTS } from "../format/ids";
import { Index } from "../format/index-note";
import { recordFromFrontmatter, type IssueRecord } from "../format/record";
import { pathIn, searchOrder } from "../ops/tracker";
import type { TrackerConfig } from "./query";
import { readViews, type SavedView } from "./views";

export interface Snapshot {
  config: TrackerConfig;
  /** Open issues in index order. */
  issues: IssueRecord[];
  /** Archived issues in index order. */
  archived: IssueRecord[];
  views: SavedView[];
  /** Why the index cannot be used, if it cannot. */
  problems: string[];
}

/** What the metadata cache knows about a note. */
export interface NoteInfo {
  frontmatter: Record<string, unknown> | null;
  /** Targets of the links and embeds in the description. */
  links: string[];
}

/** The note at a path, or undefined when there is no such note. */
export type NoteLookup = (path: string) => NoteInfo | undefined;

/** The parts of Obsidian's `CachedMetadata` that `descriptionLinks` reads. */
export interface LinkCache {
  links?: Array<{ link: string; position: { start: { line: number; offset: number } } }>;
  embeds?: Array<{ link: string; position: { start: { line: number; offset: number } } }>;
  headings?: Array<{ heading: string; level: number; position: { start: { line: number } } }>;
}

/**
 * Link targets in a note's description, in document order: links and embeds
 * outside the `## Comments` section. (The cache already leaves out code and
 * frontmatter.)
 */
export function descriptionLinks(cache: LinkCache | null | undefined): string[] {
  if (!cache) return [];
  const headings = cache.headings ?? [];
  const at = headings.findIndex((h) => h.level === 2 && h.heading.trim() === COMMENTS);
  const from = at < 0 ? Infinity : headings[at].position.start.line;
  const next = at < 0 ? undefined : headings.slice(at + 1).find((h) => h.level <= 2);
  const to = next ? next.position.start.line : Infinity;
  return [...(cache.links ?? []), ...(cache.embeds ?? [])]
    .filter((l) => l.position.start.line < from || l.position.start.line >= to)
    .sort((a, b) => a.position.start.offset - b.position.start.offset)
    .map((l) => l.link);
}

export function emptySnapshot(): Snapshot {
  return {
    config: { prefix: null, next: null, states: [], closedStates: [], labels: [], labelColors: {}, stateIcons: {}, stateColors: {} },
    issues: [],
    archived: [],
    views: [],
    problems: [],
  };
}

export function buildSnapshot(indexText: string, dir: string, lookup: NoteLookup): Snapshot {
  const idx = new Index(indexText);
  const snap = emptySnapshot();
  snap.config = {
    prefix: idx.prefix,
    next: idx.next,
    states: idx.states,
    closedStates: idx.closedStates,
    labels: idx.labels,
    labelColors: idx.labelColors,
    stateIcons: idx.stateIcons,
    stateColors: idx.stateColors,
  };
  snap.problems = idx.doc.broken ? idx.doc.problems() : idx.keyProblems();
  snap.views = readViews(indexText);
  for (const item of idx.unique()) {
    let rec: IssueRecord | null = null;
    // Where the line's section says, then the other folder, then the tracker folder.
    for (const where of searchOrder(item.archived)) {
      const path = pathIn({ dir }, item.id, where);
      const note = lookup(path);
      if (note !== undefined) {
        rec = recordFromFrontmatter(item, note.frontmatter, path, note.links);
        break;
      }
    }
    rec ??= recordFromFrontmatter(item, null, null);
    (item.archived ? snap.archived : snap.issues).push(rec);
  }
  return snap;
}
