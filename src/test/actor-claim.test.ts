import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "../core/backlog.ts";
import { parseTask } from "../markdown/parser.ts";
import { serializeTask } from "../markdown/serializer.ts";
import { initializeTestProject } from "./test-utils.ts";

// HYBRID-BOARD: Phase B tests — ActorClaim round-trip (spec §4, §7.1)

describe("ActorClaim — created_by / updated_by round-trip", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "backlog-actor-claim-"));
		const core = new Core(testDir);
		await initializeTestProject(core, "Actor Claim Test", false);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("persists createdById/createdByKind when task is created with actorId", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({
			title: "Actor test task",
			actorId: "orchestrator-1",
			actorKind: "orchestrator",
		});

		expect(task.createdById).toBe("orchestrator-1");
		expect(task.createdByKind).toBe("orchestrator");
		expect(task.updatedById).toBe("orchestrator-1");
		expect(task.updatedByKind).toBe("orchestrator");
	});

	it("writes created_by_id and created_by_kind to the .md frontmatter", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({
			title: "Frontmatter test",
			actorId: "agent-claude-5c61",
			actorKind: "subagent",
		});
		expect(task).toBeDefined();
		// Read the raw file from disk
		const tasksDir = core.fs.tasksDir;
		const files = await readdir(tasksDir);
		const taskFile = files.find((f) => f.endsWith(".md"));
		expect(taskFile).toBeDefined();
		const raw = await readFile(join(tasksDir, taskFile!), "utf-8");

		expect(raw).toContain("created_by_id: agent-claude-5c61");
		expect(raw).toContain("created_by_kind: subagent");
		expect(raw).toContain("updated_by_id: agent-claude-5c61");
		expect(raw).toContain("updated_by_kind: subagent");
	});

	it("does not add created_by fields when actorId is omitted", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({
			title: "No actor task",
		});

		expect(task.createdById).toBeUndefined();
		expect(task.createdByKind).toBeUndefined();
	});

	it("parses created_by_id/created_by_kind back from frontmatter", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({
			title: "Round-trip test",
			actorId: "tester-bot",
			actorKind: "external",
		});

		// Reload the task from disk — parseTask should populate the fields
		const reloaded = await core.fs.loadTask(task.id);
		expect(reloaded?.createdById).toBe("tester-bot");
		expect(reloaded?.createdByKind).toBe("external");
		expect(reloaded?.updatedById).toBe("tester-bot");
		expect(reloaded?.updatedByKind).toBe("external");
	});

	it("updates updatedById/updatedByKind when task is edited with actorId", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({
			title: "Edit actor test",
			actorId: "creator-agent",
			actorKind: "orchestrator",
		});

		// Edit with a different actor
		await core.editTaskOrDraft(task.id, {
			status: "In Progress",
			actorId: "editor-agent",
			actorKind: "subagent",
		});

		const reloaded = await core.fs.loadTask(task.id);
		expect(reloaded?.createdById).toBe("creator-agent"); // unchanged
		expect(reloaded?.createdByKind).toBe("orchestrator"); // unchanged
		expect(reloaded?.updatedById).toBe("editor-agent"); // updated
		expect(reloaded?.updatedByKind).toBe("subagent"); // updated
	});

	it("serializes and parses all 4 actor fields without loss", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({
			title: "Serializer test",
			actorId: "roundtrip-agent",
			actorKind: "user",
		});

		// Edit with different actor to get distinct created_by / updated_by
		await core.editTaskOrDraft(task.id, {
			description: "Updated description",
			actorId: "editor-roundtrip",
			actorKind: "external",
		});

		const reloaded = await core.fs.loadTask(task.id);
		expect(reloaded?.createdById).toBe("roundtrip-agent");
		expect(reloaded?.createdByKind).toBe("user");
		expect(reloaded?.updatedById).toBe("editor-roundtrip");
		expect(reloaded?.updatedByKind).toBe("external");

		// Serialize → parse round-trip
		const serialized = serializeTask(reloaded!);
		const reparsed = parseTask(serialized);
		expect(reparsed.createdById).toBe("roundtrip-agent");
		expect(reparsed.createdByKind).toBe("user");
		expect(reparsed.updatedById).toBe("editor-roundtrip");
		expect(reparsed.updatedByKind).toBe("external");
	});

	it("omits actor fields from frontmatter when not set", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({
			title: "No actor frontmatter test",
		});

		const serialized = serializeTask(task);
		expect(serialized).not.toContain("created_by_id");
		expect(serialized).not.toContain("created_by_kind");
		expect(serialized).not.toContain("updated_by_id");
		expect(serialized).not.toContain("updated_by_kind");
	});
});
