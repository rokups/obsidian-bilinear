# Bilinear format

This is the normative description of how a Bilinear tracker is stored. The
Obsidian plugin (`plugin/`) and the CLI (`cli/`) both implement it, sharing
the code for the format and the operations, and both are tested against the
cases in `spec/fixtures/`.

The words "must" and "must not" are requirements on the tools. Hand-edited
files that break a rule are tolerated wherever this document says how.

## 1. Storage model

A tracker is one index note. The folder it lies in is its *tracker folder*,
which has two subfolders: `issues/` for the notes of open issues and
`archive/` for the notes of archived ones.

A folder may hold several trackers. They share the two subfolders, and the
prefix of its IDs tells each tracker's notes from the others', so the
trackers of one folder must have different prefixes. A tracker in a folder
of its own is the same thing with one index note.

```
Trackers/
  Bilinear.md        index note, prefix BL
  Website.md         index note, prefix WEB
  issues/
    BL-9.md
    BL-13.md
    WEB-2.md
  archive/
    BL-4.md
```

Either subfolder may be absent; tools create it when they first need it.

Before `issues/` existed, the notes of open issues lay directly in the tracker
folder. Tools still read such notes where they are (section 3), put new notes
in `issues/`, and `lint --fix` moves the old ones there.

### 1.1 Principles

1. The index note is the authority. An issue exists if and only if it has a
   line in the index.
2. The order of lines in the index is the manual order of issues.
3. Issue properties live in the issue note's frontmatter. The issue note is the
   source of truth for everything except existence, order and archived state.
4. Everything is hand-editable Markdown. Tools preserve content they do not
   understand, byte for byte.

### 1.2 Text conventions

- Files are UTF-8. A leading byte order mark is kept.
- A file's line ending is the ending of its first line (`\n` or `\r\n`). Lines
  a tool adds use it; existing lines keep whatever they have.
- A tool that inserts a line after a last line with no terminator adds the
  terminator. Otherwise a missing final newline stays missing.
- Frontmatter is present when the first line is `---` (trailing spaces or tabs
  allowed) and a later line is also `---`. If the opening line has no closing
  line the frontmatter is *unterminated*: the note is treated as having no
  properties, tools must not write to its frontmatter, and `lint` reports it.

### 1.3 Markdown structure

Tools look at three things in a note body: fenced code blocks, headings and
list lines.

- A fenced code block opens on a line starting with up to three spaces and then
  three or more `` ` `` or `~`. It closes on a line that, trimmed, consists only
  of that character, at least as many times. Nothing inside a fenced block is a
  heading or an issue line.
- A heading is `#` to `######`, whitespace, then the name. Trailing `#`s and
  whitespace are not part of the name.
- A *section* is a level-2 heading with an exact, case-sensitive name
  (`Issues`, `Archive`, `Comments`). It runs to the next level-1 or level-2
  heading, or to the end of the file. Deeper headings stay inside it. If a name
  appears on more than one level-2 heading only the first is the section.

### 1.4 Index note

An index note is a note at the top level of a folder whose frontmatter has
`bilinear: tracker`. Tools find it by the marker, not by name; the name is
the tracker's name and anything but an issue ID. Every such note in a folder
is a tracker of its own. A tool that is given a folder that holds several
must be told which is meant (by the note, or by an issue ID, whose prefix
names its tracker), and must not pick one.

```markdown
---
bilinear: tracker
prefix: BL
next: 14
states: [triage, backlog, todo, in-progress, in-review, done, canceled]
closed-states: [done, canceled]
triage-state: triage
labels: [bug, build, ui]
---

Free-form project notes. Never modified by the tools.

## Issues
- [[BL-13]] Fix flaky cache test
- [[BL-9]] Rework cache layer

## Archive
- [[BL-4]] Remove legacy loader
```

| Key | Meaning |
|---|---|
| `bilinear` | Marker; must be `tracker` |
| `prefix` | ID prefix, `[A-Z][A-Z0-9]*`; not that of another tracker in the folder |
| `next` | Next issue number to allocate; a positive integer |
| `states` | Workflow states, in display order; not empty |
| `closed-states` | Subset of `states` that count as closed |
| `triage-state` | Optional. The one of the open `states` in which issues wait for the user to accept or reject them |
| `labels` | Known labels; others produce a lint warning |
| `label-colors` | Optional. Colours for labels, as a list of `name=color` |
| `state-icons` | Optional. Icons for states, as a list of `name=icon` |
| `state-colors` | Optional. Colours for states, as a list of `name=color` |

An issue created without a status gets the first of `states` that is not the
triage state. An issue reaches the triage state only when it is created or
set there by name: it is for issues that somebody other than the user (a
script, an agent) proposes. The user accepts one by moving it to another
state and rejects one by closing or deleting it. A `triage-state` that is not
one of the open states is ignored and reported by `lint`.

A `label-colors` entry is split at its last `=`. The colour is one of `red`,
`orange`, `yellow`, `green`, `cyan`, `blue`, `purple`, `pink`, `gray` (any
letter case when read; written in lower case), or a hex value `#rgb` or
`#rrggbb`. A label with no entry gets a colour chosen by the plugin from its
name. Entries that do not parse are kept and reported by `lint`; setting a
colour rewrites only the entry for that label, and the key is removed when the
last entry goes.

```yaml
labels: [bug, build, ui]
label-colors: [bug=red, ui=#7c5cff]
```

`state-icons` and `state-colors` have the same shape, keyed by state. A
colour is as for labels. An icon is one of the shapes `dashed`, `circle`,
`quarter`, `half`, `three-quarters`, `check`, `cross`, or the name of a Lucide
icon such as `rocket` or `eye`: lower-case words joined by hyphens. A
`lucide-` prefix and upper case are accepted when read and dropped when
written. A state with no entry is drawn automatically by the plugin: an inbox
for the triage state, a dashed ring for the first of the other states, a ring
that fills as the workflow advances for the open states after it, a check for
closed states and a cross for closed states whose name reads as "not done"
(canceled, duplicate and the like). Entries
that do not parse, or that name something that is not a state, are kept and
reported by `lint`.

```yaml
state-icons: [in-review=eye, done=check]
state-colors: [in-review=purple]
```

An issue ID is `<prefix>-<number>`, matching `[A-Z][A-Z0-9]*-[0-9]+`.

**Issue lines.** Within the `## Issues` and `## Archive` sections, a line is an
issue line when it matches

```
<indent> <bullet> <ws> [[<link>]] [<ws> <title>]
```

where `<indent>` is any spaces or tabs, `<bullet>` is `-`, `*` or `+`, and
`<link>` reduces to an issue ID after dropping an alias (`|...`), a heading
reference (`#...`), a leading path and a `.md` suffix. All other lines in the
sections are kept and ignored.

The *canonical* form, which is what tools write, is

```
- [[<ID>]] <title>
```

with a bare link and a single space, or `- [[<ID>]]` when the title is empty.
The title is a copy of the issue's `title` property, kept so the index reads
well as Markdown. A tool that rewrites or moves a line writes it in canonical
form; lines it does not touch keep their form.

**What tools may change.** Only the frontmatter keys in the table above and the
issue lines of the two sections. Everything else is left byte-identical. Other
frontmatter keys are preserved. The plugin may also keep saved views in a
`bilinear-views` JSON code block in the body; the CLI ignores it.

**Missing sections.** A tool that needs a missing section creates it:
`## Issues` goes immediately before `## Archive` if that exists, followed by a
blank line; otherwise the section is appended to the end of the note, after a
blank line.

**Insertion points.** "End of a section" is immediately after its last issue
line, or immediately after the heading if it has none. "Top" is immediately
before its first issue line, or after the heading.

### 1.5 Issue note

The filename is the ID: `<ID>.md`, in `issues/` or in `archive/`.

```markdown
---
title: Fix flaky cache test
status: in-progress
priority: high
labels: [build, bug]
assignee: rk
due: 2026-10-10
blocked-by: ["[[BL-3]]"]
created: 2026-10-01
---

Free-form description.

## Comments
- 2026-10-01 rk: reproduced on a clean cache
```

| Property | Type | Notes |
|---|---|---|
| `title` | text | Required |
| `status` | text | Required; one of the index `states` |
| `priority` | text | `none`, `low`, `medium`, `high`, `urgent`; default `none` |
| `labels` | list | Optional |
| `assignee` | text | Optional, free text |
| `due` | date | Optional, `YYYY-MM-DD` |
| `blocked-by` | list of links | Optional; the issues this one waits for |
| `related-to` | list of links | Optional; symmetric, see Relations |
| `created` | date | Set on creation |

Unknown properties are preserved. A key with an empty value is the same as an
absent key. Where a list is expected a single scalar is read as a one-item
list.

A link property is read by reducing the wikilink the same way as an index line
link, so `"[[archive/BL-4|the loader]]"` names `BL-4`. A bare ID with no
brackets is also accepted. Tools write `"[[<ID>]]"`.

Titles are single-line: runs of whitespace, including line breaks, collapse to
one space and the ends are trimmed, both when reading and when writing.

A new note has the properties above in the order of the table, omitting those
with no value, and an empty body.

**Progress.** An issue's progress is counted over the issues it is
`blocked-by`, each once and in the order named. Only issues in the index of
this tracker or of another tracker in the same folder count, open or
archived; an issue is never counted for itself. Links in the description and
`related-to` do not count.

An issue's *progress* is the number of those issues whose `status` is one of
the `closed-states` of the tracker whose index lists them, out of how many
there are. A blocker whose note is missing counts as not closed. An issue with no `blocked-by` issues has no
progress. Progress is derived every time it is shown; nothing is stored.

**Relations.** `blocked-by` and `related-to` relate issues; everything below
is derived each time it is shown, and nothing but the two properties is
stored. An issue *blocks* the issues that name it in `blocked-by`. An issue
is *blocked* while an issue it is `blocked-by` has a `status` that is not one
of the `closed-states`, or has no note; whether the blocker is archived does
not matter. The linked issues may belong to this tracker or to another
tracker in the same folder (the IDs are unique in a folder, since the
prefixes differ); an issue of another tracker is closed when its `status` is
one of the `closed-states` of that tracker, not of this one. Two issues are
*related* when the `related-to` of either names the other, also across
trackers: one entry is enough, and tools show the relation on both. Links
that name no issue in the index of a tracker in the folder, and an issue
naming itself, are ignored here and reported by `lint`. `blocked-by` must not
lead back to the issue it starts from, also through the issues of the other
trackers; `related-to` has no such rule.

The description is the note body outside the `## Comments` section. A link in
it is a wikilink or an embed, `[[BL-3]]` or `![[BL-3]]`, reduced to an ID the
same way as an index line link; links inside fenced code blocks and inline
code do not count. They are listed as `links` and are informational.

**Comments** are list items under `## Comments` in the form

```
- YYYY-MM-DD <author>: <text>
```

A new comment goes after the last non-blank line of the section. If the section
is missing it is appended to the end of the note, after a blank line. Comment
text is single-line, normalised like a title.

### 1.6 YAML subset

Frontmatter is limited to what Obsidian's Properties UI emits for flat keys.
Each key is one of:

| Form | Example |
|---|---|
| Plain scalar | `status: in-progress` |
| Double-quoted scalar | `title: "Cache: handle \"stale\" entries"` |
| Single-quoted scalar | `title: 'It''s done'` |
| Empty | `assignee:` |
| Inline list | `labels: [build, "a, b"]` |
| Block list | `labels:` followed by `- build` lines, indented or not |

Blank lines and `#` comment lines are allowed between keys and are kept.

All scalars are read as text; `next: 14` is the text `14`. A plain `null` or
`~` is empty. In a plain scalar, ` #` starts a comment. Double-quoted escapes
are `\\ \" \/ \n \t \r \0 \xNN \uNNNN`.

Not in the subset, and reported by `lint` once per key: nested maps, anchors,
aliases, tags, block scalars (`|`, `>`), inline maps, multi-line values, quoted
keys, duplicate keys, and a plain scalar containing `: `. Such keys and the
lines belonging to them are kept as they are and can still be edited around.

An unquoted wikilink (`blocked-by: [[BL-9]]`, or as a list item) is read as the
link it obviously means and reported by `lint` as a warning; it is quoted the
next time a tool writes that key.

**Writing.** Edits are per key: only the lines of the key being changed are
rewritten, so untouched keys keep their exact formatting. Setting a key to the
value it already has changes nothing. New keys are appended at the end of the
frontmatter. A list is written in the style the key already uses (block lists
keep their indentation), inline for a new key, and as `[]` when empty.

A scalar is written plain unless it must be quoted, and then double-quoted. It
must be quoted when it is empty; starts or ends with a space or tab; starts
with one of ``! & * - ? [ ] { } | > @ ` " ' # % , :``; contains `: ` or ` #`;
ends with `:`; contains a control character; looks like a number; or is one of
`true false null yes no on off y n ~` in any letter case. Inside an inline list
it must also be quoted when it contains `,`, `[`, `]`, `{` or `}`.

## 2. Operations

The index write is always last, so it acts as the commit point. An interrupted
operation leaves the index correct and at worst a stray note.

| Operation | Steps, in order |
|---|---|
| Create tracker | Create the folder, `issues/` and `archive/` as far as they are missing; create the index note. Refused if a tracker in the folder has the prefix |
| Create | Allocate ID; create note in `issues/`; add line to `## Issues` and raise `next` |
| Edit property | Write the issue note only. `blocked-by` and `related-to` accept IDs of issues of other trackers in the folder. An edit that would close a `blocked-by` cycle, also through those trackers, is refused |
| Unrelate | Remove the link from the `related-to` of both notes, also when the other issue belongs to another tracker in the folder, whose note is then edited too. Removing a `related-to` entry by editing the property does the same |
| Retitle | Write `title` in the note; rewrite the index line |
| Reorder | Move the line within `## Issues` |
| Archive | Move note to `archive/`; move line to the end of `## Archive` |
| Unarchive | Move note to `issues/`; move line to the end of `## Issues` |
| Delete | Trash the note, wherever it is; remove the links to it from `blocked-by` and `related-to` of the other notes, those of the other trackers in the folder included; remove the line |
| Comment | Append under `## Comments` in the issue note |
| Adopt | Move a note lying in the tracker folder to `issues/`; add a line for it; raise `next` if needed. A note with the prefix of another tracker in the folder is refused |
| Label | Add the label to `labels` if absent; set or clear its `label-colors` entry |
| State style | Set or clear a state's `state-icons` and `state-colors` entries |

New issues are appended at the end of `## Issues` unless "top" is requested.
An adopted note is listed in the section matching where the note is.

**Every index write** also corrects the title copy of each line whose note has
a different, non-empty `title` property.

**ID allocation.** Take `n = max(next, 1 + the highest number seen)`, where
"seen" covers IDs with the tracker's prefix on index lines, in `issues/`, in
`archive/` and in the tracker folder itself; the notes of the folder's other
trackers have other prefixes and do not count. Create `issues/<PREFIX>-<n>.md`
with an exclusive create; if a note with that name exists in any of the three
places, increment and retry. Then write the
index with `next` set to at least `n + 1`.

**Ordering in grouped views.** There is one flat global order. Views grouped by
status, assignee and so on show each group in its relative index order.

**Reordering** applies to `## Issues` only. Archived issues keep the order in
which they were archived.

## 3. Consistency rules

| Situation | Behaviour |
|---|---|
| Note with the tracker's prefix in `issues/`, `archive/` or the tracker folder, no index line | Orphan: ignored; reported by `lint`; added only by `adopt` |
| Note with another prefix there, no index line | Not this tracker's: ignored |
| Index line whose ID has the prefix of another tracker in the folder | Two trackers would own one note; `lint` error; not auto-fixed |
| Two trackers in a folder with one prefix | Each takes the other's notes for its own; `lint` error; not auto-fixed |
| Index line, note missing everywhere | Issue exists; shown as "note missing" with the title from the line; `lint` error |
| Line under `## Archive`, note in `issues/` (or the reverse) | Index wins; `lint --fix` moves the note |
| Line under `## Issues` or `## Archive`, note in the tracker folder | The note is used where it is; `lint --fix` moves it to `issues/` or `archive/` |
| Note in more than one place | The first in the search order below is used; `lint` error; not auto-fixed |
| Title copy differs from `title` property | Property wins; line corrected on next index write |
| Same ID listed twice | First occurrence wins; `lint --fix` removes the rest |
| Line not in canonical form | Read as described in 1.4; `lint --fix` rewrites it |
| `next` not above the highest number seen | Allocation still skips ahead; `lint --fix` raises `next` |
| `status` not in `states`, bad `priority`, unknown label | Reported by `lint`; not auto-fixed |

Both tools look in three places when resolving a line, in this order: the
folder matching the line's section (`issues/` or `archive/`), then the other
of the two, then the tracker folder itself.

`lint --fix` never adds or removes issues.

### 3.1 Lint codes

| Code | Severity | Fixed by `--fix` | Meaning |
|---|---|---|---|
| `index-yaml` | error | | Index frontmatter outside the YAML subset |
| `index-key` | error | | `prefix`, `next`, `states` or `closed-states` missing or invalid |
| `prefix-shared` | error | | Another tracker in the folder has the same `prefix` |
| `label-color-invalid` | warning | | A `label-colors` entry is not `name=color` with a known colour |
| `state-style-invalid` | warning | | A `state-icons` or `state-colors` entry does not parse, or names no state |
| `triage-state-invalid` | warning | | `triage-state` names no state, or a closed one |
| `missing-section` | warning | | No `## Issues` section |
| `duplicate-section` | warning | | A second `## Issues` or `## Archive` heading |
| `duplicate-id` | warning | yes | ID listed more than once |
| `line-format` | warning | yes | Issue line not in canonical form |
| `prefix-mismatch` | warning | | Listed ID does not use the tracker prefix (error if the prefix is that of another tracker in the folder) |
| `note-missing` | error | | No note in any location |
| `note-duplicate` | error | | Note in more than one location |
| `wrong-location` | warning | yes | Note is not in the folder its section says, including a note left in the tracker folder |
| `title-mismatch` | warning | yes | Title copy differs from the property |
| `next-low` | warning | yes | `next` is not above the highest number seen |
| `orphan` | warning | | Note with the tracker prefix and no index line |
| `note-yaml` | error | | Note frontmatter outside the subset (warning for an unquoted wikilink) |
| `title-missing`, `status-missing` | error | | Required property absent or empty |
| `status-unknown` | error | | `status` not in `states` |
| `priority-invalid` | error | | `priority` not one of the five values |
| `label-unknown` | warning | | Label not in the index `labels` |
| `due-invalid`, `created-invalid` | error | | Not a real `YYYY-MM-DD` date |
| `blocked-by-invalid`, `related-to-invalid` | error | | Not a link to an issue, or a link to itself |
| `blocked-by-unknown`, `related-to-unknown` | error | | Linked issue has no line in the index of this tracker or of another tracker in the same folder |
| `blocked-by-cycle` | error | | Following `blocked-by` from the issue leads back to it, also through the other trackers of the same folder; reported for each issue of this tracker on the cycle |

One problem is reported per occurrence. A problem's subject is an issue ID, or
the index note.

### 3.2 Concurrent use

An operation of section 2 runs alone: nothing else reads or changes the
tracker folder between its first read and its last write. The lock is the
folder's, so the trackers of one folder take turns. The CLI and the plugin
get there the same way.

**The lock file.** A tracker folder is locked by creating `.bilinear.lock` in
it, exclusively (the create fails if the file exists), and
unlocked by deleting it. Every operation takes the lock first and holds it to
the end: every CLI command, the commands that only read included, and every
plugin operation.

- The file holds one line of JSON, `{"by": "cli", "pid": 4711, "token":
  "9f1c…"}`. Only `token` matters: a holder deletes the file on release only
  if it still holds its own token.
- A holder touches the file (sets its modification time) every 2 seconds
  while it works. A lock file that a waiting program has seen
  unchanged, contents and modification time, for 8 seconds was left by a
  program that died; the waiter deletes it and tries again. The 8 seconds are
  measured on the waiter's own clock.
- A program that does not get the lock tries again every few milliseconds,
  and while it waits it keeps `.bilinear.lock.wait` in existence and touches
  it on every attempt, deleting it when it stops waiting. A program about to
  take the lock that finds this file stands back for 15 ms first, so that a
  program running one operation after another cannot keep a waiting one out.
  A wait file that is not touched during those 15 ms is left over and is
  deleted.
- A program gives up after 10 seconds (`BILINEAR_LOCK_TIMEOUT` for the CLI,
  in seconds). The CLI then exits with code 3 having changed nothing; the
  plugin shows a notice.
- Both files are dot files: Obsidian does not show them, and they exist only
  while an operation runs.

Besides the lock file:

- A CLI command that only reads goes ahead without the lock if the lock file
  cannot be created (a read-only folder). Its output is written after the
  lock is released, so a slow reader of that output does not hold the
  tracker.
- Plugin: operations within one Obsidian run one after another, then take
  the lock file. On a phone there is no lock file, and no other program.
  Under the lock the plugin asks the disk, not Obsidian's file list or
  metadata cache, what exists and what a note's title is; those follow a
  change made by the CLI with a delay.
- Plugin: writes go through `vault.process`; note moves through
  `fileManager.renameFile`; deletes through `fileManager.trashFile`. A move
  counts as done when the note has moved; updating links in other notes,
  which can wait for the user to answer a dialog, happens after the lock is
  released.
- The plugin re-reads on `vault` and `metadataCache` events, so CLI edits show
  up live.

**Writers that take no lock.** Obsidian's editor, its Properties UI, other
plugins and sync tools write notes without knowing of the lock, and Obsidian
writes in place: the file is emptied, then filled.

- The CLI reads a file again if it is empty or changed while being read, so
  it does not act on half a file.
- The CLI writes like this: read the file; work out the new contents; write
  them to a temp file in the same directory and `fsync` it; read the file
  again; if it changed, redo the operation on the new contents (up to three
  attempts, then exit code 3); otherwise rename the temp file over the
  file. A reader sees the old contents or the new, never part of each. A
  file that is moved or deleted after the command has found it also ends the
  command with exit code 3; running it again works on what is there.
- The editor saves its whole text two seconds after a keystroke, and would
  undo a change made to the note since it last read it. The plugin therefore
  wraps the save of every text view on a tracker's notes: the save takes the
  tracker's lock and, if the note on disk is not what the view last read or
  wrote, first has the view load it, which merges the change into the text
  being edited. (If an operation of this Obsidian is in progress the save
  does not wait for the lock, since the operation may be waiting for the
  save.)

### 3.3 Known limits

- The lock binds the CLI and the plugin, nothing else. A write by a sync
  tool, another plugin or a text editor that lands in the instant between
  the CLI's last comparison and its rename, or between the read and the
  write of the plugin's `vault.process`, is overwritten. A write at any
  earlier point of a CLI command is detected and the operation redone.
- The editor's save relies on two parts of Obsidian that are not in its
  public API (the view's last-saved text and its load-and-merge step). If a
  future Obsidian lacks them, the save still takes the lock but no longer
  merges, and a change the CLI made to an open note within a few
  milliseconds of a save can be lost again.
- A program that is suspended for more than 8 seconds while it holds the
  lock file (not merely slow: the plugin keeps touching the file) can find
  that another has taken the lock over. The CLI's comparison before each
  rename still applies.
- An operation that touches a note and the index is two atomic writes, not
  one. Killed in between, it leaves the state described in section 2: the
  index correct and at worst a stray note.
- A bad sync merge of the index can drop an issue from the tracker. The note
  survives as an orphan and `lint` reports it.
- The CLI moves notes with a plain file move. Bare `[[BL-4]]` links survive, but
  path-style links in other notes (vault link format set to relative or
  absolute) are only rewritten when the move is done from the plugin.

## 4. Fixtures

Each directory in `spec/fixtures/` is one case:

```
<case>/
  before/     a tracker folder
  op.json     one operation
  after/      the tracker folder expected afterwards
```

Where the folder holds several trackers, `op.json` has `"tracker"`: the name
of the index note the operation is for, such as `"Other.md"`.

The tests copy `before/`, apply the operation, once to the operations in
memory and once through the command line on disk, and require the result to
equal `after/` byte for byte (same set of files, same contents; empty
directories are not compared). Trashed notes leave the tracker folder and are
not compared. They also check that parsing and re-serializing every `.md` file under `spec/fixtures/` is the
identity.

`op.json`:

```json
{
  "op": "create",
  "args": { "title": "Add retry to fetcher" },
  "today": "2026-10-01",
  "author": "rk",
  "expect": { "id": "BL-14" }
}
```

| `op` | `args` | `expect` |
|---|---|---|
| `create` | `title`, optional `status`, `priority`, `labels`, `assignee`, `due`, `blockedBy` and `relatedTo` (lists of IDs), `top` | `id` |
| `set` | `id`, `props`: key to value; `null` or `[]` removes the key; IDs for `blocked-by` and `related-to` | |
| `move` | `id` and one of `before`, `after` (an ID), `top`, `bottom` (`true`) | |
| `archive` | `ids`, or `closed: true` | |
| `unarchive` | `ids` | |
| `delete` | `id` | |
| `comment` | `id`, `text` | |
| `adopt` | `id` | |
| `label` | `name`, optional `color`: a colour sets it, `null` clears it, absent leaves it | |
| `labels` | | `labels`: the known labels in order, each `{name, color}` with `null` for no colour |
| `state` | `name`, optional `icon` and `color`: a value sets it, `null` clears it, absent leaves it | |
| `states` | | `states`: the states in order, each `{name, icon, color, closed, triage}` |
| `lint` | `fix` | `problems`: sorted list of `<code>:<id>`, with `-` for the index |
| `list` | | `issues`: every issue, open and archived, in index order; each entry lists the fields to compare |

`today` is the date used for `created` and for comments; `author` is the
comment author. In `list` results `blocked-by` is a list of IDs, an absent
text property is `null`, and each issue has `archived` and `missing` flags,
`links` (the IDs its description links to, known or not) and `progress`:
`{done, total, issues}` with the blockers counted, or `null`. `related` is
the IDs related to the issue, whichever of the two notes names the other;
`blocks` is the IDs of the issues that name it in `blocked-by`; `blocked` is
true when some blocker is known and is not in a closed state or has no note.
A blocker of another tracker in the folder is known, and closed by that
tracker's `closed-states`; the entries of `list` are the issues of the
tracker itself only.
