import { generateTaskListSchema, generateTaskSearchSchema } from "../../utils/schema-generators.ts";
import type { JsonSchema } from "../../validation/validators.ts";

export const taskListSchema: JsonSchema = generateTaskListSchema({});

export const taskSearchSchema: JsonSchema = generateTaskSearchSchema({});

export const taskViewSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 50,
		},
	},
	required: ["id"],
	additionalProperties: false,
};

export const taskArchiveSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 50,
		},
		actorId: {
			type: "string",
			minLength: 1,
			maxLength: 500,
			description:
				"REQUIRED. Agent identity (who is archiving this task). Without actorId, no activity log entry is created — the MCP tool rejects this call if actorId is missing.",
		},
		actorKind: {
			type: "string",
			enum: ["orchestrator", "subagent", "user", "external"],
			description: "Optional actor kind for attribution.",
		},
		traceId: {
			type: "string",
			maxLength: 100,
			description: "Optional ZCode traceId for cross-source log correlation (doc-8).",
		},
	},
	required: ["id", "actorId"],
	additionalProperties: false,
};

export const taskCompleteSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 50,
		},
		actorId: {
			type: "string",
			minLength: 1,
			maxLength: 500,
			description:
				"REQUIRED. Agent identity (who is completing this task). Without actorId, no activity log entry is created — the MCP tool rejects this call if actorId is missing.",
		},
		actorKind: {
			type: "string",
			enum: ["orchestrator", "subagent", "user", "external"],
			description: "Optional actor kind for attribution.",
		},
		traceId: {
			type: "string",
			maxLength: 100,
			description: "Optional ZCode traceId for cross-source log correlation (doc-8).",
		},
	},
	required: ["id", "actorId"],
	additionalProperties: false,
};

export const taskDemoteSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 50,
		},
	},
	required: ["id"],
	additionalProperties: false,
};

// HYBRID-BOARD: ActivityLog — task_activity_get schema (spec §5.6)
export const taskActivityGetSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 50,
			description: "Task ID to retrieve activity log for.",
		},
		limit: {
			type: "number",
			minimum: 1,
			maximum: 200,
			description: "Maximum number of activity entries to return (default 50, most recent first).",
		},
		offset: {
			type: "number",
			minimum: 0,
			description: "Number of entries to skip for pagination (default 0).",
		},
	},
	required: ["id"],
	additionalProperties: false,
};

// HYBRID-BOARD: Claim ownership (spec §6.5)
export const taskClaimSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 50,
			description: "Task ID to claim.",
		},
		actorId: {
			type: "string",
			minLength: 1,
			maxLength: 500,
			description: "Agent identity (who is claiming this task).",
		},
		actorKind: {
			type: "string",
			enum: ["orchestrator", "subagent", "user", "external"],
			description: "Optional actor kind for attribution.",
		},
		ttlSeconds: {
			type: "number",
			minimum: 1,
			maximum: 86400,
			description:
				"Claim TTL in seconds (default 900 = 15 minutes). Claim auto-renews on any tool call from same actor.",
		},
		traceId: {
			type: "string",
			maxLength: 100,
			description: "Optional ZCode traceId for cross-source log correlation (doc-8).",
		},
	},
	required: ["id", "actorId"],
	additionalProperties: false,
};

export const taskReleaseSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 50,
			description: "Task ID to release claim on.",
		},
		actorId: {
			type: "string",
			minLength: 1,
			maxLength: 500,
			description: "Agent identity (who is releasing the claim). Must match the current claim holder.",
		},
		traceId: {
			type: "string",
			maxLength: 100,
			description: "Optional ZCode traceId for cross-source log correlation (doc-8).",
		},
	},
	required: ["id", "actorId"],
	additionalProperties: false,
};
