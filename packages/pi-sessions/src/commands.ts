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
import { deleteSessionFile, type DeleteResult } from "./delete.ts";
import {
	displayTitle,
	isArchived,
	relativeTime,
	sessionsRoot,
	twinPaths,
	underRoot,
} from "./paths.ts";
import { PickerState } from "./picker-state.ts";
import { SessionPicker } from "./picker.ts";
import { renameSessionFile } from "./rename.ts";
import {
	filterRecords,
	loadSessions,
} from "./sessions.ts";
import { setPending } from "./state.ts";
import type {
	ArchiveFilter,
	Scope,
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
 * only records a pending archive for shutdown, reported as `deferred`. It is
 * passed as `protect` to both moves, so a selected ancestor is archived
 * without taking the live session down with it.
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
		const protect = currentFile === undefined ? [] : [currentFile];
		if (
			!record.archived
			&& currentFile !== undefined
			&& resolve(record.info.path) === resolve(currentFile)
		) {
			deferArchive(pi, ctx);
			return { moved: [], deferred: true };
		}
		if (record.archived) {
			if (currentFile !== undefined && resolve(record.info.path) === resolve(currentFile)) {
				ctx.ui.notify("The current session cannot be moved", "warning");
				return { moved: [], deferred: false };
			}
			const moved = restoreSessionFile(record.info.path, { protect });
			// Nothing moves when the live twin already exists; the archived copy
			// stays put, so "Restored 0 sessions" would be misleading.
			if (moved.length === 0) ctx.ui.notify("A live copy already exists", "warning");
			else ctx.ui.notify(`Restored ${moved.length} sessions`, "info");
			return { moved, deferred: false };
		}
		const moved = archiveSessionFile(record.info.path, { name: record.info.name, protect });
		if (moved.length === 0) {
			// Only reachable for a stale record or a file outside `sessions/`; the
			// current session takes the deferred branch above.
			ctx.ui.notify("Nothing was archived", "warning");
			return { moved, deferred: false };
		}
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
 * an id cannot be recorded and is reported instead, and so is a session whose
 * file lives outside `sessions/` (a custom `--session-dir`): the archive move
 * could never run for it, so arming a pending entry would only mislead.
 */
export function deferArchive(_pi: ExtensionAPI, ctx: SessionCtx): void {
	const file = ctx.sessionManager.getSessionFile();
	const id = ctx.sessionManager.getSessionId();
	if (!file || !id) {
		ctx.ui.notify("No current session to archive yet", "warning");
		return;
	}
	if (underRoot(sessionsRoot(), file) === undefined) {
		ctx.ui.notify("This session lives outside the sessions directory and cannot be archived", "warning");
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
 * the whole archive subtree is restored. `protect` names the session pi is
 * still writing, so selecting its archived copy never moves that file. When
 * the restore moved nothing and the live path still does not exist, `target`
 * is that missing live path so the caller can warn instead of switching to a
 * file that is not there.
 */
export function resolveResumeTarget(
	record: SessionRecord,
	protect?: string,
): { target: string; restored: string[] } {
	if (!record.archived) return { target: record.info.path, restored: [] };
	const live = twinPaths(record.info.path).find((path) => !isArchived(path)) ?? record.info.path;
	if (existsSync(live)) return { target: live, restored: [] };
	return {
		target: live,
		restored: restoreSessionFile(record.info.path, protect === undefined ? {} : { protect: [protect] }),
	};
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
		// The session pi is writing stays where it is even when its archived
		// copy is the record the user picked.
		({ target, restored } = resolveResumeTarget(record, ctx.sessionManager.getSessionFile()));
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

/**
 * Rename a session from the picker. The session pi is running has to go
 * through `pi.setSessionName`, which also refreshes the footer; every other
 * one, archived included, gets a `session_info` entry in its own file.
 */
export function renameSession(
	pi: ExtensionAPI,
	ctx: SessionCtx,
	record: SessionRecord,
	name: string,
): void {
	const next = name.trim();
	if (next === "") return;
	try {
		const currentFile = ctx.sessionManager.getSessionFile();
		if (currentFile !== undefined && resolve(record.info.path) === resolve(currentFile)) {
			pi.setSessionName(next);
		} else {
			renameSessionFile(record.info.path, next);
		}
	} catch (error) {
		ctx.ui.notify(`Failed to rename session: ${errorMessage(error)}`, "error");
	}
}

/**
 * Delete a session and its whole subtree from the picker. The running session
 * is passed as `protect`, so a delete that raced a selection change cannot take
 * the file pi is still writing. The count in the notice is the sessions, not
 * every companion file that went with them.
 */
export function deleteSession(ctx: SessionCtx, record: SessionRecord): DeleteResult {
	const currentFile = ctx.sessionManager.getSessionFile();
	try {
		const result = deleteSessionFile(
			record.info.path,
			currentFile === undefined ? {} : { protect: [currentFile] },
		);
		if (result.refused) {
			ctx.ui.notify("Cannot delete the currently active session", "warning");
			return result;
		}
		const count = result.deleted.filter((path) => path.endsWith(".jsonl")).length;
		const failed = result.failed.length > 0 ? ` (${result.failed.length} failed)` : "";
		ctx.ui.notify(`Deleted ${count} session${count === 1 ? "" : "s"}${failed}`, "info");
		return result;
	} catch (error) {
		ctx.ui.notify(`Failed to delete session: ${errorMessage(error)}`, "error");
		return { deleted: [], failed: [], refused: false };
	}
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

		let loadToken = 0;
		let loadController: AbortController | undefined;
		const reload = (scope: Scope): void => {
			const token = ++loadToken;
			loadController?.abort();
			const controller = new AbortController();
			loadController = controller;
			state.beginLoading();
			tui.requestRender();
			void loadSessions(scope, ctx.cwd, {
				signal: controller.signal,
				onProgress: (next, progress) => {
					if (token !== loadToken || state.scope !== scope) return;
					state.setRecords(next);
					state.setLoadingProgress(progress.loaded, progress.total, progress.phase);
					tui.requestRender();
				},
			}).then((next) => {
				if (token !== loadToken || state.scope !== scope) return;
				state.finishLoading(next);
				tui.requestRender();
			}).catch((error) => {
				if (token !== loadToken || controller.signal.aborted) return;
				state.failLoading();
				tui.requestRender();
				ctx.ui.notify(`Failed to reload sessions: ${errorMessage(error)}`, "error");
			});
		};
		const finish = (value: SessionRecord | null): void => {
			// Invalidate the in-flight load before aborting so its rejection does
			// not surface as an error after the picker has closed.
			loadToken++;
			loadController?.abort();
			done(value);
		};

		return new SessionPicker({
			state,
			theme,
			tui,
			keybindings,
			onResume: (record) => finish(record),
			onCancel: () => finish(null),
			onToggleArchive: (record) => {
				void toggleArchive(pi, ctx, record)
					.then((result) => {
						// A deferred archive moves nothing until shutdown, so the rows
						// are still accurate and need no reload.
						if (result.deferred) return;
						reload(state.scope);
					})
					.catch((error) => ctx.ui.notify(`Failed to archive session: ${errorMessage(error)}`, "error"));
			},
			onRename: (record, name) => {
				renameSession(pi, ctx, record, name);
				reload(state.scope);
			},
			onDelete: (record) => {
				const result = deleteSession(ctx, record);
				// A refused delete moved nothing; reloading would only redraw.
				if (!result.refused) reload(state.scope);
			},
			onDeleteRefused: (reason) => ctx.ui.notify(
				reason === "current"
					? "Cannot delete the currently active session"
					: "The current session is inside this session's tree",
				"warning",
			),
			onReload: reload,
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
