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

To have an LLM coding agent track its work in a tracker, `bilinear skill`
installs a skill that teaches it the commands, and `bilinear instructions`
adds a section naming the tracker to `AGENTS.md` or `CLAUDE.md`.

`npm install -g obsidian-bilinear` installs it as `bilinear`. It needs Node 20
or later and has no dependencies. `bilinear --help` lists the commands; the
[project README](https://github.com/rokups/obsidian-bilinear#cli) describes
them.

Licensed under the GNU General Public License, version 2 only.
