/**
 * `/undo`: rewind the current session to just before its newest user message.
 *
 * Unlike `/fork`, which writes a child session file, undo stays in the same
 * file: the tail is cut from the JSONL and the session is reloaded from disk,
 * so the abandoned turn leaves neither a fork subtree nor an unselected branch
 * behind in `/tree`.
 */
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** Where an undo rewinds to: the parent entry, and the prompt to restore. */
export interface UndoTarget {
	entryId: string;
	parentId: string | null;
	/** The prompt text, as `/fork` would put it back in the editor. */
	text: string;
}

/**
 * The newest user message on the active branch, nearest the leaf. Only real
 * user messages count: injected `custom_message` entries, bash results and
 * compaction summaries are not something the user typed, so they are skipped
 * even when they sit above the prompt.
 */
export function findUndoTarget(
	sessionManager: Pick<SessionManager, "getBranch">,
): UndoTarget | undefined {
	for (const entry of [...sessionManager.getBranch()].reverse()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		return {
			entryId: entry.id,
			parentId: entry.parentId,
			text: messageText(entry.message.content),
		};
	}
	return undefined;
}

/** Text of a user message, extracted the way pi's fork path extracts it. */
function messageText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text ?? "")
		.join("");
}
