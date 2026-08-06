import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { exists, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "../core/backlog.ts";
import { registerWorkflowResources } from "../mcp/resources/workflow/index.ts";
import { McpServer } from "../mcp/server.ts";
import { registerTaskTools } from "../mcp/tools/tasks/index.ts";
import { registerWorkflowTools } from "../mcp/tools/workflow/index.ts";
import { initializeTestProject } from "./test-utils.ts";

// HYBRID-BOARD: Phase D tests — Claim ownership (spec §6)

describe("Claim Ownership — TaskClaim round-trip", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "backlog-claim-"));
		const core = new Core(testDir);
		await initializeTestProject(core, "Claim Test", false);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("serializes and parses claim nested object in frontmatter", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({
			title: "Claim round-trip test",
			actorId: "creator-agent",
		});

		// Manually set claim and save
		const claim = {
			by: "architect-agent",
			at: "2026-07-19T10:00:00Z",
			expiresAt: "2026-07-19T10:15:00Z",
		};
		const updated = { ...task, claim };
		await core.fs.saveTask(updated);

		// Re-read and parse
		const reloaded = await core.getTask(task.id);
		expect(reloaded?.claim).not.toBeNull();
		expect(reloaded?.claim?.by).toBe("architect-agent");
		expect(reloaded?.claim?.at).toBe("2026-07-19T10:00:00Z");
		expect(reloaded?.claim?.expiresAt).toBe("2026-07-19T10:15:00Z");
	});

	it("claim absent in frontmatter when not set (null/undefined)", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({ title: "No claim task" });

		const reloaded = await core.getTask(task.id);
		expect(reloaded?.claim).toBeUndefined();
	});

	it("claim null after release (serialized as absent)", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({ title: "Release test" });

		// Set claim
		const claim = {
			by: "agent-1",
			at: "2026-07-19T10:00:00Z",
			expiresAt: "2026-07-19T10:15:00Z",
		};
		await core.fs.saveTask({ ...task, claim });

		// Release (set to null)
		const claimed = await core.getTask(task.id);
		await core.fs.saveTask({ ...claimed!, claim: null });

		const reloaded = await core.getTask(task.id);
		expect(reloaded?.claim).toBeUndefined();
	});
});

describe("Claim Ownership — MCP tool handlers", () => {
	let testDir: string;
	let server: McpServer;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "backlog-claim-mcp-"));
		server = new McpServer(testDir, "Test instructions");
		await server.filesystem.ensureBacklogStructure();
		await initializeTestProject(server, "Claim MCP Test");
		// Register tools manually (normally done in createMcpServer)
		registerWorkflowResources(server);
		registerWorkflowTools(server);
		const config = await server.filesystem.loadConfig();
		registerTaskTools(server, config!);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	async function callTool(name: string, args: Record<string, unknown>) {
		return server.testInterface.callTool({ params: { name, arguments: args } });
	}

	/** Safely extract text from CallToolResult content (union type). */
	function getText(result: { content: Array<{ type: string; text?: string }> }): string {
		const first = result.content[0];
		if (!first || first.type !== "text" || typeof first.text !== "string") {
			throw new Error("Expected text content in result");
		}
		return first.text;
	}

	it("task_claim sets claim on unclaimed task", async () => {
		// Create a task first
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({ title: "Claim me" });

		const result = await callTool("task_claim", { id: task.id, actorId: "agent-alpha" });
		const text = JSON.parse(getText(result));
		expect(text.result).toBe("success");
		expect(text.claim?.by).toBe("agent-alpha");
		expect(text.claim?.expiresAt).toBeTruthy();

		// Verify persisted to disk (use readTaskFresh to bypass Bun.file cache)
		const reloaded = await server.filesystem.readTaskFresh(task.id);
		expect(reloaded?.claim?.by).toBe("agent-alpha");
	});

	it("task_claim by same actor renews claim", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({ title: "Renew me" });

		// First claim
		const r1 = await callTool("task_claim", { id: task.id, actorId: "agent-beta", ttlSeconds: 60 });
		const r1text = JSON.parse(getText(r1));
		const firstExpiry = r1text.claim.expiresAt;

		// Wait a tiny bit then renew
		await new Promise((r) => setTimeout(r, 100));
		const result = await callTool("task_claim", { id: task.id, actorId: "agent-beta", ttlSeconds: 60 });
		const text = JSON.parse(getText(result));
		expect(text.result).toBe("success");
		expect(text.renewed).toBe(true);

		// Expiry should be later (renew extends TTL from the renewal moment)
		expect(new Date(text.claim.expiresAt).getTime()).toBeGreaterThan(new Date(firstExpiry).getTime());
	});

	it("task_claim by different actor with active claim → DENY", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({ title: "Contested task" });

		// Agent A claims
		await callTool("task_claim", { id: task.id, actorId: "agent-A", ttlSeconds: 900 });

		// Agent B tries to claim same task
		const result = await callTool("task_claim", { id: task.id, actorId: "agent-B" });
		const text = JSON.parse(getText(result));
		expect(text.result).toBe("already_claimed");
		expect(text.claimedBy).toBe("agent-A");
		expect(text.retryAfterMs).toBeGreaterThan(0);
	});

	it("task_claim on terminal status → DENY", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({ title: "Done task" });

		// Move to Done
		await core.editTaskOrDraft(task.id, { status: "Done" });

		const result = await callTool("task_claim", { id: task.id, actorId: "agent-late" });
		const text = JSON.parse(getText(result));
		expect(text.result).toBe("terminal_item");
		expect(text.status).toBe("Done");
	});

	it("task_claim on expired claim → take over", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({ title: "Expired claim task" });

		// Agent A claims with 1 second TTL
		await callTool("task_claim", { id: task.id, actorId: "agent-A", ttlSeconds: 1 });

		// Wait for expiry
		await new Promise((r) => setTimeout(r, 1200));

		// Agent B takes over
		const result = await callTool("task_claim", { id: task.id, actorId: "agent-B" });
		const text = JSON.parse(getText(result));
		expect(text.result).toBe("success");
		expect(text.claim.by).toBe("agent-B");
	});

	it("task_release by claim holder → success", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({ title: "Release me" });

		await callTool("task_claim", { id: task.id, actorId: "agent-holder" });

		const result = await callTool("task_release", { id: task.id, actorId: "agent-holder" });
		const text = JSON.parse(getText(result));
		expect(text.result).toBe("success");

		// Verify claim removed from disk (use readTaskFresh to bypass Bun.file cache)
		const reloaded = await server.filesystem.readTaskFresh(task.id);
		expect(reloaded?.claim).toBeUndefined();
	});

	it("task_release by non-holder → not_claimed_by_you", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({ title: "Wrong release" });

		await callTool("task_claim", { id: task.id, actorId: "agent-owner" });

		const result = await callTool("task_release", { id: task.id, actorId: "agent-intruder" });
		const text = JSON.parse(getText(result));
		expect(text.result).toBe("not_claimed_by_you");
		expect(text.claimedBy).toBe("agent-owner");
	});

	it("task_release on unclaimed task → not_claimed", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({ title: "Never claimed" });

		const result = await callTool("task_release", { id: task.id, actorId: "agent-nobody" });
		const text = JSON.parse(getText(result));
		expect(text.result).toBe("not_claimed");
	});

	it("claim writes activity log entry", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({
			title: "Activity claim test",
			actorId: "creator-agent",
		});

		await callTool("task_claim", { id: task.id, actorId: "claimer-agent" });

		const activityPath = join(testDir, "backlog", "activity", `${task.id.toLowerCase()}.md`);
		expect(await exists(activityPath)).toBe(true);
		const content = await readFile(activityPath, "utf-8");
		expect(content).toContain("action: claim");
		expect(content).toContain("[@claimer-agent]");
	});

	it("concurrent claim race — two simultaneous claims, exactly one wins", async () => {
		const core = new Core(testDir);
		const { task } = await core.createTaskFromInput({ title: "Race condition" });

		// Two agents claim at the same time
		const [resultA, resultB] = await Promise.all([
			callTool("task_claim", { id: task.id, actorId: "agent-race-A" }),
			callTool("task_claim", { id: task.id, actorId: "agent-race-B" }),
		]);

		const textA = JSON.parse(getText(resultA));
		const textB = JSON.parse(getText(resultB));

		// Exactly one should succeed, the other should be denied
		const successes = [textA, textB].filter((t) => t.result === "success");
		const denied = [textA, textB].filter((t) => t.result === "already_claimed");
		expect(successes.length).toBe(1);
		expect(denied.length).toBe(1);
	});
});
