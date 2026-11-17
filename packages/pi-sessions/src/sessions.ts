/**
 * Loading, parent resolution and the collapsible forest the picker renders.
 *
 * Sessions live in two trees: `<agent>/sessions/` for the live ones and
 * `<agent>/sessions-archive/` for the ones this extension moved. A fork
 * records its parent as one path in its own header, written when the parent
 * happened to be somewhere in particular, so the path can point into the other
 * tree. Parent links are therefore resolved at read time - the recorded path
 * first, then its twin in the other tree - and never rewritten on disk.
 */
import { existsSync, readdirSync } from "node:fs";
import {
	basename,
	dirname,
	join,
	resolve,
} from "node:path";

import {
	SessionManager,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";

import {
	archiveRoot,
	cwdDirName,
	firstEntryId,
	isArchived,
	sessionsRoot,
	twinPaths,
	underRoot,
} from "./paths.ts";
import {
	hasName,
	matchScore,
	sortRecords,
	type ParsedQuery,
} from "./search.ts";
import {
	readIndex,
	type IndexEntry,
} from "./state.ts";
import type {
	ArchiveFilter,
	Scope,
	SessionRecord,
	SessionRelation,
	SortMode,
} from "./types.ts";

/** One row of the picker: a session plus what the tree renderer needs. */
export interface TreeRow {
	record: SessionRecord;
	/** Nesting level; roots are 0. */
	depth: number;
	/** Nodes in this row's subtree, excluding the row itself (hidden rows included). */
	descendantCount: number;
	/** Nodes below this row that the current view can actually render. */
	visibleDescendantCount: number;
	/** True when no later sibling follows at the same level. */
	isLast: boolean;
	/** Per ancestor level: whether that level's vertical line continues below. */
	ancestorContinues: boolean[];
}

/** One progress update emitted while a scope is loading. */
export type LoadPhase = "live" | "archive";

export interface LoadProgress {
	/** Sessions (live) or archive directories loaded so far. */
	loaded: number;
	/** Total sessions (live) or archive directories. */
	total: number;
	phase: LoadPhase;
}

export interface LoadSessionsOptions {
	signal?: AbortSignal;
	/** Called with the merged records after each batch; safe to render directly. */
	onProgress?: (records: SessionRecord[], progress: LoadProgress) => void;
}

/** `SessionManager.listAll`'s progress callback, without importing its type. */
type ListProgress = (loaded: number, total: number, partial?: readonly SessionInfo[]) => void;

/** Session infos from one directory; a missing or unreadable directory yields none. */
async function listAllInDir(
	dir: string,
	onProgress?: ListProgress,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	try {
		return await SessionManager.listAll(dir, onProgress, signal);
	} catch {
		signal?.throwIfAborted();
		return [];
	}
}

/**
 * Immediate subdirectories of the archive root. `listAll` is not recursive, so
 * the `all` scope has to visit them one by one; an unreadable root yields none.
 */
function archiveDirs(): string[] {
	try {
		return readdirSync(archiveRoot(), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(archiveRoot(), entry.name));
	} catch {
		return [];
	}
}

/** Archive index key of a file: its path relative to the archive root. */
function indexKey(file: string): string {
	return join(basename(dirname(file)), basename(file));
}

/** A stored ISO timestamp, or undefined when it is missing or unparseable. */
function toDate(value: unknown): Date | undefined {
	if (typeof value !== "string") return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * When an archived session was archived. The index is best effort, so a
 * session it does not know about (or an index that failed to parse) falls back
 * to the file's own modification time.
 */
function archivedAt(index: Record<string, IndexEntry>, info: SessionInfo): Date {
	return toDate(index[indexKey(info.path)]?.archivedAt) ?? info.modified;
}

/**
 * Fork/clone or subagent, from file content. A fork copies the parent's
 * entries, so its first non-header entry keeps the parent's id; a subagent
 * starts a fresh session (even when `inherit_context` feeds it parent text),
 * so its first entry id differs. A missing parent file falls back to
 * `subagent`, which keeps internal sessions out of the default view.
 */
function relationOf(info: SessionInfo): SessionRelation | undefined {
	const parentPath = info.parentSessionPath;
	if (!parentPath) return undefined;
	const parentFile = twinPaths(parentPath).find((path) => existsSync(path));
	if (parentFile === undefined) return "subagent";
	const childId = firstEntryId(info.path);
	const parentId = firstEntryId(parentFile);
	if (childId === undefined && parentId === undefined) return "fork";
	return childId !== undefined && childId === parentId ? "fork" : "subagent";
}

/** Deduplicate infos into records: live paths win, then session ids. */
function toRecords(infos: readonly SessionInfo[], index: Record<string, IndexEntry>): SessionRecord[] {
	const records = new Map<string, SessionRecord>();
	const seenIds = new Set<string>();
	for (const info of infos) {
		if (underRoot(sessionsRoot(), info.path) === undefined && underRoot(archiveRoot(), info.path) === undefined) {
			continue;
		}
		const key = resolve(info.path);
		if (records.has(key)) continue;
		if (info.id) {
			if (seenIds.has(info.id)) continue;
			seenIds.add(info.id);
		}
		const archived = isArchived(info.path);
		records.set(key, {
			info,
			archived,
			// A live file has no archive date of its own; a stale archived twin's
			// index entry must not stand in for it.
			archiveDate: archived ? archivedAt(index, info) : info.modified,
			relation: relationOf(info),
		});
	}
	return [...records.values()];
}

function byModified(a: SessionRecord, b: SessionRecord): number {
	return b.info.modified.getTime() - a.info.modified.getTime();
}

/**
 * Load every session the scope covers, live and archived, newest first.
 *
 * Live sessions are published as `SessionManager.listAll` discovers them, then
 * archive directories are merged one at a time, so the picker can render rows
 * while the scope is still loading. Only paths under the live or archive root
 * are kept. A session can exist twice - as a live file and as the archived copy
 * pi kept writing after the archive - and must still be one row, so the live
 * copy (listed first) wins over its archived twin.
 */
export async function loadSessions(
	scope: Scope,
	cwd: string,
	options: LoadSessionsOptions = {},
): Promise<SessionRecord[]> {
	const { signal, onProgress } = options;
	const cwdDir = cwdDirName(cwd);
	const index = readIndex();
	let live: SessionInfo[] = [];
	let archived: SessionInfo[] = [];

	const publish = (progress: LoadProgress): void => {
		if (!onProgress) return;
		onProgress(toRecords([...live, ...archived], index).sort(byModified), progress);
	};

	const liveProgress: ListProgress = (loaded, total, partial) => {
		if (partial === undefined) return;
		live = [...partial];
		publish({ loaded, total, phase: "live" });
	};

	signal?.throwIfAborted();
	if (scope === "current") {
		live = await listAllInDir(join(sessionsRoot(), cwdDir), liveProgress, signal);
	} else {
		try {
			live = await SessionManager.listAll(liveProgress, signal);
		} catch {
			signal?.throwIfAborted();
			live = [];
		}
	}
	publish({ loaded: live.length, total: live.length, phase: "live" });

	const dirs = scope === "current" ? [join(archiveRoot(), cwdDir)] : archiveDirs();
	for (const [dirIndex, dir] of dirs.entries()) {
		signal?.throwIfAborted();
		archived = [...archived, ...await listAllInDir(dir, undefined, signal)];
		publish({ loaded: dirIndex + 1, total: dirs.length, phase: "archive" });
	}

	signal?.throwIfAborted();
	return toRecords([...live, ...archived], index).sort(byModified);
}

/**
 * Apply the picker's filters: archive state first (by default only live
 * sessions are shown), then "named only", then the query. A missing query
 * keeps everything; an unusable `re:` query matches nothing.
 */
export function filterRecords(
	records: SessionRecord[],
	options: { archiveFilter?: ArchiveFilter; namedOnly?: boolean; query?: ParsedQuery } = {},
): SessionRecord[] {
	const { archiveFilter = "active", namedOnly = false, query } = options;
	return records.filter((record) => {
		if (archiveFilter === "active" && record.archived) return false;
		if (archiveFilter === "archived" && !record.archived) return false;
		if (namedOnly && !hasName(record.info)) return false;
		return query === undefined || matchScore(record.info, query) !== undefined;
	});
}

/**
 * The record a session hangs off. The recorded path is tried first, then the
 * same file in the other tree, so a live fork keeps its archived parent and an
 * archived fork keeps its restored one. An unresolvable parent makes a root.
 */
function findParent(
	record: SessionRecord,
	byPath: ReadonlyMap<string, SessionRecord>,
): SessionRecord | undefined {
	const parentPath = record.info.parentSessionPath;
	if (!parentPath) return undefined;
	for (const candidate of twinPaths(parentPath)) {
		const parent = byPath.get(resolve(candidate));
		if (parent !== undefined && parent !== record) return parent;
	}
	return undefined;
}

interface SubtreeStats {
	/** Nodes below the record, excluding it. */
	count: number;
	/** Newest `modified` in the subtree, in epoch milliseconds. */
	latest: number;
}

/** Subtree sizes over every loaded record, hidden or not. */
export function descendantCounts(records: SessionRecord[]): Map<SessionRecord, number> {
	const byPath = new Map<string, SessionRecord>();
	for (const record of records) byPath.set(resolve(record.info.path), record);
	const children = new Map<SessionRecord, SessionRecord[]>();
	for (const record of records) {
		const parent = findParent(record, byPath);
		if (parent === undefined) continue;
		const siblings = children.get(parent);
		if (siblings) siblings.push(record);
		else children.set(parent, [record]);
	}
	const counts = new Map<SessionRecord, number>();
	const onPath = new Set<SessionRecord>();
	const measure = (record: SessionRecord): number => {
		const done = counts.get(record);
		if (done !== undefined) return done;
		onPath.add(record);
		let count = 0;
		for (const child of children.get(record) ?? []) {
			if (onPath.has(child)) continue;
			count += 1 + measure(child);
		}
		onPath.delete(record);
		counts.set(record, count);
		return count;
	};
	for (const record of records) measure(record);
	return counts;
}

/**
 * Every loaded record below `root`, in DFS order, the root excluded.
 *
 * The traversal uses the same parent resolution as `descendantCounts`, so a
 * child whose parent lives in the other tree (the live/archive twin) still
 * hangs off `root`. `onPath` breaks a cycle a corrupt `parentSession` could
 * create.
 */
export function descendantRecords(records: SessionRecord[], root: SessionRecord): SessionRecord[] {
	const byPath = new Map<string, SessionRecord>();
	for (const record of records) byPath.set(resolve(record.info.path), record);
	const children = new Map<SessionRecord, SessionRecord[]>();
	for (const record of records) {
		const parent = findParent(record, byPath);
		if (parent === undefined) continue;
		const siblings = children.get(parent);
		if (siblings) siblings.push(record);
		else children.set(parent, [record]);
	}
	const result: SessionRecord[] = [];
	const onPath = new Set<SessionRecord>([root]);
	const walk = (record: SessionRecord): void => {
		for (const child of children.get(record) ?? []) {
			if (onPath.has(child)) continue;
			onPath.add(child);
			result.push(child);
			walk(child);
			onPath.delete(child);
		}
	};
	walk(root);
	return result;
}

/** Paths of records that have at least one child in this set. */
export function parentPaths(records: SessionRecord[]): Set<string> {
	const byPath = new Map<string, SessionRecord>();
	for (const record of records) byPath.set(resolve(record.info.path), record);
	const paths = new Set<string>();
	for (const record of records) {
		const parent = findParent(record, byPath);
		if (parent !== undefined) paths.add(parent.info.path);
	}
	return paths;
}

/** Build the nested forest: roots by the active sort, children only when expanded. */
function forest(
	ordered: SessionRecord[],
	expand: ReadonlySet<string>,
	sort: SortMode,
	counts?: ReadonlyMap<SessionRecord, number>,
): TreeRow[] {
	const byPath = new Map<string, SessionRecord>();
	for (const record of ordered) byPath.set(resolve(record.info.path), record);

	const children = new Map<SessionRecord, SessionRecord[]>();
	const roots: SessionRecord[] = [];
	for (const record of ordered) {
		const parent = findParent(record, byPath);
		if (parent === undefined) {
			roots.push(record);
			continue;
		}
		const siblings = children.get(parent);
		if (siblings) siblings.push(record);
		else children.set(parent, [record]);
	}

	const stats = new Map<SessionRecord, SubtreeStats>();
	const onPath = new Set<SessionRecord>();

	/** Subtree size and newest activity, computed once per record. */
	function measure(record: SessionRecord): SubtreeStats {
		const done = stats.get(record);
		if (done) return done;
		onPath.add(record);
		let count = 0;
		let latest = record.info.modified.getTime();
		for (const child of children.get(record) ?? []) {
			// A parent chain that loops back on itself must not recurse forever.
			if (onPath.has(child)) continue;
			const sub = measure(child);
			count += 1 + sub.count;
			latest = Math.max(latest, sub.latest);
		}
		onPath.delete(record);
		const fresh = { count, latest };
		stats.set(record, fresh);
		return fresh;
	}

	for (const record of ordered) measure(record);

	const latestOf = (record: SessionRecord): number =>
		stats.get(record)?.latest ?? record.info.modified.getTime();
	const byLatest = (a: SessionRecord, b: SessionRecord): number => latestOf(b) - latestOf(a);
	const byModified = (a: SessionRecord, b: SessionRecord): number =>
		b.info.modified.getTime() - a.info.modified.getTime();
	// Threaded order is by subtree activity; recent/relevance keep each sibling
	// level in the order `sortRecords` already produced.
	const compare = sort === "threaded" ? byLatest : byModified;

	const rows: TreeRow[] = [];
	const emitted = new Set<SessionRecord>();

	function emit(record: SessionRecord, depth: number, isLast: boolean, ancestorContinues: boolean[]): void {
		if (emitted.has(record)) return;
		emitted.add(record);
		const visible = stats.get(record)?.count ?? 0;
		rows.push({
			record,
			depth,
			descendantCount: counts?.get(record) ?? visible,
			visibleDescendantCount: visible,
			isLast,
			ancestorContinues,
		});
		if (!expand.has(record.info.path)) return;
		const kids = [...(children.get(record) ?? [])].sort(compare);
		for (const [index, child] of kids.entries()) {
			// Native flattenSessionTree only draws a continuation column below
			// depth 0; a root's own isLast must not leak into its children.
			emit(child, depth + 1, index === kids.length - 1, [
				...ancestorContinues,
				depth > 0 ? !isLast : false,
			]);
		}
	}

	const orderedRoots = [...roots].sort(compare);
	// A chain that loops back on itself never reaches a root: keep those
	// sessions visible as roots of their own instead of silently dropping them.
	const reached = new Set<SessionRecord>();
	const markReached = (record: SessionRecord): void => {
		if (reached.has(record)) return;
		reached.add(record);
		for (const child of children.get(record) ?? []) markReached(child);
	};
	for (const root of orderedRoots) markReached(root);
	for (const record of ordered) {
		if (!reached.has(record)) orderedRoots.push(record);
	}

	for (const [index, record] of orderedRoots.entries()) {
		emit(record, 0, index === orderedRoots.length - 1, []);
	}
	return rows;
}

/**
 * Rows for the picker. Without a query the child sessions stay nested under
 * their parent and collapsed, regardless of the sort mode; the sort only
 * reorders each sibling level. A query flattens the list into search results.
 */
export function buildRows(
	records: SessionRecord[],
	options: {
		query: ParsedQuery;
		sort: SortMode;
		expand: ReadonlySet<string>;
		/** Totals over every loaded record, including rows this view hides. */
		descendantCounts?: ReadonlyMap<SessionRecord, number>;
	},
): TreeRow[] {
	const { query, sort, expand, descendantCounts: counts } = options;
	const ordered = sortRecords(records, query, sort);
	if (!query.empty) {
		return ordered.map((record) => ({
			record,
			depth: 0,
			descendantCount: counts?.get(record) ?? 0,
			visibleDescendantCount: 0,
			isLast: true,
			ancestorContinues: [],
		}));
	}
	return forest(ordered, expand, sort, counts);
}
