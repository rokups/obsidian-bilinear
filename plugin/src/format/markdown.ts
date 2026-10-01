import { chomp, trimBlank } from "./lines";

export type LineKind = { kind: "code" } | { kind: "text" } | { kind: "heading"; level: number; name: string };

const HEADING_RE = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const CODE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** Classify each line as code (inside or on a fence), heading or text. */
export function classify(lines: string[]): LineKind[] {
  const out: LineKind[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const s = chomp(line);
    if (fence !== null) {
      const t = trimBlank(s);
      if (t !== "" && t.length >= fence.length && [...t].every((c) => c === fence![0])) fence = null;
      out.push({ kind: "code" });
      continue;
    }
    let m = CODE_FENCE_RE.exec(s);
    if (m) {
      fence = m[1];
      out.push({ kind: "code" });
      continue;
    }
    m = HEADING_RE.exec(s);
    if (m) out.push({ kind: "heading", level: m[1].length, name: trimBlank(m[2]) });
    else out.push({ kind: "text" });
  }
  return out;
}

export interface Sections {
  /** name -> [heading line, end line (exclusive)] */
  sections: Map<string, [number, number]>;
  duplicates: string[];
  kinds: LineKind[];
}

/**
 * Locate level-2 sections by exact name. A section runs from its heading to
 * the next heading of level 1 or 2. Only the first heading with a name counts.
 */
export function findSections(lines: string[], names: string[]): Sections {
  const kinds = classify(lines);
  const sections = new Map<string, [number, number]>();
  const duplicates: string[] = [];
  let cur: string | null = null;
  kinds.forEach((k, i) => {
    if (k.kind !== "heading" || k.level > 2) return;
    if (cur !== null) {
      sections.set(cur, [sections.get(cur)![0], i]);
      cur = null;
    }
    if (k.level === 2 && names.includes(k.name)) {
      if (sections.has(k.name)) {
        duplicates.push(k.name);
      } else {
        sections.set(k.name, [i, lines.length]);
        cur = k.name;
      }
    }
  });
  return { sections, duplicates, kinds };
}
