/**
 * `/undo`: rewind the current session to just before its newest user message.
 *
 * Unlike `/fork`, which writes a child session file, undo stays in the same
 * file: the tail is cut from the JSONL and the session is reloaded from disk,
 * so the abandoned turn leaves neither a fork subtree nor an unselected branch
 * behind in `/tree`.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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

/** How many rows an undo kept and dropped. */
export interface TruncateResult {
	kept: number;
	removed: number;
}

/**
 * Keep the header row and every row up to and including the last row whose
 * parsed `id` is `throughId`, dropping the rest. `throughId === null` keeps the
 * header alone, which is what undoing the very first prompt leaves behind.
 *
 * Rows are compared by parsed id rather than by index because a session file is
 * append-ordered across branches: rows written after the kept one belong either
 * to the abandoned turn or to an older branch, and both go.
 */
export function truncateSessionFile(file: string, throughId: string | null): TruncateResult {
	const rows = readFileSync(file, "utf8").split("\n");
	while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
	const keepIndex = throughId === null ? 0 : lastRowWithId(rows, throughId);
	if (keepIndex === -1) throw new Error(`Session entry not found: ${throughId}`);
	const kept = rows.slice(0, keepIndex + 1);
	writeAtomically(file, `${kept.join("\n")}\n`);
	return { kept: kept.length, removed: rows.length - kept.length };
}

/** Index of the last row that parses to an entry with this id, or -1. */
function lastRowWithId(rows: string[], id: string): number {
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		if (parseRowId(rows[index]!) === id) return index;
	}
	return -1;
}

/** The `id` of one JSONL row; blank and unparseable rows have none. */
function parseRowId(row: string): string | undefined {
	if (row.trim() === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(row);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const id = (parsed as { id?: unknown }).id;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}

/** Replace `file` in one step; pi appends per entry and holds no descriptor, so a rename is safe. */
function writeAtomically(file: string, content: string): void {
	const tmp = join(dirname(file), `.${basename(file)}.tmp`);
	writeFileSync(tmp, content);
	renameSync(tmp, file);
}
