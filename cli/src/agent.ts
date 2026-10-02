// What the CLI hands to LLM coding agents: a skill that teaches the commands,
// and a block of instructions for AGENTS.md or CLAUDE.md that names the
// tracker a project's work is tracked in.

import * as fs from "node:fs";
import * as nodePath from "node:path";

export const SKILL_NAME = "bilinear";

/** The skill, as a SKILL.md: frontmatter that says when to use it, then how. */
export const SKILL = `---
name: ${SKILL_NAME}
description: Track work as issues in a Bilinear tracker, a folder of Markdown notes in an Obsidian vault, using the bilinear command-line client. Use when asked to create, find, update, comment on, reorder, archive or delete issues or tasks, when project instructions name a Bilinear tracker, or when a folder holds a note whose frontmatter marks it as a bilinear tracker.
---

# Bilinear

A Bilinear tracker is a folder: an index note (frontmatter \`bilinear: tracker\`)
that lists the issues in order, and one Markdown note per issue in \`issues/\`
(open) and \`archive/\` (archived). Issue IDs look like \`BL-12\`. The user may
have the same tracker open in Obsidian; the CLI and Obsidian can be used at the
same time.

## Running the CLI

\`\`\`sh
npx --yes obsidian-bilinear <command>     # nothing to install; needs Node 20+
bilinear <command>                        # if installed with npm install -g obsidian-bilinear
\`\`\`

The tracker is taken from \`--tracker PATH\` (the folder or its index note), then
\`$BILINEAR_TRACKER\`, then a search upward from the working directory. Outside
the tracker folder, pass \`--tracker\`. Run \`<command> --help\` for a command's
exact arguments.

## Commands

- \`list [--status S] [--label L] [--assignee A] [--priority P] [--archived | --all] [--json]\`: issues in the tracker's order. Filters take comma-separated values
- \`show <ID> [--json]\`: one issue: properties, linked issues, body and comments
- \`new "Title" [--status S] [--priority P] [--label L] [--assignee A] [--due YYYY-MM-DD] [--parent ID] [--top]\`: create an issue; prints its ID
- \`set <ID> key=value ...\`: change properties. \`key=\` removes one; \`labels+=x\`, \`labels-=x\` edit a list
- \`comment <ID> "text"\`: append a dated comment
- \`move <ID> --top | --bottom | --before <ID> | --after <ID>\`: reorder; the order is the priority order the user sees
- \`archive <ID>... | --closed\`, \`unarchive <ID>...\`: move issues out of and back into the open list
- \`rm <ID>\`: delete an issue; its note goes to the vault's trash (outside a vault it needs \`--force\`)
- \`state\`, \`label\`: list the tracker's states and labels
- \`lint [--fix]\`: check the tracker's consistency, and repair what is safe to

Properties: \`title\`, \`status\` (one of the tracker's states), \`priority\`
(\`none\`, \`low\`, \`medium\`, \`high\`, \`urgent\`), \`labels\`, \`assignee\`, \`due\`,
\`parent\` (an issue ID; makes a sub-issue), \`blocked-by\` (issue IDs). Any
other key is kept as a custom property.

\`\`\`sh
bilinear list --status todo,in-progress --json
bilinear new "Fix flaky cache test" --priority high --label bug
bilinear set BL-12 status=in-progress assignee=me
bilinear comment BL-12 "Reproduced: the cache key ignores the locale."
bilinear set BL-12 status=done
\`\`\`

## Working with it

- Read with \`--json\` (\`list\`, \`show\`, \`state\`, \`label\`, \`lint\`) when you need
  to act on the result.
- Run \`state\` before setting a status: trackers define their own states, and an
  unknown one is refused. A label the tracker does not list is accepted with a
  warning; add it with \`label <name>\` if it is meant to stay.
- Change issues through the CLI, not by editing the index note or an issue's
  frontmatter by hand. The description is the body of the note
  (\`show <ID> --json\` gives its \`path\`); edit it as an ordinary Markdown file,
  above the \`## Comments\` section.
- Link issues with \`[[BL-7]]\` in a description, or with \`parent\` and
  \`blocked-by\`. An issue's progress counts its sub-issues and the issues its
  description links to.
- Record what a later reader needs (what was found, what was decided, what is
  left) as comments on the issue rather than in the chat alone.
- Exit codes: 0 done; 1 bad arguments or no such issue (the message says
  which); 2 \`lint\` found problems; 3 the tracker was busy or a file changed
  underneath the command. On 3, run the command again.
`;

const START = "<!-- bilinear:start -->";
const END = "<!-- bilinear:end -->";

export interface TrackerFacts {
  /** The tracker folder, as the instructions should name it. */
  path: string;
  prefix: string;
  states: string[];
  closedStates: string[];
}

/** The instructions for an agents file: the tracker to use, and how. */
export function instructions(t: TrackerFacts): string {
  const open = t.states.filter((s) => !t.closedStates.includes(s));
  const cli = `npx --yes obsidian-bilinear --tracker ${/\s/.test(t.path) ? `"${t.path}"` : t.path}`;
  return `${START}
## Issue tracking

Work on this project is tracked in the Bilinear tracker at \`${t.path}\`, a
folder of Markdown notes that the user may also have open in Obsidian. Issue
IDs look like \`${t.prefix}-12\`. Use the \`bilinear\` CLI for every change to it:

\`\`\`sh
${cli} <command>
\`\`\`

- Before starting a piece of work, find its issue with \`list\` or \`show <ID>\`,
  or create one with \`new "Title"\`, and move it to the state that says it is
  being worked on with \`set <ID> status=<state>\`.
- States: ${open.map((s) => `\`${s}\``).join(", ")}${t.closedStates.length ? `; closed: ${t.closedStates.map((s) => `\`${s}\``).join(", ")}` : ""}.
- Record findings, decisions and what is left as comments on the issue:
  \`comment <ID> "text"\`.
- When the work is finished, set the issue to a closed state. Work that turns
  up along the way and is not done now gets its own issue.
- Do not edit the tracker's index note or an issue's properties by hand.
  \`--help\` lists the commands; the \`bilinear\` skill, if it is installed,
  describes them.
${END}
`;
}

/** Where a skill goes: a project's or the user's Claude Code skills, or a skills folder that is named. */
export function skillPath(where: { dir?: string; global: boolean }, cwd: string, home: string): string {
  const skills = where.dir !== undefined ? nodePath.resolve(cwd, where.dir) : nodePath.join(where.global ? home : cwd, ".claude", "skills");
  return nodePath.join(skills, SKILL_NAME, "SKILL.md");
}

/** Write a file, with its folders. Returns whether it was there, and whether it changed. */
export function writeFile(path: string, text: string): "created" | "updated" | "unchanged" {
  const old = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : null;
  if (old === text) return "unchanged";
  fs.mkdirSync(nodePath.dirname(path), { recursive: true });
  fs.writeFileSync(path, text);
  return old === null ? "created" : "updated";
}

/** The agents file to write when none is named: the one that is there, AGENTS.md if both or neither. */
export function agentsFile(cwd: string): string {
  const has = (name: string) => fs.existsSync(nodePath.join(cwd, name));
  return nodePath.join(cwd, !has("AGENTS.md") && has("CLAUDE.md") ? "CLAUDE.md" : "AGENTS.md");
}

/**
 * Put the instructions into an agents file: in place of the block that is
 * there from an earlier run, else at the end. The rest of the file is kept.
 */
export function withInstructions(old: string | null, block: string): string {
  if (old === null || old.trim() === "") return block;
  const eol = old.includes("\r\n") ? "\r\n" : "\n";
  const text = eol === "\n" ? block : block.replace(/\n/g, eol);
  const start = old.indexOf(START);
  const end = old.indexOf(END);
  if (start >= 0 && end > start) {
    let after = end + END.length;
    if (old.startsWith(eol, after)) after += eol.length;
    return old.slice(0, start) + text + old.slice(after);
  }
  return `${old.replace(/\s*$/, "")}${eol}${eol}${text}`;
}
