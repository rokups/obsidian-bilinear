// Consistency checks of spec/FORMAT.md section 3.

import { ARCHIVE, ISSUES, LINK_LIST_KEYS, LOCATIONS, PRIORITIES, cleanTitle, idNumber, linkId, validDate } from "../format/ids";
import type { Index, Item } from "../format/index-note";
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
      records.push(recordFromDoc(it, doc, path));
      const title = cleanTitle(doc.getStr("title"));
      if (title && title !== it.title) add("warning", "title-mismatch", it.id, "index line title differs from the title property", true);
    }

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
