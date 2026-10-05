---
title: Rework cache layer
status: todo
priority: none
created: 2026-09-01
---

Description.

## Context
Hand-written text.

### D2: A heading in the hand-written text
- status: maybe

Not an entry of the log.

## Context log

### D1: Use SQLite for the cache
- status: superseded
- author: ana
- created: 2026-09-20
- updated: 2026-09-20
- superseded-by: D2

Store entries in one file.

### D2: Use LMDB
- status: active
- author: ana
- created: 2026-09-20
- updated: 2026-09-20
- supersedes: D1
- evidence:
  - comment:2026-09-30#1
  - entry:D1
  - file:src/cache.ts

LMDB is faster.

## Comments
- 2026-09-30 ana: looks fine
