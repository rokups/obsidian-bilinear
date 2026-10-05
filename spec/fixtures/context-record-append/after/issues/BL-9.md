---
title: Rework cache layer
status: todo
priority: none
created: 2026-09-01
---

Description.

## Context log

### D1: Use SQLite for the cache
- status: active
- author: ana
- created: 2026-09-20
- updated: 2026-09-20

Store entries in one SQLite file.

### D2: Keep the file format stable
- status: active
- author: ana
- created: 2026-09-20
- updated: 2026-09-20

Old notes must still load.

### D3: Drop the in-memory layer
- status: active
- author: claude
- created: 2026-10-01
- updated: 2026-10-01

The layer gave no gain.

## Comments
- 2026-09-30 ana: looks fine
