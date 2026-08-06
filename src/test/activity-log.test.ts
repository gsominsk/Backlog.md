import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { exists, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "../core/backlog.ts";
import { createActivityEntry, formatActivityLine } from "../domain/activity_entry.ts";
import { deriveTrigger } from "../domain/trigger-derivation.ts";
import { appendActivity, readActivity } from "../file-system/activity-log.ts";
import { initializeTestProject } from "./test-utils.ts";

// HYBRID-BOARD: Phase C tests — ActivityLog (spec §5)

describe("ActivityLog — domain model", () => {
	it("formatActivityLine produces expected format", () => {
		const entry = createActivityEntry({
			actorId: "agent-1",
			action: "status_change",
			from: "To Do",
			to: "In Progress",
			trigger: "start",
		});
		const line = formatActivityLine(entry);
		expect(line).toContain("[@agent-1]");
		expect(line).toContain("action: status_change");
		expect(line).toContain("To Do → In Progress");
		expect(line).toContain("trigger: start");
		expect(line.startsWith("- ")).toBe(true);
	});

	it("formatActivityLine escapes pipe and newlines in summary", () => {
		const entry = createActivityEntry({
			actorId: "agent-1",
			action: "comment",
			summary: "text with | pipe\nand newline",
		});
		const line = formatActivityLine(entry);
		expect(line).toContain("\\|");
	});

	it("createActivityEntry fills timestamp and defaults", () => {
		const entry = createActivityEntry({ action: "create" });
		expect(entry.timestamp).toBeTruthy();
		expect(entry.actorId).toBeNull();
		expect(entry.from).toBeNull();
		expect(entry.to).toBeNull();
		expect(entry.trigger).toBeNull();
		expect(entry.summary).toBeNull();
	});
});

describe("ActivityLog — trigger derivation", () => {
	const config = { statuses: ["To Do", "In Progress", "Done"] };

	it("forward to final status = complete", () => {
		expect(deriveTrigger("In Progress", "Done", config)).toBe("complete");
	});

	it("forward but not final = start", () => {
		expect(deriveTrigger("To Do", "In Progress", config)).toBe("start");
	});

	it("backward to first = reopen", () => {
		expect(deriveTrigger("In Progress", "To Do", config)).toBe("reopen");
	});

	it("backward but not first = resume", () => {
		const config4 = { statuses: ["To Do", "In Progress", "Review", "Done"] };
		expect(deriveTrigger("Review", "In Progress", config4)).toBe("resume");
	});

	it("same status = null", () => {
		expect(deriveTrigger("In Progress", "In Progress", config)).toBeNull();
	});

	it("null input = null", () => {
		expect(deriveTrigger(null, "Done", config)).toBeNull();
	});
});

describe("ActivityLog — file storage", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "backlog-activity-log-"));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("appendActivity creates file with header on first entry", async () => {
		const entry = createActivityEntry({ actorId: "agent-1", action: "create" });
		await appendActivity(testDir, "TASK-1", entry);

		const activityPath = join(testDir, "activity", "task-1.md");
		expect(await exists(activityPath)).toBe(true);
		const content = await readFile(activityPath, "utf-8");
		expect(content).toContain("# Activity Log: TASK-1");
		expect(content).toContain("[@agent-1]");
		expect(content).toContain("action: create");
	});

	it("appendActivity appends to existing file without duplicating header", async () => {
		const entry1 = createActivityEntry({ actorId: "agent-1", action: "create" });
		await appendActivity(testDir, "TASK-2", entry1);

		const entry2 = createActivityEntry({
			actorId: "agent-2",
			action: "status_change",
			from: "To Do",
			to: "In Progress",
		});
		await appendActivity(testDir, "TASK-2", entry2);

		const content = await readFile(join(testDir, "activity", "task-2.md"), "utf-8");
		const headerCount = (content.match(/# Activity Log/g) || []).length;
		expect(headerCount).toBe(1);
		expect(content).toContain("[@agent-1]");
		expect(content).toContain("[@agent-2]");
	});

	it("readActivity returns entries most-recent first with pagination", async () => {
		for (let i = 0; i < 5; i++) {
			await appendActivity(
				testDir,
				"TASK-3",
				createActivityEntry({
					actorId: `agent-${i}`,
					action: "update",
				}),
			);
		}

		const { entries, total } = await readActivity(testDir, "TASK-3", 3, 0);
		expect(total).toBe(5);
		expect(entries.length).toBe(3);
		expect(entries[0]).toContain("[@agent-4]");

		const { entries: page2 } = await readActivity(testDir, "TASK-3", 3, 3);
		expect(page2.length).toBe(2);
		expect(page2[0]).toContain("[@agent-1]");
	});

	it("readActivity returns empty for non-existent task", async () => {
		const { entries, total } = await readActivity(testDir, "TASK-999");
		expect(entries).toEqual([]);
		expect(total).toBe(0);
	});
});

describe("ActivityLog — integration with Core", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "backlog-activity-core-"));
		const core = new Core(testDir);
		await initializeTestProject(core, "Activity Core Test", false);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("task creation logs 'create' action in activity file", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({
			title: "Activity test task",
			actorId: "creator-agent",
			actorKind: "orchestrator",
		});

		const activityPath = join(testDir, "backlog", "activity", `${task.id.toLowerCase()}.md`);
		expect(await exists(activityPath)).toBe(true);
		const content = await readFile(activityPath, "utf-8");
		expect(content).toContain("action: create");
		expect(content).toContain("[@creator-agent]");
	});

	it("does NOT create activity file when actorId is omitted (CLI path)", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({
			title: "No actor task",
		});

		const activityPath = join(testDir, "backlog", "activity", `${task.id.toLowerCase()}.md`);
		expect(await exists(activityPath)).toBe(false);
	});

	it("status change logs 'status_change' action with from → to and trigger", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({
			title: "Status change test",
			actorId: "creator-agent",
		});

		await core.editTaskOrDraft(task.id, {
			status: "In Progress",
			actorId: "editor-agent",
		});

		const activityPath = join(testDir, "backlog", "activity", `${task.id.toLowerCase()}.md`);
		const content = await readFile(activityPath, "utf-8");
		expect(content).toContain("action: status_change");
		expect(content).toContain("To Do → In Progress");
		expect(content).toContain("trigger: start");
		expect(content).toContain("[@editor-agent]");
	});

	it("comment append logs 'comment' action with summary", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({
			title: "Comment test",
			actorId: "creator-agent",
		});

		await core.editTaskOrDraft(task.id, {
			appendComments: ["This is a test comment"],
			actorId: "commenter-agent",
		});

		const activityPath = join(testDir, "backlog", "activity", `${task.id.toLowerCase()}.md`);
		const content = await readFile(activityPath, "utf-8");
		expect(content).toContain("action: comment");
		expect(content).toContain("This is a test comment");
		expect(content).toContain("[@commenter-agent]");
	});

	it("readActivity returns all entries for a task", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({
			title: "Read activity test",
			actorId: "creator-agent",
		});

		await core.editTaskOrDraft(task.id, {
			status: "In Progress",
			actorId: "editor-agent",
		});

		const backlogDir = join(testDir, "backlog");
		const { entries, total } = await readActivity(backlogDir, task.id);
		expect(total).toBe(2);
		expect(entries[0]).toContain("status_change");
		expect(entries[1]).toContain("create");
	});

	it("completing a task logs 'complete' trigger", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({
			title: "Complete trigger test",
			actorId: "creator-agent",
		});

		await core.editTaskOrDraft(task.id, {
			status: "In Progress",
			actorId: "editor-agent",
		});

		await core.editTaskOrDraft(task.id, {
			status: "Done",
			actorId: "editor-agent",
		});

		const activityPath = join(testDir, "backlog", "activity", `${task.id.toLowerCase()}.md`);
		const content = await readFile(activityPath, "utf-8");
		expect(content).toContain("In Progress → Done");
		expect(content).toContain("trigger: complete");
	});
});
