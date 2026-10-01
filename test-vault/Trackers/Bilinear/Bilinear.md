---
bilinear: tracker
prefix: BL
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
- [[BL-1]] Rework cache layer
- [[BL-2]] Fix flaky cache test
- [[BL-3]] Speed up cold start
- [[BL-4]] Remove legacy loader
- [[BL-5]] Board layout polish
- [[BL-6]] Crash on empty manifest
- [[BL-7]] Document the cache format
- [[BL-9]] Review loader removal

## Archive
- [[BL-8]] Drop Windows 7 support
