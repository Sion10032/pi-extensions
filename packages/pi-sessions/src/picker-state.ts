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
	descendantCounts,
	filterRecords,
	parentPaths,
	type TreeRow,
} from "./sessions.ts";
import type {
	ArchiveFilter,
	ExpansionMode,
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
	/** Global expansion preset; arrows step it, `ctrl+e` overrides one row. */
	private expansionModeValue: ExpansionMode = "collapsed";
	/** Per-row overrides of the preset, keyed by session path. */
	private readonly expandOverrides = new Map<string, boolean>();
	/** True while the owner is streaming a freshly loaded scope. */
	private loadingValue = false;
	private loadingPhaseValue: "live" | "archive" = "live";
	private loadingLoadedValue = 0;
	private loadingTotalValue = 0;

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

	/** Start on a given archive filter, e.g. from `/sessions archived`. */
	setArchiveFilter(filter: ArchiveFilter): void {
		this.archiveFilterValue = filter;
	}

	toggleNamed(): void {
		this.namedOnlyValue = !this.namedOnlyValue;
	}

	togglePath(): void {
		this.showPathValue = !this.showPathValue;
	}

	/**
	 * Cycle the global expansion preset: collapsed -> children -> all ->
	 * collapsed. This is the single-key `ctrl+e` behavior; per-row overrides are
	 * cleared so the preset applies uniformly.
	 */
	cycleExpansion(): void {
		const modes: readonly ExpansionMode[] = ["collapsed", "children", "all"];
		this.expansionModeValue = modes[(modes.indexOf(this.expansionModeValue) + 1) % modes.length]!;
		this.expandOverrides.clear();
	}

	/**
	 * Directional preset step, retained for a future two-key preset control.
	 * The picker currently binds only `cycleExpansion` to `ctrl+e`.
	 */
	stepExpansion(delta: number): void {
		const modes: readonly ExpansionMode[] = ["collapsed", "children", "all"];
		const current = modes.indexOf(this.expansionModeValue);
		const next = modes[Math.max(0, Math.min(modes.length - 1, current + delta))];
		if (next === this.expansionModeValue) return;
		this.expansionModeValue = next;
		this.expandOverrides.clear();
	}

	/**
	 * Set the selected row's expansion directly. The picker has no key bound to
	 * this while dedicated row keys are undecided; the method and overrides stay
	 * so re-enabling is a small change.
	 */
	setSelectedExpanded(expanded: boolean): void {
		const row = this.selectedRow();
		if (row === undefined || row.visibleDescendantCount === 0) return;
		const path = row.record.info.path;
		if (this.isExpanded(path) === expanded) return;
		this.expandOverrides.set(path, expanded);
	}

	/** Toggle the selected row; retained for a future row key binding. */
	toggleExpand(): void {
		const row = this.selectedRow();
		if (row === undefined || row.visibleDescendantCount === 0) return;
		this.setSelectedExpanded(!this.isExpanded(row.record.info.path));
	}

	/** Clear the list and show the loading line while the owner reloads. */
	beginLoading(): void {
		this.records = [];
		this.loadingValue = true;
		this.loadingPhaseValue = "live";
		this.loadingLoadedValue = 0;
		this.loadingTotalValue = 0;
		this.selectedIndex = 0;
	}

	setLoadingProgress(loaded: number, total: number, phase: "live" | "archive"): void {
		this.loadingPhaseValue = phase;
		this.loadingLoadedValue = loaded;
		this.loadingTotalValue = total;
	}

	finishLoading(records: SessionRecord[]): void {
		this.records = records;
		this.loadingValue = false;
		this.loadingPhaseValue = "live";
		this.loadingLoadedValue = 0;
		this.loadingTotalValue = 0;
	}

	failLoading(): void {
		this.loadingValue = false;
	}

	/** Records the current view can show: subagents only in the `all` preset. */
	private visibleRecords(): SessionRecord[] {
		if (this.expansionModeValue === "all") return this.records;
		return this.records.filter((record) => record.relation !== "subagent");
	}

	/** The preset's base expansion plus the user's per-row overrides. */
	private effectiveExpanded(visible: SessionRecord[]): Set<string> {
		const expanded = new Set<string>();
		if (this.expansionModeValue === "all") {
			for (const path of parentPaths(this.records)) expanded.add(path);
		} else if (this.expansionModeValue === "children") {
			for (const path of parentPaths(visible)) expanded.add(path);
		}
		for (const [path, value] of this.expandOverrides) {
			if (value) expanded.add(path);
			else expanded.delete(path);
		}
		return expanded;
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
	 * While a reload is streaming records, a selected path that has not arrived
	 * yet is kept instead of being clobbered by the first partial batch.
	 */
	rows(): TreeRow[] {
		const query = parseQuery(this.queryText);
		const visible = this.visibleRecords();
		const rows = buildRows(
			filterRecords(visible, {
				archiveFilter: this.archiveFilterValue,
				namedOnly: this.namedOnlyValue,
				query,
			}),
			{
				query,
				sort: this.sortMode,
				expand: this.effectiveExpanded(visible),
				descendantCounts: descendantCounts(this.records),
			},
		);
		if (rows.length === 0) {
			if (!this.loadingValue) {
				this.selectedKey = undefined;
				this.selectedIndex = 0;
			}
			return rows;
		}
		const found = rows.findIndex((row) => resolve(row.record.info.path) === this.selectedKey);
		if (found >= 0) this.select(rows, found);
		else if (!this.loadingValue) this.select(rows, Math.min(this.selectedIndex, rows.length - 1));
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
	 * Sessions below `record` across every loaded record - not just the rows on
	 * screen. A query, the named filter, the recent sort and a hidden subagent
	 * subtree can all leave rows off screen, so the row's own count cannot
	 * answer how much an archive would move.
	 */
	descendantCount(record: SessionRecord): number {
		return descendantCounts(this.records).get(record) ?? 0;
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
		return this.effectiveExpanded(this.visibleRecords()).has(path);
	}

	get expansionMode(): ExpansionMode {
		return this.expansionModeValue;
	}

	get loading(): boolean {
		return this.loadingValue;
	}

	get loadingPhase(): "live" | "archive" {
		return this.loadingPhaseValue;
	}

	get loadingLoaded(): number {
		return this.loadingLoadedValue;
	}

	get loadingTotal(): number {
		return this.loadingTotalValue;
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
