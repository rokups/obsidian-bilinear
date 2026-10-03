# obsidian-bilinear

Command-line client for [Bilinear](https://github.com/rokups/obsidian-bilinear),
an issue tracker stored as plain Markdown notes in an Obsidian vault. It works
on the same files as the Obsidian plugin, and the two can be used at the same
time.

```sh
npx obsidian-bilinear Trackers/Bilinear.md init --prefix BL
npx obsidian-bilinear Trackers/Bilinear.md new "Fix flaky cache test" --priority high --label build,bug
npx obsidian-bilinear Trackers/Bilinear.md list --status todo,in-progress
npx obsidian-bilinear Trackers/Bilinear.md set BL-1 status=in-progress assignee=rk labels+=ui
npx obsidian-bilinear Trackers/Bilinear.md comment BL-1 "reproduced on a clean cache"
npx obsidian-bilinear Trackers/Bilinear.md lint --fix
```

The first argument is the board file, the tracker's index note (a path ending
in `.md`). Set `BILINEAR_TRACKER` to it to leave it out of the command line.

`blocked-by` and `related-to` also take the IDs of issues of other trackers in
the same folder (`set BL-3 blocked-by+=OT-7`); such a blocker is closed by the
`closed-states` of its own tracker.

To have an LLM coding agent track its work in a tracker,
`bilinear <board.md> agent-setup <dir> [--codex] [--claude] [--local]` installs a skill
that says how, from opening an issue to closing it, and adds a section to
`CLAUDE.md` or `AGENTS.md` that says where: the path of the tracker. `<dir>` is
a project's folder, or `~/.claude`, `~/.codex` or `~/.agents`; each file goes
where Claude Code and Codex read it. After upgrading bilinear,
`bilinear agent-setup <dir> --update` (no board file needed) refreshes what is there.

`npm install -g obsidian-bilinear` installs it as `bilinear`. It needs Node 20
or later and has no dependencies. `bilinear --help` lists the commands; the
[project README](https://github.com/rokups/obsidian-bilinear#cli) describes
them.

Licensed under the GNU General Public License, version 2 only.
