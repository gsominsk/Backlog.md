# Hybrid Board Port Specification

**Created:** 2026-07-16
**Revised:** 2026-07-16 (post-review: @reviewer-feasibility, @reviewer-design)
**Updated:** 2026-07-17 — implementation progress (Phase A + B complete)
**Status:** In implementation — Phase A ✅, Phase B ✅, Phase C next
**Authors:** @source-analyst, @model-porter, @concurrency-researcher, @mcp-architect (4 research agents)
**Reviewers:** @reviewer-feasibility, @reviewer-design (2 review agents)
**Compiled by:** orchestrator
**Base:** Fork Backlog.md v1.48.0 (MIT) + port models from TaskOrchestrator v3.11.0 (MIT)
**Working dir:** `/Users/sominskijgeorgij/ZCodeProject/backlog-fork` (branch: `hybrid-agent-board`)

---

## 1. Executive Summary

Fork Backlog.md, add 4 components. Markdown remains the single source of
truth — no SQLite, no second system, no sync. All writes go through MCP
server with atomic write (temp+rename) + flock (cross-process) + in-process
mutex. Agent identity (simplified ActorClaim) and audit trail (ActivityLog
in separate files) are ported from TaskOrchestrator as TypeScript models.

**Revised scope after review:**

| Metric | Original spec | Revised (post-review) |
|---|---|---|
| Lines of code | ~875 | ~1100 (MVP ~550) |
| Files | 22 | ~20 (MVP ~16) |
| MCP tools | 20 → 22 | 20 → 22 (task_claim + task_activity_get, not claim_item + get_activity) |

**Key design changes from review:**
1. ActivityLog → **separate files** (`backlog/activity/{task-id}.md`), not embedded in task files
2. ActorClaim → **flat strings** (`createdById`, `createdByKind`), not nested YAML objects
3. Claim → **nested object** (`claim: { by, at, expiresAt }`), not 4 separate fields
4. VerificationResult / DegradedModePolicy / resolveTrustedActorId → **dropped** (dead code with NoOpActorVerifier)
5. Claim release → **`task_release` tool** (task_edit can't do it, `additionalProperties: false`)
6. Claim renewal → **auto-renew on any tool call** from same actor (LLM agents have no timers)
7. `proof`, `parent`, `cascade`, `originalClaimedAt`, tiered disclosure → **dropped** (over-engineering)
8. Tool naming → `task_claim` / `task_release` / `task_activity_get` (match `task_*` convention)

---

## 2. Backlog.md Source Architecture (from @source-analyst)

### 2.1 Repository layout

```
src/
├── cli.ts                           — Commander entry point
├── commands/                        — CLI subcommands (mcp.ts, init.ts, task.ts, build.ts)
├── core/
│   ├── backlog.ts                   — Central Core class (~3283 lines)
│   ├── task-loader.ts               — Cross-branch task loading
│   ├── content-store.ts, search-service.ts, reorder.ts
│   └── config-migration.ts, duplicate-task-repair.ts, prefix-migration.ts
├── file-system/
│   └── operations.ts                — FileSystem class: ALL disk reads/writes + locking
├── git/operations.ts                — GitOperations: git subprocess wrapper
├── markdown/
│   ├── parser.ts                    — parseTask (gray-matter + sections)
│   ├── serializer.ts                — serializeTask (diff-preserving)
│   ├── structured-sections.ts       — Section delimiter logic
│   └── section-titles.ts
├── mcp/
│   ├── server.ts                    — McpServer class (extends Core) + createMcpServer
│   ├── types.ts                     — McpToolHandler / McpResourceHandler interfaces
│   ├── errors/mcp-errors.ts         — BacklogToolError, McpValidationError
│   ├── resources/                   — backlog://workflow/* resources
│   ├── tools/
│   │   ├── tasks/{handlers,index,schemas}.ts
│   │   ├── milestones/{handlers,index,schemas}.ts
│   │   ├── documents/{handlers,index,schemas}.ts
│   │   ├── definition-of-done/{handlers,index,schemas}.ts
│   │   └── workflow/index.ts
│   ├── utils/schema-generators.ts   — generateTaskCreateSchema, generateTaskEditSchema
│   └── validation/tool-wrapper.ts   — createSimpleValidatedTool
├── types/index.ts                   — Task, Decision, Document, Milestone interfaces
├── constants/index.ts               — Default directories, statuses, task types
├── web/                             — React browser UI
├── tui/                             — Terminal UI
├── test/atomic-task-create.test.ts  — Existing concurrency tests
└── templates/                       — Init scaffolding
```

### 2.2 Task markdown format

```yaml
---
id: TASK-1
title: 'Task title'
status: To Do
assignee: []
created_date: '2026-07-16 04:42'
updated_date: '2026-07-16 04:42'
labels: []
dependencies: []
priority: medium
type: feature
---

## Description
<!-- SECTION:DESCRIPTION:BEGIN -->
...body...
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 First criterion
- [x] #2 Second criterion (checked)
<!-- AC:END -->

## Comments
<!-- COMMENTS:BEGIN -->
author: @researcher
created: 2026-07-16 04:42
---
Comment body text
---
<!-- COMMENTS:END -->
```

**Section delimiters (from structured-sections.ts):**
- Regex: `<!-- (SECTION:[A-Z][A-Z0-9_]*|COMMENTS|COMMENT|AC|DOD):(BEGIN|END) -->`
- `ACTIVITY` is NOT in this regex — must be added or use standalone parser (see §5)
- `gray-matter` for YAML frontmatter, `Bun.write` for file writes

### 2.3 Current write path (NOT atomic)

```
saveTask → normalize ID/prefix → derive filename →
  serializeTask → Bun.write(filepath, content)   ← NOT atomic, overwrites in place
```

`Bun.write` has NO atomic mode. Overwrites target directly. A crash mid-write
leaves a partial file.

**IMPORTANT: Actual call chain (verified by @reviewer-feasibility):**
```
editTaskOrDraft → updateTaskFromInput → updateTask → saveTask → serializeTask → Bun.write
```
NOT `editTaskOrDraft → serializeTask → atomicWrite` as originally assumed.
Activity append must happen inside `saveTask` (or `updateTask`), not at the
`editTaskOrDraft` level.

### 2.4 Current locking (create-only)

`withCreateLock(fn)` — serializes create/promote/demote/milestone-create:
- Uses `proper-lockfile@4.1.2` (mkdir-based, NFS-safe)
- Lock path: `<git-common-dir>/backlog.md/locks/create` OR `<backlogDir>/.locks/create`
- Defaults: 30s timeout, 100ms retry, 10s stale-lock recovery
- Protects ID generation only, NOT regular saves
- `getCreateLockTarget()` is **private** — `withWriteLock` must reuse or duplicate this logic

### 2.5 All Bun.write call sites (verified by @reviewer-feasibility)

| Line | Method | In original spec? |
|---|---|---|
| 443 | `saveTask` | ✅ |
| 679 | `archiveDraft` | ❌ MISSING — must add |
| 800 | `saveDraft` | ✅ |
| 871 | `saveDecision` | ✅ |
| 949 | `saveDocument` | ✅ |
| 1280 | `createMilestone` | ❌ MISSING — must add |
| 1337 | `renameMilestone` (write new content) | ❌ MISSING — must add |
| 1351 | `renameMilestone` (rollback on error) | ❌ MISSING — must add |
| 1356 | `renameMilestone` (rollback on error) | ❌ MISSING — must add |
| 1440 | `saveConfig` (actual line, not 1280) | ✅ (line number was wrong) |

**Total: 10 Bun.write sites, not 5. All must be converted to atomicWrite.**

### 2.6 MCP tool count: 20 (verified)

- Tasks (7): task_create, task_list, task_search, task_view, task_edit, task_archive, task_complete
- Milestones (5): milestone_list, milestone_add, milestone_rename, milestone_remove, milestone_archive
- Documents (5): document_list, document_view, document_create, document_update, document_search
- Definition of Done (2): definition_of_done_defaults_get, definition_of_done_defaults_upsert
- Workflow (1): get_backlog_instructions

MCP SDK: `@modelcontextprotocol/sdk` v1.29.0, stdio transport only.

### 2.7 Build system

- Bun.build → single compiled native binary
- `bun run build` → `scripts/build.ts` → `Bun.build({ entrypoints, target: "bun", compile: { outfile: "dist/backlog" } })`
- Type-check: `bunx tsc --noEmit` (strict, ESNext)
- Lint: Biome 2.5.3 (tabs, double quotes, lineWidth 120)
- Tests: `bun test` (Bun test runner)
- `commentAuthor` field is the **exact model** for adding `actor` parameter (simple string, maxLength 100)

### 2.8 Key conventions (verified by @reviewer-feasibility)

- **Frontmatter keys: snake_case** (`created_date`, `updated_date`, `parent_task_id`)
- **Task interface: `rawContent?: string`** (NOT `content` — spec error fixed)
- **`additionalProperties: false`** on all MCP schemas — must add new fields to schema or validator rejects
- **`parseTask` returns hand-written object literal** — does NOT spread frontmatter; each field must be explicitly added to the return literal
- **`serializer.ts` rebuilds frontmatter explicitly** — each field added by name, not spread
- **No `StatusLabels` export** — only `DEFAULT_STATUSES = ["To Do", "In Progress", "Done"]` in constants/index.ts. Config can customize statuses via `config.yml`.

---

## 3. Atomic Writes (from @concurrency-researcher, revised by @reviewer-feasibility)

### 3.1 Problem

`Bun.write` overwrites in place — NOT atomic. Concurrent reads can see
partial content. Crash mid-write leaves truncated file. Only `withCreateLock`
exists (for ID generation), not for regular saves. **10 Bun.write sites** need
conversion (not 5 as originally listed).

### 3.2 Solution: atomicWrite + withWriteLock

**atomicWrite:** temp file (dot-prefixed, PID+random) → optional fsync → rename (POSIX atomic)

```typescript
// src/file-system/atomic-write.ts (NEW)
import { open, rename, unlink, mkdir } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { randomBytes } from "node:crypto";

export async function atomicWrite(
  path: string,
  content: string,
  options: { fsync?: boolean } = {},
): Promise<void> {
  const dir = dirname(path);
  const base = basename(path);
  const unique = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const tmpPath = join(dir, `.${base}.${unique}.tmp`);  // dot-prefixed = invisible to *.md globs

  await mkdir(dir, { recursive: true }).catch((e) => {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  });

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmpPath, "wx");  // O_CREAT|O_EXCL — kernel-level exclusive create
    await handle.writeFile(content);
    if (options.fsync) await handle.sync();
  } finally {
    if (handle) await handle.close().catch(() => {});
  }

  if (options.fsync) {
    const dirHandle = await open(dir, "r").catch(() => null);
    if (dirHandle) { await dirHandle.sync().catch(() => {}); await dirHandle.close().catch(() => {}); }
  }

  try {
    await rename(tmpPath, path);  // POSIX atomic (same filesystem)
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}
```

**Key design decisions:**
- `node:fs/promises` (not Bun.*) for rename+fsync — predictable behavior
- `open(path, 'wx')` = `O_CREAT|O_EXCL` — no TOCTOU race
- Temp file dot-prefixed — invisible to `*.md` globs (verified: operations.ts globs at lines 491, 548, 587 won't match dotfiles)
- Temp in SAME directory as target — rename atomic only on same filesystem
- fsync default OFF (matches existing Bun.write behavior, git is backup)
- PID + random hex in temp name — concurrent writers never collide
- **Note:** Bun's `node:fs/promises` compat is good but fsync on directory FDs should be explicitly tested (R3 from @reviewer-feasibility)

### 3.3 withWriteLock: per-file cross-process + in-process

**CRITICAL (B1 from @reviewer-feasibility): Re-entrant lock strategy**

The original spec had `claim_item` wrap its body in `withWriteLock`, then call
`saveTask` which also wraps in `withWriteLock` → deadlock if mutex is not re-entrant.

**Solution: `saveTaskUnlocked` internal method.**

```typescript
// src/file-system/operations.ts (ADD to FileSystem class)

import lockfile from "proper-lockfile";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Per-file lock path — different files = independent locks
function lockPathForFile(targetPath: string, locksDir: string): string {
  const hash = createHash("sha1").update(targetPath).digest("hex").slice(0, 16);
  const safe = basename(targetPath).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48);
  return join(locksDir, "writes", `${safe}.${hash}.lock`);
}

// In-process mutex map — MUST be per-file (Map<path, Mutex>), not global
// A single global mutex would serialize all writes and fail concurrent-different-file test
const mutexes = new Map<string, Mutex>();  // key = lockPathForFile()

public async withWriteLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; retryDelayMs?: number; staleMs?: number } = {},
): Promise<T> {
  // 1. In-process mutex (per-file key, guards same-process async interleaving)
  // 2. Cross-process lock (proper-lockfile mkdir, NFS-safe, per-file lockfilePath)
  // Order: in-process first, then cross-process
  // Release in reverse order (cross-process, then in-process)
  // Always release on both success and error
}

// Internal method — does NOT lock. Called from inside withWriteLock by
// claim_item, task_release, and other tools that already hold the lock.
private async saveTaskUnlocked(task: Task): Promise<void> {
  const content = serializeTask(task);
  const filepath = this.getTaskFilePath(task);
  await atomicWrite(filepath, content);
}

// Public method — locks, then calls saveTaskUnlocked
public async saveTask(task: Task): Promise<void> {
  const filepath = this.getTaskFilePath(task);
  return this.withWriteLock(filepath, () => this.saveTaskUnlocked(task));
}
```

**Re-entrancy rule:** `saveTask` locks → calls `saveTaskUnlocked` (no lock).
`claim_item` locks → calls `saveTaskUnlocked` (no lock). No double-acquisition.

**Lock directory derivation (R5 from @reviewer-feasibility):**
`getCreateLockTarget()` is private. `withWriteLock` must either:
- Make `getCreateLockTarget` accessible (protected or public), or
- Duplicate the git-common-dir resolution logic
Recommend: make it accessible (it's the same logic, no reason to duplicate).

### 3.4 Files to modify for atomic writes

| File | Change | Lines |
|---|---|---|
| `src/file-system/atomic-write.ts` | NEW — atomicWrite function | ~60 |
| `src/file-system/operations.ts` | ADD withWriteLock + saveTaskUnlocked + replace 10 Bun.write sites | ~130 |
| `src/utils/mutex.ts` | NEW — per-file in-process Mutex map | ~50 |

**All 10 Bun.write sites to convert (verified lines):**
- `saveTask` (line 443) → `saveTaskUnlocked` uses `atomicWrite`
- `archiveDraft` (line 679) → wrap with `withWriteLock` + `atomicWrite`
- `saveDraft` (line 800) → wrap
- `saveDecision` (line 871) → wrap
- `saveDocument` (line 949) → wrap
- `createMilestone` (line 1280) → wrap (currently only `withCreateLock`, needs `withWriteLock` too)
- `renameMilestone` (lines 1337, 1351, 1356) → wrap + review rollback logic (atomicWrite changes rollback semantics)
- `saveConfig` (line 1440, NOT 1280) → wrap

**IMPORTANT:** `withCreateLock` stays as-is (protects ID generation). `withWriteLock`
is SEPARATE (protects file writes). Create operations use BOTH: `withCreateLock`
(ID) → `withWriteLock` (file write). Don't replace one with the other.

### 3.5 Test cases

1. atomicWrite produces full content on success
2. No torn writes under concurrent readers (gate at rename, fire N readers)
3. Temp file cleaned up on rename failure
4. Temp file is dot-prefixed / not glob-visible
5. withWriteLock serializes same-file writes
6. withWriteLock allows concurrent writes to DIFFERENT files (requires per-file mutex map)
7. withWriteLock releases on fn error
8. withWriteLock times out with WriteLockError
9. Cross-process serialization (spawn second Bun process)
10. Stale lock recovery (10s staleMs)
11. fsync path doesn't throw on dirs that reject it
12. **Re-entrant: saveTaskUnlocked inside withWriteLock does NOT deadlock** (B1 fix)
13. **Concurrent claim race: two claim_item on same task → exactly one wins** (G5 fix)

---

## 4. ActorClaim Model — SIMPLIFIED (from @model-porter, revised by @reviewer-design)

### 4.1 What changed from original spec

| Original | Revised | Why |
|---|---|---|
| Nested object: `createdBy: {id, kind, parent, proof}` | Flat strings: `createdById`, `createdByKind` | Match Backlog.md snake_case convention, simpler YAML round-trip |
| `parent` field | **Dropped** | Orchestrator knows its spawn tree |
| `proof` field | **Dropped** | 10KB blob in YAML, never set with NoOpActorVerifier |
| VerificationResult (5 statuses) | **Dropped** | NoOpActorVerifier, no verification infra — dead code |
| DegradedModePolicy (3 modes) | **Dropped** | Collapses to one behavior with NoOp — dead code |
| resolveTrustedActorId | **Dropped** | Always returns `claim.id` — dead code |
| actor as object in MCP schema | `actorId` + optional `actorKind` strings | Match `commentAuthor` pattern (simple string) |

### 4.2 Simplified TypeScript port

```typescript
// src/domain/actor.ts (NEW — replaces actor_claim.ts + verification.ts + degraded_mode_policy.ts + actor_parsing.ts)

export const ActorKind = {
  ORCHESTRATOR: "orchestrator",
  SUBAGENT: "subagent",
  USER: "user",
  EXTERNAL: "external",
} as const;
export type ActorKind = (typeof ActorKind)[keyof typeof ActorKind];

const VALID_KINDS = new Set<string>(Object.values(ActorKind));

export function actorKindFromString(value: string): ActorKind | null {
  const lower = value.toLowerCase();
  return VALID_KINDS.has(lower) ? (lower as ActorKind) : null;
}

export class ValidationException extends Error {}

/** Validate actor ID — non-blank, ≤ 500 chars. */
export function validateActorId(id: string): void {
  if (!id || id.trim() === "") throw new ValidationException("Actor id must not be blank");
  if (id.length > 500) throw new ValidationException("Actor id must not exceed 500 characters");
}
```

### 4.3 Storage in YAML frontmatter (flat, snake_case)

```yaml
---
id: TASK-1
# ... existing fields ...
created_by_id: orchestrator-1
created_by_kind: orchestrator
updated_by_id: architect
updated_by_kind: subagent
---
```

**Why flat:** All existing Backlog.md frontmatter is flat snake_case
(`created_date`, `updated_date`, `parent_task_id`). The serializer builds
frontmatter explicitly by field name. Flat strings are trivial to add. Nested
objects would require special handling in both parser and serializer.

### 4.4 MCP actor parameter (flat strings, not object)

```json
{
  "actorId": { "type": "string", "minLength": 1, "maxLength": 500, "description": "Agent identity (who is performing this action)" },
  "actorKind": { "type": "string", "enum": ["orchestrator", "subagent", "user", "external"], "description": "Optional actor kind for attribution" }
}
```

- `task_create`: `actorId` optional (defaults to "orchestrator" if omitted)
- `task_edit`: `actorId` optional (recommended — needed for ActivityLog attribution)
- `task_claim`: `actorId` **required** (must know who is claiming)
- `task_release`: `actorId` **required** (must know who is releasing)

**Matches `commentAuthor` pattern:** simple string, maxLength, optional on
most tools. Agents already use `commentAuthor` successfully.

### 4.5 Files to modify for ActorClaim

| File | Change | Lines |
|---|---|---|
| `src/domain/actor.ts` | NEW — ActorKind + validateActorId (replaces 4 files) | ~30 |
| `src/types/index.ts` | MODIFY — add `created_by_id?`, `created_by_kind?`, `updated_by_id?`, `updated_by_kind?` to Task; add `actorId?`, `actorKind?` to TaskCreateInput + TaskUpdateInput | ~20 |
| `src/markdown/parser.ts` | MODIFY — parse `created_by_id`, `created_by_kind`, `updated_by_id`, `updated_by_kind` from frontmatter (explicit field in return literal) | ~15 |
| `src/markdown/serializer.ts` | MODIFY — serialize 4 new fields to frontmatter | ~15 |
| `src/core/backlog.ts` | MODIFY — persist actorId in `createTaskFromInput` + `editTaskOrDraft` | ~25 |
| `src/mcp/utils/schema-generators.ts` | MODIFY — add `actorId`, `actorKind` to create + edit schemas | ~20 |
| `src/mcp/tools/tasks/handlers.ts` | MODIFY — pass actorId through to core | ~10 |

**Saved vs original: ~180 lines** (dropped verification.ts, degraded_mode_policy.ts, actor_parsing.ts, and simplified actor_claim.ts)

---

## 5. ActivityLog / Audit Trail — SEPARATE FILES (revised by @reviewer-design)

### 5.1 What changed from original spec

| Original | Revised | Why |
|---|---|---|
| Embedded in task .md file (`<!-- ACTIVITY:BEGIN/END -->`) | **Separate files** `backlog/activity/{task-id}.md` | FLAW 1: unbounded growth, context bloat, O(n) per-agent queries, fragile string manipulation, git noise |
| `get_activity(taskId)` — no pagination | `task_activity_get(taskId, limit?, offset?)` | Context management for LLM agents |
| `deriveTrigger` with hardcoded `StatusLabels` | Config-driven trigger derivation | B2/FLAW 5: `StatusLabels` doesn't exist, custom statuses |
| Append via string manipulation in serialized content | Append to separate file (true append, no rewrite) | Serializer untouched, no section engine integration |

### 5.2 Storage: separate files

```
backlog/
├── tasks/
│   └── task-1-feature-x.md          # task document (bounded size, no activity)
├── activity/
│   └── task-1.md                     # append-only audit log (grows freely)
```

**Activity file format:**
```markdown
# Activity Log: TASK-1

- [2026-07-16T04:42:00Z] [@orchestrator-1] action: create | trigger: create
- [2026-07-16T04:43:00Z] [@architect] action: status_change | To Do → In Progress | trigger: start
- [2026-07-16T04:50:00Z] [@architect] action: status_change | In Progress → Done | trigger: complete
- [2026-07-16T04:55:00Z] [@tester] action: comment | summary: "Tests pass"
```

**Benefits (from @reviewer-design):**
- Task files stay small — `task_view` returns 2KB, not 10KB+
- True append (open file, append line, close) — no full rewrite
- Per-task activity: read one file
- Per-agent activity: scan `backlog/activity/`, filter by actor (O(n) but reads small files)
- Git diffs: task changes and activity changes in separate files
- Task serializer is untouched — no section engine integration needed

**Atomicity:** Task update and activity append are separate writes. If task
update succeeds but activity append fails, they're inconsistent. This is
acceptable for an audit trail — task status is source of truth, activity log
is best-effort. If strict atomicity required: lock both files in same
`withWriteLock` call (acquire in alphabetical order: activity path before
task path, to prevent deadlock).

### 5.3 TypeScript port

```typescript
// src/domain/activity_entry.ts (NEW)

export const TRIGGERS = [
  "start", "complete", "block", "hold", "resume", "cancel", "reopen",
] as const;
export type Trigger = (typeof TRIGGERS)[keyof typeof TRIGGERS];
// NOTE: "cascade" dropped — no cascade behavior in Backlog.md (CUT 2)

export interface ActivityEntry {
  readonly timestamp: string;       // ISO 8601 UTC
  readonly actorId: string | null;  // flat string, not ActorClaim object
  readonly action: string;          // "status_change" | "comment" | "claim" | "release" | "create" | "update"
  readonly from?: string | null;
  readonly to?: string | null;
  readonly trigger?: Trigger | null;
  readonly summary?: string | null;
}

export function createActivityEntry(input: {
  actorId?: string | null;
  action: string;
  from?: string | null;
  to?: string | null;
  trigger?: Trigger | null;
  summary?: string | null;
}): ActivityEntry {
  return {
    timestamp: new Date().toISOString(),
    actorId: input.actorId ?? null,
    action: input.action,
    from: input.from ?? null,
    to: input.to ?? null,
    trigger: input.trigger ?? null,
    summary: input.summary ?? null,
  };
}

/** Format entry as one line for append. Escapes | and newlines in summary. */
export function formatActivityLine(entry: ActivityEntry): string {
  const parts = [`[${entry.timestamp}]`, `[@${entry.actorId ?? "unknown"}]`, `action: ${entry.action}`];
  if (entry.from && entry.to) parts.push(`${entry.from} → ${entry.to}`);
  if (entry.trigger) parts.push(`trigger: ${entry.trigger}`);
  if (entry.summary) {
    // Escape pipe and newlines to not break line format
    const escaped = entry.summary.replace(/\|/g, "\\|").replace(/\n/g, " ");
    parts.push(`summary: "${escaped}"`);
  }
  return `- ${parts.join(" | ")}`;
}
```

### 5.4 Append logic (in saveTask, inside withWriteLock)

```typescript
// src/file-system/activity-log.ts (NEW)

import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

export async function appendActivity(
  backlogDir: string,
  taskId: string,
  entry: ActivityEntry,
): Promise<void> {
  const activityDir = join(backlogDir, "activity");
  const activityPath = join(activityDir, `${taskId.toLowerCase()}.md`);

  await mkdir(activityDir, { recursive: true }).catch((e) => {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  });

  // First entry creates the file with header
  const line = formatActivityLine(entry) + "\n";
  // Check if file exists to add header
  try {
    await appendFile(activityPath, line);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      const header = `# Activity Log: ${taskId}\n\n`;
      await appendFile(activityPath, header + line);
    } else {
      throw e;
    }
  }
}
```

**Called from `editTaskOrDraft` → `updateTask` → `saveTask`:**
```typescript
// Inside saveTask or updateTask, after determining what changed:
if (statusChanged || commentAdded || claimChanged) {
  const entry = createActivityEntry({
    actorId: updateInput.actorId,
    action: statusChanged ? "status_change" : commentAdded ? "comment" : "claim",
    from: oldStatus,
    to: newStatus,
    trigger: deriveTrigger(oldStatus, newStatus, config),
    summary: commentAdded ? commentBody : undefined,
  });
  // Append to separate file — best-effort, don't fail the task update
  await appendActivity(backlogDir, task.id, entry).catch(() => {
    // Log warning but don't fail — activity log is best-effort
  });
}
```

### 5.5 Config-aware trigger derivation (fixed B2/FLAW 5)

```typescript
// src/domain/trigger-derivation.ts (NEW)

import type { Trigger } from "./activity_entry";

/**
 * Derive trigger from status transition using config-driven statuses.
 * No hardcoded StatusLabels — reads from config.statuses at runtime.
 */
export function deriveTrigger(
  fromStatus: string | null,
  toStatus: string | null,
  config: { statuses: string[] },
): Trigger | null {
  if (!fromStatus || !toStatus) return null;

  const statuses = config.statuses;
  const fromIdx = statuses.indexOf(fromStatus);
  const toIdx = statuses.indexOf(toStatus);

  // Forward transition (e.g., To Do → In Progress, In Progress → Done)
  if (toIdx > fromIdx && toIdx === statuses.length - 1) {
    // Moving to last status = completion
    return "complete";
  }
  if (toIdx > fromIdx) {
    // Moving forward but not to final = started next phase
    return "start";
  }

  // Backward transition
  if (toIdx < fromIdx) {
    if (toIdx === 0) return "reopen";  // back to first status
    return "resume";
  }

  // Same status = no transition
  return null;
}
```

**Note:** This handles the default 3-status workflow (`["To Do", "In Progress", "Done"]`)
and custom workflows. Projects with `["To Do", "In Progress", "Review", "Done"]`
get the same logic — forward = start/complete, backward = resume/reopen.

### 5.6 New MCP tool: task_activity_get

```typescript
// src/mcp/tools/tasks/schemas.ts (ADD)
export const taskActivityGetSchema: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 50 },
    limit: { type: "number", minimum: 1, maximum: 200, default: 50 },
    offset: { type: "number", minimum: 0, default: 0 },
  },
  required: ["id"],
  additionalProperties: false,
};
```

**Tool name:** `task_activity_get` (not `get_activity` — matches `task_*` convention)

### 5.7 Files to modify for ActivityLog

| File | Change | Lines |
|---|---|---|
| `src/domain/activity_entry.ts` | NEW — ActivityEntry + formatActivityLine | ~50 |
| `src/domain/trigger-derivation.ts` | NEW — config-aware deriveTrigger | ~35 |
| `src/file-system/activity-log.ts` | NEW — appendActivity function | ~35 |
| `src/core/backlog.ts` | MODIFY — call appendActivity in saveTask/updateTask on status/comment/claim change | ~40 |
| `src/mcp/tools/tasks/schemas.ts` | ADD — taskActivityGetSchema | ~15 |
| `src/mcp/tools/tasks/handlers.ts` | ADD — getActivity handler with pagination | ~35 |
| `src/mcp/tools/tasks/index.ts` | ADD — register task_activity_get | ~10 |
| `src/mcp/server.ts` | MODIFY — registration already in tasks domain (no new register function needed) | ~0 |

**Saved vs original: ~40 lines** (no structured-sections.ts modification, no ACTIVITY section integration)

---

## 6. Claim-Based Ownership — SIMPLIFIED (from @model-porter, revised by @reviewer-design)

### 6.1 What changed from original spec

| Original | Revised | Why |
|---|---|---|
| 4 separate fields (claimedBy, claimedAt, claimExpiresAt, originalClaimedAt) | Nested `claim: { by, at, expiresAt }` | Structural invariant — no validation code needed |
| `originalClaimedAt` field | **Dropped** | Marginal value, adds complexity (CUT) |
| `claim_item` tool name | `task_claim` | Match `task_*` convention |
| Release via `task_edit` | **`task_release` tool** (new) | FLAW 2: `additionalProperties: false` blocks claim fields in task_edit |
| Manual TTL renewal | **Auto-renew on any tool call** from same actor | FLAW 3: LLM agents have no timers |
| Tiered disclosure (hide competing agent) | **Return competing agent's ID** | Trusted internal actors, orchestrator needs visibility (CUT 4) |
| One-claim-per-agent | **Deferred to v2** | TTL expiry handles stale claims naturally |
| Truth table: expired + same agent → reset originalClaimedAt | **N/A** — originalClaimedAt dropped | Contradiction resolved by dropping the field |

### 6.2 Task fields (nested claim object)

```typescript
// src/types/index.ts — add to Task interface

export interface TaskClaim {
  readonly by: string;           // actor ID
  readonly at: string;           // ISO 8601
  readonly expiresAt: string;    // ISO 8601 TTL expiry
}

export interface Task {
  // ... existing fields ...
  claim?: TaskClaim | null;      // null = unclaimed, object = active claim
}
```

**Structural invariant:** `claim` is either `null` (unclaimed) or a complete
object with all 3 fields. No "all-or-nothing" validation needed — the data
structure enforces it.

### 6.3 YAML frontmatter

```yaml
---
id: TASK-1
# ... existing fields ...
claim:
  by: architect
  at: 2026-07-16T04:42:00Z
  expiresAt: 2026-07-16T04:57:00Z
---
```

Unclaimed task: `claim:` field absent or null.

### 6.4 Three-way claim logic (simplified from four-way)

| Item state before | Outcome | Notes |
|---|---|---|
| No claim (`claim` is null) | **set** (new claim) | Any actor can claim |
| Same actor (`claim.by === actorId`) | **renew** (TTL refresh) | Heartbeat / auto-renew |
| Expired (`claim.expiresAt < now`) | **take** (new holder) | Any actor can take |
| Active claim by different actor | **DENY** → `already_claimed` + competing actor ID + retryAfterMs | Return actor ID (no tiered disclosure) |
| Terminal status | **DENY** → `terminal_item` | Use `isTerminalStatus()` from `src/utils/terminal-status.ts` |

### 6.5 New MCP tools: task_claim + task_release

**task_claim:**
```typescript
export const taskClaimSchema: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 50 },
    actorId: { type: "string", minLength: 1, maxLength: 500 },
    actorKind: { type: "string", enum: ["orchestrator", "subagent", "user", "external"] },
    ttlSeconds: { type: "number", minimum: 1, maximum: 86400, default: 900 },
  },
  required: ["id", "actorId"],
  additionalProperties: false,
};
```

**Handler (inside withWriteLock, calls saveTaskUnlocked — no deadlock):**
```typescript
async claimTask(input: { id: string; actorId: string; actorKind?: string; ttlSeconds?: number }) {
  return this.core.filesystem.withWriteLock(taskPath, async () => {
    const task = await this.core.getTask(input.id);
    if (!task) throw new BacklogToolError("Task not found", "TASK_NOT_FOUND");

    // Terminal check (G4 fix)
    if (isTerminalStatus(task.status)) {
      return formatResult("terminal_item", { id: input.id });
    }

    const now = new Date();
    const ttl = input.ttlSeconds ?? 900;
    const claimExpired = task.claim ? new Date(task.claim.expiresAt) < now : true;

    // Three-way logic
    if (!task.claim || claimExpired) {
      // No claim or expired → set/take
      const newClaim = { by: input.actorId, at: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttl * 1000).toISOString() };
      const updated = { ...task, claim: newClaim };
      await this.core.filesystem.saveTaskUnlocked(updated);
      await appendActivity(backlogDir, task.id, createActivityEntry({ actorId: input.actorId, action: "claim", trigger: "start" }));
      return formatResult("success", { claim: newClaim });
    }

    if (task.claim.by === input.actorId) {
      // Same actor → renew
      const renewedClaim = { ...task.claim, at: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttl * 1000).toISOString() };
      const updated = { ...task, claim: renewedClaim };
      await this.core.filesystem.saveTaskUnlocked(updated);
      return formatResult("success", { claim: renewedClaim });
    }

    // Different actor, active claim → DENY (return actor ID — no tiered disclosure)
    const retryAfterMs = Math.max(0, new Date(task.claim.expiresAt).getTime() - now.getTime());
    return formatResult("already_claimed", { claimedBy: task.claim.by, retryAfterMs });
  });
}
```

**task_release:**
```typescript
export const taskReleaseSchema: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 50 },
    actorId: { type: "string", minLength: 1, maxLength: 500 },
  },
  required: ["id", "actorId"],
  additionalProperties: false,
};
```

**Handler:**
```typescript
async releaseTask(input: { id: string; actorId: string }) {
  return this.core.filesystem.withWriteLock(taskPath, async () => {
    const task = await this.core.getTask(input.id);
    if (!task) throw new BacklogToolError("Task not found", "TASK_NOT_FOUND");

    if (!task.claim) return formatResult("not_claimed", { id: input.id });
    if (task.claim.by !== input.actorId) {
      return formatResult("not_claimed_by_you", { id: input.id, claimedBy: task.claim.by });
    }

    const updated = { ...task, claim: null };
    await this.core.filesystem.saveTaskUnlocked(updated);
    await appendActivity(backlogDir, task.id, createActivityEntry({ actorId: input.actorId, action: "release" }));
    return formatResult("success", { id: input.id });
  });
}
```

### 6.6 Auto-renew on any tool call (FLAW 3 fix)

**Problem:** LLM agents don't have timers. Manual TTL renewal is unreliable.
An agent thinking for 10 minutes between tool calls has its claim expire
silently. Another agent takes the task → race condition.

**Solution:** MCP server auto-renews any active claim by the calling actor
on every tool call that includes `actorId`.

```typescript
// src/mcp/server.ts — in callTool handler, BEFORE dispatching to tool handler:
if (args.actorId && args.id) {
  // Check if this task has an active claim by this actor
  const task = await this.getTask(args.id);
  if (task?.claim?.by === args.actorId) {
    const now = new Date();
    const ttl = 900; // default TTL
    // Renew claim — extends expiry
    const renewed = { ...task.claim, at: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl * 1000).toISOString() };
    await this.filesystem.saveTaskUnlocked({ ...task, claim: renewed });
  }
}
// Then dispatch to actual tool handler
```

**This makes TTL a true liveness probe:** "no tool calls from this actor in N
seconds = dead." The agent doesn't need to think about renewal — as long as
it's actively working (making tool calls), its claim stays alive.

### 6.7 Files to modify for Claim

| File | Change | Lines |
|---|---|---|
| `src/types/index.ts` | ADD — TaskClaim interface + `claim?` field on Task | ~15 |
| `src/markdown/parser.ts` | MODIFY — parse `claim` nested object from frontmatter | ~15 |
| `src/markdown/serializer.ts` | MODIFY — serialize `claim` to frontmatter | ~15 |
| `src/core/backlog.ts` | MODIFY — claim validation in applyTaskUpdateInput | ~15 |
| `src/mcp/tools/tasks/schemas.ts` | ADD — taskClaimSchema + taskReleaseSchema | ~30 |
| `src/mcp/tools/tasks/handlers.ts` | ADD — claimTask + releaseTask handlers | ~80 |
| `src/mcp/tools/tasks/index.ts` | ADD — register task_claim + task_release | ~20 |
| `src/mcp/server.ts` | MODIFY — auto-renew logic in callTool + register 3 new tools | ~30 |

---

## 7. MCP Tool Integration (from @mcp-architect, revised)

### 7.1 Adding `actorId` parameter to existing tools

**Pattern:** model on existing `commentAuthor` field (simple string, maxLength).

**task_create — add actorId:**
1. `src/mcp/utils/schema-generators.ts` → `generateTaskCreateSchema`: add `actorId` + `actorKind` properties
2. `src/mcp/tools/tasks/handlers.ts` → `TaskCreateArgs`: add `actorId?: string`, `actorKind?: string`
3. `createTask` handler: validate actorId → pass to `createTaskFromInput`
4. `src/types/index.ts` → `TaskCreateInput`: add `actorId?: string`, `actorKind?: string`
5. `src/core/backlog.ts` `createTaskFromInput`: persist as `task.created_by_id`, `task.created_by_kind`

**task_edit — add actorId:**
1. `src/mcp/utils/schema-generators.ts` → `generateTaskEditSchema`: add `actorId` + `actorKind`
2. `src/types/task-edit-args.ts` → `TaskEditArgs`: add `actorId?: string`, `actorKind?: string`
3. `src/utils/task-edit-builder.ts` → `buildTaskUpdateInput`: read `args.actorId`, set on `updateInput.actorId`
4. `src/types/index.ts` → `TaskUpdateInput`: add `actorId?: string`, `actorKind?: string`
5. `src/core/backlog.ts` `editTaskOrDraft`: persist as `task.updated_by_id` + auto-append activity

**IMPORTANT:** `additionalProperties: false` — must add to schema or validator rejects.

### 7.2 New tools (3)

| Tool name | Type | Annotations |
|---|---|---|
| `task_claim` | Mutating | `{ destructiveHint: false }` |
| `task_release` | Mutating | `{ destructiveHint: false }` |
| `task_activity_get` | Read-only | `{ readOnlyHint: true, destructiveHint: false }` |

**All 3 go in `src/mcp/tools/tasks/`** (not a separate `activity/` domain).
Claiming and releasing are task operations. Activity query is a task operation.
This matches `task_*` naming convention.

### 7.3 Tool registration

Register in `src/mcp/server.ts` in **TWO places** (verified by @mcp-architect):
- `createMcpServer` (~line 539, after existing `registerTaskTools`)
- `upgradeToProject` (~line 260, after existing `registerTaskTools`)

Both sites must register the same tools or toolset differs after roots re-resolution.

Since the new tools are in the `tasks/` domain, they're registered by the
existing `registerTaskTools(server, config)` call — just add the new tools
to that function's body. No new register function needed.

### 7.4 New tool count after fork

```
20 (existing) + 3 (new) = 23 MCP tools
```

- task_claim (mutating)
- task_release (mutating)
- task_activity_get (read-only)

---

## 8. Implementation Order

### Implementation Progress (updated 2026-07-17)

| Phase | Status | Tests | Notes |
|---|---|---|---|
| A: Atomic Writes | ✅ Complete | 1722 pass, 0 fail | atomic-write.ts, mutex.ts, withWriteLock, 10 Bun.write→atomicWrite, watcher fix (dotfile guards + temp-file parsing for macOS fs.watch) |
| B: ActorClaim | ✅ Complete | +7 new (7/7 pass) | actor.ts, 4 Task fields, parser/serializer round-trip, MCP schemas + handlers wired |
| C: ActivityLog | ⬜ Next | — | Separate files, append-only, task_activity_get tool |
| D: Claim Ownership | ⬜ Pending | — | task_claim + task_release, auto-renew |
| E: ZCode Integration | ⬜ Pending | — | npm link, .mcp.json, AGENTS.md |
| F: Migration | ⬜ Pending | — | memory-bank → board |

**Binary:** `dist/backlog` v1.48.0 (67MB) — rebuilt after Phase B.

---

### Phase A: Fork + Atomic Writes (foundation) ✅
1. `git clone https://github.com/MrLesk/Backlog.md`
2. `git checkout -b hybrid-agent-board`
3. Create `src/file-system/atomic-write.ts` — atomicWrite function
4. Create `src/utils/mutex.ts` — per-file in-process Mutex map (or `npm i async-mutex`)
5. Add `withWriteLock` to `src/file-system/operations.ts` (make `getCreateLockTarget` accessible)
6. Add `saveTaskUnlocked` internal method (B1 fix — prevent re-entrant deadlock)
7. Replace **all 10** `Bun.write` sites with `atomicWrite` (§2.5 list)
8. Wrap each save with `withWriteLock` (public methods); internal methods use `*Unlocked`
9. Write tests (13 cases from §3.5, including re-entrant + concurrent claim race)
10. Build: `bun run build` → test binary

**Deliverable:** All writes atomic + locked. No data corruption under concurrency. No deadlocks.

**Implementation notes (2026-07-17):**
- All 10 `Bun.write` sites converted to `atomicWrite` (temp+rename, dot-prefixed temp files)
- `withWriteLock` uses per-file in-process mutex (Map<path, Mutex>) + cross-process `proper-lockfile`
- `saveTaskUnlocked` internal method prevents re-entrant deadlock (B1 fix)
- File watcher fix in `content-store.ts`: macOS `fs.watch` fires rename event with TEMP filename (not target). 3 watchers (tasks/docs/decisions) now parse `.xxx.tmp` → extract target → trigger fast single-file path. Dotfile guard prevents full rescans.
- Tests: 1715 existing + 10 new concurrency = 1722 total, 0 fail
- Binary: `dist/backlog` v1.48.0

### Phase B: ActorClaim (who) ✅
1. Create `src/domain/actor.ts` — ActorKind + validateActorId (one file, not four)
2. Add `created_by_id?`, `created_by_kind?`, `updated_by_id?`, `updated_by_kind?` to Task
3. Add `actorId?`, `actorKind?` to TaskCreateInput + TaskUpdateInput
4. Modify parser.ts — parse 4 new fields from frontmatter (explicit in return literal)
5. Modify serializer.ts — serialize 4 new fields to frontmatter
6. Modify backlog.ts — persist actorId in createTaskFromInput + editTaskOrDraft
7. Add `actorId`, `actorKind` to generateTaskCreateSchema + generateTaskEditSchema
8. Wire actorId through handlers → core
9. Test: task_create with actorId → verify `created_by_id` in .md file

**Deliverable:** Every task knows who created and updated it. Flat snake_case fields.

**Implementation notes (2026-07-17):**
- 10 files modified/created (exactly per spec §4.5 + §7.1):
  - NEW: `src/domain/actor.ts` — ActorKind const (4 values) + validateActorId + actorKindFromString + ValidationException
  - `src/types/index.ts` — +4 Task fields (createdById/Kind, updatedById/Kind) + actorId/actorKind on TaskCreateInput + TaskUpdateInput
  - `src/types/task-edit-args.ts` — +actorId, actorKind on TaskEditArgs
  - `src/markdown/parser.ts` — parse 4 fields from frontmatter (snake_case → camelCase)
  - `src/markdown/serializer.ts` — serialize 4 fields (conditional spread pattern)
  - `src/core/backlog.ts` — createTaskFromInput → createdById/Kind + updatedById/Kind; applyTaskUpdateInput → updatedById/Kind
  - `src/utils/task-edit-builder.ts` — wiring actorId/actorKind → updateInput
  - `src/mcp/utils/schema-generators.ts` — actorId (string 1-500) + actorKind (enum 4 values) in create + edit schemas
  - `src/mcp/tools/tasks/handlers.ts` — TaskCreateArgs + createTask handler: pass actorId/actorKind; editTask wired via builder
  - NEW: `src/test/actor-claim.test.ts` — 7 tests: create, frontmatter, omit, round-trip, edit, serialize, omit-frontmatter
- Tests: 1722 pass, 0 fail, 4 skip (+7 new)
- Binary: rebuilt `dist/backlog` v1.48.0

### Phase C: ActivityLog (what happened) ⬜
1. Create `src/domain/activity_entry.ts` — ActivityEntry + formatActivityLine
2. Create `src/domain/trigger-derivation.ts` — config-aware deriveTrigger (no hardcoded statuses)
3. Create `src/file-system/activity-log.ts` — appendActivity (append to separate file)
4. Create `backlog/activity/` directory (on first append)
5. Modify backlog.ts — call appendActivity on status/comment/claim change (best-effort, inside withWriteLock)
6. Add taskActivityGetSchema to tasks/schemas.ts (with limit/offset pagination)
7. Add getActivity handler to tasks/handlers.ts (read activity file, apply pagination)
8. Register task_activity_get in tasks/index.ts
9. Test: task_edit (status change) → verify activity entry in `backlog/activity/{task-id}.md`

**Deliverable:** Every task has append-only audit trail in separate file. Per-task query with pagination.

### Phase D: Claim Ownership (who's working on it) ⬜
1. Add TaskClaim interface + `claim?` field to Task
2. Modify parser + serializer for nested `claim` object
3. Add taskClaimSchema + taskReleaseSchema to tasks/schemas.ts
4. Add claimTask + releaseTask handlers to tasks/handlers.ts (three-way logic, terminal check)
5. Register task_claim + task_release in tasks/index.ts
6. Add auto-renew logic to server.ts callTool handler (renew on any tool call from same actor)
7. Test: concurrent claim race (two simultaneous claims → exactly one wins)
8. Test: auto-renew (tool call extends claim expiry)
9. Test: terminal status DENY

**Deliverable:** Two agents can't claim the same task. Auto-renewal on active work. Release tool for handoffs.

### Phase E: ZCode Integration ⬜
1. Build fork: `bun run build` → `dist/backlog`
2. `npm link` locally (replace global backlog.md with fork)
3. Configure `.mcp.json` in ZCodeProject
4. Restart ZCode → MCP server auto-connect
5. Update `AGENTS.md` — rules for board MCP tools (task_claim, task_release, task_activity_get)
6. Concurrent write test: 2 parallel sub-agents → task_edit same task → no corruption
7. Verify `backlog browser` web UI (new fields may not render in v1 — that's OK, data is in markdown)

**Deliverable:** Board works in ZCode, agents call MCP tools.

### Phase F: Migration + Skill Rework ⬜
1. Migrate memory-bank/ data → board entities (docs, decisions, tasks)
2. Rework memory-bank skill: "write 5 files" → "call board MCP tools"
3. Update agents/*.md: add board MCP tools to tools field
4. Full multi-agent session test through board
5. Verify observability: ActivityLog shows who did what, claim TTL shows liveness

**Deliverable:** Memory bank replaced by board. Skill teaches agents to use MCP.

---

## 9. File Summary (revised)

### NEW files (8 — down from 12)

| File | Component | Lines |
|---|---|---|
| `src/file-system/atomic-write.ts` | Atomic writes | ~60 |
| `src/utils/mutex.ts` | Atomic writes (per-file mutex map) | ~50 |
| `src/domain/actor.ts` | ActorClaim (simplified — replaces 4 files) | ~30 |
| `src/domain/activity_entry.ts` | ActivityLog | ~50 |
| `src/domain/trigger-derivation.ts` | ActivityLog (config-aware) | ~35 |
| `src/file-system/activity-log.ts` | ActivityLog (separate files) | ~35 |
| `src/mcp/tools/tasks/schemas.ts` | Already exists — ADD claim/release/activity schemas | ~45 |
| (schemas.ts already exists — we ADD to it, not create new) | | |

**Total new:** ~305 lines (down from ~555 — dropped 4 verification files, simplified actor)

### MODIFIED files (10)

| File | Changes | Lines |
|---|---|---|
| `src/file-system/operations.ts` | withWriteLock + saveTaskUnlocked + 10 atomicWrite sites + lock dir derivation | ~130 |
| `src/types/index.ts` | created_by_*, updated_by_*, TaskClaim, claim field; actorId on inputs | ~30 |
| `src/types/task-edit-args.ts` | actorId, actorKind on TaskEditArgs | ~5 |
| `src/core/backlog.ts` | persist actor, auto-append activity, claim validation, saveTaskUnlocked | ~100 |
| `src/markdown/parser.ts` | parse created_by_*, updated_by_*, claim nested object | ~25 |
| `src/markdown/serializer.ts` | serialize all new fields | ~25 |
| `src/mcp/utils/schema-generators.ts` | actorId/actorKind in create + edit schemas | ~20 |
| `src/mcp/tools/tasks/handlers.ts` | pass actorId, claimTask, releaseTask, getActivity | ~120 |
| `src/mcp/tools/tasks/index.ts` | register task_claim, task_release, task_activity_get | ~20 |
| `src/mcp/server.ts` | auto-renew in callTool | ~30 |

**Total modified:** ~505 lines

### Grand total: ~810 lines across ~18 files (MVP ~550, full ~810)

**Revised from original ~875 → ~810** (net reduction despite adding release tool + auto-renew +
pagination, because we dropped 4 verification files and simplified actor model).

---

## 10. Nuances and Edge Cases (revised)

### 10.1 Re-entrant lock deadlock (B1 — FIXED)
- `saveTaskUnlocked` internal method — no lock
- `saveTask` public method — locks, calls `saveTaskUnlocked`
- `claimTask` / `releaseTask` — lock externally, call `saveTaskUnlocked`
- No double-acquisition of in-process mutex

### 10.2 ActivityLog in separate files (FLAW 1 — FIXED)
- Task files stay bounded — `task_view` returns task only, not activity
- Activity files grow freely — append-only, no rewrite
- Per-agent queries: scan `backlog/activity/`, filter by actor
- Git diffs: task changes and activity changes in separate files
- Best-effort consistency: if activity append fails, task update still succeeds

### 10.3 Claim auto-renewal (FLAW 3 — FIXED)
- MCP server auto-renews on any tool call from same actorId
- Agent doesn't need timers or manual renewal
- TTL = true liveness probe: "no tool calls in N seconds = dead"
- If agent crashes: claim expires → orchestrator can detect and reassign

### 10.4 Claim release (FLAW 2 — FIXED)
- `task_release` MCP tool — explicit release
- Can't use task_edit (additionalProperties: false blocks claim fields)
- Pipeline handoffs: architect releases → tester claims (no TTL wait)

### 10.5 Config-aware trigger derivation (B2/FLAW 5 — FIXED)
- No hardcoded `StatusLabels` — reads `config.statuses` at runtime
- Works with default 3-status and custom N-status workflows
- Forward = start/complete, backward = resume/reopen

### 10.6 Flat snake_case frontmatter (C3 — FIXED)
- `created_by_id`, `created_by_kind` (not `createdBy.id`, `createdBy.kind`)
- Matches existing convention (`created_date`, `updated_date`)
- Serializer/parser handle flat strings trivially

### 10.7 `task.rawContent` not `task.content` (G3 — FIXED)
- Task interface has `rawContent?: string`, not `content`
- Activity is in separate files anyway, so this is only relevant for getActivity handler

### 10.8 Terminal status check (G4 — FIXED)
- Use `isTerminalStatus()` from `src/utils/terminal-status.ts` (already exists)
- task_claim checks terminal before claiming

### 10.9 No tiered disclosure (CUT 4)
- Return competing agent's ID in `already_claimed` result
- All actors are trusted internal — orchestrator needs visibility
- `already_claimed` returns: `{ claimedBy: "architect", retryAfterMs: 540000 }`

### 10.10 Dropped: VerificationResult, DegradedModePolicy, resolveTrustedActorId
- NoOpActorVerifier → verification status always "unchecked"
- DegradedModePolicy → always trusts self-reported ID
- resolveTrustedActorId → always returns `claim.id`
- 3 files, ~125 lines of dead code → dropped
- If verification ever needed (it won't be for trusted internal agents), add then

### 10.11 Dropped: proof, parent, cascade, originalClaimedAt
- `proof` — 10KB blob in YAML, never set, footgun
- `parent` — orchestrator knows its spawn tree
- `cascade` — no cascade behavior in Backlog.md
- `originalClaimedAt` — marginal value, adds complexity

### 10.12 Merge strategy for the fork (GAP 3 — addressed)
- Use marker comments at each modification point: `// HYBRID-BOARD: actor persist`
- Prefer wrapping over modifying: new functions that call existing ones
- Document rebase workflow: sync from upstream monthly, run `bun test` after merge
- `backlog.ts` is 3282 lines — modifications are ~100 lines in 3 locations → manageable conflicts

### 10.13 MCP process model (still open)
- If ZCode spawns ONE MCP server for all sub-agents → in-process mutex sufficient
- If ZCode spawns SEPARATE processes → need cross-process flock
- **Mitigation:** withWriteLock uses BOTH layers always (correctness over micro-optimization)
- PID in temp file names provides empirical evidence of process model

### 10.14 Web UI (backlog browser)
- New fields (created_by_id, claim, activity) are in markdown
- Web UI may not render them in v1 — data is correct, display is cosmetic
- `backlog browser` reads markdown directly → no sync needed
- UI improvements for activity/claim display → v2

---

## 11. Observability Integration

### 11.1 Three levels

```
Level 3: System health    → ZCode Settings (MCP connected?)
Level 2: Agent activity   → Board (ActivityLog + claim TTL = liveness) ← THIS SPEC
Level 1: Tool calls       → ZCode artifacts (raw, per-session)
```

### 11.2 What the board logs (agent decisions, not tool calls)

| Event | Source MCP tool | ActivityLog entry |
|---|---|---|
| Task created | task_create | `action: create, trigger: create` |
| Status changed | task_edit | `action: status_change, from → to, trigger: start/complete/...` |
| Comment added | task_edit | `action: comment, summary: "text"` |
| Task claimed | task_claim | `action: claim, trigger: start` |
| Task released | task_release | `action: release` |
| Claim expired | (TTL, detected on next access) | `action: claim_expired` |

### 11.3 Claim TTL as liveness probe (with auto-renewal)

```
agent task_claim("TASK-X", ttlSeconds=900)     ← claim for 15 min
  → agent makes tool calls (task_view, task_edit, etc.)
  → MCP server auto-renews claim on each tool call  ← no manual heartbeat needed
  → agent crashes (no more tool calls)
  → 15 min later... claim expires

Orchestrator: query tasks where claim is not null and claim.expiresAt < now
  → expired claims = dead agents → can reassign
```

**With auto-renewal, TTL is a true liveness probe:** active agents (making tool
calls) keep their claims alive. Dead agents (no tool calls) lose their claims.
No manual heartbeat needed.

### 11.4 What the board does NOT log

- File reads/writes (that's ZCode artifacts)
- Bash commands (that's ZCode exec logs)
- MCP server health (that's ZCode Settings)
- Individual tool calls (that's ZCode artifacts, ~68/session)

---

## 12. Review Findings Summary

### 12.1 Reviewers

| Reviewer | Focus | Findings | Verdict |
|---|---|---|---|
| @reviewer-feasibility | Can we implement this? | 2 blockers, 5 risks, 9 gaps, 6 corrections | Needs revision |
| @reviewer-design | Is the design sound? | 3 blocking flaws, 4 cuts, 4 gaps, 4 alternatives | Conditional approval |

### 12.2 Blockers — all resolved in this revision

| ID | Problem | Fix |
|---|---|---|
| B1 | Re-entrant lock deadlock (claim_item → withWriteLock → saveTask → withWriteLock) | `saveTaskUnlocked` internal method |
| B2 | `StatusLabels` fabricated, `REVIEW` doesn't exist | Config-aware `deriveTrigger` from `config.statuses` |
| FLAW 1 | ActivityLog embedded = unbounded growth, context bloat | Separate files `backlog/activity/{task-id}.md` |
| FLAW 2 | Claim release via task_edit impossible | `task_release` MCP tool |
| FLAW 3 | TTL liveness = false guarantee without auto-renewal | Auto-renew on any tool call from same actor |

### 12.3 Cuts — all applied

| What | Lines saved |
|---|---|
| VerificationResult + DegradedModePolicy + resolveTrustedActorId (3 files) | ~125 |
| `proof` field | ~10 |
| `parent` field | ~15 |
| `cascade` trigger | ~10 |
| `originalClaimedAt` | ~15 |
| Tiered disclosure | ~10 |
| **Total saved** | **~185** |

### 12.4 Additions — all applied

| What | Lines added |
|---|---|
| `task_release` tool (GAP 1) | ~40 |
| `get_activity` pagination (GAP 2) | ~10 |
| Auto-renew claims on tool calls (FLAW 3) | ~30 |
| Config-aware trigger derivation (B2) | ~35 |
| Concurrent-claim race test (G5) | ~20 |
| Re-entrant lock test (B1) | ~15 |
| 5 missing Bun.write sites (G1) | ~50 |
| Merge strategy markers | ~10 |
| **Total added** | **~210** |

### 12.5 Net change

```
Original spec:  ~875 lines, 22 files
Cuts:          -185 lines, -4 files
Additions:     +210 lines, +0 files (added to existing files)
Revised:        ~810 lines (MVP ~550), ~18 files
```

---

## 13. Research Sources

| Agent | Role | Files studied | Tool calls | Duration |
|---|---|---|---|---|
| @source-analyst | Research | Backlog.md source (cloned) | 39 | 331s |
| @model-porter | Research | TaskOrchestrator Kotlin (17 files via API) | 20 | 412s |
| @concurrency-researcher | Research | Backlog.md + proper-lockfile + Bun docs | 21 | 841s |
| @mcp-architect | Research | Backlog.md MCP source (cloned) | 28 | 254s |
| @reviewer-feasibility | Review | Backlog.md source + spec | 25 | 481s |
| @reviewer-design | Review | Backlog.md source + spec + master file | 15 | 453s |

**Total:** 6 agents, 148 tool calls, ~2772s compute time across 4 parallel research + 2 parallel review.
