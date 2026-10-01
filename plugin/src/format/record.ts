import { ID_RE, cleanTitle, linkId, linkTarget } from "./ids";
import { bodyLinks } from "./issue-note";
import type { Item } from "./index-note";
import type { Doc } from "./yaml";

/** What a view or `list` shows for one index line. */
export interface IssueRecord {
  id: string;
  title: string;
  status: string | null;
  priority: string;
  labels: string[];
  assignee: string | null;
  due: string | null;
  parent: string | null;
  blockedBy: string[];
  created: string | null;
  /** IDs of the issues the note's description links to. */
  links: string[];
  archived: boolean;
  missing: boolean;
  /** Vault path of the note, or null when it is missing. */
  path: string | null;
}

function emptyRecord(item: Item, path: string | null): IssueRecord {
  return {
    id: item.id,
    title: item.title,
    status: null,
    priority: "none",
    labels: [],
    assignee: null,
    due: null,
    parent: null,
    blockedBy: [],
    created: null,
    links: [],
    archived: item.archived,
    missing: path === null,
    path,
  };
}

/** Record from a note parsed with the YAML subset parser. */
export function recordFromDoc(item: Item, doc: Doc | null, path: string | null): IssueRecord {
  const rec = emptyRecord(item, path);
  if (!doc || path === null) return rec;
  rec.title = cleanTitle(doc.getStr("title")) || item.title;
  rec.status = doc.getStr("status");
  rec.priority = doc.getStr("priority") || "none";
  rec.labels = doc.getList("labels");
  rec.assignee = doc.getStr("assignee");
  rec.due = doc.getStr("due");
  rec.parent = linkId(doc.getStr("parent"));
  rec.blockedBy = doc.getList("blocked-by").map(linkId).filter((v): v is string => v !== null);
  rec.created = doc.getStr("created");
  rec.links = bodyLinks(doc.body, item.id);
  return rec;
}

/**
 * A frontmatter value as a list of strings. A full YAML parser turns an
 * unquoted `[[BL-9]]` into a nested list; that is read back as the link.
 */
function toList(v: unknown): string[] {
  if (v === null || v === undefined || v === "") return [];
  if (!Array.isArray(v)) return [String(v)];
  const out: string[] = [];
  for (const el of v) {
    if (el === null || el === undefined || el === "") continue;
    out.push(Array.isArray(el) ? `[[${el.flat(Infinity).join(", ")}]]` : String(el));
  }
  return out;
}

function toStr(v: unknown): string | null {
  const list = toList(v);
  return list.length ? list[0] : null;
}

/**
 * Record from Obsidian's metadata cache: the note's frontmatter and the
 * targets of the links in its description (see `descriptionLinks`).
 */
export function recordFromFrontmatter(
  item: Item,
  fm: Record<string, unknown> | null | undefined,
  path: string | null,
  links: string[] = [],
): IssueRecord {
  const rec = emptyRecord(item, path);
  if (path === null) return rec;
  fm = fm ?? {};
  rec.title = cleanTitle(toStr(fm["title"])) || item.title;
  rec.status = toStr(fm["status"]);
  rec.priority = toStr(fm["priority"]) || "none";
  rec.labels = toList(fm["labels"]);
  rec.assignee = toStr(fm["assignee"]);
  rec.due = toStr(fm["due"]);
  rec.parent = linkId(toStr(fm["parent"]));
  rec.blockedBy = toList(fm["blocked-by"]).map(linkId).filter((v): v is string => v !== null);
  rec.created = toStr(fm["created"]);
  for (const link of links) {
    const target = linkTarget(link);
    if (ID_RE.test(target) && target !== item.id && !rec.links.includes(target)) rec.links.push(target);
  }
  return rec;
}
