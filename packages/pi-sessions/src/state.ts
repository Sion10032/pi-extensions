/**
 * Bookkeeping that must survive the session which wrote it.
 *
 * Two files are involved:
 * - `<agent>/sessions-archive/index.json` remembers the name, cwd and archive
 *   time of every session file this extension moved, keyed by its
 *   archive-relative path.
 * - `<agent>/pi-sessions-state.json` holds extension-wide state, currently
 *   only the sessions whose archiving was deferred until shutdown.
 *
 * Reads are deliberately forgiving: a missing, unreadable or corrupt file
 * yields an empty record so a broken index can never break `/sessions`.
 */
import {
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { archiveRoot } from "./paths.ts";

export interface IndexEntry {
	name: string;
	cwd: string;
	archivedAt: string;
	id?: string;
}

export interface PendingEntry {
	path: string;
	cwd: string;
	requestedAt: string;
}

/**
 * Archive-relative path of a session file maps to the metadata recorded when
 * it was archived.
 */
export function indexPath(): string {
	return join(archiveRoot(), "index.json");
}

/** Extension-wide state shared by the current and any later session. */
export function statePath(): string {
	return join(getAgentDir(), "pi-sessions-state.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse `file` as a JSON object; anything else becomes an empty record. */
function readJsonObject(file: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** Keep only object-valued entries, so one corrupt entry cannot poison the rest. */
function recordsOf<T extends object>(value: unknown): Record<string, T> {
	if (!isRecord(value)) return {};
	const records: Record<string, T> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isRecord(entry)) records[key] = entry as unknown as T;
	}
	return records;
}

/** Write `value` as JSON: create parents, write a sibling temp file, rename. */
export function writeJsonAtomic(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
}

export function readIndex(): Record<string, IndexEntry> {
	return recordsOf<IndexEntry>(readJsonObject(indexPath()));
}

export function writeIndex(entries: Record<string, IndexEntry>): void {
	writeJsonAtomic(indexPath(), entries);
}

function pendingOf(state: Record<string, unknown>): Record<string, PendingEntry> {
	return recordsOf<PendingEntry>(state.pendingArchive);
}

/** Sessions whose archiving was requested while they were still running. */
export function readPending(): Record<string, PendingEntry> {
	return pendingOf(readJsonObject(statePath()));
}

/** Record one deferred archive, leaving every other state key untouched. */
export function setPending(id: string, entry: PendingEntry): void {
	const state = readJsonObject(statePath());
	state.pendingArchive = { ...pendingOf(state), [id]: entry };
	writeJsonAtomic(statePath(), state);
}

/** Forget one deferred archive, leaving every other state key untouched. */
export function clearPending(id: string): void {
	const state = readJsonObject(statePath());
	const pending = pendingOf(state);
	delete pending[id];
	state.pendingArchive = pending;
	writeJsonAtomic(statePath(), state);
}
