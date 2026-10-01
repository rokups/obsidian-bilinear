---
bilinear: tracker
prefix: RB
next: 10
states: [backlog, todo, in-progress, in-review, done, canceled]
closed-states: [done, canceled]
labels: [bug, build, ui]
label-colors: [bug=red]
state-icons: [in-review=eye]
state-colors: [in-review=purple]
---

Sample tracker for trying the plugin and the CLI side by side.

## Issues
- [[RB-1]] Rework cache layer
- [[RB-2]] Fix flaky cache test
- [[RB-3]] Speed up cold start
- [[RB-4]] Remove legacy loader
- [[RB-5]] Board layout polish
- [[RB-6]] Crash on empty manifest
- [[RB-7]] Document the cache format
- [[RB-9]] Review loader removal

## Archive
- [[RB-8]] Drop Windows 7 support
