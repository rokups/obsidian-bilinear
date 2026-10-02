// What the CLI hands to LLM coding agents: a skill that teaches the commands,
// and a block of instructions for AGENTS.md or CLAUDE.md that names the
// tracker a project's work is tracked in. The skill is the same for every
// tracker and says how work is tracked; the instructions only say where.

import * as fs from "node:fs";
import * as nodePath from "node:path";

export const SKILL_NAME = "bilinear";

/** The skill, as a SKILL.md: frontmatter that says when to use it, then how. */
export const SKILL = `---
name: ${SKILL_NAME}
description: Track work as issues in a Bilinear tracker, a folder of Markdown notes in an Obsidian vault, using the bilinear command-line client. Use for all work in a project whose instructions name a Bilinear issue tracker, where every piece of work must be tracked as an issue from before it starts until it is finished, and whenever asked to create, find, update, comment on, reorder, archive or delete issues or tasks.
---

# Bilinear

A Bilinear tracker is a folder: an index note (frontmatter \`bilinear: tracker\`)
that lists the issues in order, and one Markdown note per issue in \`issues/\`
(open) and \`archive/\` (archived). Issue IDs look like \`BL-12\`. The user may
have the same tracker open in Obsidian; the CLI and Obsidian can be used at the
same time.

## Tracking work

When a project's instructions name a Bilinear issue tracker, every piece of
work you do in that project is tracked in it, from before you start until
after you finish. This is required, and it does not wait to be asked for.

1. **Before starting**, find the issue for the work (\`list\`, \`show <ID>\`).
   If there is none, create it with \`new "Title"\`, with a title that says
   what is to be done, and write what is known into its description: what was
   asked, the constraints, how to tell that it is done. Do not start work
   that has no issue. One issue is one piece of work that can be finished on
   its own; larger work is a parent issue with sub-issues (\`--parent <ID>\`).
2. **On starting**, move the issue to the state that means it is being worked
   on (\`set <ID> status=<state>\`; \`state\` lists the tracker's states).
3. **While working**, comment (\`comment <ID> "text"\`) whenever you learn or
   decide something a later reader needs: the cause you found, the approach
   you chose or gave up, a change of plan. If the issue cannot go on until
   another is done, say so with \`set <ID> blocked-by+=<other ID>\`; if it
   waits for a person, comment with the question. Work that turns up along
   the way and is not part of this issue gets an issue of its own, which the
   comment names as \`[[ID]]\`.
4. **When the work waits for review**, move the issue to the tracker's review
   state if it has one.
5. **On finishing**, comment what was done and how it was checked, then set
   the issue to the closed state that means done. Work that is given up is
   closed too: comment why, and set the closed state that means canceled.
   Do not close an issue whose work was not checked.
6. **On stopping before the work is finished**, comment what is done and what
   is left, so that someone else can carry on from the issue alone. Leave it
   in the working state only if the work is still going on; otherwise move it
   back to the state for work that has not started.

The status of an issue says what is true now. Archiving and deleting issues is
the user's to do: do neither unless asked.

## Running the CLI

\`\`\`sh
npx --yes obsidian-bilinear <command>     # nothing to install; needs Node 20+
bilinear <command>                        # if installed with npm install -g obsidian-bilinear
\`\`\`

The tracker is taken from \`--tracker PATH\` (the folder or its index note), then
\`$BILINEAR_TRACKER\`, then a search upward from the working directory. Pass
\`--tracker\` with the path the project's instructions give; a relative path
there is from the root of the repository. Run \`<command> --help\` for a
command's exact arguments.

## Commands

- \`list [--status S] [--label L] [--assignee A] [--priority P] [--archived | --all] [--json]\`: issues in the tracker's order. Filters take comma-separated values
- \`show <ID> [--json]\`: one issue: properties, linked issues, body and comments
- \`new "Title" [--status S] [--priority P] [--label L] [--assignee A] [--due YYYY-MM-DD] [--parent ID] [--top]\`: create an issue; prints its ID
- \`set <ID> key=value ...\`: change properties. \`key=\` removes one; \`labels+=x\`, \`labels-=x\` edit a list
- \`comment <ID> "text"\`: append a dated comment
- \`move <ID> --top | --bottom | --before <ID> | --after <ID>\`: reorder; the order is the priority order the user sees
- \`archive <ID>... | --closed\`, \`unarchive <ID>...\`: move issues out of and back into the open list
- \`rm <ID>\`: delete an issue; its note goes to the vault's trash (outside a vault it needs \`--force\`)
- \`state\`, \`label\`: list the tracker's states (marking the closed ones and the triage state) and labels
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
- A tracker may have a triage state (\`state\` marks it): issues in it wait for
  the user to accept or reject them. Do not work on them or move them out of
  it. New issues do not start there unless \`--status\` says so.
- Link issues with \`[[BL-7]]\` in a description, or with \`parent\` and
  \`blocked-by\`. An issue's progress counts its sub-issues and the issues its
  description links to.
- Exit codes: 0 done; 1 bad arguments or no such issue (the message says
  which); 2 \`lint\` found problems; 3 the tracker was busy or a file changed
  underneath the command. On 3, run the command again.
`;

const START = "<!-- bilinear:start -->";
const END = "<!-- bilinear:end -->";

/** The folder with `.git` at or above a folder: the root of its repository. The folder itself if there is none. */
export function repositoryRoot(folder: string): string {
  for (let dir = folder; ; dir = nodePath.dirname(dir)) {
    if (fs.existsSync(nodePath.join(dir, ".git"))) return dir;
    if (dir === nodePath.dirname(dir)) return folder;
  }
}

/**
 * How instructions name a tracker: by its path from the root of the
 * repository when it is inside the repository or beside it (one level up),
 * and by its absolute path when it is further away.
 */
export function trackerPath(tracker: string, root: string): string {
  const relative = nodePath.relative(root, tracker);
  if (relative === "") return ".";
  const parts = relative.split(nodePath.sep);
  if (nodePath.isAbsolute(relative) || parts.filter((part) => part === "..").length > 1) return tracker;
  return parts.join("/");
}

/** What `--followups` adds: nothing a task skips goes unrecorded, and doubtful follow-ups wait for the user. */
function followups(triage: string): string {
  return `
Finish no task with gaps left unrecorded. Whatever the task asked for or
needed that you skipped, put off, stubbed or did only in part becomes a
follow-up issue before you close the task, and a comment on the task names it
as \`[[ID]]\`. A follow-up that is plainly wanted is created like any issue. One
you are not sure is wanted is created in the \`${triage}\` state
(\`new "Title" --status ${triage}\`), with the reason for the doubt in its
description: it waits there for the user to accept it, by moving it to
another state, or to reject it. Do not work on an issue that is in \`${triage}\`.
`;
}

/** The instructions for an agents file: which tracker the project's work is tracked in. */
export function instructions(path: string, triage?: string): string {
  const where = nodePath.isAbsolute(path) ? "Its path:" : "Its path, from the root of the repository:";
  return `${START}
## Issue tracking

Work on this project is tracked in a Bilinear issue tracker. ${where}

    ${path}

Track every piece of work there, from before it starts until it is finished,
as the \`bilinear\` skill says. If the skill is not installed, read it with
\`npx --yes obsidian-bilinear skill --print\`.
${triage === undefined ? "" : followups(triage)}${END}
`;
}

/**
 * Where a skill goes: `.agents/skills`, the folder agents share, in the
 * project or in the user's home, or a skills folder that is named (an agent
 * that keeps its own, such as `.claude/skills`).
 */
export function skillPath(where: { dir?: string; global: boolean }, cwd: string, home: string): string {
  const skills = where.dir !== undefined ? nodePath.resolve(cwd, where.dir) : nodePath.join(where.global ? home : cwd, ".agents", "skills");
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
