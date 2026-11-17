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
	statSync,
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

/**
 * Compact age label with a fixed two-digit number column: `now`, ` 5m`, `23h`,
 * ` 3d`, ` 4w`, ` 1y`. No "ago" suffix.
 */
export function relativeTime(date: Date, now: number = Date.now()): string {
	const ms = Math.max(0, now - date.getTime());
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${twoDigits(minutes)}m`;
	const hours = Math.floor(ms / 3_600_000);
	if (hours < 72) return `${twoDigits(hours)}h`;
	const days = Math.floor(ms / 86_400_000);
	if (days < 21) return `${twoDigits(days)}d`;
	const weeks = Math.floor(days / 7);
	if (weeks < 52) return `${twoDigits(weeks)}w`;
	return `${twoDigits(Math.floor(weeks / 52))}y`;
}

/** Right-align the number in a two-character column. */
function twoDigits(value: number): string {
	return String(value).padStart(2, " ");
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

/** Buffers tried when reading the first entry; a huge first entry falls back to a larger one. */
const FIRST_ENTRY_READ_SIZES = [16 * 1024, 256 * 1024, 4 * 1024 * 1024] as const;

interface FirstEntryCache {
	mtimeMs: number;
	id: string | undefined;
}

const firstEntryCache = new Map<string, FirstEntryCache>();

function readBytes(file: string, length: number): string {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		const read = readSync(fd, buffer, 0, length, 0);
		return buffer.subarray(0, read).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/**
 * The `id` of a session's first non-header entry, or undefined when the file
 * has none. Forks and clones copy that entry (and its id) from their parent;
 * subagents start with a fresh one, which is how the picker tells them apart.
 */
export function firstEntryId(file: string): string | undefined {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
	const key = resolve(file);
	const cached = firstEntryCache.get(key);
	if (cached?.mtimeMs === mtimeMs) return cached.id;

	let id: string | undefined;
	for (const length of FIRST_ENTRY_READ_SIZES) {
		let text: string;
		try {
			text = readBytes(file, length);
		} catch {
			break;
		}
		let readMore = false;
		const lines = text.split("\n");
		for (let index = 1; index < lines.length; index++) {
			const line = lines[index]!.trim();
			if (!line) continue;
			try {
				const entry = JSON.parse(line) as { type?: unknown; id?: unknown };
				if (entry.type !== "session" && typeof entry.id === "string") id = entry.id;
			} catch {
				// A partial last line is retried with a larger buffer; anything else
				// means the file is malformed, so leave the id undefined.
				readMore = text.length === length && index === lines.length - 1;
			}
			break;
		}
		if (id !== undefined || !readMore) break;
	}
	firstEntryCache.set(key, { mtimeMs, id });
	return id;
}
