/**
 * The `/sessions` command: load this folder's sessions, let the user pick one,
 * resume it, and archive or unarchive a session from the picker.
 *
 * Picking uses the terminal picker (`picker.ts`) in TUI mode and a plain
 * `ctx.ui.select` list in every other mode. Resuming is shared by both paths:
 * an archived session is moved back into the live tree first - pi only opens
 * session files from its own sessions root - and only then is the switch
 * requested.
 *
 * Archiving moves a session and its whole subtree. The session pi is still
 * writing cannot be moved, so archiving it only records a pending archive that
 * the shutdown hook completes.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { archiveSessionFile, restoreSessionFile } from "./archive.ts";
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
import { setPending } from "./state.ts";
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
 * The context archive actions need. A `Pick` rather than the full command
 * context, so the `archive_session` tool can hand in its own context, which
 * shares these members without being an `ExtensionCommandContext`.
 */
export type SessionCtx = Pick<ExtensionCommandContext, "sessionManager" | "ui" | "cwd">;

/**
 * Archive a live session - or restore an archived one - together with its
 * whole subtree. The session pi is still writing cannot be moved: archiving it
 * only records a pending archive for shutdown, reported as `deferred`.
 *
 * Every failure is notified and turns into an empty result, so the picker
 * keeps running and simply reloads the unchanged trees.
 */
export async function toggleArchive(
	pi: ExtensionAPI,
	ctx: SessionCtx,
	record: SessionRecord,
): Promise<{ moved: string[]; deferred: boolean }> {
	try {
		const currentFile = ctx.sessionManager.getSessionFile();
		if (
			!record.archived
			&& currentFile !== undefined
			&& resolve(record.info.path) === resolve(currentFile)
		) {
			deferArchive(pi, ctx);
			return { moved: [], deferred: true };
		}
		if (record.archived) {
			const moved = restoreSessionFile(record.info.path);
			// Nothing moves when the live twin already exists; the archived copy
			// stays put, so "Restored 0 sessions" would be misleading.
			if (moved.length === 0) ctx.ui.notify("A live copy already exists", "warning");
			else ctx.ui.notify(`Restored ${moved.length} sessions`, "info");
			return { moved, deferred: false };
		}
		const moved = archiveSessionFile(record.info.path, { name: record.info.name });
		const children = moved.length - 1;
		const suffix = children > 0 ? ` (+${children} child sessions)` : "";
		ctx.ui.notify(`Archived ${displayTitle(record.info)}${suffix}`, "info");
		return { moved, deferred: false };
	} catch (error) {
		const action = record.archived ? "restore" : "archive";
		ctx.ui.notify(`Failed to ${action} session: ${errorMessage(error)}`, "error");
		return { moved: [], deferred: false };
	}
}

/**
 * Record an archive request for the session pi is running now; the shutdown
 * hook moves the file once pi is done writing it. A session without a file or
 * an id cannot be recorded and is reported instead.
 */
export function deferArchive(_pi: ExtensionAPI, ctx: SessionCtx): void {
	const file = ctx.sessionManager.getSessionFile();
	const id = ctx.sessionManager.getSessionId();
	if (!file || !id) {
		ctx.ui.notify("No current session to archive yet", "warning");
		return;
	}
	setPending(id, { path: file, cwd: ctx.cwd, requestedAt: new Date().toISOString() });
	ctx.ui.notify("Session will be archived when it closes", "info");
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
 * picker may be showing a record whose file was moved behind its back. A
 * failure to move or open the file is reported too, so it never surfaces as
 * the host's command error.
 */
async function resume(ctx: ExtensionCommandContext, record: SessionRecord): Promise<void> {
	let target: string;
	let restored: string[];
	try {
		({ target, restored } = resolveResumeTarget(record));
	} catch (error) {
		ctx.ui.notify(`Failed to restore session: ${errorMessage(error)}`, "error");
		return;
	}
	if (!existsSync(target)) {
		ctx.ui.notify("Session file is missing", "warning");
		return;
	}
	if (restored.length > 0) ctx.ui.notify("Restored to the active sessions list", "info");
	try {
		// A cancelled switch keeps the current session, which needs no follow-up.
		await ctx.switchSession(target);
	} catch (error) {
		ctx.ui.notify(`Failed to switch session: ${errorMessage(error)}`, "error");
	}
}

/** A thrown value's message, for a one-line notification. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The terminal picker; resolves to the chosen record, or null when cancelled. */
async function pickInTui(
	pi: ExtensionAPI,
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
			onToggleArchive: (record) => {
				void toggleArchive(pi, ctx, record)
					.then((result) => {
						// A deferred archive moves nothing until shutdown, so the rows
						// are still accurate and need no reload.
						if (result.deferred) return;
						const scope = state.scope;
						return loadSessions(scope, ctx.cwd).then((next) => {
							// A reload for a scope the user already left must not
							// replace the rows of the scope now on screen.
							if (state.scope !== scope) return;
							state.setRecords(next);
							tui.requestRender();
						});
					})
					.catch(() => ctx.ui.notify("Failed to reload sessions", "error"));
			},
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
 * `/sessions [active|archived|all]`: browse, resume and archive sessions. The
 * argument only picks the starting archive filter; the picker can still change
 * it.
 */
export async function runSessions(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const records = await loadSessions("current", ctx.cwd);
	// The terminal picker stays reachable without sessions in this folder: `tab`
	// switches to the `all` scope, which reloads sessions from everywhere.
	if (records.length === 0 && ctx.mode !== "tui") {
		ctx.ui.notify("No sessions found", "info");
		return;
	}
	const filter = parseFilterArg(args);
	const chosen = ctx.mode === "tui"
		? await pickInTui(pi, ctx, records, filter)
		: await pickWithSelect(ctx, records, filter);
	if (chosen === undefined || chosen === null) return;
	await resume(ctx, chosen);
}
