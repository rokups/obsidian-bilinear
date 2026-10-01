// The index note: frontmatter config plus the `## Issues` and `## Archive`
// lists (spec/FORMAT.md 1.4). Edits touch only issue lines and config keys.

import { ARCHIVE, DEFAULT_CLOSED, DEFAULT_STATES, ID_RE, ISSUES, PREFIX_RE, formatLine, idNumber, linkTarget } from "./ids";
import { chomp, hasEol, isBlank, splitLines } from "./lines";
import { findSections } from "./markdown";
import { Doc } from "./yaml";

const LIST_LINE_RE = /^[ \t]*[-*+][ \t]+\[\[([^[\]]*)\]\](?:[ \t]+(.*?))?[ \t]*$/;

export interface Item {
  line: number;
  section: string;
  id: string;
  title: string;
  canonical: boolean;
  archived: boolean;
}

export type Where = "before" | "after" | "top" | "bottom";

export class Index {
  doc: Doc;
  eol: string;
  lines: string[];
  sections = new Map<string, [number, number]>();
  dupSections: string[] = [];
  items: Item[] = [];

  constructor(text: string) {
    this.doc = new Doc(text);
    this.eol = this.doc.eol;
    this.lines = splitLines(this.doc.body);
    this.scan();
  }

  scan(): void {
    const { sections, duplicates, kinds } = findSections(this.lines, [ISSUES, ARCHIVE]);
    this.sections = sections;
    this.dupSections = duplicates;
    this.items = [];
    for (const [name, [start, end]] of sections) {
      for (let i = start + 1; i < end; i++) {
        if (kinds[i].kind !== "text") continue;
        const s = chomp(this.lines[i]);
        const m = LIST_LINE_RE.exec(s);
        if (!m) continue;
        const id = linkTarget(m[1]);
        if (!ID_RE.test(id)) continue;
        const title = m[2] ?? "";
        this.items.push({ line: i, section: name, id, title, canonical: s === formatLine(id, title), archived: name === ARCHIVE });
      }
    }
    this.items.sort((a, b) => a.line - b.line);
  }

  text(): string {
    this.doc.body = this.lines.join("");
    return this.doc.text();
  }

  // -- frontmatter

  isTracker(): boolean {
    return this.doc.getStr("bilinear") === "tracker";
  }

  get prefix(): string | null {
    const p = this.doc.getStr("prefix");
    return p && PREFIX_RE.test(p) ? p : null;
  }

  get next(): number | null {
    const v = this.doc.getStr("next");
    return v && /^[0-9]+$/.test(v) ? parseInt(v, 10) : null;
  }

  get states(): string[] {
    return this.doc.getList("states");
  }

  get closedStates(): string[] {
    return this.doc.getList("closed-states");
  }

  get labels(): string[] {
    return this.doc.getList("labels");
  }

  setNext(n: number): void {
    if (this.next !== n) this.doc.set("next", String(n), true);
  }

  keyProblems(): string[] {
    const out: string[] = [];
    if (this.prefix === null) out.push("prefix is missing or not of the form [A-Z][A-Z0-9]*");
    if (this.next === null || this.next < 1) out.push("next is missing or not a positive integer");
    if (this.states.length === 0) out.push("states is missing or empty");
    for (const s of this.closedStates) {
      if (!this.states.includes(s)) out.push(`closed-states entry '${s}' is not in states`);
    }
    return out;
  }

  // -- items

  /** First occurrence of each ID, in index order. */
  unique(): Item[] {
    const seen = new Set<string>();
    return this.items.filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
  }

  find(id: string): Item | undefined {
    return this.items.find((it) => it.id === id);
  }

  inSection(section: string): Item[] {
    return this.unique().filter((it) => it.section === section);
  }

  highest(): number {
    let max = 0;
    for (const it of this.items) max = Math.max(max, idNumber(it.id, this.prefix) ?? 0);
    return max;
  }

  // -- editing

  private insert(pos: number, text: string): void {
    if (pos > 0 && !hasEol(this.lines[pos - 1])) this.lines[pos - 1] += this.eol;
    this.lines.splice(pos, 0, text + this.eol);
    this.scan();
  }

  private ensureSection(name: string): void {
    if (this.sections.has(name)) return;
    if (name === ISSUES && this.sections.has(ARCHIVE)) {
      const pos = this.sections.get(ARCHIVE)![0];
      if (pos > 0 && !hasEol(this.lines[pos - 1])) this.lines[pos - 1] += this.eol;
      const added = [`## ${name}${this.eol}`, this.eol];
      if (pos > 0 && !isBlank(this.lines[pos - 1])) added.unshift(this.eol);
      this.lines.splice(pos, 0, ...added);
    } else {
      const n = this.lines.length;
      if (n && !hasEol(this.lines[n - 1])) this.lines[n - 1] += this.eol;
      if (n && !isBlank(this.lines[n - 1])) this.lines.push(this.eol);
      this.lines.push(`## ${name}${this.eol}`);
    }
    this.scan();
  }

  add(id: string, title: string, section: string = ISSUES, top = false): void {
    this.ensureSection(section);
    const items = this.items.filter((it) => it.section === section);
    let pos: number;
    if (items.length) pos = top ? items[0].line : items[items.length - 1].line + 1;
    else pos = this.sections.get(section)![0] + 1;
    this.insert(pos, formatLine(id, title));
  }

  /** Remove every line for an ID. */
  remove(id: string): void {
    for (let it = this.find(id); it !== undefined; it = this.find(id)) {
      this.lines.splice(it.line, 1);
      this.scan();
    }
  }

  rewrite(item: Item, title: string): void {
    const line = this.lines[item.line];
    this.lines[item.line] = formatLine(item.id, title) + line.slice(chomp(line).length);
    this.scan();
  }

  moveToSection(id: string, section: string): void {
    const title = this.find(id)?.title ?? "";
    this.remove(id);
    this.add(id, title, section);
  }

  /** Reorder within `## Issues`. */
  move(id: string, where: Where, anchor?: string): void {
    const title = this.find(id)!.title;
    this.remove(id);
    if (where === "top" || where === "bottom") {
      this.add(id, title, ISSUES, where === "top");
      return;
    }
    const target = this.find(anchor!)!;
    this.insert(where === "before" ? target.line : target.line + 1, formatLine(id, title));
  }

  /** The title property wins over the copy kept on the index line. */
  syncTitles(titles: Map<string, string>): void {
    for (const it of this.unique()) {
      const t = titles.get(it.id);
      if (t && t !== it.title) this.rewrite(this.find(it.id)!, t);
    }
  }

  /** `lint --fix` for the index: drop duplicate lines, canonicalize, raise next. */
  repair(highest: number): void {
    const first = new Set<string>();
    const dupLines: number[] = [];
    for (const it of this.items) {
      if (first.has(it.id)) dupLines.push(it.line);
      first.add(it.id);
    }
    for (const line of dupLines.sort((a, b) => b - a)) this.lines.splice(line, 1);
    this.scan();
    for (const it of [...this.items]) {
      if (!it.canonical) this.rewrite(this.find(it.id)!, it.title);
    }
    if (this.next !== null && this.next <= highest) this.setNext(highest + 1);
  }
}

export function newIndexText(prefix: string): string {
  return (
    "---\n" +
    "bilinear: tracker\n" +
    `prefix: ${prefix}\n` +
    "next: 1\n" +
    `states: [${DEFAULT_STATES.join(", ")}]\n` +
    `closed-states: [${DEFAULT_CLOSED.join(", ")}]\n` +
    "labels: []\n" +
    "---\n" +
    "\n" +
    `## ${ISSUES}\n` +
    "\n" +
    `## ${ARCHIVE}\n`
  );
}
