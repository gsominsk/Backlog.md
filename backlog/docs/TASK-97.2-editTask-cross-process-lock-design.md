# TASK-97.2 — editTask cross-process lock (design)

**Status:** Proposed
**Parent:** TASK-97 (Board multiplexing gap analysis)
**Milestone:** MCP Stability
**Priority:** P0
**Effort:** ~2h
**Depends on:** none (pattern already proven by Test 9)

> Спроектировано на основе реального кода в `/Users/sominskijgeorgij/ZCodeProject/backlog-fork/`.
> Все `file:line` — абсолютные ссылки на этот репозиторий.

---

## 1. Problem statement, goals, non-goals

### Problem
`task_edit` — самая частая операция агента — НЕ защищена cross-process lock.
Call chain выполняет read-modify-write БЕЗ единого cross-process lock:

```
editTask handler (handlers.ts:581)
  → editTaskOrDraft      (backlog.ts:2214)
  → updateTaskFromInput  (backlog.ts:2154)
  → updateTask           (backlog.ts:1485)
  → saveTask             (operations.ts:541)   ← только in-process withMutex
```

`saveTask` (operations.ts:541-557) использует `withMutex(filepath)` — сериализует
async-интерливинг внутри одного Bun-процесса, но НЕ между процессами. Два MCP
server instance, редактирующих одну задачу → last write wins, первая правка
теряется молча (no error, no log).

Дополнительно: `updateTaskFromInput` (backlog.ts:2155) читает через
`this.fs.loadTask(taskId)`, который использует `Bun.file(filepath).text()`
(operations.ts:598) — Bun.file кэширует контент, поэтому даже повторное чтение
внутри того же процесса может вернуть устаревший снимок после `atomicWrite`
(rename). Эталонный паттерн (claim/release) обходит это через `readTaskFresh`
(operations.ts:564 — `readFile`, bypass cache).

### Goals
1. Обернуть read-modify-write для `editTask` (plain task update) в
   `withWriteLock(taskPath)` — cross-process lock (mkdir-based, NFS-safe,
   stale-recoverable, уже реализован в operations.ts:412).
2. Внутри lock: `readTaskFresh` (НЕ `loadTask`), затем `saveTaskUnlocked`
   (НЕ `saveTask` — избегаем избыточного in-process mutex).
3. Git commit, contentStore upsert, status-change callback — ВНЕ lock
   (I/O-heavy / side-effecting, не должны удлинять критическую секцию).
4. Сохранить существующее поведение draft / demote / promote веток (они уже
   защищены `withCreateLock` либо out-of-scope).
5. CLI-путь (`editTaskOrDraft`) оставить без изменений — cross-process lock
   нужен только MCP (несколько server instance).

### Non-goals
- НЕ защищать draft-update (`updateDraftFromInput` → `updateDraft` →
  `saveDraft`). Drafts эфемерны, хранятся в `draftsDir` (другая директория),
  cross-process data-loss для drafts out of scope P0.
- НЕ защищать demote (`demoteTaskWithUpdates`) — он уже использует
  `withCreateLock` (backlog.ts:2303); additional locking создаст lock-order
  hazard (см. §8).
- НЕ защищать promote (`promoteDraftWithUpdates`) — уже под `withCreateLock`
  (backlog.ts:2257).
- НЕ мигрировать claim/release/renew на стабильный per-ID lock key (см. §9,
  open question — отдельный spike).
- НЕ выносить activity-log write из `applyTaskUpdateInput` (см. §8, ADR-2 —
  принятый компромисс).

---

## 2. System architecture (components + relationships)

Изменение затрагивает 2 файла, 3 компонента:

```
┌─ MCP layer ─────────────────────────────────────────────┐
│ TaskHandlers.editTask (handlers.ts:581)                 │  ← Component A
│   branching: draft / demote / plain-task-update          │
│   delegates to Core.editTaskLocked (NEW)                 │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ Core layer (backlog.ts) ───────────────────────────────┐
│ Core.editTaskLocked (NEW)            ← Component B       │
│   loadDraft? → editTaskOrDraft (existing)                │
│   status=draft? → editTaskOrDraft (existing, demote)     │
│   else → getTaskPath + updateTaskFromInputLocked         │
│                                                          │
│ Core.updateTaskFromInputLocked (NEW) ← Component C       │
│   withWriteLock(taskPath):                               │
│     readTaskFresh → applyTaskUpdateInput → saveTaskUnlocked │
│   outside lock: contentStore / git / statusCallback       │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼ (reuses, no changes)
┌─ File-system layer (operations.ts) ─────────────────────┐
│ withWriteLock      (operations.ts:412) — cross-proc lock │
│ readTaskFresh      (operations.ts:564) — bypass Bun cache│
│ saveTaskUnlocked   (operations.ts:474) — no mutex        │
│ saveTask           (operations.ts:541) — in-proc only    │ ← NOT used in locked path
│ getTaskPath        (task-path.ts:86)  — resolve .md path │
└──────────────────────────────────────────────────────────┘
```

Эталонный паттерн уже применяется в:
- `claimTask` handler (handlers.ts:663-700): resolve path → withWriteLock → readTaskFresh → saveTaskUnlocked.
- `releaseTask` handler (handlers.ts:780-822): тот же паттерн.
- `renewClaimIfHeld` (server.ts:456-472): тот же паттерн.

TASK-97.2 применяет тот же паттерн к `editTask`, но с дополнительной
сложностью: `applyTaskUpdateInput` (богатая мутация полей) вместо простого
spread-обновления claim, и post-save side effects (git/contentStore/callback),
которые надо вынести за пределы lock.

---

## 3. Interfaces / APIs

### 3.1 Component A — `TaskHandlers.editTask` (handlers.ts:581)

**Контракт (без изменений по сигнатуре):**
```ts
async editTask(args: TaskEditRequest): Promise<CallToolResult>
```
Возвращает `formatTaskCallResult(updatedTask)`. Бросает `BacklogToolError` с
кодом `OPERATION_FAILED` (существующий catch, handlers.ts:594-599).

**Изменение:** вместо `this.core.editTaskOrDraft(args.id, updateInput)` вызывает
`this.core.editTaskLocked(args.id, updateInput)`. Вся логика branching и lock
инкапсулирована в Core.

### 3.2 Component B — `Core.editTaskLocked` (NEW, backlog.ts)

**Сигнатура:**
```ts
async editTaskLocked(taskId: string, input: TaskUpdateInput, autoCommit?: boolean): Promise<Task>
```

**Контракт:**
- Вход: `taskId` (raw, может быть numeric или с prefix), `input` (TaskUpdateInput
  уже с resolved milestone — handler резолвит ДО вызова), `autoCommit`
  (undefined для MCP → `shouldAutoCommit` решает по config).
- Выход: обновлённая `Task` (с актуальным `filePath` после возможного rename).
- Ошибки:
  - `Task not found: <taskId>` — если `getTaskPath` вернул null И нет draft.
  - `Task not found: <taskId>` — если внутри lock `readTaskFresh` вернул null
    (другой процесс удалил/переместил файл между resolve и взятием lock).
  - Ошибки валидации из `applyTaskUpdateInput` (invalid status, missing
    dependency, missing acceptance criterion index, empty title и т.д.) —
    пробрасываются как `Error`.
- Ветки:
  1. `loadDraft(taskId)` → draft найден → `editTaskOrDraft` (existing, без
     write-lock: promote=withCreateLock, update-draft=existing).
  2. `input.status?.trim().toLowerCase() === "draft"` → demote →
     `editTaskOrDraft` (existing, без write-lock: demote=withCreateLock).
  3. Иначе → plain task update → `getTaskPath` + `updateTaskFromInputLocked`.

### 3.3 Component C — `Core.updateTaskFromInputLocked` (NEW, backlog.ts)

**Сигнатура:**
```ts
async updateTaskFromInputLocked(
  taskPath: string,
  taskId: string,
  input: TaskUpdateInput,
  autoCommit?: boolean,
): Promise<Task>
```

**Контракт:**
- Вход: `taskPath` (абсолютный путь к .md, уже зарезолвленный ДО lock),
  `taskId`, `input`, `autoCommit`.
- Поведение: one cross-process locked read-modify-write cycle.
- Выход: обновлённая `Task` (с `filePath` = путь после save, может отличаться
  от `taskPath` если изменился title → rename).
- Ошибки:
  - `Task not found: <taskId>` — `readTaskFresh` вернул null внутри lock.
  - `WriteLockError` (code `WRITE_LOCK_ERROR_CODE`, operations.ts:451) —
    таймаут cross-process lock (DEFAULT_WRITE_LOCK_TIMEOUT_MS). Пробрасывается.
  - Ошибки валидации из `applyTaskUpdateInput`.
- Гарантии:
  - Если `mutated === false` (no-op input) — НЕТ save, НЕТ side effects,
    возвращается неизменённая task (как `updateTaskFromInput`, backlog.ts:2169-2171).
  - Side effects (contentStore, git commit, status callback) — ТОЛЬКО при
    `saved === true` и ТОЛЬКО вне lock.

---

## 4. Data flow + data models

### 4.1 Текущий flow (БЕЗ cross-process lock) — для справки

```
handler.editTask (handlers.ts:581)
  buildTaskUpdateInput(args)                       → TaskUpdateInput
  resolveMilestoneInput (handlers.ts:590)          → milestone resolved
  core.editTaskOrDraft (backlog.ts:2214)
    fs.loadDraft(taskId)                           → draft? (Bun.file cache)
    [draft branch → promote/update-draft]
    [task branch]
      fs.loadTask(taskId)                          → Task (STALE: Bun.file cache)
      [demote? → demoteTaskWithUpdates → withCreateLock]
      updateTaskFromInput (backlog.ts:2154)
        applyTaskUpdateInput(task, input, resolver) → {task, mutated} (in-place mutate)
        updateTask(task, autoCommit) (backlog.ts:1485)
          fs.loadTask(task.id)                     → originalTask (STALE)
          hasUpdatedDateRelevantChanges → set updatedDate
          fs.saveTask(task)                        → withMutex(filepath) + saveTaskUnlocked
          contentStore.upsertTask
          git.addAndCommitTaskFile
          executeStatusChangeCallback
        fs.loadTask(taskId)                        → refreshed (STALE possible)
```

**Уязвимость:** между `loadTask` (read) и `saveTask` (write) нет cross-process
lock — другой процесс может сделать read-modify-write и его write будет
перезаписан (last write wins).

### 4.2 Новый flow (С cross-process lock)

```
handler.editTask (handlers.ts:581)
  buildTaskUpdateInput(args)                       → TaskUpdateInput
  resolveMilestoneInput                            → milestone resolved
  core.editTaskLocked(taskId, input)               ← NEW entry point
    ┌─ OUTSIDE lock ──────────────────────────────┐
    │ fs.loadDraft(taskId)                        │ → draft?
    │   [draft? → editTaskOrDraft (existing)]     │
    │ requestedStatus === "draft"?                │
    │   [yes → editTaskOrDraft (existing demote)] │
    │ getTaskPath(taskId, this)                   │ → taskPath | null
    │   [null → throw TASK_NOT_FOUND]             │
    └─────────────────────────────────────────────┘
    core.updateTaskFromInputLocked(taskPath, taskId, input, autoCommit)
      ┌─ INSIDE withWriteLock(taskPath) ──────────┐
      │ fs.readTaskFresh(taskId)                  │ → Task (FRESH: readFile)
      │   [null → throw TASK_NOT_FOUND]           │
      │ oldStatus = task.status                   │ (capture before mutate)
      │ snapshot = deep clone(task)               │ (for updatedDate diff)
      │ applyTaskUpdateInput(task, input, resolver)│ → {mutated} (in-place)
      │   [!mutated → return {saved:false}]       │
      │ normalizeAssignee(task)                   │
      │ hasUpdatedDateRelevantChanges(snapshot,task)│ → set/keep/delete updatedDate
      │ fs.saveTaskUnlocked(task)                 │ → savedPath (atomicWrite)
      │ task.filePath = savedPath                 │
      │ return {task, oldStatus, statusChanged, saved:true} │
      └─────────────────────────────────────────────┘
      ┌─ OUTSIDE lock (post-save) ────────────────┐
      │ [saved]                                    │
      │   contentStore? → fs.loadTask → upsertTask│
      │   shouldAutoCommit? → getTaskPath → git   │
      │   statusChanged? → executeStatusChangeCallback │
      └─────────────────────────────────────────────┘
      return result.task
  formatTaskCallResult(updatedTask)
```

### 4.3 Data models

Без изменений. Используются существующие типы:
- `Task` (types/index.ts) — с `filePath?: string`.
- `TaskUpdateInput` (types/index.ts) — input для мутаций.
- Внутренний (неэкспортируемый) тип результата lock-секции:
  ```ts
  type LockedUpdateResult = {
    task: Task;
    oldStatus: string;
    statusChanged: boolean;
    saved: boolean;
  };
  ```

### 4.4 Ключевые инварианты
- `taskPath` резолвится ОДИН раз, ДО lock (как claim handler, handlers.ts:663).
  `getTaskPath` делает glob-scan (task-path.ts:99) — I/O, не должно быть под
  lock (удлинит критическую секцию).
- `readTaskFresh` (operations.ts:564) использует `readFile` (НЕ `Bun.file`) +
  `getTaskPath` → свежий снимок даже после atomicWrite/rename другого процесса.
- `saveTaskUnlocked` (operations.ts:474) НЕ берёт `withMutex` — только
  `atomicWrite` (temp+rename, crash-safe). Безопасно внутри `withWriteLock`
  (Test 9, atomic-write-concurrency.test.ts:234-264, подтверждает no deadlock).
- `snapshot` для `hasUpdatedDateRelevantChanges` — глубокая копия
  (`JSON.parse(JSON.stringify(task))`) ДО мутации, т.к.
  `applyTaskUpdateInput` мутирует task in-place (backlog.ts:1524+). Без snapshot
  diff сравнил бы task сам с собой (всегда equal → updatedDate не обновится).

---

## 5. Error handling + failure modes + recovery

| Failure mode | Где | Поведение | Recovery |
|---|---|---|---|
| Task не найдена до lock (`getTaskPath` → null) | `editTaskLocked` | `throw Error("Task not found: ...")` → handler catch → `BacklogToolError OPERATION_FAILED` | Caller retry / пользователь проверяет ID |
| Task удалена/перемещена между resolve и lock | `updateTaskFromInputLocked`, внутри lock | `readTaskFresh` → null → `throw Error("Task not found: ...")` | Lock отпущен в `finally` (operations.ts:457-463). Caller retry |
| Cross-process lock таймаут (`ELOCKED`) | `withWriteLock` (operations.ts:446-453) | `WriteLockError` (code `WRITE_LOCK_ERROR_CODE`) пробрасывается | Caller retry; stale-lock recovery встроена (operations.ts:440 `stale`) |
| Invalid status / missing dependency / empty title / missing criterion index | `applyTaskUpdateInput` (backlog.ts:1547, 1662, 2009, …) | `throw Error(...)` | Lock отпущен в `finally`. Никаких частичных записей (saveTaskUnlocked ещё не вызван) |
| `saveTaskUnlocked` падает на `unlink`/`atomicWrite` | operations.ts:519, 528 | `throw` (IO error) | Lock отпущен. Файл мог остаться в промежуточном состоянии — но `atomicWrite` = temp+rename, rename atomic: либо старый, либо новый, никогда не повреждён |
| `git.addAndCommitTaskFile` падает (вне lock) | post-save | `throw` пробрасывается в handler | Task УЖЕ сохранена на диск (save успешен). Git commit можно повторить вручную. Data не потеряна |
| `executeStatusChangeCallback` падает (вне lock) | post-save | Внутри callback уже try/catch с `console.error` (backlog.ts:2350-2365) | Task сохранена; callback failure логируется, не блокирует |
| No-op input (`mutated === false`) | `updateTaskFromInputLocked` | Возврат `{saved:false}` без save, без side effects | Корректный no-op, соответствует `updateTaskFromInput` (backlog.ts:2169) |

**Lock-release гарантия:** `withWriteLock` (operations.ts:455-463) оборачивает
`fn()` в `try/finally` → cross-process lock отпускается ВСЕГДА (success или
error). In-process `withMutex` (mutex.ts:18-30) тоже `try/finally`. Двойная
гарантия release.

**Никаких частичных writes:** save происходит одним вызовом
`saveTaskUnlocked` → `atomicWrite` (atomic rename). Если `applyTaskUpdateInput`
бросает — save не вызывается, файл не тронут.

---

## 6. Observability / logging

Существующая observability сохраняется, новые точки не нужны (P0 fix, minimal
surface). Что уже есть:

- `withWriteLock` (operations.ts:442): `console.error("[lock-compromised] ...")`
  при compromised lock (stale recovery). Новый путь наследует.
- `executeStatusChangeCallback` (backlog.ts:2361-2364): `console.error` при
  callback failure. Наследуется (вызывается вне lock, без изменений).
- `applyTaskUpdateInput` → `appendActivity` (backlog.ts:2106-2148): activity log
  для status_change и comment (best-effort, `.catch(() => {})`). Наследуется.

**Рекомендация (опционально, не блокирующее):** добавить `console.warn` в
`editTaskLocked` при `WriteLockError` для диагностики contention:
```ts
catch (e) { if (isWriteLockError(e)) console.warn("[editTask] write-lock timeout", taskId); throw e; }
```
Не обязательно для P0; `WriteLockError` уже содержит path в message
(operations.ts:448).

**trace_id propagation:** не применимо — `TaskUpdateInput.traceId` используется
только в `appendActivity` (backlog.ts:2124, 2142), который вызывается внутри
`applyTaskUpdateInput` (внутри lock для actorId case). trace_id доходит до
activity entries без изменений.

---

## 7. Testing strategy

Тесты — в `src/test/atomic-write-concurrency.test.ts` (рядом с Test 9-10),
расширяют существующий concurrency-suite. Pattern: два `new Core(testDir)`
instance = симуляция двух MCP процессов.

### 7.1 Unit (per component)

**T1 — `updateTaskFromInputLocked` no deadlock (unit, mirror Test 9):**
`withWriteLock` + `saveTaskUnlocked` не дедлочит. Вызвать
`core.updateTaskFromInputLocked(path, id, {title:"X"})` напрямую. Assert: title
обновлён, файл валидный, lock отпущен (последующий `withWriteLock` того же path
не блокирует).

**T2 — `editTaskLocked` branching (unit):**
- draft input (`loadDraft` находит) → делегирует в `editTaskOrDraft` (assert:
  promote/update-draft path, no write-lock на task file).
- demote input (`status:"Draft"`, task exists) → делегирует в `editTaskOrDraft`
  (assert: draft создан, withCreateLock path).
- plain update → `updateTaskFromInputLocked` (assert: file updated).
- task not found (`getTaskPath` null, no draft) → throws `Task not found`.

**T3 — no-op input (unit):**
`editTaskLocked(id, {})` (пустой input) → `mutated === false` → no save, no
git, no callback. Assert: file mtime не изменился, `updatedDate` не тронут.

### 7.2 Integration (cross-process concurrency)

**T4 — concurrent edits, no silent loss (КЛЮЧЕВОЙ тест P0):**
Два `Core` instance, одна задача. A ставит `labels: ["x"]`, B ставит
`status: "Done"` concurrently (`Promise.all`). Assert: итоговая задача имеет
И `labels: ["x"]` И `status: "Done"` (обе правки применились, ни одна не
потеряна). До fix — last write wins, одна правка терялась.

```ts
const coreA = new Core(testDir);
const coreB = new Core(testDir);
const created = await coreA.createTaskFromInput({ title: "Concurrent Edit" }, false);
const id = created.task.id;
await Promise.all([
  coreA.editTaskLocked(id, { labels: ["x"] }, false),
  coreB.editTaskLocked(id, { status: "Done" }, false),
]);
const final = await coreA.fs.readTaskFresh(id);
expect(final?.labels).toEqual(["x"]);
expect(final?.status).toBe("Done");
```

**T5 — concurrent identical-field edit (last-write-wins acceptable):**
Два Core, оба ставят разный `title`. Assert: итоговый title — один из двух
(не повреждён, не пустой, файл parseable). Это допустимо (semantically
conflicting edit — user must coordinate); важно что файл не повреждён и обе
операции завершились без error.

**T6 — title rename under lock (edge case):**
A меняет title (→ rename файла) под lock, B concurrently редактирует другое
поле. Assert: B видит fresh content (A's new title), B's edit применяется
поверх; итоговый файл имеет A's title + B's field. Файл не дублирован (old
filename удалён saveTaskUnlocked, operations.ts:519).

**T7 — task deleted between resolve and lock:**
A начинает `editTaskLocked`. В окне между `getTaskPath` и взятием lock, другой
процесс удаляет файл. Внутри lock `readTaskFresh` → null → throw. Assert:
`Task not found`, lock отпущен (последующий lock не блокирует).

### 7.3 e2e (MCP handler)

**T8 — MCP `task_edit` end-to-end через TaskHandlers.editTask:**
Вызвать `handlers.editTask({ id, status: "Done" })`. Assert: `CallToolResult`
с отформатированной задачей, status=Done. Доказывает что handler делегирует в
`editTaskLocked` и форматирование работает.

**T9 — regression: draft/demote/promote через editTask:**
- `task_edit` на draft (status не Draft) → promote (existing path).
- `task_edit` на task со status=Draft → demote (existing path).
- `task_edit` на draft (без status) → update-draft (existing path).
Assert: поведение идентично до fix (ветки делегированы в `editTaskOrDraft`).

### 7.4 Что НЕ тестируется (out of scope)
- Draft-update cross-process (out of scope, см. §1 non-goals).
- Title-rename cross-process lost-update на уникальном lock-key (см. §9 —
  проанализировано, не приводит к lost update, только transient not-found).

---

## 8. Trade-offs (ADR)

### ADR-1: Branching в новом `editTaskLocked` (Core), а не в handler

**Decision:** Вся логика branching (draft / demote / plain) и взятие lock — в
новом методе `Core.editTaskLocked`. Handler остаётся тонким: одну строку
замены `editTaskOrDraft` → `editTaskLocked`.

**Alternatives:**
1. Branching в handler (handlers.ts), lock тоже в handler. Минус: handler
   становится толстым, дублирует `editTaskOrDraft` branching, lock-логика
   утекает в MCP layer (нарушает инкапсуляцию Core).
2. Модифицировать существующий `editTaskOrDraft` под lock. Минус: меняет
   CLI-путь (CLI не нуждается в cross-process lock, лишний overhead); риск
   регрессии CLI; `editTaskOrDraft` вызывается из многих мест.

**Consequences:**
- (+) CLI path (`editTaskOrDraft`) нетронут — нулевой риск регрессии CLI.
- (+) MCP layer остаётся декларативным.
- (+) Lock-логика локализована в Core, тестируется unit-тестами Core.
- (-) `editTaskLocked` частично дублирует branching `editTaskOrDraft` (loadDraft
  + status=draft check). Приемлемо: 3 строки, расходится по смыслу (locked vs
  not-locked path).

### ADR-2: Activity-log write остаётся внутри lock (compromise)

**Decision:** НЕ рефакторить `applyTaskUpdateInput` для выноса `appendActivity`
наружу. Activity-log write (backlog.ts:2106-2148, только при `input.actorId`)
остаётся внутри lock (т.к. `applyTaskUpdateInput` выполняется целиком внутри
lock-секции).

**Alternatives:**
1. Рефакторить `applyTaskUpdateInput`: вынести `appendActivity` в отдельный
   метод `logTaskUpdateActivity(task, input, oldStatus)`, вызывать снаружи lock.
   Минус: меняет существующий метод (используется CLI `updateTaskFromInput`),
   риск регрессии; +0.5-1h effort; activity-логика разносится по двум методам.
2. Добавить параметр `deferActivity: boolean` в `applyTaskUpdateInput`, собирать
   entries в возвращаемом значении. Минус: усложняет сигнатуру, используется в
   3 местах (`updateTaskFromInput`, `updateDraftFromInput`,
   `promoteDraftWithUpdates`, `demoteTaskWithUpdates`) — все надо адаптировать.

**Consequences:**
- (+) Минимальная поверхность изменения (P0-цель — быстрый fix).
- (+) `applyTaskUpdateInput` нетронут — нулевая регрессия CLI.
- (-) При `input.actorId` (claim-based edits) `appendActivity` выполняется
  внутри lock — короткий append в `backlog/activity/<id>.log` (ДРУГОЙ файл, не
  taskPath). Не дедлочит (другой lock key), не конкурирует за taskPath lock.
  Удлиняет критическую секцию на ~1 I/O. Приемлемо: MCP `task_edit` в 99%
  случаев НЕ передаёт actorId (actorId — для claim tool), поэтому activity в
  locked-пути обычно не пишется.
- Задача явно требует outside lock только для "Git commit, contentStore, status
  callbacks" (см. description) — activity НЕ упомянут, что согласуется с
  существующей структурой `applyTaskUpdateInput`.

### ADR-3: Lock на реальный .md path (не стабильный per-ID key)

**Decision:** `withWriteLock(taskPath)` где `taskPath` = реальный `.md` путь
(как claim/release/renew). НЕ вводим виртуальный стабильный per-ID lock key.

**Alternatives:**
1. Lock на стабильный ключ: `withWriteLock(join(tasksDir, taskId + ".lock-stub"))`
   — стабилен при rename. Минус: claim/release/renew используют реальный .md
   path → РАЗНЫЕ lock keys для одной задачи → claim и editTask НЕ
   взаимоисключаются → cross-tool race. Чтобы унифицировать, надо мигрировать
   claim/release/renew на stub — меняет working production code, нужен отдельный
   spike + test.

**Consequences:**
- (+) Consistency с claim/release/renew — все используют ОДИН lock key (.md
  path) для одной задачи → claim и editTask взаимоисключаются (cross-tool
  atomicity). Это КОРРЕКТНО и желательно.
- (-) Title-rename меняет .md path → lock key меняется для FUTURE edits. Анализ
  (§9) показывает: это НЕ приводит к lost update (readTaskFresh + getTaskPath
  корректно находят новый файл под своим lock; transient TASK_NOT_FOUND
  возможен в узком окне unlink→rename, уже существует в saveTask). Остаточный
  risk — редкий, не data-loss, документирован.
- Future hardening (out of scope): миграция всех write-path инструментов на
  стабильный per-ID lock key — отдельный spike (см. §9 open question).

### ADR-4: `saveTaskUnlocked` напрямую (не `saveTask`)

**Decision:** Внутри lock вызываем `this.fs.saveTaskUnlocked(task)`, НЕ
`this.fs.saveTask(task)`.

**Alternatives:**
1. `saveTask` внутри lock. Минус: `saveTask` (operations.ts:556) обёрнут в
   `withMutex(filepath)` — избыточный in-process mutex поверх уже удерживаемого
   `withMutex(lockFile)`. Разные ключи → НЕ дедлок (Test 9), но лишний слой +
   лишний `getTasksDir`/filename-derive (operations.ts:543-552) — дублирует
   логику saveTaskUnlocked.

**Consequences:**
- (+) Минимальный overhead внутри критической секции.
- (+) Test 9 (atomic-write-concurrency.test.ts:234-264) явно валидирует именно
  `saveTaskUnlocked` inside `withWriteLock` — наш путь 1:1 повторяет
  протестированный паттерн.
- (-) Теряем in-process mutex на filepath — но он избыточен, т.к. все
  same-process edit-вызовы сериализованы через `withMutex(lockFile)` в
  `withWriteLock` (один lockFile на один taskPath → одна in-process очередь).

---

## 9. Risks + open questions

### Risks

**R1 — Title-rename cross-process race (LOW, не data-loss):**
Lock берётся на старый .md path. `saveTaskUnlocked` (operations.ts:513-525) при
title-change: `unlink(old)` + `atomicWrite(new)`. Другой процесс B, начавший
edit ПОСЛЕ rename: `getTaskPath` → новый path → `withWriteLock(newPath)` —
РАЗНЫЙ lock key, не ждёт A's old-path lock.

**Анализ (почему НЕ lost update):**
- B стартовал ДО rename: `getTaskPath` → old path → `withWriteLock(old)` →
  ждёт A's old-path lock → сериализован. OK.
- B стартовал ПОСЛЕ rename, ПОСЛЕ A's atomicWrite: `getTaskPath` → new path →
  `withWriteLock(new)` → A уже не пишет (A's saveTaskUnlocked завершился до
  release в `finally`) → B `readTaskFresh` видит A's new content → mutate
  поверх → OK, fresh read, no loss.
- B стартовал в окне unlink(old)→atomicWrite(new) (rename не завершён): old
  удалён, new не существует → `getTaskPath` → null → `throw TASK_NOT_FOUND`
  (transient, retryable). НЕ data-loss. Это окно УЖЕ существует в текущем
  `saveTask` (та же unlink+atomicWrite последовательность) — не наш регресс.

**Mitigation:** документировать; transient not-found обрабатывается caller
(retry). Полное устранение требует ADR-3 alt.1 (stable lock key) — out of scope.

**R2 — `applyTaskUpdateInput` read-I/O внутри lock (LOW):**
`applyTaskUpdateInput` внутри lock вызывает `validateDependencies`
(backlog.ts:1660, 1674 — loadTask per dep), `requireCanonicalStatus`
(backlog.ts:1564 → loadConfig), `normalizePriority`/`normalizeTaskType`
(loadConfig). Это read-only I/O — безопасно (не конкурирует за taskPath lock),
но удлиняет критическую секцию.

**Mitigation:** acceptable — validates быстрые, deps обычно 0-3. Если
profile-shows contention — можно pre-resolve statuses/config ДО lock и
передать в applyTask (future optimization, out of scope).

**R3 — Activity-log write внутри lock при actorId (LOW, ADR-2):**
`appendActivity` (backlog.ts:2106-2148) пишет в `backlog/activity/<id>.log`
внутри lock при `input.actorId`. ДРУГОЙ файл → не дедлок, не конкурирует за
taskPath lock. ~1 I/O. MCP `task_edit` обычно без actorId.

**R4 — `contentStore.upsertTask` использует `loadTask` (Bun.file cache, LOW):**
post-save (вне lock) `this.fs.loadTask(taskId)` (backlog.ts:1505) — может
вернуть stale сразу после atomicWrite rename. Унаследовано от `updateTask`
(та же строка). contentStore — in-memory index, stale на миллисекунды
обновится при следующем list/watcher. Не data-loss.

**Mitigation (опционально):** заменить на `readTaskFresh` для strict
freshness. Минор, не блокирующий P0.

### Open questions

**OQ1 — Stable per-ID lock key (future hardening):**
Стоит ли мигрировать ВСЕ write-path инструменты (claim/release/renew/edit,
будущий archive/move) на стабильный per-ID lock key (виртуальный stub path),
чтобы title-rename не менял lock key? Требует: единый stub-resolver,
перевод claim/release/renew (production code), новые тесты cross-tool
atomicity. Spike/PoC нужен. Out of scope TASK-97.2 — отдельная задача.

**OQ2 — `renewClaimIfHeld` (server.ts:447) под lock:**
`renewClaimIfHeld` вызывается перед каждым tool dispatch (server.ts:446
comment) и берёт `withWriteLock` на .md path. Если agent делает `task_edit`
сразу после tool, который продлил claim — `renewClaimIfHeld` и `editTaskLocked`
берут lock на тот же .md path последовательно (не вложенно) → OK, сериализованы.
Не требует изменений, но стоит верифицировать тестом (T-дополнение: два
sequence claim-renew + edit). Не блокирующее.

---

## 10. Task breakdown (component-level)

### TASK-97.2-a — `Core.editTaskLocked` + `Core.updateTaskFromInputLocked` (backlog.ts)

**Description:** Добавить два новых public метода в класс `Core`
(`src/core/backlog.ts`), рядом с `editTaskOrDraft` (~line 2237).
`editTaskLocked` — branching + dispatch; `updateTaskFromInputLocked` —
cross-process locked read-modify-write с post-save side effects вне lock.

**Files affected:**
- `src/core/backlog.ts` (modify — добавить 2 метода; ~60 строк)

**Acceptance criteria:**
- AC1: `editTaskLocked(taskId, input, autoCommit?)` существует, public,
  компилируется. Ветки: (a) `loadDraft` → `editTaskOrDraft`; (b) `input.status`
  lowercased === "draft" → `editTaskOrDraft`; (c) иначе `getTaskPath` →
  `updateTaskFromInputLocked`; (d) `getTaskPath` null → `throw Error("Task not
  found: <taskId>")`.
- AC2: `updateTaskFromInputLocked(taskPath, taskId, input, autoCommit?)`
  существует, public, компилируется. Внутри `withWriteLock(taskPath)`:
  `readTaskFresh` → null throw; capture `oldStatus` + deep-clone `snapshot`;
  `applyTaskUpdateInput` → `mutated`; `!mutated` → return `{saved:false}`;
  `normalizeAssignee` + `hasUpdatedDateRelevantChanges(snapshot, task)` →
  set/keep/delete `updatedDate`; `saveTaskUnlocked` → `task.filePath = savedPath`;
  return `{task, oldStatus, statusChanged, saved:true}`.
- AC3: Post-save (после `await withWriteLock`, вне lock) при `saved`:
  `contentStore?.upsertTask` (через `loadTask`); `shouldAutoCommit` →
  `getTaskPath` → `git.addAndCommitTaskFile`; `statusChanged` →
  `executeStatusChangeCallback`. Возврат `result.task`.
- AC4: НЕТ вызова `saveTask` (только `saveTaskUnlocked`) внутри lock.
- AC5: НЕТ вызова `withCreateLock` внутри `withWriteLock` (demote делегирован
  наружу через `editTaskOrDraft` ДО write-lock).
- AC6: `getTaskPath` импортирован (backlog.ts:69 — уже есть; убедиться что
  используется в новых методах). `normalizeAssignee`, `hasUpdatedDateRelevantChanges`
  доступны в module/class scope (уже используются в `updateTask`:1486,1494).

**Dependencies:** none.

**Expected behavior change:** plain task update через MCP получает cross-process
lock; CLI-путь (`editTaskOrDraft`) неизменён.

**Tests that should pass:** T1, T2, T3, T4, T5, T6, T7 (см. §7).

---

### TASK-97.2-b — `TaskHandlers.editTask` делегирует в `editTaskLocked` (handlers.ts)

**Description:** В `editTask` handler (handlers.ts:581) заменить вызов
`this.core.editTaskOrDraft(args.id, updateInput)` на
`this.core.editTaskLocked(args.id, updateInput)`. Остальное (ordinal validation,
`buildTaskUpdateInput`, `resolveMilestoneInput`, catch-block) без изменений.

**Files affected:**
- `src/mcp/tools/tasks/handlers.ts` (modify — 1 строка + комментарий; ~581-593)

**Acceptance criteria:**
- AC1: `editTask` вызывает `this.core.editTaskLocked(args.id, updateInput)`.
- AC2: `buildTaskUpdateInput(args)` и `resolveMilestoneInput` вызываются ДО
  `editTaskLocked` (без изменений — milestone resolution вне lock, OK т.к.
  read-only).
- AC3: catch-block (handlers.ts:594-599) без изменений — оборачивает ошибки в
  `BacklogToolError OPERATION_FAILED`.
- AC4: `formatTaskCallResult(updatedTask)` вызывается на результат
  `editTaskLocked`.
- AC5: Нет новых imports (getTaskPath уже импортирован, handlers.ts:24 — но
  больше НЕ нужен в handler если branching в Core; оставить import если
  используется elsewhere, иначе убрать — проверить grep).

**Dependencies:** TASK-97.2-a (метод `editTaskLocked` должен существовать).

**Expected behavior change:** MCP `task_edit` проходит через locked path;
draft/demote/promote ветки работают как прежде (через делегирование в
`editTaskOrDraft` внутри `editTaskLocked`).

**Tests that should pass:** T8, T9 (см. §7).

---

### TASK-97.2-c — Concurrency + edge-case тесты (atomic-write-concurrency.test.ts)

**Description:** Добавить тесты T1-T9 (§7) в `src/test/atomic-write-concurrency.test.ts`,
рядом с Test 9-10. Главный — T4 (concurrent edits, no silent loss).

**Files affected:**
- `src/test/atomic-write-concurrency.test.ts` (modify — добавить ~9 тестов)

**Acceptance criteria:**
- AC1: T4 (concurrent edits no loss) проходит: два `Core` instance, A ставит
  `labels:["x"]`, B ставит `status:"Done"` concurrently; итоговая задача имеет
  ОБА изменения.
- AC2: T1 (no deadlock) проходит: `updateTaskFromInputLocked` не дедлочит,
  lock отпущен.
- AC3: T2 (branching) проходит: draft/demote/plain/not-found ветки.
- AC4: T3 (no-op) проходит: пустой input → no save, no side effects.
- AC5: T6 (title rename under lock) проходит: rename + concurrent edit → fresh
  read, both applied, no duplicate file.
- AC6: T7 (deleted between resolve and lock) проходит: throws `Task not found`,
  lock отпущен.
- AC7: T8/T9 (handler e2e + regression) проходят: `TaskHandlers.editTask`
  форматирует результат; draft/demote/promote regression-free.
- AC8: Все существующие тесты в файле (Test 1-10) продолжают проходить —
  нет регрессии.

**Dependencies:** TASK-97.2-a + TASK-97.2-b.

**Expected behavior change:** P0 fix верифицирован детерминированными тестами.

**Tests that should pass:** все тесты файла + новые.

---

### Critical path

```
TASK-97.2-a (backlog.ts methods) ─┬─► TASK-97.2-b (handler) ─┬─► TASK-97.2-c (tests)
                                  │                          │
                                  └──────────────────────────┘
```
Critical path: **a → b → c** (3 шага). a и b можно делать последовательно в
одном PR (b зависит от a). c зависит от обоих.

### Оценка effort
- TASK-97.2-a: ~1h (2 метода, ~60 строк, воспроизведение updateTask логики).
- TASK-97.2-b: ~10min (1 строка + комментарий).
- TASK-97.2-c: ~45min (9 тестов, pattern известен из Test 9-10).
- **Итого: ~2h** (соответствует estimate задачи).

---

## Appendix A — Точные diff-подобные изменения

### A.1 `src/mcp/tools/tasks/handlers.ts` (editTask, lines 581-600)

**OLD (handlers.ts:592):**
```ts
			const updatedTask = await this.core.editTaskOrDraft(args.id, updateInput);
			return await formatTaskCallResult(updatedTask);
```

**NEW:**
```ts
			// TASK-97.2: cross-process lock for read-modify-write (mirror claim/release
			// pattern at handlers.ts:671,785). Draft/demote branches keep existing
			// protection (promote/demote use withCreateLock); plain task update goes
			// through editTaskLocked → withWriteLock + readTaskFresh + saveTaskUnlocked.
			const updatedTask = await this.core.editTaskLocked(args.id, updateInput);
			return await formatTaskCallResult(updatedTask);
```

### A.2 `src/core/backlog.ts` — вставить после `editTaskOrDraft` (line 2237)

**NEW (2 метода):**
```ts
	/**
	 * TASK-97.2: MCP editTask entry point with cross-process write lock.
	 * Branching mirrors editTaskOrDraft but only the plain task-update path
	 * takes withWriteLock; draft/demote keep existing protection (withCreateLock).
	 * CLI continues to use editTaskOrDraft (no cross-process lock needed there).
	 */
	async editTaskLocked(taskId: string, input: TaskUpdateInput, autoCommit?: boolean): Promise<Task> {
		// Draft branch — promote (withCreateLock) or update-draft; existing protection.
		const draft = await this.fs.loadDraft(taskId);
		if (draft) {
			return await this.editTaskOrDraft(taskId, input, autoCommit);
		}

		// Demote branch — task → draft via demoteTaskWithUpdates (withCreateLock inside).
		// Must NOT wrap in withWriteLock: demote nests withCreateLock → lock-order hazard.
		const requestedStatus = input.status?.trim().toLowerCase();
		if (requestedStatus === "draft") {
			return await this.editTaskOrDraft(taskId, input, autoCommit);
		}

		// Plain task update — cross-process locked read-modify-write.
		// Resolve path OUTSIDE lock (glob scan is I/O; don't extend critical section).
		const taskPath = await getTaskPath(taskId, this);
		if (!taskPath) {
			throw new Error(`Task not found: ${taskId}`);
		}
		return await this.updateTaskFromInputLocked(taskPath, taskId, input, autoCommit);
	}

	/**
	 * TASK-97.2: Plain task update under cross-process withWriteLock.
	 * Inside lock: readTaskFresh (bypass Bun.file cache) → applyTaskUpdateInput
	 * → saveTaskUnlocked (NOT saveTask — avoids redundant in-process mutex; Test 9
	 * proves no deadlock). Outside lock: contentStore, git commit, status callback.
	 * Mirrors updateTask (backlog.ts:1485) semantics but with cross-process safety.
	 */
	async updateTaskFromInputLocked(
		taskPath: string,
		taskId: string,
		input: TaskUpdateInput,
		autoCommit?: boolean,
	): Promise<Task> {
		const result = await this.fs.withWriteLock(taskPath, async () => {
			const task = await this.fs.readTaskFresh(taskId);
			if (!task) {
				throw new Error(`Task not found: ${taskId}`);
			}

			// Capture pre-mutation state for updatedDate diff + status-change callback.
			// applyTaskUpdateInput mutates task in-place, so snapshot BEFORE mutation.
			const oldStatus = task.status ?? "";
			const snapshot = JSON.parse(JSON.stringify(task)) as Task;

			const { mutated } = await this.applyTaskUpdateInput(task, input, async (status) =>
				this.requireCanonicalStatus(status),
			);
			if (!mutated) {
				return { task, oldStatus, statusChanged: false, saved: false };
			}

			// Reproduce updateTask pre-save normalization (backlog.ts:1486-1500).
			normalizeAssignee(task);
			if (hasUpdatedDateRelevantChanges(snapshot, task)) {
				task.updatedDate = new Date().toISOString().slice(0, 16).replace("T", " ");
			} else if (snapshot.updatedDate) {
				task.updatedDate = snapshot.updatedDate;
			} else {
				delete task.updatedDate;
			}

			const savedPath = await this.fs.saveTaskUnlocked(task);
			task.filePath = savedPath;
			const statusChanged = oldStatus !== (task.status ?? "");
			return { task, oldStatus, statusChanged, saved: true };
		});

		// OUTSIDE lock — post-save side effects (mirror updateTask:1502-1521).
		// I/O-heavy / side-effecting; must not extend the critical section.
		if (result.saved) {
			if (this.contentStore) {
				const savedTask = await this.fs.loadTask(taskId);
				if (savedTask) {
					this.contentStore.upsertTask(savedTask);
				}
			}
			if (await this.shouldAutoCommit(autoCommit)) {
				const filePath = await getTaskPath(taskId, this);
				if (filePath) {
					await this.git.addAndCommitTaskFile(taskId, filePath, "update");
				}
			}
			if (result.statusChanged) {
				await this.executeStatusChangeCallback(result.task, result.oldStatus, result.task.status ?? "");
			}
		}
		return result.task;
	}
```

---

## Appendix B — Верификация доступности символов

| Символ | Где определено | Доступно из новых методов Core? |
|---|---|---|
| `getTaskPath` | task-path.ts:86, импортирован backlog.ts:69 | да (module scope) |
| `this.fs.withWriteLock` | operations.ts:412 (FileSystem) | да (Core.fs) |
| `this.fs.readTaskFresh` | operations.ts:564 | да |
| `this.fs.saveTaskUnlocked` | operations.ts:474 | да |
| `this.fs.loadDraft` | operations.ts:935 | да |
| `this.fs.loadTask` | operations.ts:578 | да |
| `this.applyTaskUpdateInput` | backlog.ts:1524 (private method) | да (same class) |
| `this.requireCanonicalStatus` | backlog.ts:469 (private) | да |
| `this.shouldAutoCommit` | backlog.ts:835 | да |
| `this.executeStatusChangeCallback` | backlog.ts:2341 (private) | да |
| `this.contentStore` | backlog.ts:255 (private field) | да |
| `this.git` | backlog.ts:265 | да |
| `this.git.addAndCommitTaskFile` | GitOperations | да |
| `normalizeAssignee` | imported, used in updateTask:1486 | да |
| `hasUpdatedDateRelevantChanges` | backlog.ts:166 (module function) | да |

McpServer `extends Core` (server.ts:67) → `this.core.editTaskLocked` доступно из
`TaskHandlers` (handlers.ts:79, `core: McpServer`).
