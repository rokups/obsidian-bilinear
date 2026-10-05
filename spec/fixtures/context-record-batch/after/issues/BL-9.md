---
title: Rework cache layer
status: todo
priority: none
created: 2026-09-01
---

Description.

## Context log

### F1: The test fails after a comment
- status: active
- author: claude
- created: 2026-10-01
- updated: 2026-10-01
- evidence:
  - comment:2026-09-30#1

See the first comment.

### D1: Use one cache directory per test
- status: active
- author: claude
- created: 2026-10-01
- updated: 2026-10-01
- evidence:
  - entry:BL-9/F1
  - file:src/cache.ts

Each test gets a temp directory.

Rationale: Shared state caused the failures.
Alternatives: A global lock. A fixture reset.

### A1: The cache test helper
- status: active
- author: claude
- created: 2026-10-01
- updated: 2026-10-01
- evidence:
  - file:tests/helper.ts

The helper makes a temp directory.

## Comments
- 2026-09-30 ana: looks fine
