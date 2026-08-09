# TASK-97.4 — Move git fetch outside create-lock

**Status:** Design (Architect output)
**Parent:** TASK-97 (board-multiplexing gap analysis, §3.3 path 4)
**Priority:** P0
**Config gate status:** `check_active_branches: false` (project) → mitigated; `backlog-fork/backlog/config.yml` has `check_active_branches: true` → **OPEN**.
**Dependencies:** TASK-97.1 (stale 60s + onCompromised) — already closed (paths 2+3).

---

## 1. Problem statement + goals + non-goals

### 1.1 Problem
`getActiveAndCompletedTaskIds` (backlog.ts:1152) calls `loadRemoteTasks` (backlog.ts:1200)
→ `gitOps.fetch()` (task-loader.ts:550) **INSIDE** `withCreateLock` (backlog.ts:1345).
The network call holds the global create-lock for the entire duration of `git fetch`.

Under 8 concurrent agents each creating tasks, the second through eighth callers
spin on the lockfile until the first releases → `ECREATELOCK` (operations.ts:67),
task creation is effectively serialized behind network I/O and may time out.

### 1.2 Goals
- Move the network `git fetch` (and the remote/cross-branch ID scan) OUTSIDE the
  create-lock so the lock is held only over cheap local-FS work.
- Preserve local ID uniqueness under concurrent creates (the lock's actual job).
- Preserve cross-branch ID uniqueness semantics (best-effort, detect+repair) — no NEW
  failure modes vs. today.
- Keep the public `generateNextId(type, parent)` API backward-compatible for external
  callers (CLI, duplicate-task-repair) that don't pass prefetched IDs.

### 1.3 Non-goals
- Coordinating the local lock with REMOTE processes (other clones/worktrees). The local
  create-lock is and remains a per-repo lock; it cannot prevent a remote branch from
  allocating the same numeric ID. Remote duplicates continue to be handled by
  `duplicate-task-repair` (detect + repair). Moving fetch outside the lock does NOT
  change this — it is the same exposure that exists today.
- Changing the lockfile protocol, stale timeout, or `onCompromised` (TASK-97.1 scope).
- Removing `git fetch` from ID generation entirely (it is still needed for the
  advisory cross-branch snapshot; it just runs outside the lock now).

---

## 2. System architecture (components + relationships)

The fix is an internal refactor of the ID-generation pipeline in `src/core/backlog.ts`.
No new modules; the critical section is narrowed.

### 2.1 Current call chain (network INSIDE lock)

```
createTaskFromInput (backlog.ts:1279)
  └─ withCreateLock (backlog.ts:1345)            <-- LOCK ACQUIRED
       ├─ resolveParentTaskIdForCreate (1347)    -- local git scan (no fetch)
       ├─ generateNextId (1349)
       │    └─ getExistingIdsForType (1073)
       │         └─ getActiveAndCompletedTaskIds (1225 → 1152)
       │              ├─ listTasksWithMetadata / listCompletedTasks  (local FS)
       │              ├─ loadWorktreeTaskStateEntries (1191)         (local FS+git, no fetch)
       │              └─ [if checkActiveBranches !== false]
       │                   Promise.all (1199):
       │                    ├─ loadRemoteTasks (1200) ─► gitOps.fetch() (task-loader.ts:550)  *** NETWORK ***
       │                    └─ loadLocalBranchTasks (1201)          (local git, no fetch)
       ├─ resolveCreateOrdinal (1350)            -- local FS (listTasks)
       ├─ writePreparedTask (1382)               -- FS write
       └─ ... return                              <-- LOCK RELEASED
```

**The lock is held across `gitOps.fetch()` + remote-branch indexing** — the slow part.

### 2.2 Proposed call chain (network OUTSIDE lock)

```
createTaskFromInput (backlog.ts:1279)
  ├─ prefetchedTaskIds = getActiveAndCompletedTaskIds()  *** NETWORK + scan, NO LOCK ***
  │      (only when entityType === Task; drafts/docs/decisions have no fetch)
  └─ withCreateLock (backlog.ts:1345)            <-- LOCK ACQUIRED (cheap body)
       ├─ resolveParentTaskIdForCreate (1347)   -- local git scan (kept in-lock, see §9.2)
       ├─ generateNextId(type, parent, prefetchedTaskIds)   (fast path)
       │    └─ getLocalExistingIdsForType(type)            (local FS ONLY, fresh)
       │         └─ getLocalActiveAndCompletedTaskIds()    (NO fetch, NO branch scan)
       ├─ resolveCreateOrdinal (1350)            -- local FS
       ├─ writePreparedTask (1382)               -- FS write
       └─ ... return                             <-- LOCK RELEASED
```

**Lock body is now local-FS-only.** `git fetch` runs before the lock is touched.

---

## 3. Interfaces / APIs (contracts)

### 3.1 New: `getLocalActiveAndCompletedTaskIds()` (private)
```ts
// backlog.ts — cheap, local-FS-only, safe to call inside the lock
private async getLocalActiveAndCompletedTaskIds(): Promise<string[]>
```
- **Input:** none (reads config + local FS + worktree FS).
- **Output:** string[] of active+completed task IDs visible on the LOCAL filesystem
  (current worktree's `tasks/`, `completed/`, and same-repo worktree task dirs).
- **Does NOT call:** `loadRemoteTasks` (no `gitOps.fetch`), `loadLocalBranchTasks`
  (no other-local-branch git scan). Only local FS + worktree FS glob.
- **Errors:** propagates FS errors (same as the local part of the current method).
  Network errors are irrelevant here (no network).

### 3.2 New: `getLocalExistingIdsForType(type)` (private)
```ts
private async getLocalExistingIdsForType(type: EntityType): Promise<string[]>
```
- **Task** → `getLocalActiveAndCompletedTaskIds()` (cheap local).
- **Draft** → `listDrafts()` (already no fetch; identical to `getExistingIdsForType`).
- **Document** → `listDocuments()` (already no fetch).
- **Decision** → `listDecisions()` (already no fetch).
- For non-Task types, local == full (no behavioral difference).

### 3.3 Refactor: `collectLocalTaskStateEntries(taskPrefix)` (private helper)
```ts
private async collectLocalTaskStateEntries(taskPrefix: string): Promise<BranchTaskStateEntry[]>
```
- Extracted from the body of `getActiveAndCompletedTaskIds` (backlog.ts:1157-1191):
  local active tasks + local completed tasks + worktree FS entries.
- Shared by both `getActiveAndCompletedTaskIds` (full) and
  `getLocalActiveAndCompletedTaskIds` (cheap) to avoid duplication.

### 3.4 Extended: `generateNextId(type, parent?, prefetchedIds?)` (public, back-compat)
```ts
async generateNextId(
  type: EntityType = EntityType.Task,
  parent?: string,
  prefetchedIds?: string[],
): Promise<string>
```
- If `prefetchedIds` is provided (fast path, in-lock): `allIds = prefetchedIds ∪ getLocalExistingIdsForType(type)`.
  The local half is re-read FRESH inside the lock; the prefetched half is the advisory
  remote/branch snapshot.
- If `prefetchedIds` is omitted (legacy/external callers, e.g. CLI direct,
  duplicate-task-repair:239): `allIds = getExistingIdsForType(type)` (full, as today).
- Duplicates in the union are harmless (`generateNextPrefixedId` /
  `generateNextSubtaskId` compute `max`, idempotent under dupes — no dedupe needed).
- **Return:** next ID string (e.g. `"task-43"`). Unchanged.

### 3.5 Callers (prefetch contract)
Each affected lock site acquires `prefetchedTaskIds = await this.getActiveAndCompletedTaskIds()`
BEFORE `withCreateLock(...)`, then passes it as the 3rd arg to `generateNextId`.

---

## 4. Data flow + data models

No new data models. The data flowing through:

1. **Prefetch (outside lock):** `string[]` of ALL existing task IDs (local + remote +
   cross-branch), as today. This is a *snapshot* — may go slightly stale before the
   lock body runs (a remote could add an ID), which is acceptable (see §6.1).
2. **In-lock local re-read (fresh):** `string[]` of LOCAL-only task IDs, re-read at
   lock-acquire time so it reflects any task written by a prior lock holder.
3. **Union** → `generateNextPrefixedId`/`generateNextSubtaskId` → next ID.
4. **Write** under the same lock → file appears on local FS for the next lock holder.

`BranchTaskStateEntry` (existing type) is reused unchanged by `collectLocalTaskStateEntries`.

---

## 5. Error handling + failure modes + recovery

### 5.1 Network error during prefetch (outside lock)
`loadRemoteTasks` (task-loader.ts:541) wraps its body in try/catch; `gitOps.fetch`
(operations.ts:302-307) swallows network errors and returns. So a network failure
during prefetch yields a partial ID set (local + whatever branches indexed) and does
NOT throw. The create proceeds with a possibly-incomplete remote snapshot — identical
to today's behavior (today the same swallowed error happens inside the lock).
**Recovery:** none needed; graceful degradation. Cross-branch duplicates, if any, are
caught later by `duplicate-task-repair`.

### 5.2 Race: remote adds an ID between prefetch and write
Prefetched snapshot is stale → we might allocate an ID a remote branch just took.
**This is NOT a new failure mode:** today's fetch-inside-lock has the identical window
(after `fetch` returns, before `saveTask` writes, a remote can still add an ID; the local
lock does not coordinate with remotes). **Recovery:** `duplicate-task-repair` detects and
renames. Confidence: high.

### 5.3 Race: LOCAL process creates an ID between prefetch and lock
Prefetched snapshot omits the new local ID. **BUT the in-lock local re-read
(`getLocalActiveAndCompletedTaskIds`) is FRESH** → it sees the new ID → computes the
next one. UNIQUE. This is why the in-lock re-validation is mandatory and why we cannot
use the prefetched set alone. Confidence: high.

### 5.4 Lock body error (e.g. `saveTask` fails)
Unchanged: lock is released in the `finally`/catch path of `withCreateLock`
(operations.ts:388-397). The prefetch result is discarded. No resource leak.

### 5.5 `resolveParentTaskIdForCreate` failure (parent not found)
Stays in-lock (backlog.ts:1347). If the parent doesn't exist, it throws → lock released
→ caller gets the error. Prefetch was wasted (one extra fetch) but correctness is
preserved. (Optional micro-opt: resolve parent BEFORE prefetch to avoid a wasted fetch
on bad input — see §9.2. Low priority.)

---

## 6. Trade-offs (ADR)

**Decision:** Split ID collection into prefetch (full, outside lock) + local re-validation
(cheap, inside lock), connected by an optional `prefetchedIds` param on `generateNextId`.

**Alternative A — prefetch ALL sites via a shared wrapper.**
Wrap every `withCreateLock` site in a generic `prefetchThenLock(type, body)` helper.
- Pro: less duplication at call sites.
- Con: Draft/Document/Decision sites don't need prefetch (no fetch); forcing them through
  a helper adds complexity for no benefit. The per-site explicit prefetch is clearer and
  only applied where `entityType === Task`.
- **Chosen: explicit per-site prefetch** (sites 1, 2, 4 only). Simpler, minimal blast radius.

**Alternative B — make `getActiveAndCompletedTaskIds` itself lock-aware (skip fetch if "in lock").**
Use a flag/thread-local to detect "inside lock" and skip the fetch.
- Pro: no call-site changes.
- Con: implicit/global state is fragile (reentrancy, multi-Core instances, tests),
  hard to reason about, violates SRP. The task explicitly asks for explicit prefetch.
- **Rejected.**

**Alternative C — cache the fetch result with a short TTL (e.g. 5s) shared across calls.**
- Pro: under 8 agents, one fetch serves all → fewer network calls.
- Con: introduces shared mutable cache + expiry logic + invalidation; bigger surface,
  more failure modes (stale cache). Out of scope for this P0 (the lock hold is the bug,
  not the fetch frequency). The prefetch-per-call already removes the lock-over-fetch.
- **Deferred** to a follow-up optimization if fetch frequency becomes a bottleneck.

**Consequences (chosen):**
- (+) Lock hold time drops from `fetch + remote index + local scan + write` to
  `local scan + write`. Under 8 agents, no ECREATELOCK from network serialization.
- (+) Public API back-compat preserved (`prefetchedIds` optional).
- (+) Existing race tests pass unchanged (in-lock local re-read is fresh).
- (−) One `getActiveAndCompletedTaskIds` call now happens even if the lock body later
  throws (e.g. parent not found) → a "wasted" fetch on bad input. Mitigated by §9.2
  (resolve parent before prefetch) if it matters.
- (−) Slightly more code (helper + local variant). Acceptable; removes duplication via
  `collectLocalTaskStateEntries`.

---

## 7. Observability / logging strategy

- The fix is internal; no new persistent logging required for correctness.
- **Recommended (optional):** in `generateNextId` fast path, add
  `if (process.env.DEBUG) console.log(\`[id-gen] type=${type} prefetch=${prefetchedIds?.length ?? 0} local-reeval\`);`
  to confirm the fast path is taken and to correlate prefetch size with lock hold time
  during load tests.
- Existing `isCreateLockError`/`ECREATELOCK` logging (server/index.ts:881,1370;
  mcp/tools/tasks/handlers.ts:158,568) is unchanged — it should fire far less often
  once the network is out of the lock.
- No `trace_id` in this layer (the lock/file-system layer has no request context);
  `process.pid` + timestamps on DEBUG logs suffice for correlating concurrent agents
  during the load test in §8.2.

---

## 8. Testing strategy

### 8.1 Unit / existing (must stay green)
`src/test/atomic-task-create.test.ts` — all race tests (create, promote, demote,
milestone) verify LOCAL uniqueness under the lock. Because the in-lock body still does a
fresh local re-read, these pass unchanged.
- AC: `bun test src/test/atomic-task-create.test.ts` → all green, no modifications.

### 8.2 New integration test — "fetch is NOT called while the create-lock is held"
The KEY new test proving the fix. Pattern (mirrors atomic-task-create.test.ts:134):

```
- Two Core instances on a repo WITH a configured remote (or a mock gitOps.fetch).
- Instrument gitOps.fetch to record call timestamps, and wrap withCreateLock to record
  acquire/release timestamps (or record via saveTask-entry + a slow fetch deferred).
- Concurrent createTaskFromInput x2.
- Assert:
  (a) every fetch call timestamp falls OUTSIDE [lock-acquire, lock-release] intervals;
  (b) both creates get distinct IDs (TASK-1, TASK-2);
  (c) with a deliberately slow fetch mock, lock-held duration < fetch duration.
```
- AC: fetch timestamp never overlaps a lock-held interval; unique IDs; lock-held < fetch.

### 8.3 Config-gate test (the "OPEN" path)
With `check_active_branches: true` AND a remote present, 2+ concurrent creates:
no `ECREATELOCK`, unique IDs. (This is the config that is currently OPEN per the task.)
- AC: zero `CreateLockError` thrown; IDs unique.

### 8.4 No-regression test (the "mitigated" path)
With `check_active_branches: false`, concurrent creates behave as before (prefetch is
already cheap; unique IDs).
- AC: behavior identical to pre-fix (unique IDs, no errors).

### 8.5 promoteDraft / promoteDraftWithUpdates race
Extend the existing "two draft promotions race" test (atomic-task-create.test.ts:134) to
also assert fetch is outside the lock for the promotion path (sites 2, 4).
- AC: unique TASK IDs; fetch outside lock intervals.

---

## 9. Risks + open questions

### 9.1 Scope: documents & repair paths share the same bug class (out of stated scope)
Two MORE network-in-lock sites were discovered (same class of bug, NOT in the task's
stated files `createTaskFromInput, generateNextId, getActiveAndCompletedTaskIds`):

- **Site 5 — `createDocumentFromInput` (backlog.ts:2898):** calls
  `generateNextDocId(this)` (id-generators.ts:8) INSIDE the lock, which calls
  `core.gitOps.fetch()` at id-generators.ts:23. **AFFECTED** (documents).
- **Site 6 — `applyDuplicateTaskIdRepair` (duplicate-task-repair.ts:612):** calls
  `previewDuplicateTaskIdRepair` (line 613) INSIDE the lock, which calls
  `loadRemoteTasks` (duplicate-task-repair.ts:130) → `fetch`. **AFFECTED**
  (but this is the manual `backlog doctor` path, low frequency, not a hot 8-agent path).

**Recommendation:** Apply the SAME prefetch pattern to site 5 in the same PR
(`generateNextDocId(core, prefetchedDocIds?)` — prefetch doc IDs outside lock, local
`listDocuments` re-read inside). Site 6 can be a follow-up (doctor is not hot).
**Confidence: high** that sites 5/6 are separable from the task-path fix. **Open
question for the coder:** confirm whether to include site 5 in this task or split it
into a sibling task (TASK-97.5). Architect recommendation: include site 5 (documents
are created by agents too); defer site 6.

### 9.2 `resolveParentTaskIdForCreate` stays in-lock (local git scan, not fetch)
`loadTaskById` (backlog.ts:717) → `findTaskInRemoteBranches` (task-loader.ts:425) uses
`listRecentRemoteBranches` (operations.ts:424) = `for-each-ref` (LOCAL, no network
fetch). So parent resolution is a local git scan, acceptable in-lock. Keeping it in-lock
preserves the "parent must exist at write time" guarantee. **Optional micro-opt** (low
priority): resolve the parent BEFORE the prefetch so a bad `--parent` doesn't waste a
fetch. If done, re-check parent existence is NOT needed in-lock (parent deletion between
prefetch and write is a separate, rare race; current code doesn't guard it either).
**Decision: leave in-lock; do not micro-opt in this P0.**

### 9.3 `demoteTaskWithUpdates` (site 3) confirmed SAFE — no change
`generateNextId(EntityType.Draft)` (backlog.ts:2249) → `getExistingIdsForType(Draft)`
→ `listDrafts()` (backlog.ts:1228). No `getActiveAndCompletedTaskIds`, no fetch. No
change required. The existing demote race test (atomic-task-create.test.ts:176) stays
green.

### 9.4 Prefetch on bad input (title/ordinal validation)
`createTaskFromInput` validates title/ordinal BEFORE the lock (backlog.ts:1280-1326),
so a bad title throws before prefetch. Good — no wasted fetch on empty title. Only a
bad `--parent` (resolved in-lock) or a dependency-validation edge could waste a fetch.
Acceptable for P0.

### 9.5 Multi-worktree correctness
`loadWorktreeTaskStateEntries` (backlog.ts:1090) is local-FS (glob over worktree dirs,
no fetch) and is included in BOTH `collectLocalTaskStateEntries` (prefetch) and the
local variant. Same-repo worktree task IDs are therefore covered by the in-lock fresh
re-read → worktree-local uniqueness preserved. Confidence: high.

---

## 10. Task breakdown (component-level, with acceptance criteria + dependencies)

> One task = one component / closely related files. Ordered by dependency graph.
> Critical path: T1 → T2 → T3 → T4 (T5 parallel; T6 follow-up).

### T1 — Extract `collectLocalTaskStateEntries` helper + add `getLocalActiveAndCompletedTaskIds`
**Files:** `src/core/backlog.ts` (lines ~1152-1211).
**Description:** Extract the local-collection body of `getActiveAndCompletedTaskIds`
(lines 1157-1191: local active tasks + local completed + worktree FS entries) into a
private `collectLocalTaskStateEntries(taskPrefix): Promise<BranchTaskStateEntry[]>`.
Refactor `getActiveAndCompletedTaskIds` to call it (full version, unchanged behavior).
Add `getLocalActiveAndCompletedTaskIds()` that calls the helper but SKIPS the
`checkActiveBranches` block (no `loadRemoteTasks`, no `loadLocalBranchTasks`) →
`buildLatestStateMap` → extract IDs.
**Acceptance criteria:**
- `getActiveAndCompletedTaskIds` returns byte-identical results to before (full path).
- `getLocalActiveAndCompletedTaskIds` returns a SUBSET (local-only) and performs ZERO
  `gitOps.fetch` calls (assertable via a spy on `git.fetch`).
- `loadRemoteTasks`/`loadLocalBranchTasks` are NOT referenced in the local variant.
**Dependencies:** none (foundation).
**Expected behavior change:** none externally (refactor only); enables T2.

### T2 — Add `getLocalExistingIdsForType(type)` + extend `generateNextId` with `prefetchedIds?`
**Files:** `src/core/backlog.ts` (lines ~1068-1082, ~1220-1242).
**Description:** Add `getLocalExistingIdsForType(type)` (Task → local variant; Draft/
Document/Decision delegate to existing `listX` calls). Extend `generateNextId` with an
optional 3rd param `prefetchedIds?: string[]`: when provided, `allIds =
[...prefetchedIds, ...getLocalExistingIdsForType(type)]`; when omitted, behavior is
unchanged (`getExistingIdsForType(type)`).
**Acceptance criteria:**
- `generateNextId(Task)` with NO 3rd arg → unchanged behavior + return value (legacy).
- `generateNextId(Task, parent, prefetched)` → uses union; `gitOps.fetch` NOT called
  (only `getLocalExistingIdsForType`, which is local-only).
- `generateNextId(Draft, ...)` → no fetch in either path.
**Dependencies:** T1.
**Expected behavior change:** none externally (back-compat); enables T3-T5.

### T3 — Move prefetch outside lock in `createTaskFromInput`
**Files:** `src/core/backlog.ts` (lines ~1345-1384).
**Description:** Before `withCreateLock`, compute
`const prefetchedTaskIds = entityType === EntityType.Task ? await this.getActiveAndCompletedTaskIds() : undefined;`
Pass `prefetchedTaskIds` as 3rd arg to `this.generateNextId(...)` inside the lock body.
Leave `resolveParentTaskIdForCreate` in-lock (see §9.2).
**Acceptance criteria:**
- `getActiveAndCompletedTaskIds` (→ `gitOps.fetch`) is invoked BEFORE the lock is
  acquired (assertable: fetch timestamp precedes lock-acquire timestamp).
- Lock body performs NO `gitOps.fetch`.
- Existing `atomic-task-create.test.ts` race tests still pass (unique IDs).
**Dependencies:** T2.
**Tests that should pass:** atomic-task-create.test.ts (unchanged) + new §8.2 test.

### T4 — Move prefetch outside lock in `promoteDraftWithUpdates` + `promoteDraft`
**Files:** `src/core/backlog.ts` (lines ~2202-2224, ~2623-2654).
**Description:** In `promoteDraftWithUpdates` (site 2): add
`const prefetchedTaskIds = await this.getActiveAndCompletedTaskIds();` before
`withCreateLock`; pass to `generateNextId(EntityType.Task, draft.parentTaskId, prefetchedTaskIds)`.
In `promoteDraft` (site 4): prefetch BEFORE the `try { withCreateLock(...) }` block; pass
through. Do NOT touch `demoteTaskWithUpdates` (site 3, Draft — safe, no change).
**Acceptance criteria:**
- Both promotion paths: `gitOps.fetch` occurs outside the lock interval.
- `atomic-task-create.test.ts:134` (promote race) still yields unique TASK-1/TASK-2.
- `demoteTaskWithUpdates` is untouched and its test (line 176) stays green.
**Dependencies:** T2.
**Tests that should pass:** atomic-task-create.test.ts:134 + new §8.5 test.

### T5 — (Parallel) New integration test: fetch outside lock
**Files:** `src/test/atomic-task-create.test.ts` (or a new `create-lock-fetch.test.ts`).
**Description:** Implement §8.2 + §8.3 + §8.4: instrument `gitOps.fetch` timestamps and
lock acquire/release; assert no overlap under 2+ concurrent creates; assert unique IDs;
assert lock-held < fetch duration with a slow-fetch mock; cover both
`check_active_branches: true` (OPEN) and `false` (mitigated) configs.
**Acceptance criteria:**
- Test fails on the PRE-fix code (fetch overlaps lock) — proves it catches the bug.
- Test passes on the POST-fix code (fetch outside lock; unique IDs).
**Dependencies:** T3, T4 (run against the fixed sites). Can be authored in parallel
with T3/T4, executed after.

### T6 — (Follow-up, separate task) Documents + repair paths
**Files:** `src/utils/id-generators.ts` (site 5), `src/core/duplicate-task-repair.ts` (site 6).
**Description:** Apply the same prefetch-outside-lock pattern to `generateNextDocId`
(add `prefetchedDocIds?`; prefetch `gitOps.fetch` + branch doc-ID scan outside the lock
in `createDocumentFromInput`, local `listDocuments` re-read inside). For site 6, run
`previewDuplicateTaskIdRepair` (the expensive scan) outside the lock and re-validate
file sha256 fingerprints inside the lock.
**Acceptance criteria (site 5):** `createDocumentFromInput` does not call `gitOps.fetch`
while holding the lock; unique doc IDs under concurrency.
**Acceptance criteria (site 6):** `applyDuplicateTaskIdRepair` does not fetch inside the
lock; fingerprint re-check still detects concurrent changes.
**Dependencies:** none (independent of T1-T5). **Recommendation:** split into
TASK-97.5 (documents) and a separate doctor task; do NOT block TASK-97.4 on these.
**Confidence: high** they are separable.

---

## Appendix A — Concrete diff sketches (file:line, old → new)

### A.1 backlog.ts — extract helper + local variant (T1)
```diff
@@ backlog.ts ~1152
-	private async getActiveAndCompletedTaskIds(): Promise<string[]> {
-		const config = await this.fs.loadConfig();
-		const taskPrefix = config?.prefixes?.task ?? "task";
-
-		// Load local active and completed tasks
-		const localTasks = await this.listTasksWithMetadata();
-		const localCompletedTasks = await this.fs.listCompletedTasks();
-
-		// Build initial state entries from local tasks
-		const stateEntries: BranchTaskStateEntry[] = [];
-		for (const task of localTasks) { ... }            // 1164-1174
-		for (const task of localCompletedTasks) { ... }    // 1177-1187
-		stateEntries.push(...(await this.loadWorktreeTaskStateEntries(taskPrefix))); // 1191
+	// NEW helper — shared local-collection body (was inline in getActiveAndCompletedTaskIds)
+	private async collectLocalTaskStateEntries(taskPrefix: string): Promise<BranchTaskStateEntry[]> {
+		const localTasks = await this.listTasksWithMetadata();
+		const localCompletedTasks = await this.fs.listCompletedTasks();
+		const stateEntries: BranchTaskStateEntry[] = [];
+		for (const task of localTasks) { ... }            // moved
+		for (const task of localCompletedTasks) { ... }    // moved
+		stateEntries.push(...(await this.loadWorktreeTaskStateEntries(taskPrefix)));
+		return stateEntries;
+	}
+
+	// FULL — pre-fetch, OUTSIDE lock (unchanged behavior)
+	private async getActiveAndCompletedTaskIds(): Promise<string[]> {
+		const config = await this.fs.loadConfig();
+		const taskPrefix = config?.prefixes?.task ?? "task";
+		const stateEntries = await this.collectLocalTaskStateEntries(taskPrefix);
 		if (config?.checkActiveBranches !== false) {       // 1194-1206 unchanged
 			...
 			await Promise.all([loadRemoteTasks(...), loadLocalBranchTasks(...)]); // fetch + branch scan
 			stateEntries.push(...branchStateEntries);
 		}
 		const latestState = buildLatestStateMap(stateEntries, []);
 		return getActiveAndCompletedIdsFromStateMap(latestState);
 	}
+
+	// NEW — cheap, local-FS-only, INSIDE lock (no fetch, no branch scan)
+	private async getLocalActiveAndCompletedTaskIds(): Promise<string[]> {
+		const config = await this.fs.loadConfig();
+		const taskPrefix = config?.prefixes?.task ?? "task";
+		const stateEntries = await this.collectLocalTaskStateEntries(taskPrefix);
+		// NOTE: deliberately NO checkActiveBranches block here.
+		const latestState = buildLatestStateMap(stateEntries, []);
+		return getActiveAndCompletedIdsFromStateMap(latestState);
+	}
```

### A.2 backlog.ts — `getLocalExistingIdsForType` + `generateNextId` param (T2)
```diff
@@ backlog.ts ~1068
-	async generateNextId(type: EntityType = EntityType.Task, parent?: string): Promise<string> {
-		const config = await this.fs.loadConfig();
-		const prefix = getPrefixForType(type, config ?? undefined);
-		const allIds = await this.getExistingIdsForType(type);
+	async generateNextId(
+		type: EntityType = EntityType.Task,
+		parent?: string,
+		prefetchedIds?: string[],
+	): Promise<string> {
+		const config = await this.fs.loadConfig();
+		const prefix = getPrefixForType(type, config ?? undefined);
+		const allIds = prefetchedIds
+			? [...prefetchedIds, ...(await this.getLocalExistingIdsForType(type))]
+			: await this.getExistingIdsForType(type);
 		if (parent) { ... return generateNextSubtaskId(allIds, ...); }
 		return generateNextPrefixedId(allIds, prefix, config?.zeroPaddedIds);
 	}

+	private async getLocalExistingIdsForType(type: EntityType): Promise<string[]> {
+		switch (type) {
+			case EntityType.Task: return this.getLocalActiveAndCompletedTaskIds();
+			case EntityType.Draft: { const drafts = await this.fs.listDrafts(); return drafts.map((d) => d.id); }
+			case EntityType.Document: { const documents = await this.fs.listDocuments(); return documents.map((d) => d.id); }
+			case EntityType.Decision: { const decisions = await this.fs.listDecisions(); return decisions.map((d) => d.id); }
+			default: return [];
+		}
+	}
```

### A.3 backlog.ts — `createTaskFromInput` prefetch (T3)
```diff
@@ backlog.ts ~1343
 	const resolvedStatus = isDraft ? "Draft" : status || config?.defaultStatus || FALLBACK_STATUS;
+	// TASK-97.4: prefetch existing IDs (incl. git fetch) OUTSIDE the create-lock so the
+	// lock body stays local-FS-only. Drafts/Docs/Decisions have no fetch → skip prefetch.
+	const prefetchedTaskIds = entityType === EntityType.Task
+		? await this.getActiveAndCompletedTaskIds()
+		: undefined;

 	const { task, filePath } = await this.withCreateLock(async () => {
 		const parentTaskId = requestedParentTaskId
 			? await this.resolveParentTaskIdForCreate(requestedParentTaskId)
 			: undefined;
-		const id = await this.generateNextId(entityType, isDraft ? undefined : parentTaskId);
+		const id = await this.generateNextId(entityType, isDraft ? undefined : parentTaskId, prefetchedTaskIds);
 		const ordinal = await this.resolveCreateOrdinal(input.ordinal, isDraft);
 		...
 	});
```

### A.4 backlog.ts — `promoteDraftWithUpdates` prefetch (T4, site 2)
```diff
@@ backlog.ts ~2200
 	const canonicalStatus = await this.requireCanonicalStatus(targetStatus);
+	const prefetchedTaskIds = await this.getActiveAndCompletedTaskIds();
 	const { promotedTask, savedPath } = await this.withCreateLock(async () => {
-		const newTaskId = await this.generateNextId(EntityType.Task, draft.parentTaskId);
+		const newTaskId = await this.generateNextId(EntityType.Task, draft.parentTaskId, prefetchedTaskIds);
 		...
 	});
```

### A.5 backlog.ts — `promoteDraft` prefetch (T4, site 4)
```diff
@@ backlog.ts ~2623
 	async promoteDraft(draftId: string, autoCommit?: boolean): Promise<boolean> {
 		let success = false;
+		const prefetchedTaskIds = await this.getActiveAndCompletedTaskIds();
 		try {
 			success = await this.withCreateLock(async () => {
 				...
-				const newTaskId = await this.generateNextId(EntityType.Task, draft.parentTaskId);
+				const newTaskId = await this.generateNextId(EntityType.Task, draft.parentTaskId, prefetchedTaskIds);
 				...
 			});
```

### A.6 (NO CHANGE) `demoteTaskWithUpdates` (site 3) — confirmed safe
`generateNextId(EntityType.Draft)` (backlog.ts:2249) → `listDrafts()`, no fetch. Unchanged.

### A.7 (FOLLOW-UP T6) `createDocumentFromInput` (site 5) — same pattern
```diff
@@ backlog.ts ~2897
 	const type = normalizeDocumentTypeInput(input.type) ?? "other";
+	// TASK-97.4 (site 5, follow-up): prefetch doc IDs OUTSIDE lock
+	const prefetchedDocIds = await this.prefetchDocumentIds(); // new helper wrapping id-generators fetch
 	const document = await this.withCreateLock(async () => {
-		const id = normalizeDocumentId(await generateNextDocId(this));
+		const id = normalizeDocumentId(await generateNextDocId(this, prefetchedDocIds));
 		...
 	});
```
Requires `generateNextDocId(core, prefetchedDocIds?)` extension in `src/utils/id-generators.ts`.
