// Reading the tracker and the index commit step shared by all operations.

import { ARCHIVE_DIR, ID_RE, ISSUES_DIR, LOCATIONS, cleanTitle, type Location } from "../format/ids";
import { Index, type Item } from "../format/index-note";
import { recordFromDoc, type IssueRecord } from "../format/record";
import { Doc } from "../format/yaml";
import { issueRelations, linkedProgress, makeClosed, type ClosedFn, type Progress, type Relations } from "../store/query";
import { OpError, joinPath, type Tracker } from "./io";

export function place(archived: boolean): Location {
  return archived ? "archive" : "issues";
}

export function folderOf(dir: string, where: Location): string {
  return where === "root" ? dir : joinPath(dir, where === "issues" ? ISSUES_DIR : ARCHIVE_DIR);
}

export function pathIn(t: Pick<Tracker, "dir">, id: string, where: Location): string {
  return joinPath(folderOf(t.dir, where), `${id}.md`);
}

/** Where the note belongs: issues/ for an open issue, archive/ for an archived one. */
export function notePath(t: Pick<Tracker, "dir">, id: string, archived: boolean): string {
  return pathIn(t, id, place(archived));
}

/** The order in which a line's note is looked for: where its section says, the other folder, the tracker folder. */
export function searchOrder(archived: boolean): Location[] {
  return [place(archived), place(!archived), "root"];
}

export function describe(where: Location | Location[]): string {
  const names: Record<Location, string> = { issues: `${ISSUES_DIR}/`, archive: `${ARCHIVE_DIR}/`, root: "the tracker folder" };
  return Array.isArray(where) ? where.map((w) => names[w]).join(", ") : names[where];
}

/** The locations that hold a note for this ID. */
export async function found(t: Tracker, id: string): Promise<Location[]> {
  const out: Location[] = [];
  for (const where of LOCATIONS) {
    if (await t.io.exists(pathIn(t, id, where))) out.push(where);
  }
  return out;
}

/** The note for an index line, or null if it is missing everywhere. */
export async function resolveNote(t: Tracker, id: string, archived: boolean): Promise<string | null> {
  for (const where of searchOrder(archived)) {
    const p = pathIn(t, id, where);
    if (await t.io.exists(p)) return p;
  }
  return null;
}

/** IDs of the notes in one location, in numeric order. */
export async function noteIds(t: Tracker, where: Location): Promise<string[]> {
  const names = await t.io.listNotes(folderOf(t.dir, where));
  const key = (n: string): [string, number] => [n.split("-")[0], parseInt(n.split("-")[1], 10)];
  return names
    .filter((n) => ID_RE.test(n))
    .sort((a, b) => {
      const [pa, na] = key(a);
      const [pb, nb] = key(b);
      return pa < pb ? -1 : pa > pb ? 1 : na - nb;
    });
}

export async function readIndexRaw(t: Tracker): Promise<Index> {
  const text = await t.io.read(t.indexPath);
  if (text === null) throw new OpError(`${t.indexPath}: index note not found`);
  return new Index(text);
}

export async function readIndex(t: Tracker): Promise<Index> {
  const idx = await readIndexRaw(t);
  const problems = idx.keyProblems();
  if (idx.doc.broken || problems.length) {
    throw new OpError(`${t.indexPath}: ${(problems.length ? problems : idx.doc.problems()).join("; ")}`);
  }
  return idx;
}

export function requireItem(idx: Index, id: string): Item {
  const it = idx.find(id);
  if (!it) throw new OpError(`${id}: no such issue`);
  return it;
}

/** Run fn holding the tracker's lock: no other operation, here or in the CLI, runs meanwhile. Not reentrant. */
export function locked<T>(t: Tracker, fn: () => Promise<T>): Promise<T> {
  return t.io.lock ? t.io.lock(t.dir, fn) : fn();
}

async function noteTitle(t: Tracker, path: string): Promise<string> {
  const quick = await t.io.title?.(path);
  if (quick !== undefined) return cleanTitle(quick);
  const text = await t.io.read(path);
  return text === null ? "" : cleanTitle(new Doc(text).getStr("title"));
}

/**
 * Apply fn to the index and write it: the commit point of an operation.
 * Every index write also corrects title copies that differ from the notes.
 * `known` gives titles this operation has just written; `extra` names IDs
 * that fn is about to add.
 */
export async function updateIndex(
  t: Tracker,
  fn: (idx: Index) => void,
  opts: { known?: Map<string, string>; extra?: Array<[string, boolean]> } = {},
): Promise<void> {
  const before = await readIndexRaw(t);
  const titles = new Map<string, string>();
  const wanted: Array<[string, boolean]> = before.unique().map((it) => [it.id, it.archived]);
  for (const [id, archived] of [...wanted, ...(opts.extra ?? [])]) {
    const path = await resolveNote(t, id, archived);
    if (!path) continue;
    const title = await noteTitle(t, path);
    if (title) titles.set(id, title);
  }
  for (const [id, title] of opts.known ?? []) titles.set(id, title);
  await t.io.process(t.indexPath, (text) => {
    const idx = new Index(text);
    fn(idx);
    idx.syncTitles(titles);
    return idx.text();
  });
}

/** Put the note where it belongs, from wherever it is. */
export async function moveNote(t: Tracker, id: string, toArchive: boolean): Promise<void> {
  const target = place(toArchive);
  const here = await found(t, id);
  const elsewhere = here.filter((w) => w !== target);
  if (!elsewhere.length) return;
  if (here.length > 1) throw new OpError(`${id}: note exists in more than one place (${describe(here)})`);
  await t.io.rename(pathIn(t, id, elsewhere[0]), pathIn(t, id, target));
}

export async function issueRecord(t: Tracker, item: Item): Promise<IssueRecord> {
  const path = await resolveNote(t, item.id, item.archived);
  const text = path === null ? null : await t.io.read(path);
  return recordFromDoc(item, text === null ? null : new Doc(text), text === null ? null : path);
}

/** Every issue, open and archived, in index order, read with the subset parser. */
export function listIssues(t: Tracker): Promise<IssueRecord[]> {
  return locked(t, async () => {
    const idx = await readIndex(t);
    const out: IssueRecord[] = [];
    for (const it of idx.unique()) out.push(await issueRecord(t, it));
    return out;
  });
}

/**
 * A record for every issue, open and archived, and the progress and relations of each. To be called holding the lock.
 * `foreign` holds the issues of the other trackers of the folder, which this one's issues may link to; `closed`
 * judges any of them by the `closed-states` of the tracker they belong to. `others` are the other trackers of the folder, if already read.
 */
export async function allRecords(
  t: Tracker,
  idx: Index,
  others?: Sibling[],
): Promise<{ records: IssueRecord[]; foreign: IssueRecord[]; closed: ClosedFn; progress: Map<string, Progress>; relations: Map<string, Relations> }> {
  const records: IssueRecord[] = [];
  for (const it of idx.unique()) records.push(await issueRecord(t, it));
  const usable = usableSiblings(idx, others ?? (await otherTrackers(t)));
  const foreign = await siblingRecords(t, usable);
  const closed = makeClosed(idx.prefix, idx.closedStates, usable.map((s) => ({ prefix: s.prefix, closedStates: s.index.closedStates, listed: new Set(s.index.unique().map((it) => it.id)) })));
  return { records, foreign, closed, progress: linkedProgress(records, closed, foreign), relations: issueRelations(records, closed, foreign) };
}

/** The trackers among these whose issues this one's may link to as theirs: those whose prefix is valid, is not this one's and is not shared. */
export function usableSiblings(idx: Index, others: Sibling[]): Sibling[] {
  const siblings = others.filter((s) => s.prefix !== null && s.prefix !== idx.prefix);
  return siblings.filter((s) => siblings.filter((other) => other.prefix === s.prefix).length === 1);
}

/** The records, archived included, of the issues of these trackers. */
export async function siblingRecords(t: Tracker, siblings: Sibling[]): Promise<IssueRecord[]> {
  const out: IssueRecord[] = [];
  for (const s of siblings) {
    for (const it of s.index.unique()) out.push(await issueRecord(t, it));
  }
  return out;
}

/** Whether an ID may be linked to from this tracker's issues: the index of this tracker or of another in its folder lists it. */
export async function linkTargets(t: Tracker, idx: Index): Promise<(id: string) => boolean> {
  return listedIn(idx, await otherTrackers(t));
}

/** Whether an ID is listed by this index or by one of these trackers. */
export function listedIn(idx: Index, others: Sibling[]): (id: string) => boolean {
  return (id) => idx.find(id) !== undefined || others.some((s) => s.index.find(id) !== undefined);
}

/** An index note of a folder, its prefix (null if it has none that is valid) and the index itself. */
export interface Sibling {
  path: string;
  prefix: string | null;
  index: Index;
}

/** The trackers of a folder: its top-level notes that carry `bilinear: tracker`, the folder-named note first, then by name. */
export async function trackersIn(io: Tracker["io"], dir: string): Promise<Sibling[]> {
  const found: Sibling[] = [];
  for (const name of (await io.listNotes(dir)).sort()) {
    if (ID_RE.test(name)) continue;
    const path = joinPath(dir, `${name}.md`);
    const text = await io.read(path);
    if (text === null) continue;
    const idx = new Index(text);
    if (idx.isTracker()) found.push({ path, prefix: idx.prefix, index: idx });
  }
  const folderName = dir.slice(dir.lastIndexOf("/") + 1);
  const rank = (s: Sibling) => (s.path === joinPath(dir, `${folderName}.md`) ? 0 : 1);
  return found.sort((a, b) => rank(a) - rank(b));
}

/** The other trackers of a tracker's folder, which share its issues/ and archive/. */
export async function otherTrackers(t: Tracker): Promise<Sibling[]> {
  return (await trackersIn(t.io, t.dir)).filter((other) => other.path !== t.indexPath);
}

/** The tracker among these whose prefix an ID has. */
export function ownerOf(id: string, trackers: Sibling[]): Sibling | undefined {
  const prefix = ID_RE.exec(id)?.[1];
  return prefix === undefined ? undefined : trackers.find((other) => other.prefix === prefix);
}
