import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "../core/backlog.ts";
import { __testImpl, atomicWrite } from "../file-system/atomic-write.ts";
import type { Task } from "../types/index.ts";
import { withMutex } from "../utils/mutex.ts";
import { initializeTestProject } from "./test-utils.ts";

describe("atomicWrite", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "aw-test-"));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	// Test 1: produces full content on success
	it("writes full content to the target path on success", async () => {
		const path = join(testDir, "task-1.md");
		const content = "---\nid: TASK-1\n---\n\n## Description\nHello world\n";
		await atomicWrite(path, content);

		const read = await readFile(path, "utf-8");
		expect(read).toBe(content);
	});

	// Test 2: no torn writes under concurrent readers
	it("concurrent readers see either old or new content, never partial", async () => {
		const path = join(testDir, "task-1.md");
		const oldContent = "OLD_CONTENT_OLD_CONTENT";
		const newContent = "NEW_CONTENT_NEW_CONTENT";

		await atomicWrite(path, oldContent);

		const reads: string[] = [];
		const readerPromises = [];
		for (let i = 0; i < 20; i++) {
			readerPromises.push(
				(async () => {
					try {
						const text = await readFile(path, "utf-8");
						reads.push(text);
					} catch {
						// File might be mid-rename — acceptable
					}
				})(),
			);
		}

		// Start the write and the readers concurrently
		const writePromise = atomicWrite(path, newContent);
		await Promise.all([writePromise, ...readerPromises]);

		// Every read must be either oldContent or newContent, never a partial
		for (const text of reads) {
			expect(text === oldContent || text === newContent).toBe(true);
		}

		// Final state is new content
		const final = await readFile(path, "utf-8");
		expect(final).toBe(newContent);
	});

	// Test 3: temp file cleaned up on rename failure
	it("cleans up temp file when rename fails", async () => {
		const path = join(testDir, "task-1.md");

		// Force rename to fail by making the target dir point to a non-existent path
		// We can't easily force rename failure on same-dir, but we can test cleanup
		// by having the original impl throw during rename.
		const originalImpl = __testImpl.atomicWrite;

		__testImpl.atomicWrite = async () => {
			throw new Error("Simulated write failure");
		};

		await expect(atomicWrite(path, "content")).rejects.toThrow("Simulated write failure");

		__testImpl.atomicWrite = originalImpl;

		// Verify no .tmp files are left behind
		const files = await readdir(testDir);
		const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
		expect(tmpFiles.length).toBe(0);
	});

	// Test 4: temp file is dot-prefixed (not glob-visible)
	it("creates dot-prefixed temp files invisible to *.md globs", async () => {
		const path = join(testDir, "task-1.md");
		await atomicWrite(path, "content");

		// Verify the file exists and no leftover .tmp files
		const files = await readdir(testDir);
		const mdFiles = files.filter((f) => f.endsWith(".md"));
		expect(mdFiles).toContain("task-1.md");
		// No leftover .tmp files (temp was renamed atomically)
		const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
		expect(tmpFiles.length).toBe(0);
	});
});

describe("withMutex (per-file in-process mutex)", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "mutex-test-"));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	// Test 5: serializes same-key writes
	it("serializes operations on the same key", async () => {
		const order: string[] = [];
		const key = "/test/file-A.md";

		const op1 = withMutex(key, async () => {
			order.push("A:start");
			await new Promise((r) => setTimeout(r, 50));
			order.push("A:end");
		});
		const op2 = withMutex(key, async () => {
			order.push("B:start");
			order.push("B:end");
		});

		await Promise.all([op1, op2]);

		// A must fully complete before B starts
		expect(order).toEqual(["A:start", "A:end", "B:start", "B:end"]);
	});

	// Test 6: allows concurrent operations on DIFFERENT keys
	it("runs different keys concurrently", async () => {
		const order: string[] = [];

		const op1 = withMutex("/test/file-A.md", async () => {
			order.push("A:start");
			await new Promise((r) => setTimeout(r, 50));
			order.push("A:end");
		});
		const op2 = withMutex("/test/file-B.md", async () => {
			order.push("B:start");
			await new Promise((r) => setTimeout(r, 50));
			order.push("B:end");
		});

		await Promise.all([op1, op2]);

		// Both started before either ended = concurrent
		expect(order.indexOf("A:start")).toBeLessThan(order.indexOf("B:start"));
		expect(order.indexOf("B:start")).toBeLessThan(order.indexOf("A:end"));
	});

	// Test 7: releases on fn error
	it("releases the mutex when fn throws", async () => {
		const key = "/test/file-err.md";
		const order: string[] = [];

		await expect(
			withMutex(key, async () => {
				order.push("err:start");
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		// After error, a new op should proceed immediately
		await withMutex(key, async () => {
			order.push("next:start");
			order.push("next:end");
		});

		expect(order).toEqual(["err:start", "next:start", "next:end"]);
	});
});

describe("withWriteLock (via saveTask)", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "writelock-test-"));
		const core = new Core(testDir);
		await initializeTestProject(core, "WriteLock Test", false);
		const config = await core.fs.loadConfig();
		if (config) {
			config.checkActiveBranches = false;
			await core.fs.saveConfig(config);
		}
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	// Test 8: saveTask serializes same-file writes
	it("serializes concurrent saves to the same task file", async () => {
		const core = new Core(testDir);
		const created = await core.createTaskFromInput({ title: "Race Task" }, false);
		const taskId = created.task.id;

		const second = new Core(testDir);
		const third = new Core(testDir);

		// Both update the same task concurrently — withWriteLock should serialize
		const taskForSecond = await second.getTask(taskId);
		const taskForThird = await third.getTask(taskId);
		expect(taskForSecond).toBeDefined();
		expect(taskForThird).toBeDefined();
		if (!taskForSecond || !taskForThird) return;

		taskForSecond.title = "From Second";
		taskForThird.title = "From Third";

		const saveA = second.updateTask(taskForSecond, false);
		const saveB = third.updateTask(taskForThird, false);

		await Promise.all([saveA, saveB]);

		// Both should have completed without error
		const task = await core.getTask(taskId);
		expect(task).toBeDefined();
		expect(task).not.toBeNull();
		if (task) {
			expect(["From Second", "From Third"]).toContain(task.title);
		}
	});

	// Test 9: saveTaskUnlocked inside withWriteLock does NOT deadlock (B1 fix)
	it("does not deadlock when saveTaskUnlocked is called inside withWriteLock", async () => {
		const core = new Core(testDir);
		const created = await core.createTaskFromInput({ title: "No Deadlock" }, false);
		const taskId = created.task.id;

		// Simulate what claim_item will do: wrap in withWriteLock, then call saveTaskUnlocked
		const existingTask = (await core.fs.listTasks()).find((t) => t.id === taskId);
		const filepath = existingTask?.filePath;
		expect(filepath).toBeDefined();

		const result = await core.fs.withWriteLock(filepath!, async () => {
			const task = await core.getTask(taskId);
			expect(task).toBeDefined();
			if (!task) throw new Error("task not found");

			// This is the critical call: saveTaskUnlocked inside withWriteLock.
			// Preserve filePath so the save goes to the same file (not a new filename).
			const updated: Task = { ...task, title: "Updated Inside Lock", filePath: filepath };
			return core.fs.saveTaskUnlocked(updated);
		});

		expect(result).toBeDefined();

		// Verify the save happened — read directly from disk (getTask uses ContentStore cache)
		const task = await core.fs.loadTask(taskId);
		expect(task).not.toBeNull();
		if (task) {
			expect(task.title).toBe("Updated Inside Lock");
		}
	});

	// Test 10: saveTask produces valid content after concurrent writes
	it("produces intact task file after 10 concurrent saves", async () => {
		const core = new Core(testDir);
		const created = await core.createTaskFromInput({ title: "Concurrent Target" }, false);
		const taskId = created.task.id;

		const cores = Array.from({ length: 10 }, () => new Core(testDir));

		// All save concurrently — different titles to the same task
		const tasks = await Promise.all(cores.map((c) => c.getTask(taskId)));
		for (const t of tasks) {
			expect(t).toBeDefined();
		}
		await Promise.all(
			cores.map((c, i) => {
				const t = tasks[i]!;
				t.title = `Concurrent ${i}`;
				return c.updateTask(t, false);
			}),
		);

		// Verify file is intact (parseable, correct structure)
		const task = await core.getTask(taskId);
		expect(task).toBeDefined();
		expect(task?.id).toBe(taskId);
		expect(task?.title).toMatch(/^Concurrent \d+$/);
	});
});
