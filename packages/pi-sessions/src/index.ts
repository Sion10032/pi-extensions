/**
 * The pi-sessions extension entry point.
 *
 * `/sessions` browses, resumes and archives sessions; `/archive` and the
 * `archive_session` tool defer archiving the session pi is running now. The
 * running session's file cannot be moved while pi still writes it, so a
 * deferred archive is only completed by the `session_shutdown` hook - and not
 * when the shutdown is a reload or a switch to the same file.
 */
import { existsSync } from "node:fs";

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { archiveSessionFile } from "./archive.ts";
import { deferArchive, runSessions } from "./commands.ts";
import { isArchived } from "./paths.ts";
import { clearPending, readPending } from "./state.ts";

/** A thrown value's message, for a one-line notification. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Forget a deferred archive whose session is already archived: the request was
 * completed by an earlier shutdown, or the session was archived from the
 * picker. A live session keeps its pending entry armed for shutdown.
 */
function sessionStart(ctx: ExtensionContext): void {
	const id = ctx.sessionManager.getSessionId();
	if (!readPending()[id]) return;
	const file = ctx.sessionManager.getSessionFile();
	if (file !== undefined && isArchived(file)) clearPending(id);
}

/**
 * Complete a deferred archive. A reload keeps the file where it is: pi is
 * about to reopen the same session, so moving it would lose the session the
 * user is in. A switch whose target is the current file does not move it
 * either. A file that is already archived or gone only needs its pending entry
 * dropped; a failure to move is notified and leaves the request pending.
 */
function sessionShutdown(pi: ExtensionAPI, event: SessionShutdownEvent, ctx: ExtensionContext): void {
	const id = ctx.sessionManager.getSessionId();
	if (!readPending()[id]) return;
	if (event.reason === "reload") return;
	const file = ctx.sessionManager.getSessionFile();
	if (!file || event.targetSessionFile === file) return;
	if (isArchived(file) || !existsSync(file)) {
		clearPending(id);
		return;
	}
	try {
		archiveSessionFile(file, { name: pi.getSessionName() });
	} catch (error) {
		ctx.ui.notify(`Archive failed: ${errorMessage(error)}`, "error");
	}
}

export default function piSessions(pi: ExtensionAPI): void {
	pi.registerCommand("sessions", {
		description: "Browse and resume sessions, including archived ones",
		handler: (args, ctx) => runSessions(pi, ctx, args),
	});
	pi.registerCommand("archive", {
		description: "Archive the current session when it closes",
		handler: async (_args, ctx) => deferArchive(pi, ctx),
	});
	pi.registerTool({
		name: "archive_session",
		label: "Archive Session",
		description: "Archive the current session when it closes. Use when the user says work is complete.",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			deferArchive(pi, ctx);
			return {
				content: [{ type: "text", text: "Session will be archived when it closes" }],
				details: undefined,
			};
		},
	});
	pi.on("session_start", (_event: SessionStartEvent, ctx) => sessionStart(ctx));
	pi.on("session_shutdown", (event, ctx) => sessionShutdown(pi, event, ctx));
}
