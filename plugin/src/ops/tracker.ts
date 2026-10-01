// Reading the tracker and the index commit step shared by all operations.

import { ARCHIVE_DIR, ID_RE, cleanTitle } from "../format/ids";
import { Index, type Item } from "../format/index-note";
import { recordFromDoc, type IssueRecord } from "../format/record";
import { Doc } from "../format/yaml";
import { OpError, joinPath, type Tracker } from "./io";

export function notePath(t: Tracker, id: string, archived: boolean): string {
  return joinPath(archived ? joinPath(t.dir, ARCHIVE_DIR) : t.dir, `${id}.md`);
}

export async function locate(t: Tracker, id: string): Promise<[boolean, boolean]> {
  return [await t.io.exists(notePath(t, id, false)), await t.io.exists(notePath(t, id, true))];
}

/** The note for an index line: its section's location first, then the other. */
export async function resolveNote(t: Tracker, id: string, archived: boolean): Promise<string | null> {
  for (const where of [archived, !archived]) {
    const p = notePath(t, id, where);
    if (await t.io.exists(p)) return p;
  }
  return null;
}

/** IDs of the notes in the folder or in archive/, in numeric order. */
export async function noteIds(t: Tracker, archived: boolean): Promise<string[]> {
  const names = await t.io.listNotes(archived ? joinPath(t.dir, ARCHIVE_DIR) : t.dir);
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

async function noteTitle(t: Tracker, path: string): Promise<string> {
  const quick = t.io.title?.(path);
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

export async function moveNote(t: Tracker, id: string, toArchive: boolean): Promise<void> {
  const src = notePath(t, id, !toArchive);
  const dst = notePath(t, id, toArchive);
  if (!(await t.io.exists(src))) return;
  if (await t.io.exists(dst)) throw new OpError(`${id}: note exists in both the tracker folder and ${ARCHIVE_DIR}/`);
  await t.io.rename(src, dst);
}

export async function issueRecord(t: Tracker, item: Item): Promise<IssueRecord> {
  const path = await resolveNote(t, item.id, item.archived);
  const text = path === null ? null : await t.io.read(path);
  return recordFromDoc(item, text === null ? null : new Doc(text), text === null ? null : path);
}

/** Every issue, open and archived, in index order, read with the subset parser. */
export async function listIssues(t: Tracker): Promise<IssueRecord[]> {
  const idx = await readIndex(t);
  const out: IssueRecord[] = [];
  for (const it of idx.unique()) out.push(await issueRecord(t, it));
  return out;
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
