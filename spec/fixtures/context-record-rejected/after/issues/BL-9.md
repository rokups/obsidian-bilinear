---
title: Rework cache layer
status: todo
priority: none
created: 2026-09-01
---

Description.

## Context log

### R1: A global lock for the cache
- status: active
- author: claude
- created: 2026-10-01
- updated: 2026-10-01

The lock was tried in the test setup.

Attempted: A global lock around each cache write.
Promising: It looked simple.
Happened: The tests ran one at a time.
Failed: The run took four times as long.
Applies: Any shared cache with many writers.

## Comments
- 2026-09-30 ana: looks fine
