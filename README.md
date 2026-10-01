# Bilinear

A Linear-style issue tracker for Obsidian, stored as plain Markdown notes, with
a Python CLI that works on the same files.

A tracker is a folder: one index note that lists the issues in order, and one
note per issue with its properties in frontmatter, kept in `issues/` while the
issue is open and in `archive/` once it is archived. Everything is
hand-editable; both tools preserve what they do not understand.

```
Trackers/RedBolt/
  RedBolt.md        index note: config, `## Issues`, `## Archive`
  issues/
    RB-9.md
    RB-13.md
  archive/
    RB-4.md
```

![The tracker as a list, with an issue note open in the side split](docs/screenshots/list.png)

| Board | Bulk edit |
|---|---|
| ![Board layout with a column per status](docs/screenshots/board.png) | ![Three issues selected with the bulk edit bar](docs/screenshots/bulk-edit.png) |

| Status picker | Embedded list |
|---|---|
| ![Picker for setting an issue's status](docs/screenshots/picker.png) | ![A filtered issue list embedded in another note](docs/screenshots/embed.png) |

The format is specified in [spec/FORMAT.md](spec/FORMAT.md). The plugin and the
CLI are tested against the same cases in `spec/fixtures/`.

## Repository layout

| Path | Contents |
|---|---|
| `spec/` | `FORMAT.md` and the shared fixtures |
| `cli/` | `bilinear.py` (single file, Python 3.12, stdlib only) and its tests |
| `plugin/` | The Obsidian plugin: Vue 3, Vite, TypeScript |
| `test-vault/` | A sample vault; the plugin build is linked into `.obsidian/plugins/bilinear` |
| `docs/screenshots/` | Screenshots of `test-vault/` in Obsidian's dark theme |

## CLI

Put it on your `PATH` as `bilinear`:

```sh
ln -s "$PWD/cli/bilinear.py" ~/.local/bin/bilinear
```

```sh
bilinear init Trackers/RedBolt --prefix RB
cd Trackers/RedBolt
bilinear new "Fix flaky cache test" --priority high --label build,bug
bilinear list --status todo,in-progress
bilinear set RB-1 status=in-progress assignee=rk labels+=ui due=2026-10-10
bilinear comment RB-1 "reproduced on a clean cache"
bilinear move RB-1 --top
bilinear archive --closed
bilinear lint --fix
```

| Command | Purpose |
|---|---|
| `init <folder> --prefix RB` | Create the folder, index note, `issues/` and `archive/` |
| `new "Title" [--status ..] [--priority ..] [--label ..] [--assignee ..] [--due ..] [--parent ..] [--top]` | Create an issue; prints the ID |
| `list [--status ..] [--label ..] [--assignee ..] [--priority ..] [--archived] [--all]` | List in index order |
| `show <ID>` | Print properties and body |
| `set <ID> key=value ...` | Change properties, including `title`. `key=` removes a key; `labels+=x` and `labels-=x` edit lists |
| `comment <ID> "text"` | Append a comment |
| `move <ID> --before <ID> \| --after <ID> \| --top \| --bottom` | Reorder |
| `archive <ID>... \| --closed` | Archive named issues or all closed ones |
| `unarchive <ID>...` | Restore |
| `rm <ID> [--force]` | Remove the line; move the note to the vault's `.trash/` |
| `adopt <ID>` | Add an index line for an orphan note |
| `label [name] [--color COLOR]` | List the labels, or add one and set its colour (`none` clears it) |
| `lint [--fix]` | Check and optionally repair consistency |

- The tracker is taken from `--tracker PATH` (folder or index note), then
  `BILINEAR_TRACKER`, then a search upward from the working directory.
- The comment author is `--author`, then `BILINEAR_USER`, then `$USER`.
- `--json` on `list`, `show`, `new`, `label` and `lint`.
- Label colours are `red`, `orange`, `yellow`, `green`, `cyan`, `blue`,
  `purple`, `pink`, `gray`, or a hex value such as `#7c5cff`. They are stored
  in the index note as `label-colors: [bug=red, ...]`.
- A tracker made before `issues/` existed, with open notes directly in the
  tracker folder, keeps working as it is; `bilinear lint --fix` moves the
  notes into `issues/`.
- Filters accept repeated flags or comma-separated values.
- `rm` finds the vault by searching upward for `.obsidian/`. Without one it
  refuses unless `--force` is given, which deletes the note.
- Exit codes: 0 success, 1 usage or not found, 2 lint problems found, 3 write
  conflict after retries, or the tracker stayed locked.
- Commands that write take a lock on the tracker folder first, so several
  `bilinear` processes (scripts, agents, cron jobs) can work on one tracker
  at once without losing each other's changes; they simply run in turn. A
  command waits up to 10 seconds for its turn; set `BILINEAR_LOCK_TIMEOUT`
  (seconds) to change that. On Linux and macOS the folder itself is locked
  and nothing is added to the vault; on Windows a `.bilinear.lock` file in
  the tracker folder is used. CI runs the CLI tests on all three.

The CLI moves notes with a plain file move. Bare `[[RB-4]]` links survive;
path-style links in other notes are only rewritten when the plugin does the
move.

## Plugin

```sh
cd plugin
pnpm install
pnpm build        # type check, then dist/main.js, styles.css, manifest.json
pnpm dev          # rebuild on change
pnpm test
```

To try it, open `test-vault/` in Obsidian and enable the Bilinear community
plugin; the vault's plugin folder is a link to `plugin/dist`. With the
hot-reload plugin installed, `pnpm dev` reloads it on every change. To install
it elsewhere, copy the three files in `plugin/dist` to
`<vault>/.obsidian/plugins/bilinear/`.

Notes with `bilinear: tracker` open in the tracker view instead of the Markdown
view. "Open as Markdown" in the view header (or the toggle command) switches
back, and the Markdown view of an index note has an "Open as tracker" button.
Opening an issue shows its note in a side split, where properties are edited
with Obsidian's own Properties UI. Changes made outside the plugin, by the CLI
or by sync, show up live.

- List layout grouped by status, priority, assignee or label; board layout
  with drag between columns.
- Drag to reorder when the sort order is "manual"; this rewrites the index.
- Filter by text, status, priority, label and assignee; saved views, kept in
  a `bilinear-views` code block in the index note.
- Coloured labels. Every label gets a colour from its name; right-click a
  label on a row, or in the labels picker, to choose another.
- Sub-issue progress on parent rows, and a "blocked" marker.
- Bulk edit on a multi-selection.
- "Note missing" rows with recreate and remove actions.

Commands: create tracker, new issue (from anywhere), toggle tracker / Markdown
view, archive closed issues, lint tracker, add comment to this issue.

Settings: the author name for comments, and the default folder for new
trackers.

| Key | Action |
|---|---|
| `C` | New issue |
| `J` / `K` | Move the cursor down / up |
| `Enter` | Open the issue note in the side split (`Shift+Enter` also focuses it) |
| `S` `P` `L` `A` | Set status, priority, labels, assignee |
| `X` | Toggle selection for bulk edit |
| `/` | Focus the filter |
| `Alt+Up` / `Alt+Down` | Reorder the issue |
| `Esc` | Clear the selection |

### Embedding a list

A `bilinear` code block shows a filtered, read-only list in any note:

````markdown
```bilinear
tracker: Trackers/RedBolt
status: todo, in-progress
assignee: rk
limit: 10
```
````

Keys: `tracker` (folder, index note or tracker name; optional inside a tracker
folder or when the vault has one tracker), `status`, `priority`, `label`,
`assignee` (`none` for unassigned), `search`, `archived`, `limit`.

## Testing

```sh
python3 -m unittest discover -s cli/tests
cd plugin && pnpm typecheck && pnpm test
```

Each case in `spec/fixtures/<case>/` is a `before/` tracker folder, an
`op.json` describing one operation, and the `after/` folder expected. Both
suites apply the operation with their own implementation and compare byte for
byte; both also check that parsing and re-serializing every fixture file is
the identity. The fixtures cover each operation, every row of the consistency
table, and the YAML variants Obsidian emits.

Manual checklist, in `test-vault/`:

- The index note opens as a tracker; toggling to Markdown and back works.
- Keyboard: every row of the table above.
- Drag a row within a group, into another group, and between board columns.
- With the view open, run `bilinear new`, `set` and `archive` in a terminal;
  the view follows.
- Delete an issue note in the file explorer; the row turns into "note
  missing"; recreate it.
- `bilinear lint` is clean after a session in the plugin.
- On a phone: the list scrolls, pickers open, an issue opens in a new tab.
  Drag and drop is desktop-only; use the pickers and `Alt+Up` / `Alt+Down`.

## Out of scope for v1

Cycles, estimates, multi-tracker roll-ups, notifications, and sync with Linear
or any other external service.
