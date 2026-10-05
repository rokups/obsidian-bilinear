import { fullId, type ContextEntry } from "./context";
import { TYPE_LETTERS, cleanTitle, type EntryType } from "./ids";

// The words that carry no meaning for a match. Negations (`not`, `no`, `never`, `without`) are kept on purpose.
const STOP_WORDS = new Set(
  "the an and or of to in on at by for from with is are was were be been it its this that as if then than so".split(" "),
);

/** Words of a text for a match: NFKC, lower case, only letters, digits and combining marks, no short or stop words, each one once. */
export function tokens(s: string): string[] {
  const words = s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]/gu, " ")
    .split(" ");
  const out = new Set<string>();
  for (const w of words) if (Array.from(w).length >= 2 && !STOP_WORDS.has(w)) out.add(w);
  return [...out];
}

/** The Jaccard score of the token sets of two texts: 0 to 1; 0 when one of them has no token. */
export function overlap(a: string, b: string): number {
  const x = new Set(tokens(a));
  const y = new Set(tokens(b));
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}

/** The tokens of a subject joined by one space: two subjects that are the same text for a match give the same string. */
export function normalizeSubject(s: string): string {
  return tokens(s).join(" ");
}

export const L0_CAP = 8000;

export interface L0Input {
  /** `BL-9`. */
  issueId: string;
  title: string;
  /** The note body without Context and Comments. */
  description: string;
  /** Entries of the issue note, all statuses. */
  entries: ContextEntry[];
  /** The tracker prefix, `BL`. */
  trackerId: string;
  /** Entries of the index note, all statuses. */
  trackerEntries: ContextEntry[];
  /** `YYYY-MM-DD` of the newest comment, or null. */
  newestComment: string | null;
  /** Characters at most in the text. Default `L0_CAP`. */
  cap?: number;
}

export interface L0View {
  /** Empty when there are no entries in either scope and `newestComment` is null. */
  text: string;
  /** `text.length`. */
  chars: number;
  cap: number;
  /** Full IDs that have their own line in a block above the index. */
  shown: string[];
  /**
   * Full IDs of the other active entries: each active issue entry and each active tracker constraint is in `shown`
   * or in `omitted`, once. Those in `omitted` are in the index only, on a `not shown:` line or in a range line.
   */
  omitted: string[];
  /** Entries of the issue by status, and the active entries of the tracker. */
  counts: { active: number; superseded: number; resolved: number; tracker: number };
}

const LINE_MAX = 220;
const DESC_MAX = 400;
const SUBJECT_MAX = 48;
const RANGE_MAX = 300;
const INDEX_FLOOR = 1200;
const NOT_SHOWN_MAX = 12;
/** The share of the index room that the `not shown:` lines can use. */
const NOT_SHOWN_SHARE = 0.4;
const FINDINGS_NOT_SHOWN = 3;
const RANGE_MIN_RUN = 3;
const MORE = "… (context list --all)";
const INDEX_HEAD = "Index (read with: context get <ID>...):";
/** Letters in the order of the IDs in a range line. */
const LETTER_ORDER = Object.keys(TYPE_LETTERS);

/** The first line of a value that has text, trimmed. A labelled value can start with a line break. */
function firstLine(s: string): string {
  for (const line of s.split("\n")) {
    const t = cleanTitle(line);
    if (t) return t;
  }
  return "";
}

/** At most `max` characters. A longer text is cut on a word boundary and ends with `…`. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max < 1) return "";
  let head = s.slice(0, max - 1);
  if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1);
  if (s[head.length] !== " ") {
    const sp = head.lastIndexOf(" ");
    if (sp > 0 && sp >= head.length / 2) head = head.slice(0, sp);
  }
  return head.trimEnd() + "…";
}

/** `D1 D2 D3 D5` -> `D1-D3 D5`. A run of two stays as two IDs. The prefix, such as `BL/`, is on each item. */
export function collapseLocals(locals: string[], prefix = ""): string[] {
  const byLetter = new Map<string, Set<number>>();
  for (const l of locals) {
    const letter = l[0].toUpperCase();
    const set = byLetter.get(letter) ?? new Set<number>();
    set.add(parseInt(l.slice(1), 10));
    byLetter.set(letter, set);
  }
  const out: string[] = [];
  const letters = [...byLetter.keys()].sort((a, b) => LETTER_ORDER.indexOf(a) - LETTER_ORDER.indexOf(b));
  for (const letter of letters) {
    const nums = [...(byLetter.get(letter) as Set<number>)].sort((a, b) => a - b);
    for (let i = 0; i < nums.length; ) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      if (j - i + 1 >= RANGE_MIN_RUN) out.push(`${prefix}${letter}${nums[i]}-${letter}${nums[j]}`);
      else for (let k = i; k <= j; k++) out.push(`${prefix}${letter}${nums[k]}`);
      i = j + 1;
    }
  }
  return out;
}

/** A line of IDs. When it is longer than `room` (or `RANGE_MAX`), it is cut and ends with a pointer to the full list. */
function rangeLine(prefix: string, items: string[], room: number): string | null {
  const limit = Math.min(room, RANGE_MAX);
  const full = prefix + items.join(" ");
  if (full.length + 1 <= limit) return full;
  let line = prefix + MORE;
  if (line.length + 1 > limit) return null;
  for (let n = items.length - 1; n >= 1; n--) {
    const t = `${prefix}${items.slice(0, n).join(" ")} ${MORE}`;
    if (t.length + 1 <= limit) {
      line = t;
      break;
    }
  }
  return line;
}

/** Entries by `updated` (`created` when there is none), the newest first. No date is last. Then by number, the highest first. */
function newestFirst(a: ContextEntry, b: ContextEntry): number {
  const da = a.updated ?? a.created;
  const db = b.updated ?? b.created;
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da < db ? 1 : -1;
  }
  return b.number - a.number;
}

interface Ref {
  e: ContextEntry;
  tracker: boolean;
}

interface Item {
  text: string;
  ref: Ref | null;
}

interface Block {
  /** Own line before the items; null when the first item carries the label. */
  heading: string | null;
  items: Item[];
}

function header(id: string, chars: number | string, cap: number, shown: number, inIndex: number): string {
  return `CONTEXT ${id} (L0, ${chars} of ${cap} chars; ${shown} shown, ${inIndex} in index)`;
}

/**
 * The header line with its number right: the number is a part of the line, so it is solved for, not guessed.
 * `bodyLength` is the length of the text under the header.
 */
function fitHeader(id: string, bodyLength: number, cap: number, shown: number, inIndex: number): string {
  const base = header(id, "", cap, shown, inIndex).length + 1 + bodyLength;
  for (let digits = 1; digits <= 12; digits++) {
    if (String(base + digits).length === digits) return header(id, base + digits, cap, shown, inIndex);
  }
  return header(id, base, cap, shown, inIndex);
}

/**
 * The L0 view of an issue: the small text for an agent that starts work on it. The blocks come in a fixed order
 * of priority and fill the text one line at a time. What does not fit is in the index at the end, which keeps
 * a floor of room for itself. `text.length` is never above `cap`. Limit: with a `cap` below the length of the header
 * line, the header is cut and has no number.
 */
export function buildL0(input: L0Input): L0View {
  const cap = input.cap ?? L0_CAP;
  const { issueId, trackerId } = input;
  const active = input.entries.filter((e) => e.status === "active");
  const trackerActive = input.trackerEntries.filter((e) => e.status === "active");
  const counts = {
    active: active.length,
    superseded: input.entries.filter((e) => e.status === "superseded").length,
    resolved: input.entries.filter((e) => e.status === "resolved").length,
    tracker: trackerActive.length,
  };
  const none: L0View = { text: "", chars: 0, cap, shown: [], omitted: [], counts };
  if (input.entries.length === 0 && input.trackerEntries.length === 0 && input.newestComment === null) return none;

  const idOf = (r: Ref) => (r.tracker ? fullId(trackerId, r.e.local) : fullId(issueId, r.e.local));
  const ofType = (list: ContextEntry[], type: EntryType) => list.filter((e) => e.type === type).sort(newestFirst);
  const issueRef = (e: ContextEntry): Ref => ({ e, tracker: false });
  const trackerRef = (e: ContextEntry): Ref => ({ e, tracker: true });
  const withTail = (head: string, tail: string) => cut(tail ? `${head} - ${tail}` : head, LINE_MAX).trimEnd();

  // The blocks, in the order of priority.
  const blocks: Block[] = [];
  const goal: Item[] = [];
  if (input.title.trim() !== "" || input.description.trim() !== "") {
    goal.push({ text: cut(`Goal: ${cleanTitle(input.title)}`.trimEnd(), LINE_MAX), ref: null });
    const head = cut(cleanTitle(input.description), DESC_MAX);
    if (head) goal.push({ text: `  ${head}`.trimEnd(), ref: null });
  }
  blocks.push({ heading: null, items: goal });

  const states = ofType(active, "state");
  blocks.push({
    heading: null,
    items: states.slice(0, 1).map((e) => {
      const when = [e.updated ?? e.created, e.author].filter((x) => x).join(" ");
      const head = `State: ${e.local}${when ? ` (${when})` : ""}`;
      return { text: cut(`${head} ${cleanTitle(e.content) || cleanTitle(e.subject)}`, LINE_MAX).trimEnd(), ref: issueRef(e) };
    }),
  });
  const listed = (
    heading: string,
    list: ContextEntry[],
    type: EntryType,
    tracker: boolean,
    tail: (e: ContextEntry) => string,
  ) => {
    const items = ofType(list, type).map((e) => {
      const id = tracker ? fullId(trackerId, e.local) : e.local;
      return { text: withTail(`  ${id} ${cleanTitle(e.subject)}`, tail(e)), ref: tracker ? trackerRef(e) : issueRef(e) };
    });
    blocks.push({ heading, items });
  };
  listed("Rejected (do not retry):", active, "rejected", false, (e) => {
    const failed = cleanTitle(e.rejected?.failed ?? "");
    return failed ? `failed: ${failed}` : cleanTitle(e.content);
  });
  listed("Constraints:", active, "constraint", false, (e) => cleanTitle(e.content));
  listed("Decisions:", active, "decision", false, (e) => firstLine(e.rationale) || firstLine(e.content));
  listed("Open questions:", active, "question", false, () => "");
  listed("Tracker constraints:", trackerActive, "constraint", true, (e) => cleanTitle(e.content));

  // The hint: a comment that the context does not know yet.
  const dates = input.entries.map((e) => e.updated ?? e.created).filter((d): d is string => d !== null);
  const newest = dates.reduce<string | null>((m, d) => (m === null || d > m ? d : m), null);
  let hint: string | null = null;
  const comment = input.newestComment;
  if (comment !== null && (input.entries.length === 0 || newest === null || comment > newest)) {
    hint =
      input.entries.length === 0
        ? `Hint: the issue has a comment (${comment}) and no context entry. Run: context checkpoint ${issueId}`
        : `Hint: the last comment (${comment}) is newer than the last context update. Run: context checkpoint ${issueId}`;
  }

  // The room. The index keeps a floor, and the header is counted at its longest.
  const total = active.length + trackerActive.filter((e) => e.type === "constraint").length;
  const headerMax = header(issueId, cap, cap, total, total).length + 1;
  const hintCost = hint === null ? 0 : hint.length + 1;
  const floor = Math.min(INDEX_FLOOR, Math.floor(cap / 3));
  let left = Math.max(0, cap - floor - headerMax - hintCost);

  // Greedy fill: a line that does not fit ends its block, and the other blocks still use what is left.
  const blockLines: string[] = [];
  const shownRefs = new Set<ContextEntry>();
  const shown: Ref[] = [];
  const overflow: Ref[] = [];
  for (const block of blocks) {
    let taken = 0;
    let stopped = false;
    for (const item of block.items) {
      const cost = item.text.length + 1 + (taken === 0 && block.heading !== null ? block.heading.length + 1 : 0);
      if (stopped || cost > left) {
        stopped = true;
        if (item.ref) overflow.push(item.ref);
        continue;
      }
      if (taken === 0 && block.heading !== null) blockLines.push(block.heading);
      blockLines.push(item.text);
      left -= cost;
      taken++;
      if (item.ref) {
        shown.push(item.ref);
        shownRefs.add(item.ref.e);
      }
    }
  }

  // Active entries with no line of their own: in the index only.
  const kinds = (r: Ref) => LETTER_ORDER.indexOf(r.e.local[0].toUpperCase());
  const omittedRefs: Ref[] = [
    ...active.filter((e) => !shownRefs.has(e)).map(issueRef),
    ...trackerActive.filter((e) => e.type === "constraint" && !shownRefs.has(e)).map(trackerRef),
  ].sort((a, b) => +a.tracker - +b.tracker || kinds(a) - kinds(b) || a.e.number - b.e.number);

  const blocksChars = blockLines.reduce((n, l) => n + l.length + 1, 0);
  let room = cap - headerMax - blocksChars - hintCost - (INDEX_HEAD.length + 1);
  const index: string[] = [];
  const add = (line: string | null) => {
    if (line === null) return;
    index.push(line);
    room -= line.length + 1;
  };

  // The tiers after `not shown:`, each with the words that start its line. The counts are the exact ones.
  const prefix = fullId(trackerId, "D").slice(0, -1);
  const ranges = (rest: Ref[]) => {
    const mine = rest.filter((r) => !r.tracker).map((r) => r.e.local);
    const theirs = [
      ...rest.filter((r) => r.tracker).map((r) => r.e.local),
      ...trackerActive.filter((e) => e.type !== "constraint").map((e) => e.local),
    ];
    const tiers: { head: string; items: string[] }[] = [
      { head: "  active: ", items: collapseLocals(mine) },
      { head: "  tracker: ", items: collapseLocals(theirs, prefix) },
    ];
    for (const status of ["superseded", "resolved"] as const) {
      const locals = input.entries.filter((e) => e.status === status).map((e) => e.local);
      tiers.push({ head: `  ${status} (${locals.length}): `, items: collapseLocals(locals) });
    }
    return tiers.filter((t) => t.items.length);
  };
  // A tier is never left with no room at all: each later tier keeps the room for a cut line.
  const reserve = (tiers: { head: string }[]) => tiers.reduce((n, t) => n + t.head.length + MORE.length + 1, 0);

  // The `not shown:` lines: entries that lost their line to the room, then the newest findings.
  const candidates: Ref[] = [
    ...overflow,
    ...ofType(active, "finding")
      .slice(0, FINDINGS_NOT_SHOWN)
      .map(issueRef),
  ];
  const named = new Set<ContextEntry>();
  const notShownRoom = Math.min(room - reserve(ranges(omittedRefs)), Math.floor(room * NOT_SHOWN_SHARE));
  let used = 0;
  for (const r of candidates) {
    if (named.size >= NOT_SHOWN_MAX) break;
    if (shownRefs.has(r.e) || named.has(r.e)) continue;
    const line = `  not shown: ${r.tracker ? fullId(trackerId, r.e.local) : r.e.local} ${r.e.type} ${cut(cleanTitle(r.e.subject), SUBJECT_MAX)}`.trimEnd();
    if (used + line.length + 1 > notShownRoom) break;
    used += line.length + 1;
    add(line);
    named.add(r.e);
  }
  const tiers = ranges(omittedRefs.filter((r) => !named.has(r.e)));
  tiers.forEach((t, i) => {
    const later = reserve(tiers.slice(i + 1));
    add(rangeLine(t.head, t.items, room - later));
  });
  if (index.length) index.unshift(INDEX_HEAD);

  // The text. The header number needs the length of the rest, so the rest comes first.
  const shownIds = shown.map(idOf);
  const omittedIds = omittedRefs.map(idOf);
  const compose = (): string => {
    const body = [...blockLines, ...index, ...(hint === null ? [] : [hint])].map((l) => l + "\n").join("");
    return `${fitHeader(issueId, body.length, cap, shownIds.length, omittedIds.length)}\n${body}`;
  };
  let text = compose();
  // The last guard: the index gives up its lines from the end, then the hint.
  while (text.length > cap && index.length) {
    index.pop();
    if (index.length === 1) index.pop();
    text = compose();
  }
  if (text.length > cap && hint !== null) {
    hint = null;
    text = compose();
  }
  if (text.length > cap) text = cap >= 2 ? cut(text.split("\n")[0], cap - 1) + "\n" : "";
  return { text, chars: text.length, cap, shown: shownIds, omitted: omittedIds, counts };
}
