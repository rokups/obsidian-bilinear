# obsidian-bilinear

Command-line client for [Bilinear](https://github.com/rokups/obsidian-bilinear),
an issue tracker stored as plain Markdown notes in an Obsidian vault. It works
on the same files as the Obsidian plugin, and the two can be used at the same
time.

```sh
npx obsidian-bilinear init Trackers/Bilinear --prefix BL
cd Trackers/Bilinear
npx obsidian-bilinear new "Fix flaky cache test" --priority high --label build,bug
npx obsidian-bilinear list --status todo,in-progress
npx obsidian-bilinear set BL-1 status=in-progress assignee=rk labels+=ui
npx obsidian-bilinear comment BL-1 "reproduced on a clean cache"
npx obsidian-bilinear lint --fix
```

To have an LLM coding agent track its work in a tracker,
`bilinear agent-setup <dir> [--codex] [--claude] [--local]` installs a skill
that says how, from opening an issue to closing it, and adds a section to
`CLAUDE.md` or `AGENTS.md` that says where: the path of the tracker. `<dir>` is
a project's folder, or `~/.claude`, `~/.codex` or `~/.agents`; each file goes
where Claude Code and Codex read it. After upgrading bilinear,
`bilinear agent-setup <dir> --update` refreshes what is there.

`npm install -g obsidian-bilinear` installs it as `bilinear`. It needs Node 20
or later and has no dependencies. `bilinear --help` lists the commands; the
[project README](https://github.com/rokups/obsidian-bilinear#cli) describes
them.

Licensed under the GNU General Public License, version 2 only.
