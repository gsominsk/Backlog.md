---
id: TASK-97.1-lock-stability-design
title: "TASK-97.1 Lock Stability — Design Document"
---

# TASK-97.1: Lock Stability Design — Raise Stale 10s→60s + Pass onCompromised Handler

**Status:** Design Complete
**Task:** TASK-97.1 (P0, parent TASK-97)
**Milestone:** MCP Stability
**Effort:** ~45 min
**Confidence:** High

## 1. Problem Statement + Goals + Non-Goals

### Problem
Under 8 concurrent MCP agents the single-process event loop can block longer
than the current lock stale threshold (10s). When that happens:

1. proper-lockfile considers the held lock **stale** and lets another process
   steal it → two processes in the critical section → **ID collision**.
2. If the lock's mtime update fails while it is held, proper-lockfile calls the
   default `onCompromised` handler which is `(err) => { throw err; }`. This throw
   fires from inside a `setTimeout` callback (updateLock) → becomes an
   **uncaughtException** → crashes the MCP server (no handler registered) → all
   8 agents lose their server simultaneously.

### Goals
- **G1:** Raise stale threshold from 10s to 60s so event-loop blocking under
  load does not cause premature lock theft.
- **G2:** Pass an `onCompromised` handler that **logs, does not throw**, so a
  lock-compromise event is observable without crashing the process.
- **G3:** Register `process.once("uncaughtException")` as a defense-in-depth
  safety net for any unexpected throw (including from libraries) so the crash
  is logged rather than silent.

### Non-Goals
- Moving `git fetch` outside the lock (that is TASK-97.4, path 4).
- Adding abort-on-compromise logic (a flag checked inside `fn()`) — out of
  scope for this P0; documented as a follow-up risk.
- Raising the lock timeout (stays 30s — see §8 ADR).
- `unhandledRejection` handler — not in scope (only `uncaughtException`).

## 2. System Architecture (Components + Relationships)

Three layers are affected:

```
┌─────────────────────────────────────────────────────┐
│  src/commands/mcp.ts  (CLI entry, process handlers)  │
│  - Signal handlers: SIGINT/SIGTERM/SIGHUP/SIGPIPE    │
│  - NEW: process.once("uncaughtException")  [Fix C]  │
│  - Calls createMcpServer() then server.connect()     │
└──────────────────────┬──────────────────────────────┘
                       │ creates
┌──────────────────────▼──────────────────────────────┐
│  src/mcp/server.ts  (McpServer class)                │
│  - No process-level handlers (unchanged)             │
└──────────────────────┬──────────────────────────────┘
                       │ uses
┌──────────────────────▼──────────────────────────────┐
│  src/file-system/operations.ts  (FileSystem class)    │
│  - withCreateLock  ← stale constant + onCompromised  │
│  - withWriteLock   ← stale constant + onCompromised  │
│  - Calls lockfile.lock() from proper-lockfile         │
└──────────────────────┬──────────────────────────────┘
                       │ typed by
┌──────────────────────▼──────────────────────────────┐
│  src/types/proper-lockfile.d.ts  (LockOptions)        │
│  - NEW: onCompromised?: (err: Error) => void          │
└───────────────────────────────────────────────────────┘
```

**Key relationship:** `onCompromised` is called by proper-lockfile from inside
a `setTimeout` callback (updateLock → fs.stat/fs.utimes callback →
setLockAsCompromised → onCompromised). A throw there = uncaughtException. Fix B
prevents the throw; Fix C catches it if it still happens from elsewhere.

## 3. Interfaces / APIs (Contracts)

### 3.1 LockOptions type (proper-lockfile.d.ts)

```ts
interface LockOptions {
    stale?: number;
    update?: number | null;
    realpath?: boolean;
    retries?: number | RetryOptions;
    lockfilePath?: string;
    onCompromised?: (err: Error) => void;  // NEW
}
```

The `onCompromised` callback contract (from proper-lockfile/lib/lockfile.js:200):
- **Called when:** the lock's mtime could not be refreshed within the stale
  threshold, or the lock file was deleted/modified by another process.
- **Called from:** inside a `setTimeout` callback (updateLock).
- **Error passed:** an `Error` with `code: 'ECOMPROMISED'`.
- **Default (if not passed):** `(err) => { throw err; }` → uncaughtException.
- **After call:** the lock is marked `released = true` and removed from the
  internal `locks` map; the subsequent `release()` call will fail with
  `ERELEASED` (caught by existing try/catch).

### 3.2 Constants contract (operations.ts)

| Constant | Current | New | Rationale |
|---|---|---|---|
| `DEFAULT_CREATE_LOCK_STALE_MS` | 10_000 | **60_000** | Headroom for event-loop blocking |
| `DEFAULT_WRITE_LOCK_STALE_MS` | 10_000 | **60_000** | Same rationale |
| `DEFAULT_CREATE_LOCK_TIMEOUT_MS` | 30_000 | 30_000 (unchanged) | timeout < stale is safe (§8) |
| `DEFAULT_WRITE_LOCK_TIMEOUT_MS` | 30_000 | 30_000 (unchanged) | Same |
| `DEFAULT_CREATE_LOCK_RETRY_DELAY_MS` | 100 | 100 (unchanged) | Auto-adjusts via retries formula |
| `DEFAULT_WRITE_LOCK_RETRY_DELAY_MS` | 50 | 50 (unchanged) | Same |

### 3.3 uncaughtException handler contract (mcp.ts)

- **Triggered by:** any uncaught throw (e.g., from setTimeout callbacks, library
  internals, or a bug).
- **Action:** `console.error("[uncaught-exception] ...")` then `process.exit(1)`.
- **Does NOT** call `server.stop()` — the process is in an undefined state;
  graceful shutdown may hang.

## 4. Data Flow + Data Models

### 4.1 Lock acquisition + mtime update flow (with stale=60s)

```
withCreateLock/withWriteLock called
  │
  ├─ staleMs = max(options.staleMs ?? 60_000, 2_000)  // floor 2s
  ├─ retries = ceil(timeoutMs / retryDelayMs) - 1     // 30s/100ms = 299 retries
  │
  └─ lockfile.lock(file, {
       stale: 60_000,           // lock stale after 60s of no mtime update
       onCompromised: (err) => {
         console.error("[lock-compromised] ...", err);  // LOG, no throw
       },
       retries: { ... },
     })
       │
       ├─ [acquire] mkdir lockfile → probe mtime → store lock
       │
       ├─ [update] setTimeout every stale/2 = 30s:
       │    stat lockfile → is mtime ours?
       │      YES → utimes (refresh mtime) → schedule next update
       │      NO  → setLockAsCompromised → onCompromised(LOG)
       │    (timer is unref'd — does not keep process alive)
       │
       └─ [release] rmdir lockfile → clear update timer
```

### 4.2 What happens when event loop blocks >60s (failure path)

```
t=0s    Process A acquires lock, fn() runs
t=0-60s Event loop blocked (heavy sync work under 8 agents)
        → update timer (set for t=30s) does NOT fire
t=60s   Lock is now stale (mtime < now - 60s)
        Process B (or A's retry) detects stale → removes lock → acquires
        A's lock → setLockAsCompromised called → onCompromised(LOG, no throw)
        A's fn() continues (it was blocked, now resumes)
        A's release() → ERELEASED (caught by existing try/catch)
```

With the **old** stale=10s, this happened at t=10s — much more likely under
load. With stale=60s, the event loop must block for a full 60s, which is
extremely unlikely (process would be essentially frozen).

## 5. Error Handling + Failure Modes + Recovery

| Failure mode | Detection | Recovery | Post-fix behavior |
|---|---|---|---|
| Event loop blocks 10-60s | Lock not yet stale | None needed | Lock survives (was: stolen at 10s → collision) |
| Event loop blocks >60s | onCompromised fires | LOG + continue | A's release() fails with ERELEASED (caught); B holds lock; collision risk remains but event is logged |
| onCompromised throw (if default) | uncaughtException | **NEW handler**: log + exit(1) | With Fix B, onCompromised does NOT throw; handler is safety net for other throws |
| Lock file deleted by external process | onCompromised (ENOENT) | LOG + continue | Same as above |
| Release fails (ERELEASED) | Existing try/catch | Silently swallowed | Unchanged (lines 380-383, 452-456) |

### Recovery for onCompromised (Fix B)
- **No abort of fn():** the callback `fn()` is not interrupted. It may complete
  and return a result. The result may be inconsistent if another process wrote
  concurrently.
- **Acceptance:** with stale=60s, onCompromised is extremely rare. The log
  provides observability. Full abort-on-compromise is a documented follow-up
  (§9 Risks).

## 6. Observability / Logging Strategy

### 6.1 onCompromised log (Fix B)
```ts
onCompromised: (err) => {
    console.error(`[lock-compromised] create-lock ${lockTarget.targetPath}`, err);
}
// write-lock variant:
onCompromised: (err) => {
    console.error(`[lock-compromised] write-lock ${targetPath}`, err);
}
```
- Written to stderr (visible in MCP debug mode, `--debug`).
- Includes: lock type (create/write), target path, the ECOMPROMISED error.
- Does NOT use the MCP `server.sendLoggingMessage()` channel (the handler runs
  from a setTimeout outside the request lifecycle — no `extra` context).

### 6.2 uncaughtException log (Fix C)
```ts
console.error("[uncaught-exception] MCP server exiting:", error);
```
- Last-resort log before `process.exit(1)`.
- Includes the full error object (stack trace).

### 6.3 Existing observability (unchanged)
- `DEBUG` env var → `console.error` in listTasks/listCompletedTasks parse errors.
- `options.debug` in mcp.ts → `console.error` for server lifecycle events.
- MCP `sendLoggingMessage` in server.ts `log()` method (request-scoped only).

## 7. Testing Strategy

### 7.1 Unit / existing tests (must not break)
- **`src/test/atomic-task-create.test.ts:258-282`**: "returns a user-facing
  error when the create lock times out" — passes explicit `staleMs: 5_000`.
  Changing the default from 10_000 to 60_000 does **not** affect this test
  (explicit value overrides default). **Expected: still passes.**

### 7.2 New tests to add (recommended for coder)
1. **onCompromised is passed (not default):** verify that the lock options
   object passed to `lockfile.lock()` includes `onCompromised` as a function.
   This can be a spy/mock test on `lockfile.lock`.
2. **onCompromised does not throw:** simulate a compromised lock and verify the
   process does not crash (the handler logs to stderr).
3. **uncaughtException handler exits:** verify `process.once("uncaughtException")`
   is registered and calls `process.exit(1)`. (Integration-level; may need
   process spawn to test fully.)

### 7.3 Manual / integration
- Run 8 concurrent agents creating tasks; verify no ID collisions and no
  silent crashes in logs.
- Search logs for `[lock-compromised]` — should not appear under normal load.

## 8. Trade-offs (ADR)

### ADR-1: stale 10s → 60s
**Decision:** Raise stale threshold to 60s.
**Alternatives:**
1. 30s (compromise) — still risky under heavy load (event loop can block >30s
   with 8 agents doing sync file I/O).
2. 120s (conservative) — longer stale means a truly-dead process holds the lock
   longer, blocking other agents for up to 2 minutes before recovery.
**Consequences (+):** Eliminates premature lock theft under normal-to-heavy load.
**Consequences (−):** If a process truly hangs (deadlock, not just slow), other
agents wait up to 60s before the lock is recovered. Acceptable: a deadlocked
process is a rare, severe event; 60s recovery is better than data corruption.

### ADR-2: timeout stays 30s (< stale=60s)
**Decision:** Do NOT raise `DEFAULT_*_LOCK_TIMEOUT_MS` (stays 30s).
**Rationale:** timeout < stale is the correct safety relationship:
- A waiter gives up gracefully (ELOCKED → "try again") at 30s, **before** the
  dangerous stale-steal kicks in at 60s.
- If timeout > stale, stale-steal would happen silently within a normal wait —
  two processes briefly in the critical section with no user-visible signal.
- With timeout=30s < stale=60s, stale-steal only happens on a **retry** (user is
  aware something is wrong).
**Alternatives:**
1. Raise timeout to 90s (> stale) — reduces "try again" errors but enables
  silent stale-steal. Rejected (safety > convenience).
2. Raise timeout to 60s (= stale) — borderline; retry timing would race with
  stale-steal unpredictably. Rejected.
**Consequences (+):** Stale-steal is always user-visible (requires retry).
**Consequences (−):** Legitimate long operations (>30s) inside a lock cause
"try again" errors. **Mitigated by TASK-97.4** (move git fetch outside lock).

### ADR-3: onCompromised logs, does not throw or abort
**Decision:** `onCompromised: (err) => console.error(...)`.
**Alternatives:**
1. Throw + rely on uncaughtException handler (Fix C) to log + exit(1) —
   fail-fast, no corruption risk, but crashes all 8 agents. Rejected for P0:
   too aggressive for a rare, potentially recoverable event.
2. Set a flag + abort fn() — most robust (prevents fn() from writing after
   compromise). Rejected for P0: requires changing the fn() contract /
   closure plumbing; out of scope for a 45-min fix.
**Consequences (+):** No crash from lock-compromise; observable via logs.
**Consequences (−):** fn() continues after compromise → potential ID collision.
**Mitigation:** stale=60s makes onCompromised extremely rare; the log enables
post-incident investigation. Follow-up (flag + abort) tracked in §9.

### ADR-4: uncaughtException in mcp.ts, not server.ts
**Decision:** Add `process.once("uncaughtException")` in `src/commands/mcp.ts`
alongside existing signal handlers (after SIGPIPE, before async init).
**Rationale:**
- All process-level handlers (SIGINT/SIGTERM/SIGHUP/SIGPIPE/stdio-close) are
  already in mcp.ts, installed BEFORE async init (line 67-90).
- Installing uncaughtException there follows the same pattern and catches
  errors during `createMcpServer()` / `server.connect()` too.
- server.ts `createMcpServer` is called AFTER signal handlers — putting the
  handler there would miss errors during early init.
**Alternatives:**
1. server.ts `createMcpServer` — available for programmatic server creation,
   but installed too late (after signal handlers) and misses init errors.
**Consequences (+):** Catches uncaughtExceptions from the earliest point.
**Consequences (−):** Programmatic (non-CLI) server creation won't have the
handler. Acceptable: the CLI is the only production entry point.
**Note:** The task description listed server.ts; this design recommends mcp.ts
instead with the above justification.

## 9. Risks + Open Questions

### Risks
1. **fn() continues after compromise (MEDIUM):** onCompromised logs but does not
   abort fn(). If the event loop was blocked >60s and another process stole the
   lock, both may write → ID collision. Mitigated by stale=60s (rare event) and
   logging. **Follow-up:** add a compromised flag checked by fn() (TASK-97.x).
2. **Bun uncaughtException behavior (LOW):** The project runs on Bun. Bun
   supports `process.on("uncaughtException")`, but edge cases in setTimeout
   callback throws may differ from Node.js. **Mitigation:** Fix B prevents the
   throw from onCompromised; the handler is a safety net. Verify in integration
   test.
3. **update interval = 30s (LOW):** With stale=60s, proper-lockfile refreshes
   mtime every 30s (stale/2). Under 8 agents × multiple locks, this is ~16
   stat+utimes calls per 30s — negligible I/O. No concern.
4. **No `unhandledRejection` handler (LOW):** Only `uncaughtException` is added.
   Unhandled promise rejections could still crash silently (Bun default:
   print + exit). Out of scope for this P0.

### Open Questions
- None blocking. All design decisions are resolved with stated confidence.

## 10. Task Breakdown (Component-Level)

All changes are in a single implementation task (TASK-97.1) since they are
tightly coupled and small. Ordered by logical dependency:

### Sub-task 1: Fix A — Raise stale constants (operations.ts)
**Files:** `src/file-system/operations.ts`
**Changes:**
```
Line 59:
-    const DEFAULT_CREATE_LOCK_STALE_MS = 10_000;
+    const DEFAULT_CREATE_LOCK_STALE_MS = 60_000;

Line 64:
-    const DEFAULT_WRITE_LOCK_STALE_MS = 10_000;
+    const DEFAULT_WRITE_LOCK_STALE_MS = 60_000;
```
**Acceptance criteria:**
- `DEFAULT_CREATE_LOCK_STALE_MS === 60_000`
- `DEFAULT_WRITE_LOCK_STALE_MS === 60_000`
- `DEFAULT_CREATE_LOCK_TIMEOUT_MS` and `DEFAULT_WRITE_LOCK_TIMEOUT_MS` remain 30_000.
- `DEFAULT_CREATE_LOCK_RETRY_DELAY_MS` and `DEFAULT_WRITE_LOCK_RETRY_DELAY_MS` unchanged.
- Existing test `atomic-task-create.test.ts` still passes (uses explicit staleMs).
**Dependencies:** None.
**Expected behavior:** Locks survive event-loop blocking up to 60s without being stolen.

### Sub-task 2: Fix B1 — Add onCompromised to LockOptions type
**Files:** `src/types/proper-lockfile.d.ts`
**Changes:**
```
Lines 10-16:
     interface LockOptions {
         stale?: number;
         update?: number | null;
         realpath?: boolean;
         retries?: number | RetryOptions;
         lockfilePath?: string;
+        onCompromised?: (err: Error) => void;
     }
```
**Acceptance criteria:**
- `LockOptions` interface includes `onCompromised?: (err: Error) => void;`.
- TypeScript compiles without errors when `onCompromised` is used in `lockfile.lock()`.
**Dependencies:** None (must precede Sub-task 3 for TypeScript to compile).
**Expected behavior:** TypeScript accepts `onCompromised` in lock options.

### Sub-task 3: Fix B2 — Pass onCompromised in lock calls
**Files:** `src/file-system/operations.ts`
**Changes:**

withCreateLock (lines 361-372):
```
             release = await lockfile.lock(lockTarget.targetPath, {
                 lockfilePath: lockDir,
                 realpath: true,
                 stale: staleMs,
+                onCompromised: (err) => {
+                    console.error(`[lock-compromised] create-lock ${lockTarget.targetPath}`, err);
+                },
                 retries: {
                     retries,
                     factor: 1,
                     minTimeout: retryDelayMs,
                     maxTimeout: retryDelayMs,
                     randomize: false,
                 },
             });
```

withWriteLock (lines 434-438):
```
                 release = await lockfile.lock(targetPath, {
                     lockfilePath: lockFile,
                     realpath: false, // HYBRID-BOARD: file may not exist yet on first create
                     stale: staleMs,
+                    onCompromised: (err) => {
+                        console.error(`[lock-compromised] write-lock ${targetPath}`, err);
+                    },
                     retries: { retries, factor: 1, minTimeout: retryDelayMs, maxTimeout: retryDelayMs, randomize: false },
                 });
```
**Acceptance criteria:**
- Both `lockfile.lock()` calls pass `onCompromised` as a function that calls `console.error` and does NOT throw.
- The create-lock variant logs `lockTarget.targetPath`; the write-lock variant logs `targetPath`.
- TypeScript compiles (depends on Sub-task 2).
- No `throw` statement inside either `onCompromised` handler.
**Dependencies:** Sub-task 2 (type declaration must include onCompromised).
**Expected behavior:** A lock-compromise event logs to stderr instead of throwing → no uncaughtException from this path.

### Sub-task 4: Fix C — Add uncaughtException handler
**Files:** `src/commands/mcp.ts`
**Changes:** Insert after line 90 (SIGPIPE handler), before line 92 (async init comment):
```
+            // Safety net for uncaught exceptions (e.g., a throw from a setTimeout
+            // callback in proper-lockfile's updateLock, or any other unexpected error).
+            // The process is in an undefined state — log and exit immediately. Do NOT
+            // attempt graceful shutdown (server.stop() may hang). This complements the
+            // signal handlers above and prevents silent crashes.
+            process.once("uncaughtException", (error) => {
+                console.error("[uncaught-exception] MCP server exiting:", error);
+                process.exit(1);
+            });
```
**Acceptance criteria:**
- `process.once("uncaughtException", ...)` is registered BEFORE `createMcpServer()` is called (i.e., before the async init block).
- The handler calls `console.error` with the error and then `process.exit(1)`.
- The handler does NOT call `server.stop()` or the `shutdown` function.
- No conflict with existing signal handlers (SIGINT/SIGTERM/SIGHUP/SIGPIPE) — different event type.
- Uses `process.once` (one-shot, consistent with other signal handlers).
**Dependencies:** None.
**Expected behavior:** Any uncaught exception causes a logged exit(1) instead of a silent crash.

### Critical Path
Sub-task 2 → Sub-task 3 (type must exist before lock calls compile).
Sub-tasks 1 and 4 are independent.

### Recommended Application Order
1. Sub-task 1 (stale constants) — trivial, no dependencies.
2. Sub-task 2 (type declaration) — must precede sub-task 3.
3. Sub-task 3 (onCompromised handlers) — depends on sub-task 2.
4. Sub-task 4 (uncaughtException) — independent, can be done any time.

All four sub-tasks can be implemented in a single pass (different files / sections), then verified with `tsc --noEmit` and existing tests.

## 11. Summary of All Files Changed

| # | File | Sub-tasks | Lines affected |
|---|------|-----------|----------------|
| 1 | `src/file-system/operations.ts` | 1, 3 | 59, 64, 361-372, 434-438 |
| 2 | `src/types/proper-lockfile.d.ts` | 2 | 10-16 (add 1 field) |
| 3 | `src/commands/mcp.ts` | 4 | Insert after line 90 |

**Note:** The task description mentioned `src/mcp/server.ts` for the uncaughtException handler, but this design recommends `src/commands/mcp.ts` instead (see ADR-4 in §8).
