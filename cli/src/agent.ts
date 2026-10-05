// What the CLI hands to LLM coding agents: a skill that teaches the commands,
// and a block of instructions for CLAUDE.md or AGENTS.md that names the
// tracker a project's work is tracked in. The skill is the same for every
// tracker and says how work is tracked; the instructions only say where.
// The files go where Claude Code and Codex read them: in a project, or in
// the folders they keep in the user's home, or the instructions in a project
// and the skill in the home folder, where it serves every project.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { ContextEntry } from "../../plugin/src/format/context";
import { TYPE_LETTERS } from "../../plugin/src/format/ids";

export const SKILL_NAME = "bilinear";

/** The skill, as a SKILL.md: frontmatter that says when to use it, then how. */
export const SKILL = `---
name: ${SKILL_NAME}
description: Track work as issues in a Bilinear tracker, Markdown notes in an Obsidian vault, using the bilinear command-line client. Use for all work in a project whose instructions name a Bilinear issue tracker, where every piece of work must be tracked as an issue from before it starts until it is finished, and whenever asked to create, find, update, comment on, reorder, archive or delete issues or tasks.
---

# Bilinear

A Bilinear tracker is an index note (frontmatter \`bilinear: tracker\`) that
lists the issues in order, and one Markdown note per issue beside it, in
\`issues/\` (open) and \`archive/\` (archived). Issue IDs look like \`BL-12\`:
the tracker's prefix and a number. The user may have the same tracker open in
Obsidian; the CLI and Obsidian can be used at the same time.

A folder may hold several trackers, each with a prefix of its own, whose
notes lie together in \`issues/\` and \`archive/\`. The tracker of a project is
the one its instructions name, by the path of its index note: work in that
one only, and leave the issues of the others alone unless you are asked.
The exception: an issue may be blocked by or related to an issue of another
tracker in the folder, by its ID, and you may set such a link. Relating,
unrelating and deleting may edit the relation lists in the other tracker's
note as a side effect. Beyond that, do not change the other tracker's
issues: to edit, comment on or move one, run the CLI with that tracker's
board file.

## Tracking work

When a project's instructions name a Bilinear issue tracker, every piece of
work you do in that project is tracked in it, from before you start until
after you finish. This is required, and it does not wait to be asked for.

1. **Before starting**, find the issue for the work (\`list\`, \`show <ID>\`).
   If there is none, create it with \`new "Title" --description "..."\`, with a
   title that says what is to be done and a description of what is known:
   what was asked, the constraints, how to tell that it is done. Do not start work
   that has no issue. One issue is one piece of work that can be finished on
   its own; larger work is split into issues of their own, which the issue
   for the whole is blocked by (\`--blocked-by <ID>\`). When you start or
   resume an issue, read the working state that \`show <ID>\` prints, if
   there is one: it is what earlier sessions left, so do not derive it again.
2. **On choosing what to work on**, take the issue and move it out of the
   backlog, before anything is started. As soon as you intend to work on
   an issue, set it to the state for work that is up next, and assign it
   to yourself: \`set <ID> assignee=<your name> status=<state>\`. That
   state is the one between the state new issues start in and the working
   state, \`todo\` in a new tracker (\`state\` lists the tracker's states in
   order). Do this even when the work starts later or after other issues,
   so that the user sees what is coming and who has taken it. In a tracker
   with no such state there is nothing to move to here: assign the issue
   to yourself and leave it where it is. Do not take an issue that is
   assigned to someone else unless you are asked to; an issue that bears
   the user's name only because it waited for them is the exception, as
   said below.
3. **On starting**, move the issue to the state that means it is being
   worked on: \`set <ID> status=<state>\`. It is assigned to you from the
   step before; if it is still unassigned, assign it to yourself now.
4. **While working**, comment (\`--author <your name> comment <ID> "text"\`)
   whenever you learn or decide something a later reader needs: the cause you found, the approach
   you chose or gave up, a change of plan. If the issue cannot go on until
   another is done, say so with \`set <ID> blocked-by+=<other ID>\`; if it
   waits for the user, comment with what you need from them and assign the
   issue to them (\`set <ID> assignee=<the user's name>\`), and take it back
   once they have answered. Work that turns up along the way and is not
   part of this issue gets an issue of its own, related to this one
   (\`new "Title" --related-to <ID>\`), which the comment names as \`[[ID]]\`.
   Before you try a new approach, run \`context list <ID> --type R\`, and do
   not repeat an approach whose \`Applies:\` condition still holds; read
   that condition with \`context get <FULLID>\`. Record
   what a later session needs with \`context record\`: a decision with its
   rationale, a constraint, a finding, an approach that failed (what was
   attempted, why it failed, when that applies), an open question, the
   current state. A comment is for the user and the history; a context entry
   is for the next session. Do not copy one into the other.
5. **When the work waits for review**, move the issue to the tracker's review
   state if it has one. At each status change, and before you stop work, run
   \`context checkpoint <ID>\` and, if there is something new, answer it
   with one \`context record <ID> --file -\` call.
6. **On finishing**, comment what was done and how it was checked, then set
   the issue to the closed state that means done. Work that is given up is
   closed too: comment why, and set the closed state that means canceled.
   Do not close an issue whose work was not checked.
7. **On stopping before the work is finished**, comment what is done and what
   is left, so that someone else can carry on from the issue alone. Leave it
   in the working state only if the work is still going on; otherwise move
   it back: to the state for work that is up next, still assigned to you, if
   you intend to carry on with it, else to the backlog, with the assignment
   given up (\`assignee=\`).
   An issue that stops because it waits for the user is not given up: it
   stays assigned to the user, in the state it is in.

Your name, for assignments and comments, is the name of the agent you are,
such as \`claude\` or \`codex\`: never the user's, and the same every time. The
CLI signs a comment with the name of the user who is logged in unless it is
told otherwise, so pass \`--author <your name>\` with every \`comment\`, or set
\`BILINEAR_USER=<your name>\` for the commands you run. Issues you create for
any agent to pick up stay unassigned.

An issue that needs the user to act is assigned to the user, so that they
see it as theirs: one that waits for their answer or decision, one that only
they can do, one in the triage state. The user's name is their login name,
\`$USER\`, which is what the CLI signs their comments with, unless issues in
the tracker are already assigned to the user under another name.
Once the user has acted, by answering or by moving the issue out of the
triage state, the issue is free for you to take although it still bears
their name. An issue whose work only the user can do is not: say in its
description that the work is the user's, and leave such an issue to them.

The status of an issue says what is true now. Archiving and deleting issues is
the user's to do: do neither unless asked.

## Writing issues

Titles, descriptions and comments are read in passing. Keep them short.

- Prefer checklists to prose: what to do, constraints and how to tell it is
  done go in as items (\`- [ ] item\`). Tick an item (\`- [x]\`) in the
  description when it is done; a comment is not edited.
- Short-form technical English: no filler, no greetings, no "I have found
  that". Lead with the fact or the verb. "Cache key ignores locale. Fix:
  add locale to key."
- Exact names in backticks: paths, symbols, commands, error text.
- Prose only where a list cannot carry it, such as a reason or a
  trade-off, and then a sentence or two.
- Options in a triage issue follow the same rule: a heading, then items for
  and against.

## Relations between issues

How issues depend on each other is part of the tracking, and it is required
as the statuses are. Record a relation in the tracker when you create an
issue and whenever you learn of one, and keep it true as the work changes. A
relation that is only in your head, or only in the prose of a comment where
a property is meant for it, is lost to whoever reads the tracker next.

- **Has to wait for another issue**: \`set <ID> blocked-by+=<other ID>\`, or
  \`--blocked-by <ID>\` with \`new\`. When issues have to be done in an order,
  say so this way, each one blocked by the one before it. Do not start an
  issue while one that blocks it is open: work on the blocker first.
  Remove the entry (\`blocked-by-=<other ID>\`) if it turns out not to hold;
  one whose blocker is closed may stay.
- **Made up of other issues**: split work that is too large to finish in
  one go into issues of their own, and make the issue for the whole
  \`blocked-by\` each of them. Its progress counts the issues it is blocked
  by (closed out of total), so it shows how many are done. \`[[ID]]\` in a
  description is only a mention and does not count.
- **Related in another way** (a follow-up, the same cause, a duplicate, one
  that replaces another): \`set <ID> related-to+=<other ID>\`, or
  \`--related-to <ID>\` with \`new\`. Setting it on one of the two is
  enough: the relation shows on both, and \`related-to-=<other ID>\` on
  either ends it. Say in a comment what the relation is. A duplicate is
  then closed in the state that means canceled, and what it knew is carried
  over to the issue that stays.
- **Another tracker's issue**: \`blocked-by\` and \`related-to\` also take the
  ID of an issue of another tracker in the same folder, such as
  \`set BL-3 blocked-by+=OT-7\`. Such a blocker is done when it is in a closed
  state of its own tracker. An ID that no tracker in the folder lists is
  refused. \`show\` prints the linked issue with its status, but \`show <ID>\`
  and \`list\` cover only the tracker you ran them with: to read the other
  issue itself, run the CLI with that tracker's board file.

Before creating an issue, look through the open ones (\`list\`) for the ones
it has to wait for and the ones that have to wait for it, and set these when
you create it. Before choosing what to work on, read the relations of the
issue: \`show <ID>\` lists the issues it is blocked by, the ones it blocks
and the ones it is related to, with their states, and \`list --blocked\`
lists the issues that still wait for another. The CLI refuses a
\`blocked-by\` that would make issues wait for each other in a circle, also
through the other trackers of the folder. When
a relation changes, because work is split or no longer needed, change it in
the tracker at once.

## Running the CLI

\`\`\`sh
npx --yes obsidian-bilinear <board file> <command>   # nothing to install; needs Node 20+
bilinear <board file> <command>                      # if installed with npm install -g obsidian-bilinear
\`\`\`

The first argument is the board file: the tracker's index note, which ends in
\`.md\`. Pass the path the project's instructions give, first, with every
command; a relative path there is from the root of the repository. Or set
\`BILINEAR_TRACKER\` to that path once, and leave the board file out:
\`bilinear <command> ...\`; one given first wins. Nothing else picks the
tracker: not the working directory, and not the prefix of the issues named.
Options such as \`--author\` come after the command. Run
\`<board file> <command> --help\` for a command's exact arguments.

## Commands

- \`list [--status S] [--label L] [--assignee A] [--priority P] [--blocked] [--blocked-by ID] [--related-to ID] [--archived | --all] [--json]\`: issues in the tracker's order. Filters take comma-separated values
- \`show <ID> [--json]\`: one issue: properties, the issues it is blocked by, blocks and is related to, body and comments, and its working state (the context that earlier sessions recorded)
- \`new "Title" [--description TEXT] [--status S] [--priority P] [--label L] [--assignee A] [--due YYYY-MM-DD] [--blocked-by ID] [--related-to ID] [--top]\`: create an issue; prints its ID. The description is Markdown and may have several lines
- \`set <ID> key=value ...\`: change properties. \`key=\` removes one; \`labels+=x\`, \`labels-=x\` edit a list
- \`comment <ID> "text" [--author NAME]\`: append a dated comment, signed with NAME
- \`context record <ID|PREFIX> --type T --subject TEXT [--content TEXT] [--rationale TEXT] [--alternatives TEXT] [--evidence kind:value] [--supersedes ID] [--new] | --file <path|->\`: add a context entry to an issue, or to the tracker with its prefix; \`--file\` takes a batch of entries as JSON, all or nothing. T is \`decision\`, \`constraint\`, \`finding\`, \`rejected\`, \`question\`, \`state\` or \`artifact\`; \`rejected\` also needs \`--attempted\`, \`--failed\` and \`--applies\`, and takes \`--promising\` and \`--happened\`
- \`context list <ID|PREFIX> [--type T] [--status S] [--all] [--json]\`: one line for each active entry; \`--type R\` gives the rejected approaches
- \`context get <FULLID>... [--json]\`: whole entries, such as \`BL-12/D3\` or \`BL/D1\`, with their evidence; also the superseded ones
- \`context checkpoint <ID>\`: writes nothing; prints what to record now, for you to answer with one \`context record <ID> --file -\` call
- \`move <ID> --top | --bottom | --before <ID> | --after <ID>\`: reorder; the order is the priority order the user sees
- \`archive <ID>... | --closed\`, \`unarchive <ID>...\`: move issues out of and back into the open list
- \`rm <ID>\`: delete an issue; its note goes to the vault's trash (outside a vault it needs \`--force\`)
- \`state\`, \`label\`: list the tracker's states (marking the closed ones and the triage state) and labels
- \`lint [--fix]\`: check the tracker's consistency, and repair what is safe to

Properties: \`title\`, \`status\` (one of the tracker's states), \`priority\`
(\`none\`, \`low\`, \`medium\`, \`high\`, \`urgent\`), \`labels\`, \`assignee\`, \`due\`,
\`blocked-by\` and \`related-to\` (issue IDs). Any other key is kept as a
custom property.

\`\`\`sh
bilinear <board file> list --status todo,in-progress --json
bilinear <board file> new "Fix flaky cache test" --priority high --label bug
bilinear <board file> set BL-12 assignee=claude status=todo
bilinear <board file> set BL-12 status=in-progress
bilinear <board file> comment BL-12 "Reproduced: the cache key ignores the locale." --author claude
bilinear <board file> context record BL-12 --type rejected --subject "Key the cache by URL" --attempted "Used the URL as the key" --failed "Two locales share a URL" --applies "While the URL has no locale"
bilinear <board file> context list BL-12 --type R
bilinear <board file> context checkpoint BL-12
bilinear <board file> set BL-12 status=done
\`\`\`

## Working with it

- Read with \`--json\` (\`list\`, \`show\`, \`context list\`, \`context get\`, \`state\`,
  \`label\`, \`lint\`) when you need to act on the result.
- Never edit or delete a context entry by hand. A decision that changes is a
  new entry with \`--supersedes\`. A constraint for the whole tracker goes to
  the tracker scope: \`context record <PREFIX> --type constraint ...\`.
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
- The triage state is only for decisions of high importance about the
  architecture: ones that shape how the system is built, are costly to undo,
  and where it is not plain which way is best. Anything of lower importance,
  and anything whose best course is obvious, is not put there: create it as
  an ordinary issue in the backlog, with the course you would take in its
  description. Do not use triage to ask leave for what you can decide.
- Before you put an issue in the triage state, search the tracker for the
  issues that have to do with it: \`list --all\` shows every issue, the
  closed and the archived ones too, and its notes (those in \`issues/\` and
  \`archive/\` beside the index note whose names have its prefix) can be
  searched for the words that matter. Add the issue only if it is
  warranted. If an issue already covers it, comment there instead; if one
  like it was rejected or canceled, do not propose it again unless something
  has changed, and then say what. When you do add it, set its relations as
  the section on relations says, so that the user sees what it belongs to.
- Assign an issue that you put in the triage state to the user
  (\`--assignee <the user's name>\`), and write it so that the user can accept
  it with as few edits as possible: a title and a description that are ready
  to work from as they stand. Where there is more than one way to do the
  work, give each in the description as an option of its own, under its own
  heading, with what speaks for it and against it, and the one you recommend
  first. The user deletes the options they discard, leaves the one they
  accept and moves the issue to the backlog. Do not ask a question where
  options to keep or delete can stand for the answers.
- Exit codes: 0 done; 1 bad arguments or no such issue (the message says
  which); 2 \`lint\` found problems; 3 the tracker was busy or a file changed
  underneath the command. On 3, run the command again.
`;

const posix = (path: string): string => path.split(nodePath.sep).join("/");

const START = "<!-- bilinear:start -->";
const END = "<!-- bilinear:end -->";
/** The line after START that says the block has the rule about follow-ups. */
const FOLLOWUPS = "<!-- bilinear:followups -->";

/** The folder with `.git` at or above a folder: the root of its repository. Null if there is none. */
export function repositoryRoot(folder: string): string | null {
  for (let dir = folder; ; dir = nodePath.dirname(dir)) {
    if (fs.existsSync(nodePath.join(dir, ".git"))) return dir;
    if (dir === nodePath.dirname(dir)) return null;
  }
}

/**
 * How instructions name a tracker: by the path of its index note, from the
 * root of the repository when it is inside the repository or beside it (one
 * level up), and by its absolute path when it is further away.
 */
export function trackerPath(tracker: string, root: string): string {
  const relative = nodePath.relative(root, tracker);
  if (relative === "") return ".";
  const parts = relative.split(nodePath.sep);
  if (nodePath.isAbsolute(relative) || parts.filter((part) => part === "..").length > 1) return tracker;
  return parts.join("/");
}

/** What `--followups` adds: nothing a task skips goes unrecorded, and follow-ups that need a decision of high importance about the architecture wait for the user. */
function followups(triage: string): string {
  return `
Finish no task with gaps left unrecorded. Whatever the task asked for or
needed that you skipped, put off, stubbed or did only in part becomes a
follow-up issue before you close the task, related to the task
(\`--related-to <the task's ID>\`), and a comment on the task names it as
\`[[ID]]\`.

A follow-up is created like any issue, in the backlog, with the course you
would take in its description: that is so for everything of lower
importance, and for everything whose best course is obvious. Only a
follow-up that needs a decision of high importance about the architecture,
one that shapes how the system is built, is costly to undo, and where it is
not plain which way is best, is created in the \`${triage}\` state
(\`new "Title" --status ${triage}\`): it waits there for the user to accept
it, by moving it to another state, or to reject it. Do not work on an issue
that is in \`${triage}\`.

Before you create an issue in \`${triage}\`, search the tracker for the issues
that have to do with it, the closed and the archived ones too, and create it
only if it is warranted: none covers it already, and none like it was
rejected. When you create it, set its relations to the issues you found.

Assign an issue for \`${triage}\` to the user (\`--assignee <the user's name>\`),
since it is theirs to act on, and write it so that the user can accept it
with as few edits as possible. Where there is more than one way to do it,
give each in the description as an option of its own, the one you recommend
first: the user deletes the options they discard, leaves the one they accept
and moves the issue to the backlog.
`;
}

/**
 * `word` as one shell word: as is if plain, else in double quotes. A backslash is left as it is, being the separator
 * of a Windows path, which no shell there takes for an escape.
 */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./\\~-]+$/.test(word) ? word : `"${word.replace(/["$`]/g, "\\$&")}"`;
}

/** The batch that `context record --file -` takes, as the checkpoint shows it. It is valid for an issue with no entries. */
const CHECKPOINT_EXAMPLE = [
  {
    type: "decision",
    subject: "Use a queue for the writes",
    content: "All writes go through one queue.",
    rationale: "Two writers can overwrite each other.",
  },
  {
    type: "rejected",
    subject: "Lock the file for each write",
    rejected: {
      attempted: "A lock on the file for each write.",
      failed: "The lock made the editor wait.",
      applies: "Any code that runs in the editor.",
    },
  },
  {
    type: "state",
    subject: "Queue works, tests are next",
    content: "The queue is done. Next: write the tests for a full queue.",
  },
];

/**
 * The text of `context checkpoint`, for an agent: what to record in the note of an issue, what to leave out, the
 * active entries of the issue now, the shape of a batch and the command that records it. A pure function.
 */
export function checkpointText(id: string, entries: Array<Pick<ContextEntry, "local" | "type" | "subject" | "status">>): string {
  const active = entries.filter((e) => e.status === "active");
  const groups = Object.values(TYPE_LETTERS).flatMap((type) => {
    const found = active.filter((e) => e.type === type);
    return found.length ? [`${type}:`, ...found.map((e) => `  ${e.local} ${e.subject}`)] : [];
  });
  const count = (status: string) => entries.filter((e) => e.status === status).length;
  return [
    `CHECKPOINT ${id}`,
    "",
    "What must the next session know that the note does not hold yet? Record only these:",
    "- decisions, with the rationale",
    "- constraints",
    "- findings",
    "- rejected approaches: what you attempted, why it failed, where it applies",
    "- open questions",
    "- the current state: what is done and what is next",
    "- artifacts",
    "",
    "Do not record:",
    "- a narrative of the session",
    "- what the code or the commits already say",
    "- what an active entry already holds",
    "- a guess as a finding",
    'To change an entry, supersede it with "supersedes": ["D3"]. Do not write a second entry.',
    "",
    `The active entries of ${id} now:`,
    ...(active.length ? groups : [entries.length ? "(no active entries)" : "(no entries yet)"]),
    `superseded: ${count("superseded")}, resolved: ${count("resolved")}`,
    "",
    "The batch is a JSON array. For example:",
    JSON.stringify(CHECKPOINT_EXAMPLE, null, 2),
    "",
    "Record the batch with this command. Send the JSON on the standard input:",
    `context record ${id} --file -`,
    'If there is nothing new, "nothing new" is a valid result. Then no command is necessary.',
  ].join("\n");
}

/** The instructions for CLAUDE.md or AGENTS.md: which tracker the project's work is tracked in, and where the skill is. */
export function instructions(path: string, skill: string, triage?: string): string {
  const where = nodePath.isAbsolute(path) ? "Its path:" : "Its path, from the root of the repository:";
  return `${START}${triage === undefined ? "" : `\n${FOLLOWUPS}`}
## Issue tracking

Work on this project is tracked in a Bilinear issue tracker. ${where}

    ${path}

Run the CLI with it first, as in \`bilinear ${shellWord(path)} <command> ...\`, or set
\`BILINEAR_TRACKER\` to it once and leave it out.

Track every piece of work there, from before it starts until it is finished,
as the \`bilinear\` skill says. The skill is in
\`${skill}\`.
${triage === undefined ? "" : followups(triage)}${END}
`;
}

/** The block an earlier run wrote in the text of an instructions file, from START to END. Null if there is none. */
export function instructionsBlock(text: string): string | null {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  return start >= 0 && end > start ? text.slice(start, end + END.length) : null;
}

/** Whether a block has the rule about follow-ups: it says so, or, if it is from before it did, it has the rule's text. */
export function hasFollowups(block: string): boolean {
  return block.includes(FOLLOWUPS) || block.includes("follow-up issue");
}

/** The tracker a block names: the first line indented by four spaces after the one that says "Its path". Null if there is none. */
export function blockTracker(block: string): string | null {
  const lines = block.split("\n");
  for (let i = lines.findIndex((line) => line.includes("Its path")) + 1; i > 0 && i < lines.length; i++) {
    if (/^ {4}\S/.test(lines[i])) return lines[i].slice(4).replace(/\r$/, "");
  }
  return null;
}

/** Where the skill goes in a folder that agents read skills from (`.claude`, `.agents`): `skills/bilinear/SKILL.md`. */
export function skillPath(dir: string): string {
  return nodePath.join(dir, "skills", SKILL_NAME, "SKILL.md");
}

/**
 * The skill a block refers to, as the block names it and as a path: one
 * from `~` is in the home folder, a relative one in the project. Null if the
 * block names none, or something that is not where a skill goes.
 */
export function blockSkill(block: string, dir: string, home: string): { ref: string; path: string } | null {
  const ref = /The skill is in\s+`([^`\r\n]+)`/.exec(block)?.[1];
  if (ref === undefined || !posix(ref).endsWith(posix(skillPath("")))) return null;
  return { ref, path: ref.startsWith("~/") ? nodePath.join(nodePath.resolve(home), ref.slice(2)) : nodePath.resolve(dir, ref) };
}

/** Write a file, with its folders. Returns whether it was there, and whether it changed. */
export function writeFile(path: string, text: string): "created" | "updated" | "unchanged" {
  const old = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : null;
  if (old === text) return "unchanged";
  fs.mkdirSync(nodePath.dirname(path), { recursive: true });
  fs.writeFileSync(path, text);
  return old === null ? "created" : "updated";
}

/**
 * Put the instructions into an instructions file: in place of the block that is
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

/** Bad choice of folder or options for `agent-setup`. */
export class SetupError extends Error {}

/** One harness's files: the skill, the instructions file (none for a folder only skills are read from), and how the instructions name the skill. */
export interface Target {
  skill: string;
  file: string | null;
  ref: string;
  /** The skill is in a folder of the user's home, not in the project. */
  global: boolean;
}

/** Where `agent-setup` goes: the folder, whether it is one of the user's own, and the files to write, claude before codex. */
export interface Plan {
  dir: string;
  home: boolean;
  targets: Target[];
}

export interface Places {
  cwd: string;
  home: string;
  claudeHome?: string;
  codexHome?: string;
}

export interface Flags {
  codex?: boolean;
  claude?: boolean;
  local?: boolean;
  followups?: boolean;
  /** A project gets only the instructions; the skill goes to the harness's folder in the home directory. */
  globalSkill?: boolean;
  /** Refresh what an earlier run wrote: a project folder gives every file it may have written. */
  update?: boolean;
}

/**
 * Decide what `agent-setup <arg>` writes. A project folder takes `--codex`,
 * `--claude` or both; `~/.claude`, `~/.codex` and `~/.agents` (or where
 * CLAUDE_CONFIG_DIR and CODEX_HOME put the first two) mean their harness,
 * and `~/.agents` gets only the skill, which Codex also reads from there. With
 * `globalSkill` a project's skill goes to those folders too, and the project
 * has only the instructions. With `update`, a project folder needs no option: it gives each file that an
 * earlier run may have written, for the caller to look at which are there.
 */
export function plan(arg: string, at: Places, flags: Flags): Plan {
  const home = nodePath.resolve(at.home);
  const dir = nodePath.resolve(at.cwd, arg === "~" || arg.startsWith("~/") || arg.startsWith(`~${nodePath.sep}`) ? nodePath.join(home, arg.slice(1)) : arg);
  const is = (...paths: (string | undefined)[]) => paths.some((p) => p !== undefined && nodePath.resolve(at.cwd, p) === dir);
  const tilde = (path: string) => (path.startsWith(home + nodePath.sep) ? `~/${posix(nodePath.relative(home, path))}` : path);
  const target = (base: string, file: string | null, ref: (skill: string) => string, global: boolean): Target => {
    const skill = skillPath(base);
    return { skill, file, ref: ref(skill), global };
  };
  const inHome = (base: string, file: string | null) => target(base, file, tilde, true);
  const agents = nodePath.join(home, ".agents");
  const claudeHome = at.claudeHome !== undefined ? nodePath.resolve(at.cwd, at.claudeHome) : nodePath.join(home, ".claude");
  const kind = is(at.claudeHome, nodePath.join(home, ".claude")) ? "claude" : is(at.codexHome, nodePath.join(home, ".codex")) ? "codex" : is(agents) ? "agents" : null;
  const wrong = (flag: string, what: string) => new SetupError(`${flag} does not go with ${arg}: it is ${what}`);

  if (kind === "claude") {
    if (flags.codex) throw wrong("--codex", "Claude Code's folder");
    return { dir, home: true, targets: [inHome(dir, nodePath.join(dir, "CLAUDE.md"))] };
  }
  if (kind === "codex") {
    if (flags.claude) throw wrong("--claude", "Codex's folder");
    return { dir, home: true, targets: [inHome(agents, nodePath.join(dir, "AGENTS.md"))] };
  }
  if (kind === "agents") {
    if (flags.claude) throw wrong("--claude", "where only skills are kept, which Claude Code does not read");
    if (flags.followups) throw new SetupError("--followups needs instructions, and there are none in ~/.agents: give ~/.codex or a project's folder");
    return { dir, home: true, targets: [inHome(agents, null)] };
  }
  if ([".claude", ".codex", ".agents"].includes(nodePath.basename(dir))) {
    throw new SetupError(`give the project's folder, not its ${nodePath.basename(dir)}, or one of the folders in your home to set up for all projects`);
  }
  const local = (base: string, file: string) => target(nodePath.join(dir, base), nodePath.join(dir, file), (skill) => posix(nodePath.relative(dir, skill)), false);
  if (flags.update) return { dir, home: false, targets: [local(".claude", "CLAUDE.md"), local(".claude", "CLAUDE.local.md"), local(".agents", "AGENTS.md")] };
  if (!flags.claude && !flags.codex) throw new SetupError("give --codex, --claude or both");
  // With the skill in the home folder, the project has only its instructions.
  const project = (base: string, homeBase: string, file: string) => (flags.globalSkill ? inHome(homeBase, nodePath.join(dir, file)) : local(base, file));
  const targets: Target[] = [];
  if (flags.claude) targets.push(project(".claude", claudeHome, flags.local ? "CLAUDE.local.md" : "CLAUDE.md"));
  if (flags.codex) targets.push(project(".agents", agents, "AGENTS.md"));
  return { dir, home: false, targets };
}

/** A path with its links resolved as far as it exists. */
export function realPath(path: string): string {
  const rest: string[] = [];
  let dir = path;
  while (!fs.existsSync(dir) && dir !== nodePath.dirname(dir)) {
    rest.unshift(nodePath.basename(dir));
    dir = nodePath.dirname(dir);
  }
  return nodePath.join(fs.realpathSync(dir), ...rest);
}

/** Whether git has a file committed or staged. False when it says no or cannot say. */
export function isTracked(file: string, cwd: string): boolean {
  return fs.existsSync(file) && spawnSync("git", ["ls-files", "--error-unmatch", "--", file], { cwd, stdio: "ignore" }).status === 0;
}

/** What to exclude from git for a project's files: the instructions files and the skill folders that are in the project, from the repository's root. `real` is `dir` with its links resolved. */
export function excludePatterns(targets: Target[], dir: string, real: string, root: string): string[] {
  const from = (path: string) => `/${posix(nodePath.relative(root, nodePath.join(real, nodePath.relative(dir, path))))}`;
  return targets.flatMap(({ skill, file, global }) => [...(file === null ? [] : [from(file)]), ...(global ? [] : [`${from(nodePath.dirname(skill))}/`])]);
}

/** Add patterns to a git exclude file, keeping what is there. Returns those that were not there yet. */
export function exclude(file: string, patterns: string[]): string[] {
  const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = new Set(old.split(/\r?\n/));
  const added = patterns.filter((p) => !lines.has(p));
  if (added.length) {
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${old}${old === "" || old.endsWith("\n") ? "" : "\n"}${added.join("\n")}\n`);
  }
  return added;
}
