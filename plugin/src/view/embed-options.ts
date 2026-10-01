import { emptyFilter, type Filter } from "../store/query";

export interface EmbedOptions {
  tracker: string | null;
  filter: Filter;
  archived: boolean;
  limit: number;
}

/**
 * Parse the body of a `bilinear` code block: one `key: value` per line.
 *
 *     tracker: Trackers/Bilinear
 *     status: todo, in-progress
 *     label: bug
 *     limit: 10
 */
export function parseEmbed(source: string): EmbedOptions {
  const opts: EmbedOptions = { tracker: null, filter: emptyFilter(), archived: false, limit: 0 };
  for (const line of source.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2];
    const list = value.split(",").map((v) => v.trim()).filter(Boolean);
    if (key === "tracker") opts.tracker = value || null;
    else if (key === "status") opts.filter.status = list;
    else if (key === "priority") opts.filter.priority = list;
    else if (key === "label" || key === "labels") opts.filter.labels = list;
    else if (key === "assignee") opts.filter.assignee = list.map((v) => (v === "none" || v === "unassigned" ? "" : v));
    else if (key === "text" || key === "search") opts.filter.text = value;
    else if (key === "archived") opts.archived = /^(true|yes|1)$/i.test(value);
    else if (key === "limit") opts.limit = Math.max(0, parseInt(value, 10) || 0);
  }
  return opts;
}
