// HYBRID-BOARD: ActorClaim model — simplified, flat strings (spec §4)

export const ActorKind = {
	ORCHESTRATOR: "orchestrator",
	SUBAGENT: "subagent",
	USER: "user",
	EXTERNAL: "external",
} as const;
export type ActorKind = (typeof ActorKind)[keyof typeof ActorKind];

const VALID_KINDS = new Set<string>(Object.values(ActorKind));

/** Parse a string into ActorKind, or null if invalid. Case-insensitive. */
export function actorKindFromString(value: string): ActorKind | null {
	const lower = value.toLowerCase();
	return VALID_KINDS.has(lower) ? (lower as ActorKind) : null;
}

export class ValidationException extends Error {}

/** Validate actor ID — non-blank, ≤ 500 chars. */
export function validateActorId(id: string): void {
	if (!id || id.trim() === "") throw new ValidationException("Actor id must not be blank");
	if (id.length > 500) throw new ValidationException("Actor id must not exceed 500 characters");
}
