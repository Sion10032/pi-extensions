/**
 * The UI-agnostic state machine behind the `/sessions` picker.
 *
 * It owns what the picker shows - filter, sort, scope, expanded subtrees, the
 * query and the selected row - and answers the one question the picker asks
 * before archiving: whether the selected session may be moved right now.
 *
 * Selection is tracked by path rather than by index: every keystroke re-filters
 * and re-sorts the rows, and the session the user picked must stay picked for
 * as long as it is still visible. Nothing here touches the filesystem;
 * archiving itself belongs to `archive.ts`.
 */
import { resolve } from "node:path";

import { parseQuery } from "./search.ts";
import {
	buildRows,
	filterRecords,
	type TreeRow,
} from "./sessions.ts";
import type {
	ArchiveFilter,
	Scope,
	SessionRecord,
	SortMode,
} from "./types.ts";

/** What `ctrl+a` would do to the selected session. */
export type ArchiveAction = "archive" | "deferred-archive" | "unarchive" | "none";

/** `cycleSort` order, matching the native session picker. */
const SORT_ORDER: readonly SortMode[] = ["threaded", "recent", "relevance"];

/** `cycleArchiveFilter` order: live sessions, archived ones, both. */
const ARCHIVE_FILTER_ORDER: readonly ArchiveFilter[] = ["active", "archived", "all"];

/** The value after `current`, wrapping at the end. */
function nextIn<T>(values: readonly T[], current: T): T {
	return values[(values.indexOf(current) + 1) % values.length];
}

export class PickerState {
	/** Every loaded record; the archive filter narrows the view, not this list. */
	private records: SessionRecord[];
	/** Resolved path of the session the session manager is writing. */
	private readonly currentPath: string | undefined;
	/** Working directory the picker was opened for; reloads are the owner's job. */
	private readonly currentCwd: string;
	/** Resolved path of the selected row; undefined when nothing is selected. */
	private selectedKey: string | undefined;
	/** Last valid row index, used to clamp when the selected path disappears. */
	private selectedIndex = 0;
	private queryText = "";
	private scopeValue: Scope = "current";
	private sortMode: SortMode = "threaded";
	private archiveFilterValue: ArchiveFilter = "active";
	private namedOnlyValue = false;
	private showPathValue = false;
	/** Paths of parents whose children are shown; empty means fully collapsed. */
	private readonly expanded = new Set<string>();

	constructor(records: SessionRecord[], currentFile: string | undefined, currentCwd: string) {
		this.records = records;
		this.currentPath = currentFile === undefined ? undefined : resolve(currentFile);
		this.currentCwd = currentCwd;
		this.selectedKey = this.currentPath;
	}

	/** Replace the loaded records, e.g. after archiving refreshed the trees. */
	setRecords(records: SessionRecord[]): void {
		this.records = records;
	}

	setQuery(query: string): void {
		this.queryText = query;
	}

	cycleScope(): void {
		this.scopeValue = this.scopeValue === "current" ? "all" : "current";
	}

	cycleSort(): void {
		this.sortMode = nextIn(SORT_ORDER, this.sortMode);
	}

	cycleArchiveFilter(): void {
		this.archiveFilterValue = nextIn(ARCHIVE_FILTER_ORDER, this.archiveFilterValue);
	}

	toggleNamed(): void {
		this.namedOnlyValue = !this.namedOnlyValue;
	}

	togglePath(): void {
		this.showPathValue = !this.showPathValue;
	}

	/**
	 * Expand or collapse the selected row. Rows without descendants are left
	 * alone: collapsing a leaf would store a key the tree never consults.
	 */
	toggleExpand(): void {
		const row = this.selectedRow();
		if (row === undefined || row.descendantCount === 0) return;
		const path = row.record.info.path;
		if (this.expanded.has(path)) this.expanded.delete(path);
		else this.expanded.add(path);
	}

	/** Move the selection by `delta` rows, stopping at the list boundaries. */
	move(delta: number): void {
		const rows = this.rows();
		if (rows.length === 0) return;
		const current = rows.findIndex((row) => resolve(row.record.info.path) === this.selectedKey);
		const next = Math.max(0, Math.min(rows.length - 1, current + delta));
		this.select(rows, next);
	}

	/**
	 * The rows to render, with the selection re-anchored to the current filter.
	 * A selected path that is no longer visible is clamped by index so the
	 * cursor never jumps past the end of a shorter list.
	 */
	rows(): TreeRow[] {
		const query = parseQuery(this.queryText);
		const rows = buildRows(
			filterRecords(this.records, {
				archiveFilter: this.archiveFilterValue,
				namedOnly: this.namedOnlyValue,
				query,
			}),
			{ query, sort: this.sortMode, expand: this.expanded },
		);
		if (rows.length === 0) {
			this.selectedKey = undefined;
			this.selectedIndex = 0;
			return rows;
		}
		const found = rows.findIndex((row) => resolve(row.record.info.path) === this.selectedKey);
		this.select(rows, found >= 0 ? found : Math.min(this.selectedIndex, rows.length - 1));
		return rows;
	}

	selectedRow(): TreeRow | undefined {
		const rows = this.rows();
		return rows.length === 0 ? undefined : rows[this.selectedIndex];
	}

	/** True for the session file the session manager is still writing. */
	isCurrent(record: SessionRecord): boolean {
		return this.currentPath !== undefined && resolve(record.info.path) === this.currentPath;
	}

	/**
	 * What archiving the selected session would do. The current session wins
	 * over the archived flag: moving a file pi is writing is unsafe, so it can
	 * only be deferred to shutdown, or not touched at all once archived.
	 */
	archiveAction(): ArchiveAction {
		const row = this.selectedRow();
		if (row === undefined) return "none";
		if (this.isCurrent(row.record)) return row.record.archived ? "none" : "deferred-archive";
		return row.record.archived ? "unarchive" : "archive";
	}

	/** True when the row at `path` has its children rendered. */
	isExpanded(path: string): boolean {
		return this.expanded.has(path);
	}

	get scope(): Scope {
		return this.scopeValue;
	}

	get sort(): SortMode {
		return this.sortMode;
	}

	get archiveFilter(): ArchiveFilter {
		return this.archiveFilterValue;
	}

	get namedOnly(): boolean {
		return this.namedOnlyValue;
	}

	get showPath(): boolean {
		return this.showPathValue;
	}

	get query(): string {
		return this.queryText;
	}

	/** Live and archived totals over everything loaded, not just visible rows. */
	get counts(): { active: number; archived: number } {
		let archived = 0;
		for (const record of this.records) if (record.archived) archived++;
		return { active: this.records.length - archived, archived };
	}

	/** Make row `index` of `rows` the selection, remembering path and index. */
	private select(rows: TreeRow[], index: number): void {
		const row = rows[index];
		this.selectedKey = resolve(row.record.info.path);
		this.selectedIndex = index;
	}
}
