/**
 * The `/sessions` TUI picker component.
 *
 * A thin view over `PickerState`: this file decides how the state looks and
 * which keystroke does what, but it never reads the filesystem, archives or
 * restores anything itself. Every action goes through the callbacks in
 * `SessionPickerProps`, so the command layer owns loading, moving files and
 * switching sessions.
 */
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { displayTitle, relativeTime } from "./paths.ts";
import { hasName } from "./search.ts";
import type { PickerState } from "./picker-state.ts";
import type { TreeRow } from "./sessions.ts";
import type { Scope, SessionRecord } from "./types.ts";

/** Rows rendered at once, matching the native session picker. */
const MAX_VISIBLE = 10;

const HINT_LINE_1 = 'tab scope · re:<pattern> regex · "phrase" exact';
const FOOTER_LINE = "ctrl+e expand · ctrl+a archive · enter resume · esc cancel";

/** A pending archive, waiting for Enter to confirm. */
interface Confirmation {
	record: SessionRecord;
	/** Descendant count captured when the prompt was opened. */
	children: number;
}

export interface SessionPickerProps {
	state: PickerState;
	theme: Theme;
	tui: TUI;
	keybindings: KeybindingsManager;
	/** Resume the selected session, restoring it first when needed. */
	onResume(record: SessionRecord): void;
	/** Archive or unarchive the record; the owner refreshes the rows. */
	onToggleArchive(record: SessionRecord): void;
	onCancel(): void;
	/** Called after a scope switch so the owner can reload that scope. */
	onReload?(scope: Scope): void;
}

/** The tree prefix `TreeRow` describes, copied from the native session list. */
function treePrefix(row: TreeRow): string {
	if (row.depth === 0) return "";
	const parts = row.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
	const branch = row.isLast ? "└─ " : "├─ ";
	return parts.join("") + branch;
}

function archiveFilterLabel(state: PickerState): string {
	if (state.archiveFilter === "active") return "Active";
	if (state.archiveFilter === "archived") return "Archived";
	return "All";
}

function scopeLabel(state: PickerState): string {
	return state.scope === "current" ? "Current Folder" : "All";
}

function sortLabel(state: PickerState): string {
	if (state.sort === "threaded") return "Threaded";
	if (state.sort === "recent") return "Recent";
	return "Relevance";
}

export class SessionPicker implements Component {
	private readonly props: SessionPickerProps;
	private readonly input: Input;
	/** Set while `ctrl+a` waits for Enter on a parent with children. */
	private confirming: Confirmation | undefined;
	/** Rows rendered last, for mapping a click's row back to the selection. */
	private visibleRows: TreeRow[] = [];
	/** First rendered line of the session list; header and filter precede it. */
	private rowsTop = 0;
	/** Index of the selection inside `visibleRows`, or -1 when off-screen. */
	private selectedVisibleIndex = -1;

	constructor(props: SessionPickerProps) {
		this.props = props;
		this.input = new Input({ prompt: "> " });
	}

	handleInput(data: string): void {
		const { keybindings: kb, state, tui } = this.props;

		// A pending archive owns every key: Enter confirms, Esc cancels, the
		// rest must not leak into the filter or the list.
		if (this.confirming !== undefined) {
			if (kb.matches(data, "tui.select.confirm")) {
				const { record } = this.confirming;
				this.confirming = undefined;
				this.props.onToggleArchive(record);
			} else if (kb.matches(data, "tui.select.cancel")) {
				this.confirming = undefined;
			}
			tui.requestRender();
			return;
		}

		// Claim the custom control keys before `Input` sees them. `matchesKey`
		// covers both legacy control bytes and the Kitty keyboard protocol's
		// CSI-u sequences, so ctrl+e/ctrl+a work in terminals that negotiate it.
		if (matchesKey(data, "ctrl+t")) {
			state.cycleArchiveFilter();
			tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+e")) {
			state.toggleExpand();
			tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+a")) {
			this.archiveSelected();
			tui.requestRender();
			return;
		}

		if (kb.matches(data, "tui.input.tab")) {
			state.cycleScope();
			// The picker only holds the scope's records it was given; switching
			// to `all` has to be loaded by whoever opened the picker.
			this.props.onReload?.(state.scope);
			tui.requestRender();
			return;
		}
		if (kb.matches(data, "app.session.toggleSort")) {
			state.cycleSort();
			tui.requestRender();
			return;
		}
		if (kb.matches(data, "app.session.toggleNamedFilter")) {
			state.toggleNamed();
			tui.requestRender();
			return;
		}
		if (kb.matches(data, "app.session.togglePath")) {
			state.togglePath();
			tui.requestRender();
			return;
		}

		if (kb.matches(data, "tui.select.up")) {
			state.move(-1);
		} else if (kb.matches(data, "tui.select.down")) {
			state.move(1);
		} else if (kb.matches(data, "tui.select.pageUp")) {
			state.move(-MAX_VISIBLE);
		} else if (kb.matches(data, "tui.select.pageDown")) {
			state.move(MAX_VISIBLE);
		} else if (kb.matches(data, "tui.select.confirm")) {
			const row = state.selectedRow();
			if (row !== undefined) this.props.onResume(row.record);
			return;
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.props.onCancel();
			return;
		} else {
			this.input.handleInput(data);
			state.setQuery(this.input.getValue());
		}
		tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? 0;
			if (delta === 0) return undefined;
			this.props.state.move(delta);
			return { handled: true, render: true };
		}
		if ((event.type === "press" || event.type === "click") && event.button === "left") {
			const offset = event.y - this.rowsTop;
			if (offset < 0 || offset >= this.visibleRows.length) return undefined;
			if (this.selectedVisibleIndex < 0) return undefined;
			this.props.state.move(offset - this.selectedVisibleIndex);
			return { handled: true, render: true };
		}
		return undefined;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const { state, theme } = this.props;
		const lines = [...this.renderHeader(safeWidth), ...this.input.render(safeWidth), ""];

		const rows = state.rows();
		// `selectedRow()` re-anchors the selection after a filter change; calling
		// it here (not once per row) keeps that work to a single extra pass.
		const selected = state.selectedRow();
		const selectedIndex = selected === undefined
			? -1
			: rows.findIndex((row) => row.record === selected.record);
		const start = Math.max(0, Math.min(
			selectedIndex - Math.floor(MAX_VISIBLE / 2),
			rows.length - MAX_VISIBLE,
		));
		const end = Math.min(start + MAX_VISIBLE, rows.length);
		this.rowsTop = lines.length;
		this.visibleRows = rows.slice(start, end);
		this.selectedVisibleIndex = selectedIndex >= start && selectedIndex < end
			? selectedIndex - start
			: -1;

		if (rows.length === 0) {
			const empty = this.props.state.query.trim() !== ""
				|| state.archiveFilter !== "active"
				|| state.namedOnly
				? "No sessions match the current filter."
				: state.scope === "current"
					? "No sessions in current folder. Press Tab to view all."
					: "No sessions found.";
			lines.push(theme.fg("dim", truncateToWidth(`  ${empty}`, safeWidth, "…")));
		} else {
			for (const [offset, row] of this.visibleRows.entries()) {
				lines.push(this.renderRow(row, selectedIndex === start + offset, safeWidth));
			}
			if (start > 0 || end < rows.length) {
				const position = selectedIndex >= 0
					? `${selectedIndex + 1}/${rows.length}`
					: `${rows.length} sessions`;
				lines.push(theme.fg("dim", truncateToWidth(`  (${position})`, safeWidth, "")));
			}
		}

		lines.push("");
		if (this.confirming !== undefined) {
			const title = displayTitle(this.confirming.record.info);
			const prompt = `Archive ${title} and ${this.confirming.children} child sessions? enter confirm · esc cancel`;
			lines.push(theme.fg("accent", truncateToWidth(prompt, safeWidth, "…")));
		} else {
			lines.push(theme.fg("dim", truncateToWidth(FOOTER_LINE, safeWidth, "…")));
		}
		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
		this.visibleRows = [];
		this.selectedVisibleIndex = -1;
		this.rowsTop = 0;
		this.props.tui.requestRender();
	}

	/** `ctrl+a`: confirm a recursive archive, otherwise act immediately. */
	private archiveSelected(): void {
		const { state } = this.props;
		const row = state.selectedRow();
		if (row === undefined) return;
		const action = state.archiveAction();
		if (action === "none") return;
		// Count every loaded descendant, not the visible rows: a query or the
		// recent sort flattens the list and would archive children silently.
		if (action === "archive") {
			const children = state.descendantCount(row.record);
			if (children > 0) {
				this.confirming = { record: row.record, children };
				return;
			}
		}
		this.props.onToggleArchive(row.record);
	}

	private renderHeader(width: number): string[] {
		const { state, theme } = this.props;
		const counts = state.counts;
		const title = theme.bold(`Sessions (${scopeLabel(state)})`);
		const right = theme.fg(
			"dim",
			`Showing: ${archiveFilterLabel(state)} · ${counts.active} active / ${counts.archived} archived`,
		);
		const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(right));
		const controls = [
			`ctrl+s sort (${sortLabel(state)})`,
			`ctrl+n named (${state.namedOnly ? "Named" : "All"})`,
			`ctrl+t filter (${archiveFilterLabel(state)})`,
			`ctrl+p path (${state.showPath ? "on" : "off"})`,
		].join(" · ");
		return [
			truncateToWidth(`${title}${" ".repeat(gap)}${right}`, width, ""),
			theme.fg("dim", truncateToWidth(HINT_LINE_1, width, "…")),
			theme.fg("dim", truncateToWidth(controls, width, "…")),
		];
	}

	private renderRow(row: TreeRow, selected: boolean, width: number): string {
		const { state, theme } = this.props;
		const { info } = row.record;
		const cursor = selected ? theme.fg("accent", "› ") : "  ";
		const prefix = theme.fg("dim", treePrefix(row));

		// Count and metadata live on the right so a long title can never hide
		// the `↳N` badge that tells the user the row has children.
		const rightParts: string[] = [];
		if (row.record.archived) rightParts.push("[archived]");
		if (row.descendantCount > 0) rightParts.push(`↳${row.descendantCount}`);
		if (state.showPath) rightParts.unshift(info.path);
		rightParts.push(String(info.messageCount));
		rightParts.push(relativeTime(row.record.archived ? row.record.archiveDate : info.modified));
		const right = theme.fg("dim", rightParts.join("  "));

		const leftWidth = visibleWidth(cursor) + visibleWidth(prefix);
		const available = Math.max(10, width - leftWidth - visibleWidth(right) - 2);
		let message = truncateToWidth(displayTitle(info), available, "…");
		const color = state.isCurrent(row.record) ? "accent" : hasName(info) ? "warning" : undefined;
		if (color !== undefined) message = theme.fg(color, message);
		if (selected) message = theme.bold(message);

		const left = `${cursor}${prefix}${message}`;
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		let line = `${left}${" ".repeat(gap)}${right}`;
		if (selected) line = theme.bg("selectedBg", line);
		return truncateToWidth(line, width);
	}
}
