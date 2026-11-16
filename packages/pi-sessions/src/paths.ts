/**
 * Path, name and session-header helpers shared by every part of the extension.
 *
 * Archive status is derived from directory location alone: a session file is
 * archived iff it sits under `<agent>/sessions-archive/`. Nothing here rewrites
 * a session header or name.
 */
import {
	closeSync,
	openSync,
	readSync,
} from "node:fs";
import {
	basename,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Legacy marker some session names carry; stripped for display and on restore. */
export const ARCHIVE_TAG = "[ARCHIVE] ";

/** One or more leading archive markers. The old plugin wrote a bare `[ARCHIVE]` for unnamed sessions. */
const LEADING_ARCHIVE_TAG = /^(?:\[ARCHIVE\]\s*)+/;

/** C0 controls, DEL and C1 controls would break the one-line picker layout. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** First line of a session JSONL file holds its header; 4KB is plenty. */
const HEADER_READ_BYTES = 4096;

/** Where pi keeps live sessions for every cwd. */
export function sessionsRoot(): string {
	return join(getAgentDir(), "sessions");
}

/** Where this extension moves archived sessions. */
export function archiveRoot(): string {
	return join(getAgentDir(), "sessions-archive");
}

/** Same encoding pi uses for per-cwd session subdirectories. */
export function cwdDirName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function sessionIdFromFile(file: string): string {
	return basename(file, ".jsonl").split("_").pop() ?? "";
}

/**
 * Path of `file` relative to `root`, with separators normalized to `/`.
 * Returns undefined when `file` is not strictly inside `root`.
 */
export function underRoot(root: string, file: string): string | undefined {
	const rel = relative(resolve(root), resolve(file));
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
	return rel.split(sep).join("/");
}

export function isArchived(file: string): boolean {
	return underRoot(archiveRoot(), file) !== undefined;
}

/**
 * The file itself plus its counterpart in the other tree: a live session maps
 * to where it would be archived and vice versa. Files outside both trees have
 * no twin.
 */
export function twinPaths(file: string): string[] {
	const abs = resolve(file);
	const live = underRoot(sessionsRoot(), abs);
	if (live !== undefined) return [abs, join(archiveRoot(), live)];
	const archived = underRoot(archiveRoot(), abs);
	if (archived !== undefined) return [abs, join(sessionsRoot(), archived)];
	return [abs];
}

/** Remove leading legacy archive markers and surrounding whitespace. */
export function stripArchiveTag(name: string | undefined): string {
	return (name ?? "").replace(LEADING_ARCHIVE_TAG, "").trim();
}

/** True when a name still starts with the legacy archive marker. */
export function hasArchiveTag(name: string | undefined): boolean {
	return LEADING_ARCHIVE_TAG.test(name ?? "");
}

/** Strip legacy archive tags; an empty result becomes `(unnamed)`. */
export function cleanName(name: string | undefined): string {
	const cleaned = stripArchiveTag(name);
	return cleaned || "(unnamed)";
}

/**
 * Collapse a title to a single line: control characters become spaces and runs
 * of whitespace collapse, so a message containing a newline or an escape
 * sequence cannot break the picker layout.
 */
function singleLine(text: string): string {
	return text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/** User-facing session title: the cleaned name, else the first message. */
export function displayTitle(info: { name?: string; firstMessage: string }): string {
	const named = singleLine(cleanName(info.name));
	if (named !== "" && named !== "(unnamed)") return named;
	return singleLine(info.firstMessage) || "(unnamed)";
}

/** Coarse age label, e.g. `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function relativeTime(date: Date, now: number = Date.now()): string {
	const sec = Math.floor((now - date.getTime()) / 1000);
	if (sec < 60) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	return `${Math.floor(hr / 24)}d ago`;
}

export interface HeaderLite {
	id?: string;
	cwd?: string;
	parentSession?: string;
}

/**
 * Read the session header (the first line of the JSONL file). Only the fields
 * callers need are returned; a missing or malformed file yields undefined.
 */
export function readHeader(file: string): HeaderLite | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const buffer = Buffer.alloc(HEADER_READ_BYTES);
		const read = readSync(fd, buffer, 0, HEADER_READ_BYTES, 0);
		const firstLine = buffer.subarray(0, read).toString("utf8").split("\n")[0];
		if (!firstLine) return undefined;
		const parsed = JSON.parse(firstLine) as Record<string, unknown>;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const header: HeaderLite = {};
		if (typeof parsed.id === "string") header.id = parsed.id;
		if (typeof parsed.cwd === "string") header.cwd = parsed.cwd;
		if (typeof parsed.parentSession === "string") header.parentSession = parsed.parentSession;
		return header;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
