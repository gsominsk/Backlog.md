// HYBRID-BOARD: ActivityLog model — audit trail entries (spec §5.3)

export const TRIGGERS = ["start", "complete", "block", "hold", "resume", "cancel", "reopen"] as const;
export type Trigger = (typeof TRIGGERS)[keyof typeof TRIGGERS];

export interface ActivityEntry {
	readonly timestamp: string; // ISO 8601 UTC
	readonly actorId: string | null; // flat string, not ActorClaim object
	readonly action: string; // "status_change" | "comment" | "claim" | "release" | "create" | "update" | "archive" | "complete"
	readonly from?: string | null;
	readonly to?: string | null;
	readonly trigger?: Trigger | null;
	readonly summary?: string | null;
	readonly traceId?: string | null; // ZCode traceId for cross-source correlation (doc-8)
}

export function createActivityEntry(input: {
	actorId?: string | null;
	action: string;
	from?: string | null;
	to?: string | null;
	trigger?: Trigger | null;
	summary?: string | null;
	traceId?: string | null;
}): ActivityEntry {
	return {
		timestamp: new Date().toISOString(),
		actorId: input.actorId ?? null,
		action: input.action,
		from: input.from ?? null,
		to: input.to ?? null,
		trigger: input.trigger ?? null,
		summary: input.summary ?? null,
		traceId: input.traceId ?? null,
	};
}

/** Format entry as one line for append. Escapes | and newlines in summary. */
export function formatActivityLine(entry: ActivityEntry): string {
	const parts = [`[${entry.timestamp}]`, `[@${entry.actorId ?? "unknown"}]`, `action: ${entry.action}`];
	if (entry.from && entry.to) parts.push(`${entry.from} → ${entry.to}`);
	if (entry.trigger) parts.push(`trigger: ${entry.trigger}`);
	if (entry.traceId) parts.push(`traceId: ${entry.traceId}`);
	if (entry.summary) {
		// Escape pipe and newlines to not break line format
		const escaped = entry.summary.replace(/\|/g, "\\|").replace(/\n/g, " ");
		parts.push(`summary: "${escaped}"`);
	}
	return `- ${parts.join(" | ")}`;
}
