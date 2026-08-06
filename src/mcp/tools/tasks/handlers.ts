import { basename, join } from "node:path";
import { DEFAULT_STATUSES } from "../../../constants/index.ts";
import { findLocalDuplicateTaskIds } from "../../../core/duplicate-task-repair.ts";
// HYBRID-BOARD: Claim ownership (spec §6)
import { createActivityEntry } from "../../../domain/activity_entry.ts";
// HYBRID-BOARD: ActivityLog (spec §5)
import { appendActivity, readActivity } from "../../../file-system/activity-log.ts";
import { isCreateLockError } from "../../../file-system/operations.ts";
import {
	isLocalEditableTask,
	type SearchPriorityFilter,
	type Task,
	type TaskListFilter,
} from "../../../types/index.ts";
import type { TaskEditArgs, TaskEditRequest } from "../../../types/task-edit-args.ts";
import { formatDuplicateTaskIdWarning } from "../../../utils/duplicate-detection.ts";
import {
	createMilestoneFilterValueResolver,
	normalizeMilestoneFilterValue,
	resolveClosestMilestoneFilterValue,
} from "../../../utils/milestone-filter.ts";
import { resolveMilestoneInputForStorage } from "../../../utils/milestone-storage.ts";
import { buildTaskUpdateInput } from "../../../utils/task-edit-builder.ts";
import { getTaskPath } from "../../../utils/task-path.ts";
import { createTaskSearchIndex } from "../../../utils/task-search.ts";
import { sortByOrdinalAndPriority } from "../../../utils/task-sorting.ts";
import { getTerminalStatus, isTerminalStatus } from "../../../utils/terminal-status.ts";
import { BacklogToolError } from "../../errors/mcp-errors.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";
import { formatTaskCallResult } from "../../utils/task-response.ts";

export type TaskCreateArgs = {
	title: string;
	description?: string;
	labels?: string[];
	assignee?: string[];
	priority?: string;
	type?: string;
	ordinal?: number;
	status?: string;
	milestone?: string;
	parentTaskId?: string;
	acceptanceCriteria?: string[];
	definitionOfDoneAdd?: string[];
	disableDefinitionOfDoneDefaults?: boolean;
	dependencies?: string[];
	references?: string[];
	documentation?: string[];
	modifiedFiles?: string[];
	finalSummary?: string;
	// HYBRID-BOARD: ActorClaim — actor identity (spec §4.4)
	actorId?: string;
	actorKind?: string;
	traceId?: string; // ZCode traceId for cross-source correlation (doc-8)
};

export type TaskListArgs = {
	status?: string;
	type?: string[];
	assignee?: string;
	unassigned?: boolean;
	milestone?: string;
	labels?: string[];
	search?: string;
	limit?: number;
};

export type TaskSearchArgs = {
	query?: string;
	status?: string;
	type?: string[];
	priority?: SearchPriorityFilter;
	modifiedFiles?: string[];
	limit?: number;
};

export class TaskHandlers {
	constructor(private readonly core: McpServer) {}

	private async resolveMilestoneInput(milestone: string): Promise<string> {
		const [activeMilestones, archivedMilestones] = await Promise.all([
			this.core.filesystem.listMilestones(),
			this.core.filesystem.listArchivedMilestones(),
		]);
		return resolveMilestoneInputForStorage(milestone, activeMilestones, archivedMilestones);
	}

	private async getConfiguredStatuses(): Promise<string[]> {
		const config = await this.core.filesystem.loadConfig();
		return config?.statuses ?? [...DEFAULT_STATUSES];
	}

	private isDraftStatus(status?: string | null): boolean {
		return (status ?? "").trim().toLowerCase() === "draft";
	}

	private formatTaskSummaryLine(task: Task, options: { includeStatus?: boolean } = {}): string {
		const priorityIndicator = task.priority ? `[${task.priority.toUpperCase()}] ` : "";
		const typeIndicator = task.type ? `[${task.type}] ` : "";
		const status = task.status || (task.source === "completed" ? "Done" : "");
		const statusText = options.includeStatus && status ? ` (${status})` : "";
		return `  ${priorityIndicator}${typeIndicator}${task.id} - ${task.title}${statusText}`;
	}

	private async loadTaskOrThrow(id: string): Promise<Task> {
		const task = await this.core.getTask(id);
		if (!task) {
			throw new BacklogToolError(`Task not found: ${id}`, "TASK_NOT_FOUND");
		}
		return task;
	}

	async createTask(args: TaskCreateArgs): Promise<CallToolResult> {
		try {
			const rawOrdinal = (args as { ordinal?: unknown }).ordinal;
			if (rawOrdinal === null) {
				throw new BacklogToolError("Ordinal must be a non-negative number.", "VALIDATION_ERROR");
			}

			const acceptanceCriteria =
				args.acceptanceCriteria
					?.map((text) => String(text).trim())
					.filter((text) => text.length > 0)
					.map((text) => ({ text, checked: false })) ?? undefined;

			const milestone =
				typeof args.milestone === "string" ? await this.resolveMilestoneInput(args.milestone) : undefined;

			const { task: createdTask } = await this.core.createTaskFromInput({
				title: args.title,
				description: args.description,
				status: args.status,
				priority: args.priority,
				type: args.type,
				...(typeof rawOrdinal === "number" ? { ordinal: rawOrdinal } : {}),
				milestone,
				labels: args.labels,
				assignee: args.assignee,
				dependencies: args.dependencies,
				references: args.references,
				documentation: args.documentation,
				modifiedFiles: args.modifiedFiles,
				parentTaskId: args.parentTaskId,
				finalSummary: args.finalSummary,
				acceptanceCriteria,
				definitionOfDoneAdd: args.definitionOfDoneAdd,
				disableDefinitionOfDoneDefaults: args.disableDefinitionOfDoneDefaults,
				// HYBRID-BOARD: ActorClaim — pass actor identity (spec §7.1)
				...(args.actorId && { actorId: args.actorId }),
				...(args.actorKind && { actorKind: args.actorKind }),
				// doc-8: pass traceId for cross-source log correlation
				...(args.traceId && { traceId: args.traceId }),
			});

			return await formatTaskCallResult(createdTask);
		} catch (error) {
			if (isCreateLockError(error)) {
				throw new BacklogToolError(error.message, "OPERATION_FAILED");
			}
			if (error instanceof Error) {
				throw new BacklogToolError(error.message, "OPERATION_FAILED");
			}
			throw new BacklogToolError(String(error), "OPERATION_FAILED");
		}
	}

	async listTasks(args: TaskListArgs = {}): Promise<CallToolResult> {
		if (args.assignee && args.unassigned) {
			throw new BacklogToolError("unassigned cannot be combined with assignee.", "VALIDATION_ERROR");
		}
		const config = await this.core.filesystem.loadConfig();
		const priorities = config?.priorities;
		if (this.isDraftStatus(args.status)) {
			let drafts = await this.core.filesystem.listDrafts();
			if (args.search || args.type?.length) {
				const draftSearch = createTaskSearchIndex(drafts);
				drafts = draftSearch.search({ query: args.search, status: "Draft", type: args.type });
			}

			if (args.assignee) {
				drafts = drafts.filter((draft) => (draft.assignee ?? []).includes(args.assignee ?? ""));
			}
			if (args.unassigned) {
				drafts = drafts.filter((draft) => !(draft.assignee ?? []).some((value) => value.trim().length > 0));
			}
			if (args.milestone) {
				const [activeMilestones, archivedMilestones] = await Promise.all([
					this.core.filesystem.listMilestones(),
					this.core.filesystem.listArchivedMilestones(),
				]);
				const resolveMilestoneFilterValue = createMilestoneFilterValueResolver([
					...activeMilestones,
					...archivedMilestones,
				]);
				const milestoneFilter = resolveClosestMilestoneFilterValue(
					args.milestone,
					drafts.map((draft) => resolveMilestoneFilterValue(draft.milestone ?? "")),
				);
				drafts = drafts.filter(
					(draft) =>
						normalizeMilestoneFilterValue(resolveMilestoneFilterValue(draft.milestone ?? "")) === milestoneFilter,
				);
			}

			const labelFilters = args.labels ?? [];
			if (labelFilters.length > 0) {
				drafts = drafts.filter((draft) => {
					const draftLabels = draft.labels ?? [];
					return labelFilters.every((label) => draftLabels.includes(label));
				});
			}

			if (drafts.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No tasks found.",
						},
					],
				};
			}

			let sortedDrafts = sortByOrdinalAndPriority(drafts, priorities);
			if (typeof args.limit === "number" && args.limit >= 0) {
				sortedDrafts = sortedDrafts.slice(0, args.limit);
			}
			const lines = ["Draft:"];
			for (const draft of sortedDrafts) {
				lines.push(this.formatTaskSummaryLine(draft));
			}

			return {
				content: [
					{
						type: "text",
						text: lines.join("\n"),
					},
				],
			};
		}

		const filters: TaskListFilter = {};
		if (args.status) {
			filters.status = args.status;
		}
		if (args.type?.length) {
			filters.type = args.type;
		}
		if (args.assignee) {
			filters.assignee = args.assignee;
		}
		if (args.unassigned) {
			filters.unassigned = true;
		}
		if (args.milestone) {
			filters.milestone = args.milestone;
		}

		const tasks = await this.core.queryTasks({
			query: args.search,
			filters: Object.keys(filters).length > 0 ? filters : undefined,
			includeCrossBranch: false,
		});

		let filteredByLabels = tasks.filter((task) => isLocalEditableTask(task));
		const labelFilters = args.labels ?? [];
		if (labelFilters.length > 0) {
			filteredByLabels = filteredByLabels.filter((task) => {
				const taskLabels = task.labels ?? [];
				return labelFilters.every((label) => taskLabels.includes(label));
			});
		}

		if (filteredByLabels.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: "No tasks found.",
					},
				],
			};
		}

		const statuses = config?.statuses ?? [];

		const canonicalByLower = new Map<string, string>();
		for (const status of statuses) {
			canonicalByLower.set(status.toLowerCase(), status);
		}

		const grouped = new Map<string, Task[]>();
		for (const task of filteredByLabels) {
			const rawStatus = (task.status ?? "").trim();
			const canonicalStatus = canonicalByLower.get(rawStatus.toLowerCase()) ?? rawStatus;
			const bucketKey = canonicalStatus || "";
			const existing = grouped.get(bucketKey) ?? [];
			existing.push(task);
			grouped.set(bucketKey, existing);
		}

		const orderedStatuses = [
			...statuses.filter((status) => grouped.has(status)),
			...Array.from(grouped.keys()).filter((status) => !statuses.includes(status)),
		];

		const contentItems: Array<{ type: "text"; text: string }> = [];
		let remaining = typeof args.limit === "number" && args.limit >= 0 ? args.limit : undefined;
		for (const status of orderedStatuses) {
			const bucket = grouped.get(status) ?? [];
			const sortedBucket = sortByOrdinalAndPriority(bucket, priorities);
			const limitedBucket = remaining !== undefined ? sortedBucket.slice(0, remaining) : sortedBucket;
			if (remaining !== undefined) {
				remaining -= limitedBucket.length;
			}
			if (limitedBucket.length === 0) {
				continue;
			}
			const sectionLines: string[] = [`${status || "No Status"}:`];
			for (const task of limitedBucket) {
				sectionLines.push(this.formatTaskSummaryLine(task));
			}
			contentItems.push({
				type: "text",
				text: sectionLines.join("\n"),
			});
		}

		if (contentItems.length === 0) {
			contentItems.push({
				type: "text",
				text: "No tasks found.",
			});
		}

		try {
			const duplicateGroups = await findLocalDuplicateTaskIds(this.core);
			if (duplicateGroups.length > 0) {
				contentItems.unshift({
					type: "text",
					text: formatDuplicateTaskIdWarning(duplicateGroups),
				});
			}
		} catch {
			// Duplicate detection is best-effort; skip if filesystem is unavailable
		}

		return {
			content: contentItems,
		};
	}

	async searchTasks(args: TaskSearchArgs): Promise<CallToolResult> {
		const query = args.query?.trim() ?? "";
		const modifiedFiles = args.modifiedFiles?.map((file) => file.trim()).filter((file) => file.length > 0);
		if (!query && (!modifiedFiles || modifiedFiles.length === 0) && !args.type?.length) {
			throw new BacklogToolError("Search query, modifiedFiles, or type filter is required", "VALIDATION_ERROR");
		}

		if (this.isDraftStatus(args.status)) {
			const drafts = await this.core.filesystem.listDrafts();
			const searchIndex = createTaskSearchIndex(drafts);
			let draftMatches = searchIndex.search({
				query,
				status: "Draft",
				type: args.type,
				priority: args.priority,
				modifiedFiles,
			});
			if (typeof args.limit === "number" && args.limit >= 0) {
				draftMatches = draftMatches.slice(0, args.limit);
			}

			if (draftMatches.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No tasks found for "${query || modifiedFiles?.join(", ")}".`,
						},
					],
				};
			}

			const lines: string[] = ["Tasks:"];
			for (const draft of draftMatches) {
				lines.push(this.formatTaskSummaryLine(draft, { includeStatus: true }));
			}

			return {
				content: [
					{
						type: "text",
						text: lines.join("\n"),
					},
				],
			};
		}

		const tasks = await this.core.loadTasks(undefined, undefined, { includeCompleted: true });
		const searchIndex = createTaskSearchIndex(tasks);
		let taskMatches = searchIndex.search({
			query,
			status: args.status,
			type: args.type,
			priority: args.priority,
			modifiedFiles,
		});
		if (typeof args.limit === "number" && args.limit >= 0) {
			taskMatches = taskMatches.slice(0, args.limit);
		}

		const taskResults = taskMatches.filter((task) => isLocalEditableTask(task));
		if (taskResults.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No tasks found for "${query || modifiedFiles?.join(", ")}".`,
					},
				],
			};
		}

		const lines: string[] = ["Tasks:"];
		for (const task of taskResults) {
			lines.push(this.formatTaskSummaryLine(task, { includeStatus: true }));
		}

		return {
			content: [
				{
					type: "text",
					text: lines.join("\n"),
				},
			],
		};
	}

	async viewTask(args: { id: string }): Promise<CallToolResult> {
		const draft = await this.core.filesystem.loadDraft(args.id);
		if (draft) {
			return await formatTaskCallResult(draft);
		}

		const task = await this.core.getTaskWithSubtasks(args.id);
		if (!task) {
			throw new BacklogToolError(`Task not found: ${args.id}`, "TASK_NOT_FOUND");
		}
		return await formatTaskCallResult(task);
	}

	async archiveTask(args: {
		id: string;
		actorId?: string;
		actorKind?: string;
		traceId?: string;
	}): Promise<CallToolResult> {
		const draft = await this.core.filesystem.loadDraft(args.id);
		if (draft) {
			const success = await this.core.archiveDraft(draft.id);
			if (!success) {
				throw new BacklogToolError(`Failed to archive task: ${args.id}`, "OPERATION_FAILED");
			}

			return await formatTaskCallResult(draft, [`Archived draft ${draft.id}.`]);
		}

		const task = await this.loadTaskOrThrow(args.id);

		if (!isLocalEditableTask(task)) {
			throw new BacklogToolError(`Cannot archive task from another branch: ${task.id}`, "VALIDATION_ERROR");
		}

		const statuses = await this.getConfiguredStatuses();
		const terminalStatus = getTerminalStatus(statuses) ?? "Done";
		if (isTerminalStatus(task.status, statuses)) {
			throw new BacklogToolError(
				`Task ${task.id} is ${terminalStatus}. ${terminalStatus} tasks should be completed (moved to the completed folder), not archived. Use task_complete instead.`,
				"VALIDATION_ERROR",
			);
		}

		const success = await this.core.archiveTask(task.id);
		if (!success) {
			throw new BacklogToolError(`Failed to archive task: ${args.id}`, "OPERATION_FAILED");
		}

		// Activity log — best-effort, only when actorId provided
		if (args.actorId) {
			const backlogDir = join(this.core.fs.rootDir, this.core.fs.backlogDirName);
			await appendActivity(
				backlogDir,
				task.id,
				createActivityEntry({
					actorId: args.actorId,
					action: "archive",
					from: task.status,
					to: "Archived",
					traceId: args.traceId,
				}),
			).catch(() => {});
		}

		const refreshed = (await this.core.getTask(task.id)) ?? task;
		return await formatTaskCallResult(refreshed);
	}

	async completeTask(args: {
		id: string;
		actorId?: string;
		actorKind?: string;
		traceId?: string;
	}): Promise<CallToolResult> {
		const task = await this.loadTaskOrThrow(args.id);

		if (!isLocalEditableTask(task)) {
			throw new BacklogToolError(`Cannot complete task from another branch: ${task.id}`, "VALIDATION_ERROR");
		}

		const statuses = await this.getConfiguredStatuses();
		const terminalStatus = getTerminalStatus(statuses) ?? "Done";
		if (!isTerminalStatus(task.status, statuses)) {
			throw new BacklogToolError(
				`Task ${task.id} is not ${terminalStatus}. Set status to "${terminalStatus}" with task_edit before completing it.`,
				"VALIDATION_ERROR",
			);
		}

		const filePath = task.filePath ?? null;
		const completedFilePath = filePath ? join(this.core.filesystem.completedDir, basename(filePath)) : undefined;

		const success = await this.core.completeTask(task.id);
		if (!success) {
			throw new BacklogToolError(`Failed to complete task: ${args.id}`, "OPERATION_FAILED");
		}

		// Activity log — best-effort, only when actorId provided
		if (args.actorId) {
			const backlogDir = join(this.core.fs.rootDir, this.core.fs.backlogDirName);
			await appendActivity(
				backlogDir,
				task.id,
				createActivityEntry({
					actorId: args.actorId,
					action: "complete",
					from: task.status,
					to: "Completed",
					trigger: "complete",
					traceId: args.traceId,
				}),
			).catch(() => {});
		}

		return await formatTaskCallResult(task, [`Completed task ${task.id}.`], {
			filePathOverride: completedFilePath,
		});
	}

	async demoteTask(args: { id: string }): Promise<CallToolResult> {
		const task = await this.loadTaskOrThrow(args.id);
		let success: boolean;
		try {
			success = await this.core.demoteTask(task.id, false);
		} catch (error) {
			if (isCreateLockError(error)) {
				throw new BacklogToolError(error.message, "OPERATION_FAILED");
			}
			throw error;
		}
		if (!success) {
			throw new BacklogToolError(`Failed to demote task: ${args.id}`, "OPERATION_FAILED");
		}

		const refreshed = (await this.core.getTask(task.id)) ?? task;
		return await formatTaskCallResult(refreshed);
	}

	async editTask(args: TaskEditRequest): Promise<CallToolResult> {
		try {
			const rawOrdinal = (args as { ordinal?: unknown }).ordinal;
			if (rawOrdinal === null) {
				throw new BacklogToolError("Ordinal must be a non-negative number.", "VALIDATION_ERROR");
			}

			const updateInput = buildTaskUpdateInput(args);
			if (typeof updateInput.milestone === "string") {
				updateInput.milestone = await this.resolveMilestoneInput(updateInput.milestone);
			}
			const updatedTask = await this.core.editTaskOrDraft(args.id, updateInput);
			return await formatTaskCallResult(updatedTask);
		} catch (error) {
			if (error instanceof Error) {
				throw new BacklogToolError(error.message, "OPERATION_FAILED");
			}
			throw new BacklogToolError(String(error), "OPERATION_FAILED");
		}
	}

	// HYBRID-BOARD: ActivityLog — task_activity_get handler (spec §5.6)
	async getActivity(args: { id: string; limit?: number; offset?: number }): Promise<CallToolResult> {
		try {
			const backlogDir = join(this.core.fs.rootDir, this.core.fs.backlogDirName);
			const limit = typeof args.limit === "number" ? args.limit : 50;
			const offset = typeof args.offset === "number" ? args.offset : 0;
			const { entries, total } = await readActivity(backlogDir, args.id, limit, offset);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								taskId: args.id,
								total,
								limit,
								offset,
								entries,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new BacklogToolError(error.message, "OPERATION_FAILED");
			}
			throw new BacklogToolError(String(error), "OPERATION_FAILED");
		}
	}

	// HYBRID-BOARD: Claim ownership — three-way logic (spec §6.4-6.5)
	async claimTask(args: {
		id: string;
		actorId: string;
		actorKind?: string;
		ttlSeconds?: number;
		traceId?: string;
	}): Promise<CallToolResult> {
		try {
			const task = await this.core.getTask(args.id);
			if (!task) {
				throw new BacklogToolError(`Task not found: ${args.id}`, "TASK_NOT_FOUND");
			}

			// Terminal check (G4 fix) — can't claim done/archived tasks
			const statuses = await this.getConfiguredStatuses();
			if (isTerminalStatus(task.status, statuses)) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ result: "terminal_item", id: args.id, status: task.status }, null, 2),
						},
					],
				};
			}

			const taskPath = await getTaskPath(args.id, this.core);
			if (!taskPath) {
				throw new BacklogToolError(`Task file not found: ${args.id}`, "TASK_NOT_FOUND");
			}

			const ttl = args.ttlSeconds ?? 900;

			// Three-way logic inside withWriteLock (spec §6.4)
			return await this.core.fs.withWriteLock(taskPath, async () => {
				// Read fresh from disk (bypass Bun.file cache) — critical after atomicWrite
				const lockedTask = await this.core.fs.readTaskFresh(args.id);
				if (!lockedTask) {
					throw new BacklogToolError(`Task not found: ${args.id}`, "TASK_NOT_FOUND");
				}
				if (isTerminalStatus(lockedTask.status, statuses)) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ result: "terminal_item", id: args.id, status: lockedTask.status }, null, 2),
							},
						],
					};
				}

				// Compute now inside lock — fresh timestamp for each call
				const now = new Date();
				const currentExpired = lockedTask.claim ? new Date(lockedTask.claim.expiresAt) < now : true;

				// No claim or expired → set/take
				if (!lockedTask.claim || currentExpired) {
					const newClaim = {
						by: args.actorId,
						at: now.toISOString(),
						expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
					};
					const updated = { ...lockedTask, claim: newClaim };
					await this.core.fs.saveTaskUnlocked(updated);

					// Activity log — best-effort
					const backlogDir = join(this.core.fs.rootDir, this.core.fs.backlogDirName);
					await appendActivity(
						backlogDir,
						lockedTask.id,
						createActivityEntry({
							actorId: args.actorId,
							action: "claim",
							trigger: "start",
							traceId: args.traceId,
						}),
					).catch(() => {});

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ result: "success", id: args.id, claim: newClaim }, null, 2),
							},
						],
					};
				}

				// Same actor → renew
				if (lockedTask.claim.by === args.actorId) {
					const renewedClaim = {
						...lockedTask.claim,
						at: now.toISOString(),
						expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
					};
					const updated = { ...lockedTask, claim: renewedClaim };
					await this.core.fs.saveTaskUnlocked(updated);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ result: "success", id: args.id, claim: renewedClaim, renewed: true }, null, 2),
							},
						],
					};
				}

				// Different actor, active claim → DENY (return actor ID, no tiered disclosure)
				const retryAfterMs = Math.max(0, new Date(lockedTask.claim.expiresAt).getTime() - now.getTime());
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									result: "already_claimed",
									id: args.id,
									claimedBy: lockedTask.claim.by,
									retryAfterMs,
								},
								null,
								2,
							),
						},
					],
				};
			});
		} catch (error) {
			if (error instanceof Error) {
				throw new BacklogToolError(error.message, "OPERATION_FAILED");
			}
			throw new BacklogToolError(String(error), "OPERATION_FAILED");
		}
	}

	// HYBRID-BOARD: Release claim (spec §6.5)
	async releaseTask(args: { id: string; actorId: string; traceId?: string }): Promise<CallToolResult> {
		try {
			const task = await this.core.getTask(args.id);
			if (!task) {
				throw new BacklogToolError(`Task not found: ${args.id}`, "TASK_NOT_FOUND");
			}

			const taskPath = await getTaskPath(args.id, this.core);
			if (!taskPath) {
				throw new BacklogToolError(`Task file not found: ${args.id}`, "TASK_NOT_FOUND");
			}

			return await this.core.fs.withWriteLock(taskPath, async () => {
				const lockedTask = await this.core.fs.readTaskFresh(args.id);
				if (!lockedTask) {
					throw new BacklogToolError(`Task not found: ${args.id}`, "TASK_NOT_FOUND");
				}

				if (!lockedTask.claim) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ result: "not_claimed", id: args.id }, null, 2),
							},
						],
					};
				}

				if (lockedTask.claim.by !== args.actorId) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										result: "not_claimed_by_you",
										id: args.id,
										claimedBy: lockedTask.claim.by,
									},
									null,
									2,
								),
							},
						],
					};
				}

				const updated = { ...lockedTask, claim: null };
				await this.core.fs.saveTaskUnlocked(updated);

				// Activity log — best-effort
				const backlogDir = join(this.core.fs.rootDir, this.core.fs.backlogDirName);
				await appendActivity(
					backlogDir,
					lockedTask.id,
					createActivityEntry({
						actorId: args.actorId,
						action: "release",
						traceId: args.traceId,
					}),
				).catch(() => {});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ result: "success", id: args.id }, null, 2),
						},
					],
				};
			});
		} catch (error) {
			if (error instanceof Error) {
				throw new BacklogToolError(error.message, "OPERATION_FAILED");
			}
			throw new BacklogToolError(String(error), "OPERATION_FAILED");
		}
	}
}

export type { TaskEditArgs, TaskEditRequest };
