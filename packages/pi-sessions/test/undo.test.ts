import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { findUndoTarget } from "../src/undo.ts";

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
