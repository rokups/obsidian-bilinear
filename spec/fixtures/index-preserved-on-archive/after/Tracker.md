---
bilinear: tracker
prefix: BL
next: 14
states:
  - backlog
  - todo
  - in-progress
  - in-review
  - done
  - canceled
closed-states: [done, canceled]
labels: [bug, build, ui]
cssclasses: [wide]
---
# Bilinear

Free-form project notes. Never modified by the tools.

```bilinear-views
[{"name": "Mine", "filter": {"assignee": ["rk"]}}]
```

````markdown
## Issues
- [[BL-1]] this is an example inside a code block
````

## Issues
Loose text inside the section is kept.
- [[BL-9]] Rework cache layer

### Later
  - [[Trackers/Bilinear/BL-11.md]] Speed up cold start
- [[Some other note]] is not an issue

## Archive
- [[BL-4]] Remove legacy loader
- [[BL-13]] Fix flaky cache test

## Decisions
- [[BL-9]] is the umbrella issue
- Keep it simple