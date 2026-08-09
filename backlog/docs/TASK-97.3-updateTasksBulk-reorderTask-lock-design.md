# TASK-97.3 — updateTasksBulk per-file lock + reorderTask readTaskFresh

Design document for the final P0 concurrency fix from the TASK-97 gap analysis
(§3.4). Two related defects in bulk task operations.

- **Status:** To Do → ready for implementation
- **Parent:** TASK-97 — Board multiplexing gap analysis
- **Dependencies:** TASK-97.2 (editTask cross-process lock) — CLOSED. This task
  reuses the exact same primitive set: `withWriteLock` + `readTaskFresh` +
  `saveTaskUnlocked`.
- **Confidence:** HIGH for the per-file lock + field-merge (Fix A); HIGH for the
  reorderTask fresh read (Fix B). The residual cross-file atomicity gap is a
  documented, accepted limitation (see §8).

---

## 1. Problem statement, goals, non-goals

### 1.1 Problem

Two related defects cause lost-updates under concurrent reorders / bulk writes.

**Fix A — `updateTasksBulk` (backlog.ts:2442-2454).** The current implementation
calls `this.updateTask(task, false)` in a loop. Each `updateTask` →
`this.fs.saveTask(task)` (backlog.ts:1502) → `saveTask` uses only an **in-process**
mutex (`withMutex`, operations.ts:556). There is **no cross-process lock**. Two
processes running `reorderTask` concurrently each write full task objects based on
their own stale snapshot — the second write clobbers every field of the first
(title, description, assignee, …), not just the ordinal.

**Fix B — `reorderTask` (backlog.ts:2486-2491).** Ordinals of the participating
tasks are read via `this.getTask(id)` which resolves through the `ContentStore`
(backlog.ts:619-654) — an **in-memory cache that can be stale**. The new ordinal is
calculated (`calculateNewOrdinal`, backlog.ts:2528) from potentially stale
neighbor ordinals, so even under a lock the computed value can be wrong.

### 1.2 Goals

1. `updateTasksBulk` writes each task under a **per-file cross-process lock**
   (`withWriteLock`), re-reading the task fresh from disk (`readTaskFresh`) and
   persisting with `saveTaskUnlocked` (no redundant in-process mutex).
2. `updateTasksBulk` performs a **field-merge**: only the fields the caller intends
   to change are copied from the input task; all other fields come from the fresh
   disk read. This prevents whole-task clobbering of concurrent edits.
3. `reorderTask` reads participating ordinals via `readTaskFresh` instead of the
   in-memory `getTask`, so the ordinal calculation uses current disk state.
4. No new deadlocks. No regression to existing `reorderTask` / `archiveTask`
   behavior (updatedDate semantics, auto-commit, cross-branch rejection).

### 1.3 Non-goals

- **Cross-file atomicity for a single reorder.** A reorder that touches N tasks
  will lock them one at a time, not all at once. Two concurrent reorders that share
  a rebalanced neighbor can still last-writer-wins on that neighbor's *ordinal*
  (only the ordinal — never title/description/etc., thanks to field-merge). A
  fully-atomic reorder would need a coarse multi-file lock with deadlock-ordered
  acquisition; that is explicitly out of scope for this P0 and noted as future
  work (§8).
- Changing the `reorderTask` public signature or return shape.
- Adding cross-process locking to `saveTask` itself (kept in-process only, per
  operations.ts:532-537 comment — `withWriteLock` is reserved for read-modify-write
  paths).

---

## 2. System architecture (components + relationships)

All changes are inside `src/core/backlog.ts`. The primitives already exist in
`src/file-system/operations.ts` (added by TASK-97.1/97.2):

```
reorderTask (backlog.ts:2456)
  │
  │ 1. read participating tasks  ← Fix B: readTaskFresh ?? getTask
  │ 2. calculateNewOrdinal / resolveOrdinalConflicts (pure, no I/O)
  │ 3. build changedTasks (ordinal/status/milestone deltas)
  ▼
updateTasksBulk (backlog.ts:2442)  ← Fix A
  │
  │ for each task in tasks:
  │   getTaskPath ──▶ withWriteLock(taskPath) ──▶ readTaskFresh ──▶
  │   field-merge(fresh, update, mergeFields) ──▶ saveTaskUnlocked
  │   [contentStore refresh OUTSIDE lock]
  │
  ▼
git stageBacklogDirectory + commitChanges  [OUTSIDE all locks]
```

### Components touched

| Component | File:line | Change |
|---|---|---|
| `updateTasksBulk` | backlog.ts:2442-2454 | Rewrite loop body: per-file lock + fresh read + field-merge + unlocked save. Add `mergeFields` param. |
| `reorderTask` (load block) | backlog.ts:2485-2491 | Replace `getTask` with `readTaskFresh ?? getTask`. |
| `reorderTask` (bulk call) | backlog.ts:2568-2572 | Pass `mergeFields: ["ordinal","status","milestone"]`. |
| `archiveTask` (bulk call) | backlog.ts:2603 | Pass `mergeFields: ["dependencies","references"]`. |
| new helper `mergeBulkTask` | backlog.ts (near `updateTasksBulk`) | Pure field-merge function. |
| `reorder-utils.test.ts:178` | test | Add `mergeFields: ["ordinal"]` to the existing call. |

### Reused primitives (NO changes)

- `fs.withWriteLock(targetPath, fn)` — operations.ts:412. Per-file lock:
  lock-file path = sha1(targetPath) hash (operations.ts:418-422). Different files
  → independent locks. Cross-process via `proper-lockfile` mkdir; in-process via
  `withMutex`. Stale-recoverable, timeout-bounded.
- `fs.readTaskFresh(taskId)` — operations.ts:564. Reads from disk via
  `readFile` (bypasses `Bun.file` cache). Returns `{ ...task, filePath }` or null.
- `fs.saveTaskUnlocked(task)` — operations.ts:474. Atomic write (temp+rename),
  no lock. Preserves `filePath` when set on the task.
- `getTaskPath(taskId, this)` — utils/task-path.ts:86, already imported
  (backlog.ts:69). Returns the on-disk path or null.

---

## 3. Interfaces / APIs

### 3.1 `updateTasksBulk` — new signature

```ts
async updateTasksBulk(
    tasks: Task[],
    commitMessage?: string,
    autoCommit?: boolean,
    mergeFields?: ReadonlyArray<keyof Task>,
): Promise<void>
```

**`mergeFields` (NEW, optional but strongly recommended explicit).** The subset of
`Task` fields to copy from each input `task` over the fresh disk read. All other
fields are taken from the fresh read. Callers MUST pass the fields they actually
change.

- `reorderTask` → `["ordinal", "status", "milestone"]`
- `archiveTask` sanitization → `["dependencies", "references"]`

If `mergeFields` is omitted, the method falls back to
`DEFAULT_BULK_MERGE_FIELDS = ["ordinal", "status", "milestone"] as const` (the
reorder case, the dominant caller). This keeps the signature backwards-compatible
with the existing test, but **both production callers are updated to pass it
explicitly** for clarity. See §9 (risks) for why the default exists.

**Field-merge semantics.** For each field `f` in `mergeFields`, the merged task
takes `update[f]` verbatim (including `undefined`, which clears the field via
`serializeTask` omission). This correctly handles "clear milestone" (set to
`undefined`) — unlike a `!== undefined` guard which would skip clears.

**Inputs:** `tasks` — full Task objects carrying the desired new values for the
declared `mergeFields`. `commitMessage`, `autoCommit` — unchanged.

**Outputs:** `void` (unchanged).

**Error cases:**
- A task whose file cannot be resolved (`getTaskPath` → null) or that disappears
  between `getTaskPath` and `readTaskFresh` is **skipped** (logged via `DEBUG`),
  not resurrected. This is a behavioral improvement over the old path which would
  create a new file. The loop continues with remaining tasks.
- `withWriteLock` may throw `WriteLockError` (code `WRITE_LOCK_ERROR_CODE`,
  operations.ts:448-452) after `DEFAULT_WRITE_LOCK_TIMEOUT_MS`. This propagates
  out of the loop (partial write already persisted for prior tasks — acceptable,
  same crash-safety profile as the rest of the codebase).

### 3.2 `reorderTask` — unchanged signature, changed read

```ts
async reorderTask(params: { ... }): Promise<{ updatedTask: Task; changedTasks: Task[] }>
```

Only the load block (backlog.ts:2485-2491) changes: `getTask` →
`readTaskFresh ?? getTask`. The rest of the method (calculation, conflict
resolution, changedTasks filter, bulk dispatch) is unchanged.

---

## 4. Data flow + data models

### 4.1 `updateTasksBulk` per-task flow (Fix A)

```
for task in tasks:
    taskPath = getTaskPath(task.id)            # outside lock
    if taskPath == null: skip (DEBUG log)
    saved = withWriteLock(taskPath):
        fresh = readTaskFresh(task.id)          # disk, bypass cache
        if fresh == null: return false          # disappeared, skip
        merged = mergeBulkTask(fresh, task, mergeFields)
        # updatedDate — mirror updateTask (backlog.ts:1494-1500)
        if hasUpdatedDateRelevantChanges(fresh, merged):
            merged.updatedDate = now()
        elif fresh.updatedDate: merged.updatedDate = fresh.updatedDate
        else: delete merged.updatedDate
        normalizeAssignee(merged)
        saveTaskUnlocked(merged)                # no lock (we hold it)
        return true
    # --- OUTSIDE lock ---
    if saved and contentStore:
        contentStore.upsertTask(readTaskFresh(task.id))
# --- OUTSIDE all locks ---
if shouldAutoCommit(autoCommit):
    stageBacklogDirectory + commitChanges(commitMessage)
```

### 4.2 Field-merge data model

```ts
function mergeBulkTask(
    fresh: Task,
    update: Task,
    fields: ReadonlyArray<keyof Task>,
): Task {
    const merged: Task = { ...fresh };
    for (const field of fields) {
        // Copy verbatim — including undefined (clears field on serialize).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (merged as Record<string, unknown>)[field] =
            (update as Record<string, unknown>)[field];
    }
    return merged;
}
```

Why spread `fresh` first, then overlay only `mergeFields`: `filePath` stays from
fresh (correct disk path); `rawContent`, `lastModified`, `source`, `branch`,
`createdDate` stay from fresh (identity/metadata, never bulk-modified);
`assignee` stays from fresh (already normalized on disk). Only the declared data
fields are overwritten.

### 4.3 `updatedDate` preservation

`buildUpdatedDateComparableTask` (backlog.ts:136-164) deliberately **excludes
`ordinal`**. So:

| Caller | mergeFields | updatedDate behavior |
|---|---|---|
| reorderTask | ordinal/status/milestone | ordinal-only change → no updatedDate (preserved). status/milestone change → updatedDate set. Matches existing test `reorder-utils.test.ts:157` ("preserves updatedDate for ordinal-only bulk updates"). |
| archiveTask | dependencies/references | both fields ARE in `buildUpdatedDateComparableTask` → updatedDate set if they changed. Matches old `updateTask` behavior (which also triggered updatedDate for dependency changes). |

### 4.4 `reorderTask` fresh read (Fix B)

```
# OLD (backlog.ts:2486-2491):
loadedTasks = Promise.all(orderedTaskIds.map(id => this.getTask(id)))

# NEW:
loadedTasks = Promise.all(orderedTaskIds.map(id =>
    this.fs.readTaskFresh(id) ?? this.getTask(id)
))
```

- `readTaskFresh` reads the local tasks dir from disk (bypasses cache) → correct,
  current ordinals for the `calculateNewOrdinal` / `resolveOrdinalConflicts`
  computation.
- Fallback `?? this.getTask(id)` preserves the existing ability to include
  **cross-branch** tasks (present only in the `ContentStore`, not on local disk)
  in the ordered list. Without the fallback, cross-branch IDs would silently drop
  from `validTasks` (backlog.ts:2494) and shift `targetIndex` — a behavioral
  change. The fallback keeps behavior identical for cross-branch tasks while
  fixing staleness for local tasks.
- This read is **outside any lock** (best-effort freshness for the calculation).
  The actual write atomicity is provided by Fix A's per-file locks in
  `updateTasksBulk`. See §8 for why calculation-read and write are not jointly
  atomic.

---

## 5. Concrete changes: old → new

### 5.1 `updateTasksBulk` (backlog.ts:2442-2454)

**OLD:**
```ts
async updateTasksBulk(tasks: Task[], commitMessage?: string, autoCommit?: boolean): Promise<void> {
    // Update all tasks without committing individually
    for (const task of tasks) {
        await this.updateTask(task, false); // Don't auto-commit each one
    }

    // Commit all changes at once if auto-commit is enabled
    if (await this.shouldAutoCommit(autoCommit)) {
        const backlogDir = await this.getBacklogDirectoryName();
        const repoRoot = await this.git.stageBacklogDirectory(backlogDir);
        await this.git.commitChanges(commitMessage || `Update ${tasks.length} tasks`, repoRoot);
    }
}
```

**NEW:**
```ts
/**
 * TASK-97.3: per-file cross-process locked bulk update with field-merge.
 * Each task is locked individually (withWriteLock), re-read fresh from disk
 * (readTaskFresh), and only `mergeFields` are copied from the input task over
 * the fresh snapshot (mergeBulkTask). Persisted via saveTaskUnlocked (we hold
 * the lock). Git commit + contentStore run OUTSIDE the lock.
 *
 * `mergeFields` declares which fields the caller intends to change; everything
 * else comes from the fresh disk read (prevents whole-task clobbering of
 * concurrent edits). Defaults to ordinal/status/milestone (reorder case).
 */
async updateTasksBulk(
    tasks: Task[],
    commitMessage?: string,
    autoCommit?: boolean,
    mergeFields: ReadonlyArray<keyof Task> = DEFAULT_BULK_MERGE_FIELDS,
): Promise<void> {
    for (const task of tasks) {
        const taskPath = await getTaskPath(task.id, this);
        if (!taskPath) {
            if (process.env.DEBUG) console.error(`[updateTasksBulk] skip ${task.id}: no file path`);
            continue;
        }

        const saved = await this.fs.withWriteLock(taskPath, async () => {
            const fresh = await this.fs.readTaskFresh(task.id);
            if (!fresh) {
                // Deleted concurrently — do NOT resurrect.
                if (process.env.DEBUG) console.error(`[updateTasksBulk] skip ${task.id}: not on disk under lock`);
                return false;
            }

            const merged = this.mergeBulkTask(fresh, task, mergeFields);

            // updatedDate — mirror updateTask (backlog.ts:1494-1500).
            // buildUpdatedDateComparableTask excludes `ordinal`, so ordinal-only
            // merges preserve updatedDate; status/milestone/dependencies merges
            // update it when the comparable fields differ.
            if (hasUpdatedDateRelevantChanges(fresh, merged)) {
                merged.updatedDate = new Date().toISOString().slice(0, 16).replace("T", " ");
            } else if (fresh.updatedDate) {
                merged.updatedDate = fresh.updatedDate;
            } else {
                delete merged.updatedDate;
            }

            normalizeAssignee(merged);
            await this.fs.saveTaskUnlocked(merged);
            return true;
        });

        // contentStore refresh OUTSIDE the lock (mirrors TASK-97.2:2224-2229).
        if (saved && this.contentStore) {
            const savedTask = await this.fs.readTaskFresh(task.id);
            if (savedTask) {
                this.contentStore.upsertTask(savedTask);
            }
        }
    }

    // Commit all changes at once if auto-commit is enabled — OUTSIDE all locks.
    if (await this.shouldAutoCommit(autoCommit)) {
        const backlogDir = await this.getBacklogDirectoryName();
        const repoRoot = await this.git.stageBacklogDirectory(backlogDir);
        await this.git.commitChanges(commitMessage || `Update ${tasks.length} tasks`, repoRoot);
    }
}

/** TASK-97.3: overlay only `fields` from `update` onto a fresh `fresh` task. */
private mergeBulkTask(
    fresh: Task,
    update: Task,
    fields: ReadonlyArray<keyof Task>,
): Task {
    const merged: Task = { ...fresh };
    const mergedRecord = merged as Record<string, unknown>;
    const updateRecord = update as Record<string, unknown>;
    for (const field of fields) {
        // Copy verbatim — including undefined (clears the field on serialize).
        mergedRecord[field] = updateRecord[field];
    }
    return merged;
}
```

Add near the top of the file (alongside `DEFAULT_ORDINAL_STEP` import region, or
just above `updateTasksBulk`):

```ts
/** TASK-97.3: default fields merged by updateTasksBulk (reorder case). */
const DEFAULT_BULK_MERGE_FIELDS: ReadonlyArray<keyof Task> = ["ordinal", "status", "milestone"];
```

### 5.2 `reorderTask` load block (backlog.ts:2485-2491)

**OLD:**
```ts
// Load all tasks from the ordered list - use getTask to include cross-branch tasks from the store
const loadedTasks = await Promise.all(
    orderedTaskIds.map(async (id) => {
        const task = await this.getTask(id);
        return task;
    }),
);
```

**NEW:**
```ts
// TASK-97.3: read ordinals fresh from disk (bypass ContentStore cache) so the
// ordinal calculation uses current state. Fall back to getTask for cross-branch
// tasks that exist only in the store (not on local disk) — preserves prior
// behavior for non-local IDs.
const loadedTasks = await Promise.all(
    orderedTaskIds.map(async (id) => {
        const fresh = await this.fs.readTaskFresh(id);
        if (fresh) return fresh;
        return await this.getTask(id);
    }),
);
```

### 5.3 `reorderTask` bulk call (backlog.ts:2567-2573)

**OLD:**
```ts
if (changedTasks.length > 0) {
    await this.updateTasksBulk(
        changedTasks,
        params.commitMessage ?? `Reorder tasks in ${targetStatus}`,
        params.autoCommit,
    );
}
```

**NEW:**
```ts
if (changedTasks.length > 0) {
    await this.updateTasksBulk(
        changedTasks,
        params.commitMessage ?? `Reorder tasks in ${targetStatus}`,
        params.autoCommit,
        ["ordinal", "status", "milestone"], // TASK-97.3: merge only reorder fields
    );
}
```

### 5.4 `archiveTask` bulk call (backlog.ts:2602-2604)

**OLD:**
```ts
const sanitizedTasks = this.sanitizeArchivedTaskLinks(activeTasks, normalizedTaskId);
if (sanitizedTasks.length > 0) {
    await this.updateTasksBulk(sanitizedTasks, undefined, false);
}
```

**NEW:**
```ts
const sanitizedTasks = this.sanitizeArchivedTaskLinks(activeTasks, normalizedTaskId);
if (sanitizedTasks.length > 0) {
    // TASK-97.3: merge only link-sanitization fields; rest from fresh disk read.
    await this.updateTasksBulk(sanitizedTasks, undefined, false, ["dependencies", "references"]);
}
```

### 5.5 Test update — `reorder-utils.test.ts:178-185`

The existing call works unchanged (default mergeFields = ordinal/status/milestone,
and the test only changes ordinal). **No edit strictly required**, but for
explicitness the coder MAY add `["ordinal"]`:

```ts
await core.updateTasksBulk(
    [
        { ...task1, ordinal: 3000 },
        { ...task2, ordinal: 4000 },
    ],
    "Sort To Do",
    false,
    ["ordinal"], // TASK-97.3: explicit merge fields
);
```

---

## 6. Files affected

| File | Change |
|---|---|
| `src/core/backlog.ts` | Rewrite `updateTasksBulk`; add `mergeBulkTask` + `DEFAULT_BULK_MERGE_FIELDS`; update `reorderTask` load block; update 2 bulk call sites (reorder, archive). |
| `src/test/reorder-utils.test.ts` | (Optional) add explicit `mergeFields` to existing `updateTasksBulk` call at line 178. |
| `src/test/atomic-write-concurrency.test.ts` | **NEW test** — concurrent `reorderTask` / `updateTasksBulk` does not clobber non-merged fields (see §7). |

No changes to `src/file-system/operations.ts` (primitives already exist from
TASK-97.1/97.2). No changes to `src/core/reorder.ts` (pure functions).

---

## 7. Testing strategy

### 7.1 Unit — `mergeBulkTask` (new helper)

Direct unit test (can live in `reorder-utils.test.ts` or a new
`bulk-merge.test.ts`):

- `mergeBulkTask(fresh, { ...fresh, ordinal: 999, title: "X" }, ["ordinal"])`
  → result.ordinal === 999, result.title === fresh.title (NOT "X").
- Clear semantics: `mergeBulkTask(fresh, { ...fresh, milestone: undefined }, ["milestone"])`
  → result.milestone === undefined (cleared, not preserved from fresh).
- Fields not in the list are untouched.

### 7.2 Unit — `updatedDate` preservation (existing test stays green)

`reorder-utils.test.ts:157` ("preserves updatedDate for ordinal-only bulk
updates") must remain green: ordinal-only merge → `buildUpdatedDateComparableTask`
excludes ordinal → no updatedDate change. The coder must run this test.

### 7.3 Integration — concurrent reorder does not clobber non-merged fields

**NEW test in `atomic-write-concurrency.test.ts`** (mirrors the existing
`withWriteLock (via saveTask)` describe block at line 183):

```
Setup: two tasks TASK-1 (ordinal 1000), TASK-2 (ordinal 2000) in "To Do".
       TASK-1 has description "original desc".
Process A: coreA.reorderTask({ taskId: TASK-1, targetStatus: "To Do",
            orderedTaskIds: [TASK-1, TASK-2] })   # moves TASK-1 first
Process B (concurrent): coreB.editTask("TASK-1", { description: "edited by B" })
                        # via updateTaskLocked (TASK-97.2 path)

Assert after both resolve:
  - TASK-1.description === "edited by B"   # B's edit NOT clobbered by A's reorder
  - TASK-1.ordinal reflects A's reorder    # A's ordinal applied
```

This is the core regression guard: before the fix, A's `updateTask` would
whole-task write TASK-1 (with stale description) and clobber B's edit. After the
fix, A's bulk merges only `ordinal`/`status`/`milestone`, so B's description
survives. **This is the single most important acceptance test.**

### 7.4 Integration — two concurrent reorders serialize on shared file

```
Two Core instances, both reorder in the same column touching TASK-2 (shared neighbor).
Both call updateTasksBulk concurrently.
Assert: no error (no permanent deadlock), both complete; TASK-2's final ordinal
is one of the two calculated values (last-writer-wins on the shared neighbor's
ordinal is acceptable — documented limitation). TASK-2's title/description are
intact (from fresh, not clobbered).
```

### 7.5 Integration — archive sanitization under concurrent edit

```
TASK-1 depends on TASK-2. Concurrently: archive TASK-2 (sanitizes TASK-1's
dependencies) AND edit TASK-1's title via a second Core.
Assert: TASK-1.title === edited value (not clobbered by sanitization's bulk write),
        TASK-1.dependencies no longer references TASK-2 (sanitization applied).
```

### 7.6 Existing tests — must stay green

- `reorder-utils.test.ts` (full file) — ordinal/updatedDate behavior.
- `atomic-write-concurrency.test.ts:235` ("does not deadlock when
  saveTaskUnlocked is called inside withWriteLock") — confirms the primitive
  nesting we rely on.
- `claim-ownership.test.ts` — uses the same `withWriteLock` +
  `saveTaskUnlocked` pattern; unaffected.

Run: `bun test src/test/reorder-utils.test.ts src/test/atomic-write-concurrency.test.ts src/test/claim-ownership.test.ts`

---

## 8. Trade-offs (ADR)

### ADR-1: per-file locks in the loop vs. coarse multi-file lock

**Decision:** Per-file `withWriteLock`, acquired one at a time in the loop
(release before acquiring the next).

**Alternatives:**
1. **Coarse multi-file lock** — lock all N participating files, then read all,
   calculate, write all, release. Fully atomic reorder. REJECTED: acquiring N
   locks simultaneously requires a consistent global ordering (e.g. sorted by
   path) to avoid deadlock between two reorders locking overlapping sets in
   different orders. The `proper-lockfile` API acquires one lock per call;
   composing N-lock ordered acquisition is complex and error-prone, and a single
   global "reorder" lock would serialize ALL reorders across the board (poor
   concurrency). Out of scope for a P0 fix.
2. **Single global reorder lock** — one `withCreateLock` around the entire
   reorder. REJECTED: serializes unrelated reorders (different columns / different
   task sets), regressing concurrency for the common case. Also much coarser than
   needed.

**Consequences:**
- (+) No deadlock possible (§9): each process holds at most one file lock at a
  time → no circular wait.
- (+) Unrelated reorders (disjoint files) run fully parallel.
- (+) Field-merge limits any race damage to the merged field only (ordinal), never
  title/description/assignee.
- (-) Residual race: two concurrent reorders sharing a rebalanced neighbor can
  last-writer-wins on that neighbor's *ordinal*. The neighbor's other fields are
  safe (fresh). This is strictly better than today (whole-task clobber) and
  acceptable for P0.

### ADR-2: field-merge with explicit `mergeFields` vs. whole-task write

**Decision:** Caller declares `mergeFields`; bulk copies only those from the input
task, rest from fresh.

**Alternatives:**
1. **Whole-task write (status quo)** — `saveTaskUnlocked(task)`. REJECTED: writes
   every field from the input task, which is a stale snapshot → clobbers
   concurrent edits to any field.
2. **Diff-based merge** — caller passes `(original, updated)` pairs; bulk diffs
   them to detect changed fields. REJECTED: requires capturing an original
   snapshot per task at call time; the current callers build `changedTasks` from
   `getTask` reads and don't retain clean originals. More plumbing for no
   accuracy gain over explicit `mergeFields`.

**Consequences:**
- (+) Minimal, explicit, auditable: each caller declares exactly what it changes.
- (+) Handles field-clearing (undefined) correctly via verbatim copy.
- (-) A caller that forgets a field in `mergeFields` would silently drop that
  change. Mitigated by the default and by having only two callers, both updated in
  this same change.

### ADR-3: `readTaskFresh ?? getTask` fallback in reorderTask

**Decision:** Try fresh disk read first; fall back to `getTask` (ContentStore) if
the task is not on local disk (cross-branch).

**Alternatives:**
1. **`readTaskFresh` only** — REJECTED: cross-branch tasks (in ContentStore, not
  on local disk) would return null and be filtered out of `validTasks`
  (backlog.ts:2494), shifting `targetIndex` and changing neighbor selection — a
  behavioral regression for cross-branch board scenarios.
2. **`getTask` only (status quo)** — REJECTED: stale cache, the very bug Fix B
   targets.

**Consequences:**
- (+) Local tasks (the reordering case) get fresh ordinals; cross-branch behavior
  unchanged.
- (-) If `readTaskFresh` fails transiently for a local task, falls back to stale
  `getTask`. Acceptable degradation (rare, same as today).

---

## 9. Deadlock analysis

**Claim: per-file `withWriteLock` acquired sequentially in a loop cannot
deadlock.**

1. **Single reorder — no nesting.** The loop body acquires one lock, runs the
   read-merge-save, releases, then moves to the next task. At any instant the
   process holds **at most one** file lock. There is no point where it holds lock
   A while waiting for lock B. → No circular wait, no self-deadlock.

2. **Two reorders, disjoint files** (e.g. column "To Do" vs. column "Done").
   Locks are keyed by file path hash (operations.ts:418-422) → independent lock
   files. Both run fully parallel, never contend. → No deadlock.

3. **Two reorders, overlapping files** (shared neighbor TASK-Y). Process A
   acquires Y's lock; process B retries with backoff until A releases
   (`DEFAULT_WRITE_LOCK_RETRY_DELAY_MS`, operations.ts:425). B then acquires Y.
   Serialized on the shared file. Each still holds at most one lock at a time. →
   No deadlock.

4. **In-process `withMutex` + cross-process `lockfile` nesting** (inside
   `withWriteLock`, operations.ts:431-464): always acquired in the same order
   (in-process mutex first, then cross-process mkdir lock), keyed by the same
   `lockFile` path. `saveTaskUnlocked` inside does NOT re-acquire any lock. This
   nesting is already proven deadlock-free by
   `atomic-write-concurrency.test.ts:235` ("does not deadlock when
   saveTaskUnlocked is called inside withWriteLock").

5. **Crash recovery.** `withWriteLock` uses `proper-lockfile` with `stale`
   recovery (operations.ts:441): if a holder crashes, the next acquirer reclaims
   the lock after `DEFAULT_WRITE_LOCK_STALE_MS`. No permanent stall. Bounded by
   `DEFAULT_WRITE_LOCK_TIMEOUT_MS` → throws `WriteLockError` if unattainable.

**Conclusion:** The per-file-in-loop pattern is deadlock-free by construction
(non-overlapping lock lifetimes). This is the decisive reason it was chosen over
a coarse multi-file lock (ADR-1).

---

## 10. Risks + open questions

### Risks

1. **Residual cross-file race (accepted, ADR-1).** Two concurrent reorders sharing
   a rebalanced neighbor can last-writer-wins on that neighbor's ordinal. Only
   ordinal is affected (field-merge protects all other fields). Bounded and
   strictly better than today's whole-task clobber. **Mitigation for the future:**
   a coarse ordered multi-file lock — documented as future work, not this task.
   Confidence: HIGH that this is the intended scope (task explicitly says
   "per-file withWriteLock in the loop").

2. **`mergeFields` default masks forgotten fields.** If a future caller of
   `updateTasksBulk` changes a field not in the default set without passing
   `mergeFields`, that change is silently dropped. **Mitigation:** only two
   production callers exist, both updated in this change; JSDoc on the method
   states the contract. Confidence: MEDIUM that the default is the right
   trade-off vs. making the param required. (ASSUMPTION: backwards-compat with the
   existing test is worth keeping the default; revisit if more callers appear.)

3. **`readTaskFresh ?? getTask` doubles read I/O for cross-branch tasks.** For a
   cross-branch ID, `readTaskFresh` (disk miss) + `getTask` (store hit). Negligible
   — cross-branch tasks are rare in a reorder's `orderedTaskIds` (the moved task is
   rejected if branched, backlog.ts:2502-2507), and the store hit is in-memory.
   Confidence: HIGH this is a non-issue.

4. **Skip-on-missing changes behavior vs. old `updateTask`.** Old path would
   create a new file for a task whose path is unresolvable; new path skips it. This
   is correct (don't resurrect deleted tasks) but is a behavioral delta. The only
   realistic trigger is a task deleted between reorder's read and bulk's write —
   already an error scenario in the old code (it would write a stale resurrected
   file). Confidence: HIGH the new behavior is strictly better.

### Open questions

None blocking. The design is implementable as specified. The one product-level
question — "is the residual cross-file ordinal race acceptable for P0?" — is
answered YES by the task description's explicit choice of per-file locks; a
follow-up task can pursue coarse-lock atomicity if needed.

---

## 11. Task breakdown (for the coder)

Single implementation task (one component — `backlog.ts` bulk/reorder). No
sub-dependencies; TASK-97.2 (the primitive set) is already closed.

### TASK-97.3-impl — updateTasksBulk per-file lock + reorderTask readTaskFresh

**Description:** Apply §5 changes to `src/core/backlog.ts`: rewrite
`updateTasksBulk` with per-file `withWriteLock` + `readTaskFresh` +
`mergeBulkTask` field-merge + `saveTaskUnlocked`; add `mergeBulkTask` private
helper and `DEFAULT_BULK_MERGE_FIELDS` constant; update `reorderTask` load block
to `readTaskFresh ?? getTask`; update the two `updateTasksBulk` call sites
(reorder, archive) with explicit `mergeFields`. Add the concurrent-clobber
integration test (§7.3).

**Files:**
- `src/core/backlog.ts` (modify)
- `src/test/atomic-write-concurrency.test.ts` (add test §7.3)
- `src/test/reorder-utils.test.ts` (optionally add explicit `mergeFields`)

**Acceptance criteria (pass/fail):**
1. `bun test src/test/reorder-utils.test.ts` — all green (incl. "preserves
   updatedDate for ordinal-only bulk updates" at line 157).
2. `bun test src/test/atomic-write-concurrency.test.ts` — all green, including the
   NEW §7.3 test asserting a concurrent `editTask` (description) is NOT clobbered
   by a concurrent `reorderTask` on the same task.
3. `bun test src/test/claim-ownership.test.ts` — green (no regression to the
   shared `withWriteLock` + `saveTaskUnlocked` pattern).
4. `grep -n "this.updateTask(task, false)" src/core/backlog.ts` inside
   `updateTasksBulk` returns NO match (old loop body removed).
5. `updateTasksBulk` body contains `withWriteLock`, `readTaskFresh`,
   `saveTaskUnlocked`, and `mergeBulkTask` (or equivalent field-merge).
6. `reorderTask` load block contains `readTaskFresh` (not just `getTask`).
7. No new TS compile errors (`bunx tsc --noEmit` or the project's type-check
   command).

**Dependencies:** TASK-97.2 (CLOSED — provides `withWriteLock`/`readTaskFresh`/
`saveTaskUnlocked` primitives and the `updateTaskLocked` reference pattern).

**Critical path:** This is the last P0 fix in the TASK-97 chain; no downstream
tasks depend on it.

**Expected behavior change:** Concurrent reorders / archive-sanitization no longer
clobber unrelated task fields (title, description, assignee, etc.); only the
declared merge fields (ordinal/status/milestone for reorder;
dependencies/references for archive) are written, and each write is serialized
per-file across processes. Ordinal calculations in `reorderTask` use fresh disk
state instead of a stale in-memory cache.
