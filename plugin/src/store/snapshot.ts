// What a tracker view shows: the index list resolved against the notes.

import { ID_RE, LOCATIONS, NON_DESCRIPTION_SECTIONS } from "../format/ids";
import { Index } from "../format/index-note";
import { recordFromFrontmatter, type IssueRecord } from "../format/record";
import { joinPath } from "../ops/io";
import { folderOf, pathIn, searchOrder } from "../ops/tracker";
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
  /** The other trackers of the folder whose issues this one's may link to; empty when this one is alone. */
  siblings: SiblingSnapshot[];
}

/** Another tracker of the folder: its index note and its issues, open and archived. */
export interface SiblingSnapshot {
  /** The index note's name, for display. */
  name: string;
  /** The index note's path. */
  path: string;
  config: TrackerConfig;
  issues: IssueRecord[];
  archived: IssueRecord[];
}

/** The text of an index note. */
export interface IndexNote {
  path: string;
  text: string;
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
 * outside the `## Comments` and `## Context` sections. (The cache already leaves out code and
 * frontmatter.)
 */
export function descriptionLinks(cache: LinkCache | null | undefined): string[] {
  if (!cache) return [];
  const headings = cache.headings ?? [];
  // The first level-2 heading of each section that is not description, up to the next heading of level 1 or 2.
  const skipped: Array<[number, number]> = [];
  const seen = new Set<string>();
  headings.forEach((h, i) => {
    const name = h.heading.trim();
    if (h.level !== 2 || !NON_DESCRIPTION_SECTIONS.includes(name) || seen.has(name)) return;
    seen.add(name);
    const next = headings.slice(i + 1).find((x) => x.level <= 2);
    skipped.push([h.position.start.line, next ? next.position.start.line : Infinity]);
  });
  return [...(cache.links ?? []), ...(cache.embeds ?? [])]
    .filter((l) => !skipped.some(([a, b]) => l.position.start.line >= a && l.position.start.line < b))
    .sort((a, b) => a.position.start.offset - b.position.start.offset)
    .map((l) => l.link);
}

export function emptySnapshot(): Snapshot {
  return {
    config: { prefix: null, next: null, states: [], closedStates: [], triageState: null, labels: [], labelColors: {}, stateIcons: {}, stateColors: {} },
    issues: [],
    archived: [],
    views: [],
    problems: [],
    siblings: [],
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
    triageState: idx.triageState,
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

/**
 * The trackers among these index notes (the other trackers of the folder) whose issues this one's may link to as
 * theirs: those whose prefix is valid, is not this one's and is not shared. The folder-named note comes first, then by path.
 */
export function buildSiblings(own: TrackerConfig, dir: string, notes: IndexNote[], lookup: NoteLookup): SiblingSnapshot[] {
  const built = notes.map((note) => ({ note, snap: buildSnapshot(note.text, dir, lookup) }));
  const usable = built.filter(({ snap }) => snap.config.prefix !== null && snap.config.prefix !== own.prefix);
  const folderNote = joinPath(dir, `${dir.slice(dir.lastIndexOf("/") + 1)}.md`);
  const rank = (path: string) => (path === folderNote ? 0 : 1);
  return usable
    .filter(({ snap }) => usable.filter((other) => other.snap.config.prefix === snap.config.prefix).length === 1)
    .sort((a, b) => rank(a.note.path) - rank(b.note.path) || (a.note.path < b.note.path ? -1 : a.note.path > b.note.path ? 1 : 0))
    .map(({ note, snap }) => ({
      name: note.path.slice(note.path.lastIndexOf("/") + 1).replace(/\.md$/, ""),
      path: note.path,
      config: snap.config,
      issues: snap.issues,
      archived: snap.archived,
    }));
}

/** What `touches` knows about a tracker's surroundings. */
export interface Surroundings {
  dir: string;
  indexPath: string;
  /** This tracker's prefix: null while its index has none that is valid. */
  prefix: string | null;
  /** The prefixes of its siblings. */
  siblingPrefixes: string[];
  /** The IDs on the index lines of this tracker and its siblings. */
  listed: Set<string>;
  /** The index notes of the siblings, as last read. */
  siblingPaths: Set<string>;
  /** Whether the metadata cache says a note carries `bilinear: tracker`. */
  isTracker: (path: string) => boolean;
}

/**
 * Does a change to this path call for a reload? Yes for the index, for an index note of another tracker in the
 * folder, and for a note of this tracker or a sibling in issues/, archive/ or the folder: a note is a tracker's if it
 * has its prefix or is listed in it.
 */
export function touches(path: string, s: Surroundings): boolean {
  if (path === s.indexPath || s.siblingPaths.has(path)) return true;
  const slash = path.lastIndexOf("/");
  const parent = slash < 0 ? "" : path.slice(0, slash);
  if (parent === s.dir && path.endsWith(".md") && s.isTracker(path)) return true;
  if (!LOCATIONS.some((where) => parent === folderOf(s.dir, where))) return false;
  const id = path.slice(slash + 1).replace(/\.md$/, "");
  const prefix = ID_RE.exec(id)?.[1];
  return s.prefix === null || (prefix !== undefined && (prefix === s.prefix || s.siblingPrefixes.includes(prefix))) || s.listed.has(id);
}
