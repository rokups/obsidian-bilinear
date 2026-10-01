import { COLOR_NAMES } from "../format/ids";

// Labels without a colour in the index get one of these, picked by name, so
// a label looks the same everywhere without any setup.
const AUTO = COLOR_NAMES.filter((c) => c !== "gray");

function hash(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h * 33) ^ name.charCodeAt(i)) >>> 0;
  return h;
}

/** The colour name or hex value a label is shown in. */
export function labelColorName(name: string, colors: Record<string, string>): string {
  return colors[name] ?? AUTO[hash(name) % AUTO.length];
}

/** The same as a CSS colour, using Obsidian's theme palette for named colours. */
export function labelCssColor(name: string, colors: Record<string, string>): string {
  const c = labelColorName(name, colors);
  if (c.startsWith("#")) return c;
  return c === "gray" ? "var(--text-faint)" : `var(--color-${c})`;
}
