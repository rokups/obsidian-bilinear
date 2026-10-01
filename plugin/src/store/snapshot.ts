// What a tracker view shows: the index list resolved against the notes.

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

/**
 * Frontmatter of the note at a path as the metadata cache has it:
 * undefined when there is no such note, null when it has no frontmatter.
 */
export type NoteLookup = (path: string) => Record<string, unknown> | null | undefined;

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
