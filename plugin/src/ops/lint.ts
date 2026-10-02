// Consistency checks of spec/FORMAT.md section 3.

import { ARCHIVE, ISSUES, LOCATIONS, PRIORITIES, cleanTitle, idNumber, linkId, validDate } from "../format/ids";
import type { Index, Item } from "../format/index-note";
import { Doc } from "../format/yaml";
import type { Tracker } from "./io";
import { describe, found, indexNotes, locked, moveNote, noteIds, pathIn, place, readIndexRaw, resolveNote, updateIndex } from "./tracker";

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

function checkNote(idx: Index, id: string, doc: Doc, add: Add): void {
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
  const refs: Array<[string, string]> = [
    ...doc.getList("parent").map((v): [string, string] => ["parent", v]),
    ...doc.getList("blocked-by").map((v): [string, string] => ["blocked-by", v]),
  ];
  for (const [key, value] of refs) {
    const target = linkId(value);
    if (target === null || target === id) add("error", `${key}-invalid`, id, `${key} '${value}' is not a link to another issue`);
    else if (!idx.find(target)) add("error", `${key}-unknown`, id, `${key} ${target} is not in the index`);
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
    for (const other of await indexNotes(t.io, t.dir)) {
      if (other !== t.indexPath) add("error", "multiple-trackers", null, `${other.slice(other.lastIndexOf("/") + 1)} is also marked as a tracker index`);
    }
    if (!idx.sections.has(ISSUES)) add("warning", "missing-section", null, `the index has no '## ${ISSUES}' section`);
    for (const name of idx.dupSections) {
      add("warning", "duplicate-section", null, `more than one '## ${name}' section; only the first is used`);
    }

    const prefix = idx.prefix;
    const seen = new Map<string, Item>();
    const moves: Array<[string, boolean]> = [];
    for (const it of idx.items) {
      if (seen.has(it.id)) {
        add("warning", "duplicate-id", it.id, "listed more than once; the first line wins", true);
        continue;
      }
      seen.set(it.id, it);
      if (!it.canonical) add("warning", "line-format", it.id, "index line is not in the form '- [[ID]] title'", true);
      if (prefix && idNumber(it.id, prefix) === null) add("warning", "prefix-mismatch", it.id, `ID does not use the tracker prefix ${prefix}`);
      const here = await found(t, it.id);
      if (!here.length) {
        add("error", "note-missing", it.id, "note missing");
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
      checkNote(idx, it.id, doc, add);
      const title = cleanTitle(doc.getStr("title"));
      if (title && title !== it.title) add("warning", "title-mismatch", it.id, "index line title differs from the title property", true);
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
