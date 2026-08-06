// HYBRID-BOARD: ActivityLog trigger derivation — config-aware (spec §5.5)

import type { Trigger } from "./activity_entry.ts";

/**
 * Derive trigger from status transition using config-driven statuses.
 * No hardcoded StatusLabels — reads from config.statuses at runtime.
 */
export function deriveTrigger(
	fromStatus: string | null,
	toStatus: string | null,
	config: { statuses: string[] },
): Trigger | null {
	if (!fromStatus || !toStatus) return null;

	const statuses = config.statuses;
	const fromIdx = statuses.indexOf(fromStatus);
	const toIdx = statuses.indexOf(toStatus);

	// If either status is not in config, can't derive
	if (fromIdx === -1 || toIdx === -1) return null;

	// Forward transition (e.g., To Do → In Progress, In Progress → Done)
	if (toIdx > fromIdx && toIdx === statuses.length - 1) {
		// Moving to last status = completion
		return "complete";
	}
	if (toIdx > fromIdx) {
		// Moving forward but not to final = started next phase
		return "start";
	}

	// Backward transition
	if (toIdx < fromIdx) {
		if (toIdx === 0) return "reopen"; // back to first status
		return "resume";
	}

	// Same status = no transition
	return null;
}
