// The YAML subset of spec/FORMAT.md section 1.6, with a frontmatter editor
// that rewrites only the lines of the key being changed. Mirrors the parser in
// cli/bilinear.py; the shared fixtures keep the two in step.

import { chomp, detectEol, hasEol, splitLines, trimBlank } from "./lines";

export type Value = string | string[] | null;

const PLAIN_BAD_START = "!&*-?[]{}|>@`\"'#%,:";
const NUMBER_RE =
  /^[-+]?(\.[0-9]+|[0-9][0-9_]*(\.[0-9_]*)?)([eE][-+]?[0-9]+)?$|^0x[0-9a-fA-F]+$|^0o[0-7]+$|^[-+]?\.(inf|Inf|INF)$|^\.(nan|NaN|NAN)$/;
const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "y", "n", "~"]);
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "\\": "\\", "/": "/" };

function isControl(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

export function needsQuote(s: string, flow = false): boolean {
  if (s === "") return true;
  if (" \t".includes(s[0]) || " \t".includes(s[s.length - 1])) return true;
  if (PLAIN_BAD_START.includes(s[0])) return true;
  if (s.includes(": ") || s.includes(" #") || s.endsWith(":")) return true;
  for (let i = 0; i < s.length; i++) if (isControl(s.charCodeAt(i))) return true;
  if (NUMBER_RE.test(s) || RESERVED.has(s.toLowerCase())) return true;
  if (flow && /[,[\]{}]/.test(s)) return true;
  return false;
}

export function quote(s: string): string {
  let out = '"';
  for (const c of s) {
    const code = c.charCodeAt(0);
    if (c === "\\") out += "\\\\";
    else if (c === '"') out += '\\"';
    else if (c === "\n") out += "\\n";
    else if (c === "\t") out += "\\t";
    else if (c === "\r") out += "\\r";
    else if (c.length === 1 && isControl(code)) out += "\\x" + code.toString(16).padStart(2, "0");
    else out += c;
  }
  return out + '"';
}

export function formatScalar(s: string, flow = false): string {
  return needsQuote(s, flow) ? quote(s) : s;
}

function scanDouble(raw: string): [string, number] | null {
  let out = "";
  let i = 1;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') return [out, i + 1];
    if (c === "\\" && i + 1 < raw.length) {
      const e = raw[i + 1];
      if (e === "x" && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 2, i + 4))) {
        out += String.fromCodePoint(parseInt(raw.slice(i + 2, i + 4), 16));
        i += 4;
        continue;
      }
      if (e === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) {
        out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      out += ESCAPES[e] ?? e;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return null;
}

function scanSingle(raw: string): [string, number] | null {
  let out = "";
  let i = 1;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "'") {
      if (raw[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return [out, i + 1];
    }
    out += c;
    i += 1;
  }
  return null;
}

const TRAILER_RE = /^[ \t]*(?:[ \t]#.*)?$/;
const BARE_LINK_RE = /^\[\[[^[\]]*\]\]$/;

/** Parse one scalar. Returns [value, problem]; an empty value is null. */
export function parseScalar(input: string): [string | null, string | null] {
  let raw = trimBlank(input);
  if (raw === "") return [null, null];
  if (raw[0] === '"' || raw[0] === "'") {
    const res = raw[0] === '"' ? scanDouble(raw) : scanSingle(raw);
    if (res === null) return [raw, "unterminated quoted scalar"];
    const [value, end] = res;
    if (!TRAILER_RE.test(raw.slice(end))) return [value, "unexpected text after quoted scalar"];
    return [value, null];
  }
  if (raw[0] === "#") return [null, null];
  const m = /[ \t]#/.exec(raw);
  if (m) raw = raw.slice(0, m.index).replace(/[ \t]+$/, "");
  if (BARE_LINK_RE.test(raw)) return [raw, "unquoted wikilink"];
  if ("&*!|>{%@`".includes(raw[0])) return [raw, "unsupported YAML syntax"];
  if (raw[0] === "[") return [raw, "unsupported YAML syntax"];
  if (raw.includes(": ") || raw.endsWith(":")) return [raw, "unsupported YAML syntax"];
  if (raw === "null" || raw === "~") return [null, null];
  return [raw, null];
}

/** Parse `[a, "b", c]`; the input starts with `[`. */
export function parseFlowList(input: string): [string[], string | null] {
  const raw = trimBlank(input);
  const m = /\][ \t]*(?:[ \t]#.*)?$/.exec(raw);
  if (!m) return [[], "unterminated inline list"];
  const inner = raw.slice(1, m.index);
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let quoteCh: string | null = null;
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (quoteCh) {
      cur += c;
      if (quoteCh === '"' && c === "\\" && i + 1 < inner.length) {
        cur += inner[i + 1];
        i += 2;
        continue;
      }
      if (c === quoteCh) {
        if (quoteCh === "'" && inner[i + 1] === "'") {
          cur += "'";
          i += 2;
          continue;
        }
        quoteCh = null;
      }
    } else if ((c === '"' || c === "'") && trimBlank(cur) === "") {
      quoteCh = c;
      cur += c;
    } else if (c === "[" || c === "{") {
      depth += 1;
      cur += c;
    } else if (c === "]" || c === "}") {
      depth -= 1;
      cur += c;
    } else if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
    i += 1;
  }
  if (quoteCh || depth !== 0) return [[], "malformed inline list"];
  parts.push(cur);
  if (parts.length === 1 && trimBlank(parts[0]) === "") return [[], null];
  const values: string[] = [];
  let problem: string | null = null;
  for (const part of parts) {
    const [value, prob] = parseScalar(part);
    if (prob && !problem) problem = prob;
    if (value !== null) values.push(value);
  }
  return [values, problem];
}

const KEY_RE = /^([^\s:#\-[\]{}"'!&*|>%@`,?][^:]*?)[ \t]*:(?:[ \t]+(.*))?$/;
const ITEM_RE = /^([ \t]*)-(?:[ \t]+(.*))?$/;
const FENCE_LINE_RE = /^---[ \t]*$/;

type Style = "raw" | "scalar" | "flow" | "block";

/** One frontmatter key with the raw lines it occupies. */
export class Entry {
  value: Value = null;
  style: Style = "raw";
  indent = "  ";
  problems: string[] = [];
  constructor(
    public key: string | null,
    public lines: string[],
  ) {}
}

function sameValue(a: Value, b: Value): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

export class FrontmatterError extends Error {}

/**
 * A note: optional frontmatter plus body, editable key by key.
 * `text()` reproduces the input exactly unless a key was changed.
 */
export class Doc {
  bom: boolean;
  eol: string;
  hasFm = false;
  broken = false;
  openLine = "";
  closeLine = "";
  entries: Entry[] = [];
  body: string;

  constructor(text: string) {
    this.bom = text.startsWith("﻿");
    if (this.bom) text = text.slice(1);
    this.eol = detectEol(text);
    this.body = text;
    const lines = splitLines(text);
    if (lines.length === 0 || !FENCE_LINE_RE.test(chomp(lines[0]))) return;
    let close = -1;
    for (let i = 1; i < lines.length; i++) {
      if (FENCE_LINE_RE.test(chomp(lines[i]))) {
        close = i;
        break;
      }
    }
    if (close < 0) {
      this.broken = true;
      return;
    }
    this.hasFm = true;
    this.openLine = lines[0];
    this.closeLine = lines[close];
    this.body = lines.slice(close + 1).join("");
    this.parse(lines.slice(1, close));
  }

  private parse(lines: string[]): void {
    let i = 0;
    while (i < lines.length) {
      const s = chomp(lines[i]);
      const stripped = trimBlank(s);
      if (stripped === "" || stripped.startsWith("#")) {
        this.entries.push(new Entry(null, [lines[i]]));
        i += 1;
        continue;
      }
      const m = KEY_RE.exec(s);
      if (!m) {
        const e = new Entry(null, [lines[i]]);
        e.problems.push("unsupported YAML line: " + stripped);
        this.entries.push(e);
        i += 1;
        continue;
      }
      const e = new Entry(m[1], [lines[i]]);
      const rest = trimBlank(m[2] ?? "");
      i += 1;
      if (rest === "" || rest.startsWith("#")) {
        const items: string[] = [];
        while (i < lines.length) {
          const im = ITEM_RE.exec(chomp(lines[i]));
          if (!im) break;
          if (e.style !== "block") e.indent = im[1];
          e.style = "block";
          const [value, prob] = parseScalar(im[2] ?? "");
          if (prob) e.problems.push(prob);
          if (value !== null) items.push(value);
          e.lines.push(lines[i]);
          i += 1;
        }
        if (e.style === "block") {
          e.value = items;
        } else {
          e.style = "scalar";
          e.value = null;
        }
      } else if (rest.startsWith("[") && !BARE_LINK_RE.test(rest)) {
        e.style = "flow";
        const [value, prob] = parseFlowList(rest);
        e.value = value;
        if (prob) e.problems.push(prob);
      } else {
        e.style = "scalar";
        const [value, prob] = parseScalar(rest);
        e.value = value;
        if (prob) e.problems.push(prob);
      }
      // Indented continuation lines are outside the subset; keep them attached
      // so that edits never split them from their key.
      while (i < lines.length) {
        const c = chomp(lines[i]);
        if ((c[0] === " " || c[0] === "\t") && trimBlank(c) !== "") {
          e.lines.push(lines[i]);
          e.problems.push("nested or multi-line value");
          i += 1;
        } else {
          break;
        }
      }
      if (this.find(e.key!) !== undefined) e.problems.push("duplicate key");
      this.entries.push(e);
    }
  }

  find(key: string): Entry | undefined {
    return this.entries.find((e) => e.key === key);
  }

  get(key: string): Value {
    return this.find(key)?.value ?? null;
  }

  getStr(key: string): string | null {
    const v = this.get(key);
    if (Array.isArray(v)) return v.length ? v[0] : null;
    return v;
  }

  getList(key: string): string[] {
    const v = this.get(key);
    if (v === null) return [];
    return Array.isArray(v) ? v : [v];
  }

  keys(): string[] {
    return this.entries.filter((e) => e.key !== null).map((e) => e.key!);
  }

  problems(): string[] {
    const out: string[] = [];
    if (this.broken) out.push("frontmatter is not terminated");
    for (const e of this.entries) {
      // One report per key is enough.
      if (e.problems.length) out.push(e.key ? `${e.key}: ${e.problems[0]}` : e.problems[0]);
    }
    return out;
  }

  private format(key: string, value: string | string[], block: boolean, indent: string): string[] {
    if (Array.isArray(value)) {
      if (block && value.length) {
        return [`${key}:${this.eol}`, ...value.map((v) => `${indent}- ${formatScalar(v)}${this.eol}`)];
      }
      return [`${key}: [${value.map((v) => formatScalar(v, true)).join(", ")}]${this.eol}`];
    }
    return [`${key}: ${formatScalar(value)}${this.eol}`];
  }

  /** Set or (value null) remove a key. raw writes the scalar unquoted. */
  set(key: string, value: Value, raw = false): void {
    if (this.broken) throw new FrontmatterError("frontmatter is not terminated; fix the note by hand");
    const e = this.find(key);
    if (value === null) {
      if (e) this.entries.splice(this.entries.indexOf(e), 1);
      return;
    }
    if (e && e.problems.length === 0 && sameValue(e.value, value) && !raw) return;
    if (!this.hasFm) {
      this.hasFm = true;
      this.openLine = "---" + this.eol;
      this.closeLine = "---" + this.eol;
    }
    const lines = raw
      ? [`${key}: ${value as string}${this.eol}`]
      : this.format(key, value, e?.style === "block", e ? e.indent : "  ");
    if (e) {
      e.lines = lines;
      e.value = value;
      e.problems = [];
      if (!Array.isArray(value)) e.style = "scalar";
      else if (e.style !== "block" || value.length === 0) e.style = "flow";
    } else {
      const ne = new Entry(key, lines);
      ne.value = value;
      ne.style = Array.isArray(value) ? "flow" : "scalar";
      this.entries.push(ne);
    }
  }

  text(): string {
    let out = this.bom ? "﻿" : "";
    if (this.hasFm) {
      out += this.openLine;
      for (const e of this.entries) out += e.lines.join("");
      out += this.closeLine;
      if (this.body && !hasEol(this.closeLine)) out += this.eol;
    }
    return out + this.body;
  }
}
