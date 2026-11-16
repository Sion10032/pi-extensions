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
import { readdirSync } from "node:fs";
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
	SortMode,
} from "./types.ts";

/** One row of the picker: a session plus what the tree renderer needs. */
export interface TreeRow {
	record: SessionRecord;
	/** Nesting level; roots are 0. */
	depth: number;
	/** Nodes in this row's subtree, excluding the row itself. */
	descendantCount: number;
	/** True when no later sibling follows at the same level. */
	isLast: boolean;
	/** Per ancestor level: whether that level's vertical line continues below. */
	ancestorContinues: boolean[];
}

/** Session infos from every directory; a directory that fails to list is skipped. */
async function listAllIn(dirs: string[]): Promise<SessionInfo[]> {
	const lists = await Promise.all(
		dirs.map(async (dir) => {
			try {
				return await SessionManager.listAll(dir);
			} catch {
				return [];
			}
		}),
	);
	return lists.flat();
}

/** Session infos across every cwd directory; an unusable sessions root yields none. */
async function listAllEverywhere(): Promise<SessionInfo[]> {
	try {
		return await SessionManager.listAll();
	} catch {
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
 * When the session was archived. The index is best effort, so a session it
 * does not know about (or an index that failed to parse) falls back to the
 * file's own modification time.
 */
function archiveDate(index: Record<string, IndexEntry>, info: SessionInfo): Date {
	return toDate(index[indexKey(info.path)]?.archivedAt) ?? info.modified;
}

/**
 * Load every session the scope covers, live and archived, newest first.
 *
 * Only paths under the live or the archive root are kept, so a stray path the
 * session manager might return can never leak into the picker. One session can
 * exist twice - as a live file and as the archived copy pi kept writing after
 * the archive - and must still be one row, so the live copy (listed first, and
 * the one that keeps changing) wins over its archived twin.
 */
export async function loadSessions(scope: Scope, cwd: string): Promise<SessionRecord[]> {
	const cwdDir = cwdDirName(cwd);
	const [live, archived] = await Promise.all([
		scope === "current" ? listAllIn([join(sessionsRoot(), cwdDir)]) : listAllEverywhere(),
		scope === "current" ? listAllIn([join(archiveRoot(), cwdDir)]) : listAllIn(archiveDirs()),
	]);
	const index = readIndex();
	const records = new Map<string, SessionRecord>();
	const seenIds = new Set<string>();
	for (const info of [...live, ...archived]) {
		if (underRoot(sessionsRoot(), info.path) === undefined && underRoot(archiveRoot(), info.path) === undefined) {
			continue;
		}
		const key = resolve(info.path);
		if (records.has(key)) continue;
		if (info.id) {
			if (seenIds.has(info.id)) continue;
			seenIds.add(info.id);
		}
		records.set(key, {
			info,
			archived: isArchived(info.path),
			archiveDate: archiveDate(index, info),
		});
	}
	return [...records.values()].sort((a, b) => b.info.modified.getTime() - a.info.modified.getTime());
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

/** Build the nested forest: roots by subtree activity, children only when expanded. */
function forest(ordered: SessionRecord[], expand: ReadonlySet<string>): TreeRow[] {
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

	const rows: TreeRow[] = [];
	const emitted = new Set<SessionRecord>();

	function emit(record: SessionRecord, depth: number, isLast: boolean, ancestorContinues: boolean[]): void {
		if (emitted.has(record)) return;
		emitted.add(record);
		rows.push({
			record,
			depth,
			descendantCount: stats.get(record)?.count ?? 0,
			isLast,
			ancestorContinues,
		});
		if (!expand.has(record.info.path)) return;
		const kids = [...(children.get(record) ?? [])].sort(byLatest);
		for (const [index, child] of kids.entries()) {
			emit(child, depth + 1, index === kids.length - 1, [...ancestorContinues, !isLast]);
		}
	}

	const orderedRoots = [...roots].sort(byLatest);
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
 * Rows for the picker. Threaded order without a query nests child sessions
 * under their parent and collapses them, unless the parent is in `expand`;
 * every other combination is a flat, already sorted list.
 */
export function buildRows(
	records: SessionRecord[],
	options: { query: ParsedQuery; sort: SortMode; expand: ReadonlySet<string> },
): TreeRow[] {
	const { query, sort, expand } = options;
	const ordered = sortRecords(records, query, sort);
	if (!query.empty || sort !== "threaded") {
		return ordered.map((record) => ({
			record,
			depth: 0,
			descendantCount: 0,
			isLast: true,
			ancestorContinues: [],
		}));
	}
	return forest(ordered, expand);
}
