export interface TaskEditArgs {
	title?: string;
	description?: string;
	status?: string;
	priority?: string;
	type?: string;
	milestone?: string | null;
	labels?: string[];
	addLabels?: string[];
	removeLabels?: string[];
	assignee?: string[];
	ordinal?: number;
	dependencies?: string[];
	references?: string[];
	addReferences?: string[];
	removeReferences?: string[];
	documentation?: string[];
	addDocumentation?: string[];
	removeDocumentation?: string[];
	modifiedFiles?: string[];
	implementationPlan?: string;
	planSet?: string;
	planAppend?: string[];
	planClear?: boolean;
	implementationNotes?: string;
	notesSet?: string;
	notesAppend?: string[];
	notesClear?: boolean;
	commentsAppend?: string[];
	commentAuthor?: string;
	finalSummary?: string;
	finalSummaryAppend?: string[];
	finalSummaryClear?: boolean;
	acceptanceCriteriaSet?: string[];
	acceptanceCriteriaAdd?: string[];
	acceptanceCriteriaRemove?: number[];
	acceptanceCriteriaCheck?: number[];
	acceptanceCriteriaUncheck?: number[];
	definitionOfDoneAdd?: string[];
	definitionOfDoneRemove?: number[];
	definitionOfDoneCheck?: number[];
	definitionOfDoneUncheck?: number[];
	// HYBRID-BOARD: ActorClaim — actor identity for attribution (spec §7.1)
	actorId?: string;
	actorKind?: string;
	traceId?: string; // ZCode traceId for cross-source correlation (doc-8)
}

export type TaskEditRequest = TaskEditArgs & { id: string };
