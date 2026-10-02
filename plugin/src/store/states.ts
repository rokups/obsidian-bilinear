// How a state is drawn: a ring that fills as the workflow advances, a check
// or a cross for closed states and an inbox for the triage state, unless the
// index says otherwise.

import type { TrackerConfig } from "./query";

export type StateDrawing =
  | { kind: "ring"; dashed: boolean; fraction: number }
  | { kind: "check" }
  | { kind: "cross" }
  | { kind: "lucide"; name: string };

/** A colour name or hex value as a CSS colour, using Obsidian's theme palette for names. */
export function cssColor(color: string): string {
  if (color.startsWith("#")) return color;
  return color === "gray" ? "var(--text-faint)" : `var(--color-${color})`;
}

const SHAPES: Record<string, StateDrawing> = {
  dashed: { kind: "ring", dashed: true, fraction: 0 },
  circle: { kind: "ring", dashed: false, fraction: 0 },
  quarter: { kind: "ring", dashed: false, fraction: 0.25 },
  half: { kind: "ring", dashed: false, fraction: 0.5 },
  "three-quarters": { kind: "ring", dashed: false, fraction: 0.75 },
  check: { kind: "check" },
  cross: { kind: "cross" },
};

type Config = Pick<TrackerConfig, "states" | "closedStates" | "stateIcons" | "stateColors"> & Partial<Pick<TrackerConfig, "triageState">>;

/** The states work moves through: open ones, without the triage state, which comes before the workflow. */
function workflow(config: Config): string[] {
  return config.states.filter((s) => !config.closedStates.includes(s) && s !== config.triageState);
}

function isDropped(status: string): boolean {
  return /cancel|wont|won't|dup|reject|invalid/i.test(status);
}

/** The drawing a state gets when the index does not set one. */
export function automaticDrawing(status: string | null, config: Config): StateDrawing {
  if (status === null || !config.states.includes(status)) return SHAPES["dashed"];
  if (config.closedStates.includes(status)) return isDropped(status) ? SHAPES["cross"] : SHAPES["check"];
  if (status === config.triageState) return { kind: "lucide", name: "inbox" };
  const open = workflow(config);
  const at = open.indexOf(status);
  if (at <= 0) return SHAPES["dashed"];
  return { kind: "ring", dashed: false, fraction: at / open.length };
}

/** The colour a state gets when the index does not set one. */
export function automaticColor(status: string | null, config: Config): string {
  if (status === null || !config.states.includes(status)) return "var(--text-faint)";
  if (config.closedStates.includes(status)) return isDropped(status) ? "var(--text-faint)" : "var(--interactive-accent)";
  if (status === config.triageState) return "var(--color-orange)";
  return workflow(config).indexOf(status) <= 0 ? "var(--text-faint)" : "var(--color-yellow)";
}

export function stateDrawing(status: string | null, config: Config): StateDrawing {
  const icon = status === null ? undefined : config.stateIcons[status];
  if (icon === undefined) return automaticDrawing(status, config);
  return SHAPES[icon] ?? { kind: "lucide", name: icon };
}

export function stateColor(status: string | null, config: Config): string {
  const color = status === null ? undefined : config.stateColors[status];
  return color === undefined ? automaticColor(status, config) : cssColor(color);
}
