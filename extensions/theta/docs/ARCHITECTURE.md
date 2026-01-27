# Theta Architecture

## Overview

Theta is a code review extension that provides an interactive 3-column TUI dashboard for browsing git diffs.

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Pi Agent                                  │
│                              │                                      │
│                     /theta command                                   │
│                              │                                      │
│                              ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Dashboard (Component)                      │  │
│  │                                                               │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────────────┐    │  │
│  │  │ Commits  │  │  Files   │  │        Diff              │    │  │
│  │  │  (20%)   │  │  (20%)   │  │        (60%)             │    │  │
│  │  │          │  │          │  │                          │    │  │
│  │  │ h ← → l │  │ h ← → l │  │  j/k scroll              │    │  │
│  │  │ j/k nav  │  │ j/k nav  │  │  PgUp/PgDn fast         │    │  │
│  │  └──────────┘  └──────────┘  └──────────────────────────┘    │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│                              ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    DiffService                               │  │
│  │                                                               │  │
│  │  getCommits()    getDiff()    getFiles()    hasUncommitted()  │  │
│  │       │              │             │               │          │  │
│  │       └──────────────┴─────────────┴───────────────┘          │  │
│  │                          │                                    │  │
│  │                   git (child_process)                         │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Module Structure

| File | LOC | Purpose |
|------|-----|---------|
| `index.ts` | ~18 | Extension entry, `/theta` command registration |
| `services/diff-service.ts` | ~200 | Git operations via child_process.exec |
| `ui/dashboard.ts` | ~531 | 3-column TUI dashboard component |

## Data Flow

### Initialization

```
/theta
  │
  ▼
ctx.ui.custom() → Dashboard constructor
  │
  ├─ DiffService.hasUncommittedChanges()
  ├─ DiffService.getCommits(0, 50)
  │
  ▼
Build commit list
  │
  ├─ [Uncommitted] (if changes exist)
  └─ [commit1, commit2, ...]
  │
  ▼
selectCommit(0) → load files + diff
```

### Commit Selection

```
User selects commit
  │
  ▼
selectCommit(index)
  │
  ├─ DiffService.getDiff(base, head)
  │   → raw diff string + parsed files
  │
  ├─ Update files panel
  └─ Update diff panel
```

### Dynamic Loading

```
User scrolls near bottom of commits
  │
  ▼
Check: commitIndex > commits.length - 10
  │
  ▼
DiffService.getCommits(offset, 50)
  │
  ▼
Append to commit list
```

## Panel State

| Panel | State | Scroll |
|-------|-------|--------|
| Commits | `commitIndex`, `commitScrollOffset` | Virtual scroll with batch loading |
| Files | `fileIndex`, `fileScrollOffset` | Simple list scroll |
| Diff | `diffScrollOffset`, `maxDiffLines` | Line-based scroll with PgUp/PgDn |

## DiffService API

| Method | Git Command | Returns |
|--------|-------------|---------|
| `getCommits(skip, limit)` | `git log --format=...` | `CommitInfo[]` |
| `getFiles(base?, head?)` | `git diff --name-only` | `string[]` |
| `getDiff(base?, head?, file?)` | `git diff` | `DiffResult` with parsed files |
| `hasUncommittedChanges()` | `git status --porcelain` | `boolean` |

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Class-based Component | Dashboard needs mutable state across many render cycles |
| Batch commit loading (50) | Avoids loading entire history upfront |
| `@pierre/diffs` for parsing | Structured diff metadata (additions, deletions, hunks) |
| Relative paths | Respects CWD for multi-repo/worktree setups |
| 10MB maxBuffer | Support large diffs without truncation |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@mariozechner/pi-coding-agent` | Pi extension API |
| `@mariozechner/pi-tui` | TUI primitives (Component, Key, Text, truncateToWidth) |
| `@pierre/diffs` | Git diff parsing (FileDiffMetadata, Hunk, parsePatchFiles) |
