import { isAmbiguousTaskIdError } from "../../utils/task-path.ts";
import type { CallToolResult } from "../types.ts";

/**
 * Base MCP error class for all MCP-related errors
 */
export class BacklogToolError extends Error {
	constructor(
		message: string,
		public code: string,
		public details?: unknown,
	) {
		super(message);
		this.name = "BacklogToolError";
	}
}

/**
 * Validation error for input validation failures
 */
export class McpValidationError extends BacklogToolError {
	constructor(message: string, validationError?: unknown) {
		super(message, "VALIDATION_ERROR", validationError);
	}
}

/**
 * Authentication error for auth failures
 */
export class McpAuthenticationError extends BacklogToolError {
	constructor(message = "Authentication required") {
		super(message, "AUTH_ERROR");
	}
}

/**
 * Connection error for transport-level failures
 */
export class McpConnectionError extends BacklogToolError {
	constructor(message: string, details?: unknown) {
		super(message, "CONNECTION_ERROR", details);
	}
}

/**
 * Transport-dropped field error — MCP transport serialization drops large
 * string values (>1KB) during subagent tool calls. The server receives the
 * call with the field missing. This is a transport limitation, not a server error.
 */
export class McpTransportDroppedError extends BacklogToolError {
	constructor(message: string, details?: { fields: string[]; receivedFields: string[] }) {
		super(message, "TRANSPORT_DROPPED", details);
	}
}

/**
 * Builds an actionable error message for transport-dropped fields.
 * Gives the model options (reduce, split, or Write tool), not just "don't retry".
 */
export function buildTransportDroppedMessage(
	toolName: string,
	droppedFields: string[],
	receivedFields: string[],
): string {
	const fieldsList = droppedFields.map((f) => `'${f}'`).join(", ");
	const receivedList = receivedFields.join(", ");
	return [
		`Required field(s) ${fieldsList} missing from ${toolName} call.`,
		`Received fields: ${receivedList}. The ${fieldsList} string was likely dropped by MCP`,
		"transport serialization (occurs with content >1KB in subagent calls).",
		"",
		"Options:",
		"1. Reduce content to <1KB and retry the call",
		"2. Split into multiple calls (create with short content, then update with additions)",
		"3. Use Write tool to write directly to the file — but note that frontmatter,",
		"   search index, and board metadata will not be updated (needs separate MCP call)",
	].join("\n");
}

/**
 * Internal error for unexpected failures
 */
export class McpInternalError extends BacklogToolError {
	constructor(message = "An unexpected error occurred", details?: unknown) {
		super(message, "INTERNAL_ERROR", details);
	}
}

/**
 * Formats MCP errors into standardized tool responses
 */
function buildErrorResult(code: string, message: string, details?: unknown): CallToolResult {
	const includeDetails = !!process.env.DEBUG;
	const structured = details !== undefined ? { code, details } : { code };
	return {
		content: [
			{
				type: "text",
				text: formatErrorMarkdown(code, message, details, includeDetails),
			},
		],
		isError: true,
		structuredContent: structured,
	};
}

export function handleBacklogToolError(error: unknown): CallToolResult {
	if (error instanceof BacklogToolError) {
		return buildErrorResult(error.code, error.message, error.details);
	}
	if (isAmbiguousTaskIdError(error)) {
		return buildErrorResult("AMBIGUOUS_TASK_ID", error.message, { candidates: error.candidates });
	}

	console.error("Unexpected MCP error:", error);

	return {
		content: [
			{
				type: "text",
				text: formatErrorMarkdown("INTERNAL_ERROR", "An unexpected error occurred", error, !!process.env.DEBUG),
			},
		],
		isError: true,
		structuredContent: {
			code: "INTERNAL_ERROR",
			details: error,
		},
	};
}

/**
 * Formats successful responses in a consistent structure
 */
export function handleMcpSuccess(data: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: "OK",
			},
		],
		structuredContent: {
			success: true,
			data,
		},
	};
}

/**
 * Format error messages in markdown for consistent MCP error responses
 */
export function formatErrorMarkdown(code: string, message: string, details?: unknown, includeDetails = false): string {
	// Always prefix with code so model can distinguish error types in text
	let result = `${code}: ${message}`;

	// Include details only when explicitly requested (e.g., debug mode)
	if (includeDetails && details) {
		const detailsText = typeof details === "string" ? details : JSON.stringify(details, null, 2);
		result += `\n  ${detailsText}`;
	}

	return result;
}
