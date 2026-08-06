// HYBRID-BOARD: ActivityLog storage — append to separate files (spec §5.4)

import { appendFile, exists, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActivityEntry } from "../domain/activity_entry.ts";
import { formatActivityLine } from "../domain/activity_entry.ts";

/**
 * Append an activity entry to the task's activity log file.
 * File: backlog/activity/{task-id}.md — created on first append with header.
 */
export async function appendActivity(backlogDir: string, taskId: string, entry: ActivityEntry): Promise<void> {
	const activityDir = join(backlogDir, "activity");
	const activityPath = join(activityDir, `${taskId.toLowerCase()}.md`);

	await mkdir(activityDir, { recursive: true }).catch((e) => {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
	});

	const line = formatActivityLine(entry) + "\n";
	// Check if file exists — first entry needs header
	const fileExists = await exists(activityPath);
	if (!fileExists) {
		const header = `# Activity Log: ${taskId}\n\n`;
		await appendFile(activityPath, header + line);
	} else {
		await appendFile(activityPath, line);
	}
}

/**
 * Read activity log for a task, with optional pagination.
 * Returns lines (without header) in reverse chronological order (most recent first).
 */
export async function readActivity(
	backlogDir: string,
	taskId: string,
	limit = 50,
	offset = 0,
): Promise<{ entries: string[]; total: number }> {
	const activityDir = join(backlogDir, "activity");
	const activityPath = join(activityDir, `${taskId.toLowerCase()}.md`);

	let content: string;
	try {
		content = await readFile(activityPath, "utf-8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") {
			return { entries: [], total: 0 };
		}
		throw e;
	}

	// Split into lines, skip header lines (starting with # or empty)
	const allLines = content
		.split("\n")
		.filter((line) => line.startsWith("- "))
		.reverse(); // most recent first

	const total = allLines.length;
	const entries = allLines.slice(offset, offset + limit);

	return { entries, total };
}
