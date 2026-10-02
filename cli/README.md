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

`npm install -g obsidian-bilinear` installs it as `bilinear`. It needs Node 20
or later and has no dependencies. `bilinear --help` lists the commands; the
[project README](https://github.com/rokups/obsidian-bilinear#cli) describes
them.
