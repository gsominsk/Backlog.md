import type { BacklogConfig } from "../../../types/index.ts";
import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import {
	generateTaskCreateSchema,
	generateTaskEditSchema,
	generateTaskListSchema,
	generateTaskSearchSchema,
} from "../../utils/schema-generators.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { TaskCreateArgs, TaskEditRequest, TaskListArgs, TaskSearchArgs } from "./handlers.ts";
import { TaskHandlers } from "./handlers.ts";
import {
	taskActivityGetSchema,
	taskArchiveSchema,
	taskClaimSchema,
	taskCompleteSchema,
	taskReleaseSchema,
	taskViewSchema,
} from "./schemas.ts";

export function registerTaskTools(server: McpServer, config: BacklogConfig): void {
	const handlers = new TaskHandlers(server);

	const taskCreateSchema = generateTaskCreateSchema(config);
	const taskEditSchema = generateTaskEditSchema(config);
	const taskListSchema = generateTaskListSchema(config);
	const taskSearchSchema = generateTaskSearchSchema(config);

	const createTaskTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_create",
			description: "Create a new task using Backlog.md",
			inputSchema: taskCreateSchema,
			annotations: { title: "Create Task", destructiveHint: false },
		},
		taskCreateSchema,
		async (input) => handlers.createTask(input as TaskCreateArgs),
	);

	const listTaskTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_list",
			description:
				"List Backlog.md tasks with optional filtering by status, type, assignee (or unassigned: true for tasks with no assignee), milestone, labels, and search",
			inputSchema: taskListSchema,
			annotations: { title: "List Tasks", readOnlyHint: true, destructiveHint: false },
		},
		taskListSchema,
		async (input) => handlers.listTasks(input as TaskListArgs),
	);

	const searchTaskTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_search",
			description: "Search Backlog.md tasks by title, description, task type, and modified file path filters",
			inputSchema: taskSearchSchema,
			annotations: { title: "Search Tasks", readOnlyHint: true, destructiveHint: false },
		},
		taskSearchSchema,
		async (input) => handlers.searchTasks(input as TaskSearchArgs),
	);

	const editTaskTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_edit",
			description:
				"Edit a Backlog.md task, including metadata (status, priority, type), implementation plan/notes, dependencies, acceptance criteria, and task-specific Definition of Done items",
			inputSchema: taskEditSchema,
			annotations: { title: "Edit Task", destructiveHint: false },
		},
		taskEditSchema,
		async (input) => handlers.editTask(input as unknown as TaskEditRequest),
	);

	const viewTaskTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_view",
			description: "View a Backlog.md task details",
			inputSchema: taskViewSchema,
			annotations: { title: "View Task", readOnlyHint: true, destructiveHint: false },
		},
		taskViewSchema,
		async (input) => handlers.viewTask(input as { id: string }),
	);

	const archiveTaskTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_archive",
			description: "Archive a Backlog.md task",
			inputSchema: taskArchiveSchema,
			annotations: { title: "Archive Task", destructiveHint: true },
		},
		taskArchiveSchema,
		async (input) => handlers.archiveTask(input as { id: string; actorId?: string; actorKind?: string }),
	);

	const completeTaskTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_complete",
			description: "Complete a Backlog.md task (move it to the completed folder)",
			inputSchema: taskCompleteSchema,
			annotations: { title: "Complete Task", destructiveHint: true },
		},
		taskCompleteSchema,
		async (input) => handlers.completeTask(input as { id: string; actorId?: string; actorKind?: string }),
	);

	server.addTool(createTaskTool);
	server.addTool(listTaskTool);
	server.addTool(searchTaskTool);
	server.addTool(editTaskTool);
	server.addTool(viewTaskTool);
	server.addTool(archiveTaskTool);
	server.addTool(completeTaskTool);

	// HYBRID-BOARD: ActivityLog — task_activity_get (spec §5.6)
	const activityGetTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_activity_get",
			description:
				"Retrieve the activity log for a Backlog.md task (audit trail of status changes, comments, claims, releases)",
			inputSchema: taskActivityGetSchema,
			annotations: { title: "Get Task Activity", readOnlyHint: true, destructiveHint: false },
		},
		taskActivityGetSchema,
		async (input) => handlers.getActivity(input as { id: string; limit?: number; offset?: number }),
	);
	server.addTool(activityGetTool);

	// HYBRID-BOARD: Claim ownership — task_claim (spec §6.5)
	const claimTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_claim",
			description:
				"Claim a task for an agent (ownership lock with TTL). Three-way logic: no claim → set, same actor → renew, different actor → deny. Auto-renews on any tool call from same actor.",
			inputSchema: taskClaimSchema,
			annotations: { title: "Claim Task", destructiveHint: false },
		},
		taskClaimSchema,
		async (input) =>
			handlers.claimTask(input as { id: string; actorId: string; actorKind?: string; ttlSeconds?: number }),
	);
	server.addTool(claimTool);

	// HYBRID-BOARD: Claim ownership — task_release (spec §6.5)
	const releaseTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_release",
			description: "Release a task claim. Only the current claim holder can release. Used for handoffs between agents.",
			inputSchema: taskReleaseSchema,
			annotations: { title: "Release Task Claim", destructiveHint: false },
		},
		taskReleaseSchema,
		async (input) => handlers.releaseTask(input as { id: string; actorId: string }),
	);
	server.addTool(releaseTool);
}

export type { TaskCreateArgs, TaskEditArgs, TaskListArgs, TaskSearchArgs } from "./handlers.ts";
export {
	taskActivityGetSchema,
	taskArchiveSchema,
	taskClaimSchema,
	taskCompleteSchema,
	taskListSchema,
	taskReleaseSchema,
	taskSearchSchema,
	taskViewSchema,
} from "./schemas.ts";
