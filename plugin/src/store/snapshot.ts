// What a tracker view shows: the index list resolved against the notes.

import { Index } from "../format/index-note";
import { recordFromFrontmatter, type IssueRecord } from "../format/record";
import { notePath } from "../ops/tracker";
import type { Tracker } from "../ops/io";
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

/**
 * Frontmatter of the note at a path as the metadata cache has it:
 * undefined when there is no such note, null when it has no frontmatter.
 */
export type NoteLookup = (path: string) => Record<string, unknown> | null | undefined;

export function emptySnapshot(): Snapshot {
  return { config: { prefix: null, next: null, states: [], closedStates: [], labels: [] }, issues: [], archived: [], views: [], problems: [] };
}

export function buildSnapshot(indexText: string, dir: string, lookup: NoteLookup): Snapshot {
  const idx = new Index(indexText);
  const snap = emptySnapshot();
  snap.config = { prefix: idx.prefix, next: idx.next, states: idx.states, closedStates: idx.closedStates, labels: idx.labels };
  snap.problems = idx.doc.broken ? idx.doc.problems() : idx.keyProblems();
  snap.views = readViews(indexText);
  const t = { dir } as Tracker;
  for (const item of idx.unique()) {
    let rec: IssueRecord | null = null;
    // The location matching the line's section first, then the other.
    for (const archived of [item.archived, !item.archived]) {
      const path = notePath(t, item.id, archived);
      const fm = lookup(path);
      if (fm !== undefined) {
        rec = recordFromFrontmatter(item, fm, path);
        break;
      }
    }
    rec ??= recordFromFrontmatter(item, null, null);
    (item.archived ? snap.archived : snap.issues).push(rec);
  }
  return snap;
}
