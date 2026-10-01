/** Split into lines, each keeping its own terminator. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

export function chomp(line: string): string {
  if (line.endsWith("\r\n")) return line.slice(0, -2);
  if (line.endsWith("\n")) return line.slice(0, -1);
  return line;
}

export function hasEol(line: string): boolean {
  return line.endsWith("\n");
}

export function detectEol(text: string): string {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

/** Strip spaces and tabs only, as the spec does (not all Unicode whitespace). */
export function trimBlank(s: string): string {
  return s.replace(/^[ \t]+|[ \t]+$/g, "");
}

export function isBlank(line: string): boolean {
  return trimBlank(chomp(line)) === "";
}
