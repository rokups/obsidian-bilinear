// Consistency checks of spec/FORMAT.md section 3.

import { fullId, normalizeLocal, parseContext, parseFullId } from "../format/context";
import { ARCHIVE, ISSUES, LINK_LIST_KEYS, LOCATIONS, PRIORITIES, cleanTitle, idNumber, linkId, validDate } from "../format/ids";
import type { Index, Item } from "../format/index-note";
import { parseComments } from "../format/issue-note";
import { recordFromDoc, type IssueRecord } from "../format/record";
import { Doc } from "../format/yaml";
import { reaches } from "../store/query";
import { basename, type Tracker } from "./io";
import { describe, found, listedIn, locked, moveNote, noteIds, otherTrackers, ownerOf, pathIn, place, readIndexRaw, resolveNote, siblingRecords, updateIndex, usableSiblings } from "./tracker";

export interface Problem {
  severity: "error" | "warning";
  code: string;
  /** Issue ID, or null for the index note. */
  id: string | null;
  message: string;
  fixable: boolean;
  fixed: boolean;
}

type Add = (severity: Problem["severity"], code: string, id: string | null, message: string, fixable?: boolean) => void;

/** `listed` says whether an ID is in the index of this tracker or of another in its folder. */
function checkNote(idx: Index, listed: (id: string) => boolean, id: string, doc: Doc, add: Add): void {
  for (const p of doc.problems()) {
    add(p.endsWith("unquoted wikilink") ? "warning" : "error", "note-yaml", id, p);
  }
  if (!cleanTitle(doc.getStr("title"))) add("error", "title-missing", id, "title is missing");
  const status = doc.getStr("status");
  if (!status) add("error", "status-missing", id, "status is missing");
  else if (!idx.states.includes(status)) add("error", "status-unknown", id, `status '${status}' is not one of the tracker's states`);
  const priority = doc.getStr("priority");
  if (priority !== null && !(PRIORITIES as readonly string[]).includes(priority)) {
    add("error", "priority-invalid", id, `priority '${priority}' is not valid`);
  }
  for (const label of doc.getList("labels")) {
    if (!idx.labels.includes(label)) add("warning", "label-unknown", id, `label '${label}' is not in the tracker's labels`);
  }
  for (const key of ["due", "created"]) {
    const value = doc.getStr(key);
    if (value !== null && !validDate(value)) add("error", `${key}-invalid`, id, `${key} '${value}' is not a YYYY-MM-DD date`);
  }
  const refs = LINK_LIST_KEYS.flatMap((key) => doc.getList(key).map((v): [string, string] => [key, v]));
  for (const [key, value] of refs) {
    const target = linkId(value);
    if (target === null || target === id) add("error", `${key}-invalid`, id, `${key} '${value}' is not a link to another issue`);
    else if (!listed(target)) add("error", `${key}-unknown`, id, `${key} ${target} is not in the index`);
  }
}

const COMMENT_REF_RE = /^([0-9]{4}-[0-9]{2}-[0-9]{2})#([0-9]+)$/;

/**
 * Check the context entries of a note: `id` is the issue ID, or null for the index note, whose entries have the
 * tracker `prefix` in their full IDs. The local IDs of the note go into `notes` (note ID -> local IDs). A reference
 * to the entry of another note cannot be checked before all notes are read, so its check goes into `later`.
 */
function checkContext(
  text: string,
  id: string | null,
  prefix: string | null,
  notes: Map<string, Set<string>>,
  later: Array<() => void>,
  add: Add,
): void {
  const parsed = parseContext(text);
  if (parsed.section === null) return;
  const noteId = id ?? prefix ?? "tracker";
  const locals = new Set(parsed.entries.map((e) => e.local));
  notes.set(noteId, locals);
  const where = id === null ? "the index note" : "this note";
  const comments = id === null ? [] : parseComments(text);

  for (const p of parsed.problems) {
    const at = p.indexOf(": ");
    add("warning", "context-entry-invalid", id, `entry ${fullId(noteId, p.slice(0, at))}: ${p.slice(at + 2)}`);
  }
  for (const local of parsed.duplicates) {
    add("warning", "context-duplicate-id", id, `more than one entry has the ID ${fullId(noteId, local)}; each entry needs its own ID`);
  }
  for (const e of parsed.entries) {
    const entryId = fullId(noteId, e.local);
    const invalid = (message: string) => add("warning", "context-entry-invalid", id, `entry ${entryId}: ${message}`);
    const unknown = (message: string) => add("warning", "context-link-unknown", id, `entry ${entryId}: ${message}`);
    if (e.type === "rejected") {
      const absent = (["attempted", "failed", "applies"] as const)
        .filter((k) => (e.rejected?.[k] ?? "").trim() === "")
        .map((k) => `${k[0].toUpperCase()}${k.slice(1)}:`);
      if (absent.length) invalid(`a rejected entry needs a value for ${absent.length > 1 ? `${absent.slice(0, -1).join(", ")} and ${absent[absent.length - 1]}` : absent[0]}`);
    }
    // A status or superseded-by that did not parse is reported already; the two checks would only repeat it.
    const unread = parsed.problems.some((p) => p.startsWith(`${e.local}: `) && /^(unknown status|status |superseded-by )/.test(p.slice(e.local.length + 2)));
    if (!unread && e.status === "superseded" && e.supersededBy === null) invalid("status is superseded but there is no superseded-by; name the entry that replaces it");
    if (!unread && e.supersededBy !== null && e.status === "active") invalid(`superseded-by is ${e.supersededBy} but status is active; status must be superseded or resolved`);

    for (const [key, value] of [...e.supersedes.map((v) => ["supersedes", v] as const), ...(e.supersededBy === null ? [] : [["superseded-by", e.supersededBy] as const])]) {
      if (!locals.has(value)) unknown(`${key} ${value} is not an entry of ${where}`);
    }
    for (const item of e.evidence) {
      if (item.startsWith("entry:")) {
        const ref = item.slice("entry:".length).trim();
        const local = normalizeLocal(ref);
        const full = local === null ? parseFullId(ref) : null;
        if (local !== null) {
          if (!locals.has(local)) unknown(`evidence ${item} is not an entry of ${where}`);
        } else if (full === null) {
          unknown(`evidence ${item} is not an entry ID`);
        } else if (prefix !== null && (full.noteId === prefix || idNumber(full.noteId, prefix) !== null)) {
          // The entry may be in a note that is read later.
          later.push(() => {
            if (!notes.get(full.noteId)?.has(full.local)) unknown(`evidence ${item} is not an entry of ${full.noteId}`);
          });
        }
      } else if (item.startsWith("comment:")) {
        const m = COMMENT_REF_RE.exec(item.slice("comment:".length).trim());
        if (id === null) unknown(`evidence ${item} is not valid, because the index note has no comments`);
        else if (!m || !validDate(m[1]) || parseInt(m[2], 10) < 1) unknown(`evidence ${item} is not in the form comment:<date>#<n>, with n from 1`);
        else if (comments.filter((c) => c.date === m[1]).length < parseInt(m[2], 10)) unknown(`evidence ${item} is not a comment of this note; there are ${comments.filter((c) => c.date === m[1]).length} comments of ${m[1]}`);
      }
    }
  }
}

/** Check the tracker; with fix, repair what is safe. Never adds or removes issues. */
export function lint(t: Tracker, fix: boolean): Promise<Problem[]> {
  return locked(t, async () => {
    const problems: Problem[] = [];
    const add: Add = (severity, code, id, message, fixable = false) => {
      problems.push({ severity, code, id, message, fixable, fixed: false });
    };

    const idx = await readIndexRaw(t);
    for (const p of idx.doc.problems()) add("error", "index-yaml", null, p);
    for (const p of idx.keyProblems()) add("error", "index-key", null, p);
    for (const [code, message] of idx.styleProblems()) add("warning", code, null, message);
    // The trackers of a folder share issues/ and archive/; only their prefixes tell their notes apart.
    const siblings = await otherTrackers(t);
    for (const other of siblings) {
      if (idx.prefix !== null && other.prefix === idx.prefix) add("error", "prefix-shared", null, `${basename(other.path)}, in the same folder, has the prefix ${idx.prefix} too`);
    }
    if (!idx.sections.has(ISSUES)) add("warning", "missing-section", null, `the index has no '## ${ISSUES}' section`);
    for (const name of idx.dupSections) {
      add("warning", "duplicate-section", null, `more than one '## ${name}' section; only the first is used`);
    }

    const listed = listedIn(idx, siblings);
    const prefix = idx.prefix;
    const notes = new Map<string, Set<string>>();
    const later: Array<() => void> = [];
    checkContext(idx.text(), null, prefix, notes, later, add);
    const seen = new Map<string, Item>();
    const records: IssueRecord[] = [];
    const moves: Array<[string, boolean]> = [];
    for (const it of idx.items) {
      if (seen.has(it.id)) {
        add("warning", "duplicate-id", it.id, "listed more than once; the first line wins", true);
        continue;
      }
      seen.set(it.id, it);
      if (!it.canonical) add("warning", "line-format", it.id, "index line is not in the form '- [[ID]] title'", true);
      if (prefix && idNumber(it.id, prefix) === null) {
        const owner = ownerOf(it.id, siblings);
        if (owner) add("error", "prefix-mismatch", it.id, `ID has the prefix of ${basename(owner.path)}, another tracker in this folder`);
        else add("warning", "prefix-mismatch", it.id, `ID does not use the tracker prefix ${prefix}`);
      }
      const here = await found(t, it.id);
      if (!here.length) {
        add("error", "note-missing", it.id, "note missing");
        records.push(recordFromDoc(it, null, null));
        continue;
      }
      if (here.length > 1) {
        add("error", "note-duplicate", it.id, `note exists in more than one place (${describe(here)})`);
      } else if (here[0] !== place(it.archived)) {
        const section = it.archived ? `## ${ARCHIVE}` : `## ${ISSUES}`;
        add("warning", "wrong-location", it.id, `listed under ${section} but the note is in ${describe(here[0])}, not ${describe(place(it.archived))}`, true);
        moves.push([it.id, it.archived]);
      }
      const path = (await resolveNote(t, it.id, it.archived))!;
      const doc = new Doc((await t.io.read(path)) ?? "");
      checkNote(idx, listed, it.id, doc, add);
      checkContext(doc.text(), it.id, prefix, notes, later, add);
      records.push(recordFromDoc(it, doc, path));
      const title = cleanTitle(doc.getStr("title"));
      if (title && title !== it.title) add("warning", "title-mismatch", it.id, "index line title differs from the title property", true);
    }

    for (const check of later) check();

    // A link to itself is `blocked-by-invalid` already, not a cycle as well. A cycle may pass through the other
    // trackers of the folder; only the issues of this one on it are reported, the others' own lint reports theirs.
    const others = records.map((r) => ({ ...r, blockedBy: r.blockedBy.filter((b) => b !== r.id) }));
    const foreign = await siblingRecords(t, usableSiblings(idx, siblings));
    for (const r of others) {
      if (reaches(others, r.id, r.id, foreign)) add("error", "blocked-by-cycle", r.id, "blocked-by leads back to the issue itself");
    }

    let highest = idx.highest();
    for (const where of LOCATIONS) {
      for (const id of await noteIds(t, where)) {
        const number = idNumber(id, prefix);
        if (number === null) continue;
        highest = Math.max(highest, number);
        if (!seen.has(id)) {
          const path = pathIn({ dir: "" }, id, where);
          add("warning", "orphan", id, `${path} has no index line (use 'adopt' to add it)`);
        }
      }
    }
    if (idx.next !== null && idx.next <= highest) add("warning", "next-low", null, `next is ${idx.next} but ${prefix}-${highest} exists`, true);

    if (!fix || idx.doc.broken) return problems;

    for (const [id, toArchive] of moves) await moveNote(t, id, toArchive);
    await updateIndex(t, (i) => i.repair(highest));
    for (const p of problems) {
      if (p.fixable) p.fixed = true;
    }
    return problems;
  });
}
