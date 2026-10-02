// The operations of spec/FORMAT.md section 2. In each, the index write comes
// last, so an interrupted operation leaves at worst a stray note. Each holds
// the tracker's lock from start to finish (section 3.2); none calls another.

import { ARCHIVE, ARCHIVE_DIR, COLOR_NAMES, ID_RE, ISSUES, ISSUES_DIR, LINK_LIST_KEYS, LOCATIONS, PREFIX_RE, PRIORITIES, STATE_SHAPES, cleanTitle, idNumber, linkId, makeLink, normalizeColor, normalizeIcon, validDate } from "../format/ids";
import { newIndexText, type Index, type Where } from "../format/index-note";
import { addComment, newNoteText } from "../format/issue-note";
import { Doc, type Value } from "../format/yaml";
import { reaches } from "../store/query";
import { OpError, joinPath, type Tracker, type TrackerIO } from "./io";
import { allRecords, folderOf, found, indexNotes, issueRecord, locked, moveNote, noteIds, notePath, pathIn, readIndex, requireItem, resolveNote, updateIndex } from "./tracker";

export interface NewIssue {
  title: string;
  status?: string;
  priority?: string;
  labels?: string[];
  assignee?: string;
  due?: string;
  /** IDs of the issues this one waits for. */
  blockedBy?: string[];
  /** IDs of the issues this one is related to. */
  relatedTo?: string[];
  /** The body of the note, as Markdown. */
  description?: string;
  top?: boolean;
}

/** Property edits. null or [] removes a key; `blocked-by` and `related-to` take IDs, and a string for a list is a list of one. */
export type PropEdits = Record<string, Value>;

/** Check values about to be written. Labels the tracker does not list only warn. */
function checkProps(idx: Index, props: PropEdits, selfId: string | null, warn?: (message: string) => void): void {
  const str = (key: string) => (typeof props[key] === "string" ? (props[key] as string) : null);
  if ("title" in props && !str("title")) throw new OpError("title must not be empty");
  if ("status" in props) {
    const status = str("status");
    if (!status) throw new OpError("status must not be empty");
    if (!idx.states.includes(status)) throw new OpError(`unknown status '${status}' (states: ${idx.states.join(", ")})`);
  }
  const priority = str("priority");
  if (priority !== null && !(PRIORITIES as readonly string[]).includes(priority)) {
    throw new OpError(`unknown priority '${priority}' (one of: ${PRIORITIES.join(", ")})`);
  }
  for (const key of ["due", "created"]) {
    if (str(key) !== null && !validDate(str(key))) throw new OpError(`${key} must be a date in the form YYYY-MM-DD`);
  }
  const labels = props["labels"];
  for (const label of Array.isArray(labels) ? labels : typeof labels === "string" ? [labels] : []) {
    if (!idx.labels.includes(label)) warn?.(`warning: label '${label}' is not in the tracker's labels`);
  }
  const links = LINK_LIST_KEYS.flatMap((key) => {
    const value = props[key];
    return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  });
  for (const link of links) {
    const target = linkId(link);
    if (target === null) throw new OpError(`'${link}' is not an issue ID`);
    if (target === selfId) throw new OpError(`${target}: an issue cannot refer to itself`);
    if (!idx.find(target)) throw new OpError(`${target}: no such issue`);
  }
}

/** Create the tracker folder, its index note, issues/ and archive/. Returns the index path. */
export async function createTracker(io: TrackerIO, folder: string, prefix: string): Promise<string> {
  if (!PREFIX_RE.test(prefix)) throw new OpError("the prefix must be of the form [A-Z][A-Z0-9]*");
  if (!folder) throw new OpError("a tracker needs its own folder");
  if ((await indexNotes(io, folder)).length) throw new OpError(`${folder} already contains a tracker`);
  await io.mkdir(folder);
  await io.mkdir(joinPath(folder, ISSUES_DIR));
  await io.mkdir(joinPath(folder, ARCHIVE_DIR));
  const indexPath = joinPath(folder, `${folder.slice(folder.lastIndexOf("/") + 1)}.md`);
  if (!(await io.createExclusive(indexPath, newIndexText(prefix)))) {
    throw new OpError(`${indexPath} already exists and is not a tracker index`);
  }
  return indexPath;
}

export function createIssue(t: Tracker, args: NewIssue, today: string): Promise<string> {
  return locked(t, async () => {
    const idx = await readIndex(t);
    const title = cleanTitle(args.title);
    const props: PropEdits = {
      title,
      status: args.status || idx.defaultState,
      priority: args.priority || "none",
      labels: args.labels ?? [],
      assignee: args.assignee || null,
      due: args.due || null,
      "blocked-by": args.blockedBy ?? [],
      "related-to": args.relatedTo ?? [],
      created: today,
    };
    checkProps(idx, props, null, t.warn);
    for (const key of LINK_LIST_KEYS) props[key] = (props[key] as string[]).map((v) => makeLink(linkId(v)!));
    // No cycle check: nothing can link to an issue that does not exist yet.
    const text = newNoteText(props, args.description);

    const prefix = idx.prefix!;
    let highest = idx.highest();
    for (const where of LOCATIONS) {
      for (const id of await noteIds(t, where)) highest = Math.max(highest, idNumber(id, prefix) ?? 0);
    }
    let n = Math.max(idx.next!, highest + 1);
    await t.io.mkdir(folderOf(t.dir, "issues"));
    let id: string;
    for (;;) {
      id = `${prefix}-${n}`;
      const taken = (await t.io.exists(pathIn(t, id, "archive"))) || (await t.io.exists(pathIn(t, id, "root")));
      if (!taken && (await t.io.createExclusive(notePath(t, id, false), text))) break;
      n += 1;
    }

    await updateIndex(
      t,
      (i) => {
        if (!i.find(id)) i.add(id, title, ISSUES, args.top ?? false);
        i.setNext(Math.max(i.next ?? 1, n + 1));
      },
      { known: new Map([[id, title]]) },
    );
    return id;
  });
}

/** Drop `other` from the `related-to` of `id`'s note, if the note names it. A missing note is skipped. */
async function dropRelated(t: Tracker, idx: Index, id: string, other: string): Promise<void> {
  const item = idx.find(id);
  if (!item) return;
  const path = await resolveNote(t, id, item.archived);
  if (path === null) return;
  const names = (text: string) => new Doc(text).getList("related-to").some((v) => linkId(v) === other);
  const before = await t.io.read(path);
  if (before === null || !names(before)) return;
  await t.io.process(path, (text) => {
    const doc = new Doc(text);
    const keep = doc.getList("related-to").filter((v) => linkId(v) !== other);
    if (keep.length === doc.getList("related-to").length) return text;
    doc.set("related-to", keep.length ? keep : null);
    return doc.text();
  });
}

/**
 * Change properties of an issue. The edits may be given as a function of the
 * note as it is, for edits that depend on it (adding to a list). `blocked-by` may
 * not be changed to close a cycle. Removing an issue from
 * `related-to` removes this one from its `related-to` too.
 */
export function setProps(t: Tracker, id: string, edits: PropEdits | ((doc: Doc) => PropEdits)): Promise<void> {
  return locked(t, async () => {
    const idx = await readIndex(t);
    const item = requireItem(idx, id);
    const path = await resolveNote(t, id, item.archived);
    if (path === null) throw new OpError(`${id}: note missing`);
    const first = await t.io.read(path);
    if (first === null) throw new OpError(`${id}: note missing`);

    // What the edits make of a note's text; run on the text as read, to check
    // before anything is written, and on the text as it is when writing.
    const plan = (text: string, warn?: (message: string) => void) => {
      const doc = new Doc(text);
      const props: PropEdits = { ...(typeof edits === "function" ? edits(doc) : edits) };
      if (typeof props["title"] === "string") props["title"] = cleanTitle(props["title"]);
      for (const [key, value] of Object.entries(props)) {
        if (value === "" && key !== "title" && key !== "status") props[key] = null;
      }
      for (const key of LINK_LIST_KEYS) {
        if (typeof props[key] === "string") props[key] = [props[key] as string];
      }
      // Of the lists, only what this edit adds is checked: a link to an
      // issue that has since been deleted must not stand in the way.
      const added = (key: string, same: (a: string, b: string) => boolean): PropEdits => {
        const value = props[key];
        if (!Array.isArray(value)) return {};
        const had = doc.getList(key);
        return { [key]: value.filter((v) => !had.some((h) => same(h, v))) };
      };
      const sameLink = (a: string, b: string) => linkId(a) !== null && linkId(a) === linkId(b);
      const addedLinks = Object.assign({}, ...LINK_LIST_KEYS.map((key) => added(key, sameLink)));
      checkProps(idx, { ...props, ...added("labels", (a, b) => a === b), ...addedLinks }, id, warn);
      const newBlockers: string[] = ((addedLinks["blocked-by"] as string[] | undefined) ?? []).map((v) => linkId(v)!);
      for (const key of LINK_LIST_KEYS) {
        if (Array.isArray(props[key])) props[key] = props[key].map((v) => makeLink(linkId(v)!));
      }
      const kept = ((props["related-to"] as string[] | null | undefined) ?? []).map(linkId);
      const unrelated = "related-to" in props
        ? doc.getList("related-to").map(linkId).filter((v): v is string => v !== null && !kept.includes(v))
        : [];
      return { doc, props, newBlockers, unrelated };
    };

    const planned = plan(first, t.warn);
    if (planned.newBlockers.length) {
      const { records } = await allRecords(t, idx);
      for (const b of planned.newBlockers) {
        if (reaches(records, b, id)) throw new OpError(`${id}: would block itself through ${b}`);
      }
    }

    let title: string | null = null;
    let unrelated: string[] = [];
    await t.io.process(path, (text) => {
      const { doc, props, unrelated: gone } = plan(text);
      for (const [key, value] of Object.entries(props)) {
        doc.set(key, Array.isArray(value) && value.length === 0 ? null : value);
      }
      title = typeof props["title"] === "string" ? props["title"] : null;
      unrelated = gone;
      return doc.text();
    });
    for (const other of unrelated) await dropRelated(t, idx, other, id);
    if (title !== null) {
      // Retitle: the note first, then the index line.
      await updateIndex(t, () => {}, { known: new Map([[id, title]]) });
    }
  });
}

/** Make two issues no longer related: each note's `related-to` stops naming the other. The other may be an issue that is gone. */
export function unrelate(t: Tracker, id: string, other: string): Promise<void> {
  return locked(t, async () => {
    const idx = await readIndex(t);
    requireItem(idx, id);
    await dropRelated(t, idx, id, other);
    await dropRelated(t, idx, other, id);
  });
}

export function moveIssue(t: Tracker, id: string, where: Where, anchor?: string): Promise<void> {
  return locked(t, async () => {
    const idx = await readIndex(t);
    const relative = where === "before" || where === "after";
    if (relative && !anchor) throw new OpError("an anchor issue is needed");
    for (const each of relative ? [id, anchor!] : [id]) {
      if (requireItem(idx, each).archived) throw new OpError(`${each} is archived; only open issues can be reordered`);
    }
    if (relative && anchor === id) throw new OpError("an issue cannot be moved relative to itself");
    await updateIndex(t, (i) => {
      if (!i.find(id) || (relative && !i.find(anchor!))) throw new OpError("the index changed; issue no longer listed");
      i.move(id, where, anchor);
    });
  });
}

async function moveToSection(t: Tracker, ids: string[], toArchive: boolean): Promise<string[]> {
  const idx = await readIndex(t);
  const unique = [...new Set(ids)];
  const todo = unique.filter((id) => requireItem(idx, id).archived !== toArchive);
  for (const id of todo) await moveNote(t, id, toArchive);
  if (todo.length) {
    await updateIndex(t, (i) => {
      for (const id of todo) {
        if (i.find(id)) i.moveToSection(id, toArchive ? ARCHIVE : ISSUES);
      }
    });
  }
  return todo;
}

/** Archive issues. Returns the IDs that were actually archived. */
export function archiveIssues(t: Tracker, ids: string[]): Promise<string[]> {
  return locked(t, () => moveToSection(t, ids, true));
}

export function unarchiveIssues(t: Tracker, ids: string[]): Promise<string[]> {
  return locked(t, () => moveToSection(t, ids, false));
}

/** Archive every open issue whose status is one of the closed states. */
export function archiveClosed(t: Tracker): Promise<string[]> {
  return locked(t, async () => {
    const idx = await readIndex(t);
    const ids: string[] = [];
    for (const it of idx.inSection(ISSUES)) {
      const status = (await issueRecord(t, it)).status;
      if (status !== null && idx.closedStates.includes(status)) ids.push(it.id);
    }
    return ids.length ? moveToSection(t, ids, true) : [];
  });
}

/**
 * Delete an issue: first clear `blocked-by` and `related-to`
 * entries naming it from the other notes (those that do not are not
 * touched; `[[ID]]` mentions in descriptions stay), then trash the note
 * (wherever it is) and remove the index line.
 */
export function deleteIssue(t: Tracker, id: string): Promise<void> {
  return locked(t, async () => {
    const idx = await readIndex(t);
    requireItem(idx, id);
    const { records } = await allRecords(t, idx);
    // The note goes first: if this stops halfway, lint reports what is left.
    for (const where of await found(t, id)) await t.io.trash(pathIn(t, id, where));
    for (const r of records) {
      if (r.id === id || r.path === null) continue;
      if (!r.blockedBy.includes(id) && !r.relatedTo.includes(id)) continue;
      await t.io.process(r.path, (text) => {
        const doc = new Doc(text);
        for (const key of LINK_LIST_KEYS) {
          const list = doc.getList(key);
          const rest = list.filter((v) => linkId(v) !== id);
          if (rest.length !== list.length) doc.set(key, rest.length ? rest : null);
        }
        return doc.text();
      });
    }
    await updateIndex(t, (i) => i.remove(id));
  });
}

export function commentIssue(t: Tracker, id: string, text: string, author: string, today: string): Promise<void> {
  return locked(t, async () => {
    const idx = await readIndex(t);
    const item = requireItem(idx, id);
    const path = await resolveNote(t, id, item.archived);
    if (path === null) throw new OpError(`${id}: note missing`);
    if (!cleanTitle(text)) throw new OpError("comment text must not be empty");
    await t.io.process(path, (note) => addComment(note, today, author || "unknown", text));
  });
}

/** Add an index line for an orphan note. */
export function adoptIssue(t: Tracker, id: string): Promise<void> {
  return locked(t, async () => {
    const idx = await readIndex(t);
    if (!ID_RE.test(id)) throw new OpError(`'${id}' is not an issue ID`);
    if (idx.find(id)) throw new OpError(`${id} is already in the index`);
    const here = await found(t, id);
    if (!here.length) throw new OpError(`${id}: no such note in ${ISSUES_DIR}/, ${ARCHIVE_DIR}/ or the tracker folder`);
    const archived = here[0] === "archive";
    const section = archived ? ARCHIVE : ISSUES;
    const number = idNumber(id, idx.prefix);
    // A note lying in the tracker folder goes to issues/ as it is adopted.
    await moveNote(t, id, archived);
    await updateIndex(
      t,
      (i) => {
        if (!i.find(id)) i.add(id, "", section);
        if (number !== null && (i.next ?? 1) <= number) i.setNext(number + 1);
      },
      { extra: [[id, archived]] },
    );
  });
}

/** Recreate the note of a "note missing" issue from its index line. */
export function recreateNote(t: Tracker, id: string, today: string): Promise<string> {
  return locked(t, async () => {
    const idx = await readIndex(t);
    const item = requireItem(idx, id);
    if ((await resolveNote(t, id, item.archived)) !== null) throw new OpError(`${id}: the note exists`);
    const path = notePath(t, id, item.archived);
    await t.io.mkdir(folderOf(t.dir, item.archived ? "archive" : "issues"));
    const text = newNoteText({ title: item.title || id, status: idx.defaultState, priority: "none", created: today });
    if (!(await t.io.createExclusive(path, text))) throw new OpError(`${id}: the note exists`);
    return path;
  });
}

/**
 * Make a label known to the tracker and, if `color` is given, set its colour
 * (a name from COLOR_NAMES, #rgb or #rrggbb) or clear it (null).
 */
export function setLabel(t: Tracker, name: string, color?: string | null): Promise<void> {
  return locked(t, async () => {
    await readIndex(t);
    const label = cleanTitle(name);
    if (!label) throw new OpError("label name must not be empty");
    let normalized: string | null = null;
    if (typeof color === "string") {
      normalized = normalizeColor(color);
      if (normalized === null) throw new OpError(`unknown colour '${color}' (one of: ${COLOR_NAMES.join(", ")}, #rgb, #rrggbb)`);
    }
    await updateIndex(t, (i) => {
      i.addLabel(label);
      if (color !== undefined) i.setLabelColor(label, normalized);
    });
  });
}

/**
 * Set how a state is drawn. `icon` is one of STATE_SHAPES or a Lucide icon
 * name; `color` a name from COLOR_NAMES, #rgb or #rrggbb. null clears a
 * value, so the state is drawn the automatic way; undefined leaves it.
 */
export function setStateStyle(t: Tracker, state: string, style: { icon?: string | null; color?: string | null }): Promise<void> {
  return locked(t, async () => {
    const idx = await readIndex(t);
    if (!idx.states.includes(state)) throw new OpError(`unknown state '${state}' (states: ${idx.states.join(", ")})`);
    let icon: string | null = null;
    let color: string | null = null;
    if (typeof style.icon === "string") {
      icon = normalizeIcon(style.icon);
      if (icon === null) throw new OpError(`'${style.icon}' is not an icon (one of: ${STATE_SHAPES.join(", ")}, or a Lucide icon name such as rocket)`);
    }
    if (typeof style.color === "string") {
      color = normalizeColor(style.color);
      if (color === null) throw new OpError(`unknown colour '${style.color}' (one of: ${COLOR_NAMES.join(", ")}, #rgb, #rrggbb)`);
    }
    await updateIndex(t, (i) => {
      if (style.icon !== undefined) i.setStateIcon(state, icon);
      if (style.color !== undefined) i.setStateColor(state, color);
    });
  });
}

/**
 * Make a state the tracker's triage state: the one for issues that wait for
 * the user to accept or reject them. A state the tracker does not have yet is
 * added in front of the others.
 */
export function setTriageState(t: Tracker, state: string): Promise<void> {
  return locked(t, async () => {
    const idx = await readIndex(t);
    const name = cleanTitle(state);
    if (!name) throw new OpError("state name must not be empty");
    if (idx.closedStates.includes(name)) throw new OpError(`'${name}' is a closed state; the triage state must be an open one`);
    await updateIndex(t, (i) => i.setTriageState(name));
  });
}
