---
bilinear: tracker
prefix: RB
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
# RedBolt

Free-form project notes. Never modified by the tools.

```bilinear-views
[{"name": "Mine", "filter": {"assignee": ["rk"]}}]
```

````markdown
## Issues
- [[RB-1]] this is an example inside a code block
````

## Issues
Loose text inside the section is kept.
- [[RB-11]] Speed up cold start
* [[RB-13|the flaky one]]   Fix flaky cache test
- [[RB-9]] Rework cache layer

### Later
- [[Some other note]] is not an issue

## Archive
- [[RB-4]] Remove legacy loader

## Decisions
- [[RB-9]] is the umbrella issue
- Keep it simple