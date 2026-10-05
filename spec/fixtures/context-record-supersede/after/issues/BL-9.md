---
title: Rework cache layer
status: todo
priority: none
created: 2026-09-01
---

Description.

## Context log

### D1: Use SQLite for the cache
- status: superseded
- author: ana
- created: 2026-09-20
- updated: 2026-10-01
- superseded-by: D2

Store entries in one SQLite file.

### D2: Use LMDB for the cache
- status: active
- author: claude
- created: 2026-10-01
- updated: 2026-10-01
- supersedes: D1

LMDB is faster for reads.

## Comments
- 2026-09-30 ana: looks fine
