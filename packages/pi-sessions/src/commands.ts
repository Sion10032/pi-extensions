/**
 * The `/sessions` command: load this folder's sessions, let the user pick one
 * and resume it.
 *
 * Picking uses the terminal picker (`picker.ts`) in TUI mode and a plain
 * `ctx.ui.select` list in every other mode. Resuming is shared by both paths:
 * an archived session is moved back into the live tree first - pi only opens
 * session files from its own sessions root - and only then is the switch
 * requested.
 *
 * Archiving from inside the picker (`ctrl+a`) is wired by a later task, so the
 * placeholder callback below intentionally does nothing.
 */
import { existsSync } from "node:fs";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { restoreSessionFile } from "./archive.ts";
import {
	displayTitle,
	isArchived,
	relativeTime,
	twinPaths,
} from "./paths.ts";
import { PickerState } from "./picker-state.ts";
import { SessionPicker } from "./picker.ts";
import {
	filterRecords,
	loadSessions,
} from "./sessions.ts";
import type {
	ArchiveFilter,
	SessionRecord,
} from "./types.ts";

/** Shown in a select label when the session header carries no working directory. */
const UNKNOWN_CWD = "(unknown cwd)";

/** Archive filters the `/sessions` argument accepts. */
const ARCHIVE_FILTERS: readonly ArchiveFilter[] = ["active", "archived", "all"];

/** Parse the `/sessions` argument: an archive filter, or undefined for none. */
export function parseFilterArg(arg: string): ArchiveFilter | undefined {
	const value = arg.trim().toLowerCase();
	return ARCHIVE_FILTERS.find((filter) => filter === value);
}

/**
 * One line describing a session in the non-TUI list. It shows the archive date
 * (which falls back to the last activity for live sessions) and the working
 * directory, so two sessions with the same title still read differently. The
 * archived marker is appended rather than joined so it reads as a tag after
 * the location.
 */
export function formatOption(record: SessionRecord): string {
	const { info } = record;
	const cwd = info.cwd || UNKNOWN_CWD;
	const label = `${displayTitle(info)} · ${relativeTime(record.archiveDate)} · ${cwd}`;
	return record.archived ? `${label} [archived]` : label;
}

/**
 * The path to hand to `switchSession` and the live files a restore moved.
 *
 * A live session resumes in place. An archived one has to go back under the
 * live sessions root first: when its twin is already there (pi kept writing to
 * the live path after the archive) that copy wins and nothing moves; otherwise
 * the whole archive subtree is restored. When the restore moved nothing and
 * the live path still does not exist, `target` is that missing live path so the
 * caller can warn instead of switching to a file that is not there.
 */
export function resolveResumeTarget(record: SessionRecord): { target: string; restored: string[] } {
	if (!record.archived) return { target: record.info.path, restored: [] };
	const live = twinPaths(record.info.path).find((path) => !isArchived(path)) ?? record.info.path;
	if (existsSync(live)) return { target: live, restored: [] };
	return { target: live, restored: restoreSessionFile(record.info.path) };
}

/**
 * Switch to `record`, restoring it first when it is archived. A missing file
 * is reported instead: pi cannot open a session that is not there, and the
 * picker may be showing a record whose file was moved behind its back.
 */
async function resume(ctx: ExtensionCommandContext, record: SessionRecord): Promise<void> {
	const { target, restored } = resolveResumeTarget(record);
	if (!existsSync(target)) {
		ctx.ui.notify("Session file is missing", "warning");
		return;
	}
	if (restored.length > 0) ctx.ui.notify("Restored to the active sessions list", "info");
	// A cancelled switch keeps the current session, which needs no follow-up.
	await ctx.switchSession(target);
}

/** The terminal picker; resolves to the chosen record, or null when cancelled. */
async function pickInTui(
	ctx: ExtensionCommandContext,
	records: SessionRecord[],
	filter: ArchiveFilter | undefined,
): Promise<SessionRecord | null> {
	return ctx.ui.custom<SessionRecord | null>((tui, theme, keybindings, done) => {
		const state = new PickerState(records, ctx.sessionManager.getSessionFile(), ctx.cwd);
		if (filter !== undefined) state.setArchiveFilter(filter);
		return new SessionPicker({
			state,
			theme,
			tui,
			keybindings,
			onResume: (record) => done(record),
			onCancel: () => done(null),
			// Archiving from the picker lands in a later task.
			onToggleArchive: () => {},
			onReload: (scope) => {
				void loadSessions(scope, ctx.cwd)
					.then((next) => {
						// A load for a scope the user already left must not replace
						// the rows of the scope now on screen.
						if (state.scope !== scope) return;
						state.setRecords(next);
						tui.requestRender();
					})
					.catch(() => ctx.ui.notify("Failed to reload sessions", "error"));
			},
		});
	});
}

/**
 * The flat list for modes without custom components. Numbered labels keep two
 * sessions with the same title apart: `select` only hands back the label, so
 * the number - not the text - is what maps back to the record.
 */
async function pickWithSelect(
	ctx: ExtensionCommandContext,
	records: SessionRecord[],
	filter: ArchiveFilter | undefined,
): Promise<SessionRecord | undefined> {
	// There is no `ctrl+t` here, so archived sessions stay listed unless the
	// argument asks for one archive state only.
	const visible = filterRecords(records, { archiveFilter: filter ?? "all" });
	if (visible.length === 0) {
		ctx.ui.notify("No sessions match the current filter", "info");
		return undefined;
	}
	const byLabel = new Map<string, SessionRecord>();
	const labels = visible.map((record, index) => {
		const label = `${index + 1}. ${formatOption(record)}`;
		byLabel.set(label, record);
		return label;
	});
	const choice = await ctx.ui.select("Resume session", labels);
	return choice === undefined ? undefined : byLabel.get(choice);
}

/**
 * `/sessions [active|archived|all]`: browse and resume a session. The argument
 * only picks the starting archive filter; the picker can still change it.
 */
export async function runSessions(_pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const records = await loadSessions("current", ctx.cwd);
	if (records.length === 0) {
		ctx.ui.notify("No sessions found", "info");
		return;
	}
	const filter = parseFilterArg(args);
	const chosen = ctx.mode === "tui"
		? await pickInTui(ctx, records, filter)
		: await pickWithSelect(ctx, records, filter);
	if (chosen === undefined || chosen === null) return;
	await resume(ctx, chosen);
}
