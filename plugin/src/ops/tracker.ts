// Reading the tracker and the index commit step shared by all operations.

import { ARCHIVE_DIR, ID_RE, ISSUES_DIR, LOCATIONS, cleanTitle, type Location } from "../format/ids";
import { Index, type Item } from "../format/index-note";
import { recordFromDoc, type IssueRecord } from "../format/record";
import { Doc } from "../format/yaml";
import { issueRelations, linkedProgress, type Progress, type Relations } from "../store/query";
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

/** A record for every issue, open and archived, and the progress and relations of each. To be called holding the lock. */
export async function allRecords(t: Tracker, idx: Index): Promise<{ records: IssueRecord[]; progress: Map<string, Progress>; relations: Map<string, Relations> }> {
  const records: IssueRecord[] = [];
  for (const it of idx.unique()) records.push(await issueRecord(t, it));
  return { records, progress: linkedProgress(records, idx.closedStates), relations: issueRelations(records, idx.closedStates) };
}

/** Top-level notes of a folder that carry `bilinear: tracker`, folder-named note first. */
export async function indexNotes(io: Tracker["io"], dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of (await io.listNotes(dir)).sort()) {
    if (ID_RE.test(name)) continue;
    const path = joinPath(dir, `${name}.md`);
    const text = await io.read(path);
    if (text !== null && new Doc(text).getStr("bilinear") === "tracker") found.push(path);
  }
  const folderName = dir.slice(dir.lastIndexOf("/") + 1);
  const rank = (p: string) => (p === joinPath(dir, `${folderName}.md`) ? 0 : 1);
  return found.sort((a, b) => rank(a) - rank(b));
}
