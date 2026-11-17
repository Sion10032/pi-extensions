import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { findUndoTarget, runUndo, truncateSessionFile } from "../src/undo.ts";

const CWD = "/work/project";
const ID = "01a0aaaa-0000-7000-8000-000000000001";
const header = {
	type: "session",
	version: 3,
	id: ID,
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: CWD,
};

const user = (id: string, parentId: string | null, content: unknown) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-01T00:00:01.000Z",
	message: { role: "user", content, timestamp: 1 },
});
const assistant = (id: string, parentId: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-01T00:00:02.000Z",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: { input: 1, output: 1 },
		stopReason: "stop",
		timestamp: 2,
	},
});
const toolResult = (id: string, parentId: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-01T00:00:03.000Z",
	message: {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "bash",
		content: [{ type: "text", text: "out" }],
		isError: false,
		timestamp: 3,
	},
});

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-sessions-undo-"));
});

/** A session file written from raw rows, opened the way pi opens it. */
function open(rows: unknown[]): SessionManager {
	const file = join(dir, "s.jsonl");
	writeFileSync(file, [header, ...rows].map((row) => JSON.stringify(row)).join("\n") + "\n");
	return SessionManager.open(file);
}

test("findUndoTarget picks the last user message on the branch", () => {
	const sm = open([
		user("u1", null, "first"),
		assistant("a1", "u1"),
		user("u2", "a1", "second"),
		assistant("a2", "u2"),
	]);
	assert.deepEqual(findUndoTarget(sm), { entryId: "u2", parentId: "a1", text: "second" });
});

test("findUndoTarget returns a null parent for the first message", () => {
	const sm = open([user("u1", null, "only")]);
	assert.deepEqual(findUndoTarget(sm), { entryId: "u1", parentId: null, text: "only" });
});

test("findUndoTarget skips tool results, custom messages and compactions after the last prompt", () => {
	const sm = open([
		user("u1", null, "first"),
		assistant("a1", "u1"),
		toolResult("t1", "a1"),
		{ type: "custom_message", id: "c1", parentId: "t1", timestamp: "2026-01-01T00:00:04.000Z", customType: "ext", content: "injected", display: false },
		{ type: "compaction", id: "k1", parentId: "c1", timestamp: "2026-01-01T00:00:05.000Z", summary: "s", firstKeptEntryId: "u1", tokensBefore: 10 },
	]);
	assert.deepEqual(findUndoTarget(sm), { entryId: "u1", parentId: null, text: "first" });
});

test("findUndoTarget returns undefined without a user message", () => {
	assert.equal(findUndoTarget(open([])), undefined);
	assert.equal(
		findUndoTarget(
			open([
				{ type: "custom", id: "x1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", customType: "ext" },
			]),
		),
		undefined,
	);
});

test("findUndoTarget follows the active branch, not the newest row in the file", () => {
	const sm = open([
		user("u1", null, "first"),
		assistant("a1", "u1"),
		user("u2", "a1", "old branch"),
	]);
	sm.branch("a1");
	sm.appendMessage({ role: "user", content: "new branch", timestamp: 9 });
	const target = findUndoTarget(sm);
	assert.equal(target?.text, "new branch");
	assert.equal(target?.parentId, "a1");
});

test("findUndoTarget joins text blocks and drops non-text parts", () => {
	const sm = open([
		user("u1", null, [
			{ type: "text", text: "a" },
			{ type: "image", data: "AA==", mimeType: "image/png" },
			{ type: "text", text: "b" },
		]),
	]);
	assert.equal(findUndoTarget(sm)?.text, "ab");
});

test("truncateSessionFile drops everything after the kept row", () => {
	const sm = open([
		user("u1", null, "first"),
		assistant("a1", "u1"),
		user("u2", "a1", "second"),
		assistant("a2", "u2"),
	]);
	const file = sm.getSessionFile();
	assert.equal(file !== undefined, true);
	const result = truncateSessionFile(file!, "a1");
	assert.deepEqual(result, { kept: 3, removed: 2 });
	const lines = readFileSync(file!, "utf8").split("\n").filter((line) => line !== "");
	assert.equal(lines.length, 3);
	assert.equal(JSON.parse(lines[2]!).id, "a1");
	assert.equal(SessionManager.open(file!).getLeafId(), "a1");
});

test("truncateSessionFile keeps only the header when throughId is null", () => {
	const sm = open([user("u1", null, "only"), assistant("a1", "u1")]);
	const file = sm.getSessionFile()!;
	const result = truncateSessionFile(file, null);
	assert.deepEqual(result, { kept: 1, removed: 2 });
	const reopened = SessionManager.open(file);
	assert.equal(reopened.getLeafId(), null);
	reopened.appendMessage({ role: "user", content: "next", timestamp: 5 });
	assert.equal(reopened.getBranch().length, 1);
});

test("truncateSessionFile also drops sibling rows written after the kept one", () => {
	const sm = open([user("u1", null, "first"), assistant("a1", "u1")]);
	sm.branch("a1");
	sm.appendMessage({ role: "user", content: "sibling", timestamp: 7 });
	const file = sm.getSessionFile()!;
	assert.deepEqual(truncateSessionFile(file, "a1"), { kept: 3, removed: 1 });
});

test("truncateSessionFile preserves blank and unparseable rows before the cut", () => {
	const file = join(dir, "ragged.jsonl");
	writeFileSync(file, `${JSON.stringify(header)}\n\nnot json\n${JSON.stringify(user("u1", null, "hi"))}\n${JSON.stringify(assistant("a1", "u1"))}\n`);
	assert.deepEqual(truncateSessionFile(file, "u1"), { kept: 4, removed: 1 });
	const lines = readFileSync(file, "utf8").split("\n");
	assert.equal(lines[2], "not json");
	assert.equal(readFileSync(file, "utf8").endsWith("\n"), true);
});

test("truncateSessionFile leaves the file untouched for an unknown id", () => {
	const sm = open([user("u1", null, "first")]);
	const file = sm.getSessionFile()!;
	const before = readFileSync(file, "utf8");
	assert.throws(() => truncateSessionFile(file, "nope"), /Session entry not found: nope/);
	assert.equal(readFileSync(file, "utf8"), before);
});

interface FakeOptions {
	file?: string;
	idle?: boolean;
	pending?: boolean;
	editor?: string;
	cancelled?: boolean;
	/** Thrown by `switchSession` itself, before any replacement. */
	switchError?: Error;
	/** Make `setEditorText` throw, to exercise a post-replacement failure. */
	editorError?: Error;
	/** Throw after the session was replaced, leaving `ctx` stale like the host does. */
	staleThrow?: Error;
	sm?: SessionManager;
}

/** A command context that records what `runUndo` asked the host to do. */
function fakeCtx(options: FakeOptions) {
	let stale = false;
	const notices: string[] = [];
	const switches: { path: string; bytes: string }[] = [];
	let editor = options.editor ?? "";
	const ui = {
		notify: (message: string) => notices.push(message),
		getEditorText: () => editor,
		setEditorText: (text: string) => {
			if (options.editorError) throw options.editorError;
			editor = text;
		},
	};
	const ctx = {
		sessionManager: {
			getSessionFile: () => {
				// A replaced session leaves the old command context unusable.
				if (stale) throw new Error("stale command context");
				return options.file;
			},
			getBranch: () => options.sm?.getBranch() ?? [],
		},
		ui,
		isIdle: () => options.idle ?? true,
		hasPendingMessages: () => options.pending ?? false,
		switchSession: async (path: string, switchOptions?: { withSession?: (next: unknown) => Promise<void> }) => {
			switches.push({ path, bytes: readFileSync(path, "utf8") });
			if (options.staleThrow) {
				stale = true;
				throw options.staleThrow;
			}
			if (options.switchError) throw options.switchError;
			if (options.cancelled) return { cancelled: true };
			await switchOptions?.withSession?.({ ui });
			return { cancelled: false };
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notices, switches, editor: () => editor };
}

test("runUndo refuses while the agent is busy", async () => {
	const sm = open([user("u1", null, "first"), assistant("a1", "u1")]);
	const file = sm.getSessionFile()!;
	const before = readFileSync(file, "utf8");
	for (const options of [{ idle: false }, { pending: true }]) {
		const { ctx, notices, switches } = fakeCtx({ file, sm, ...options });
		await runUndo(ctx);
		assert.equal(readFileSync(file, "utf8"), before);
		assert.equal(switches.length, 0);
		assert.match(notices[0] ?? "", /finish before/);
	}
});

test("runUndo explains when there is nothing to undo", async () => {
	const sm = open([assistant("a1", "u1")]);
	const file = sm.getSessionFile()!;
	const { ctx, notices, switches } = fakeCtx({ file, sm });
	await runUndo(ctx);
	assert.equal(switches.length, 0);
	assert.match(notices[0] ?? "", /No user message to undo/);

	const empty = fakeCtx({});
	await runUndo(empty.ctx);
	assert.equal(empty.switches.length, 0);
	assert.match(empty.notices[0] ?? "", /no saved file/i);
});

test("runUndo on the first prompt leaves an empty session", async () => {
	const sm = open([user("u1", null, "only"), assistant("a1", "u1")]);
	const file = sm.getSessionFile()!;
	const { ctx, editor, switches } = fakeCtx({ file, sm });
	await runUndo(ctx);
	assert.equal(switches.length, 1);
	assert.equal(SessionManager.open(file).getLeafId(), null);
	assert.equal(editor(), "only");
});

test("runUndo truncates, reloads the same file and restores the prompt", async () => {
	const sm = open([
		user("u1", null, "first"),
		assistant("a1", "u1"),
		user("u2", "a1", "second"),
		assistant("a2", "u2"),
	]);
	const file = sm.getSessionFile()!;
	const { ctx, notices, switches, editor } = fakeCtx({ file, sm });
	await runUndo(ctx);
	assert.equal(switches.length, 1);
	assert.equal(switches[0]!.path, file);
	assert.equal(switches[0]!.bytes.includes('"u2"'), false);
	assert.equal(SessionManager.open(file).getLeafId(), "a1");
	assert.equal(editor(), "second");
	assert.match(notices[0] ?? "", /Undone: rewound before your last message \(2 entries removed\)/);
});

test("runUndo keeps an existing draft in the editor", async () => {
	const sm = open([user("u1", null, "first"), assistant("a1", "u1")]);
	const file = sm.getSessionFile()!;
	const { ctx, notices, editor } = fakeCtx({ file, sm, editor: "draft" });
	await runUndo(ctx);
	assert.equal(editor(), "draft");
	assert.equal(notices.some((notice) => notice.includes("editor kept")), true);
});

test("runUndo restores the file when the switch is cancelled", async () => {
	const sm = open([user("u1", null, "first"), assistant("a1", "u1")]);
	const file = sm.getSessionFile()!;
	const before = readFileSync(file, "utf8");
	const { ctx, notices } = fakeCtx({ file, sm, cancelled: true });
	await runUndo(ctx);
	assert.equal(readFileSync(file, "utf8"), before);
	assert.match(notices[0] ?? "", /cancelled/i);
});

test("runUndo restores the file when the switch throws before replacing", async () => {
	const sm = open([user("u1", null, "first"), assistant("a1", "u1")]);
	const file = sm.getSessionFile()!;
	const before = readFileSync(file, "utf8");
	const { ctx, notices } = fakeCtx({ file, sm, switchError: new Error("boom") });
	await runUndo(ctx);
	assert.equal(readFileSync(file, "utf8"), before);
	assert.match(notices[0] ?? "", /Undo failed: boom/);
});

test("runUndo keeps the truncation when the host throws after replacing the session", async () => {
	const sm = open([
		user("u1", null, "first"),
		assistant("a1", "u1"),
		user("u2", "a1", "second"),
		assistant("a2", "u2"),
	]);
	const file = sm.getSessionFile()!;
	const { ctx, notices } = fakeCtx({ file, sm, staleThrow: new Error("rebind failed") });
	await runUndo(ctx);
	// The host already made the truncated session live: restoring the old bytes
	// would put the replaced turn back behind a session that no longer has it.
	assert.equal(SessionManager.open(file).getLeafId(), "a1");
	assert.equal(notices.some((notice) => notice.includes("Undo failed")), false);
});

test("runUndo keeps the truncation when only the post-switch step fails", async () => {
	const sm = open([user("u1", null, "first"), assistant("a1", "u1")]);
	const file = sm.getSessionFile()!;
	const { ctx, notices } = fakeCtx({ file, sm, editorError: new Error("no editor") });
	await runUndo(ctx);
	assert.equal(SessionManager.open(file).getLeafId(), null);
	assert.match(notices[0] ?? "", /Undo failed: no editor/);
});
