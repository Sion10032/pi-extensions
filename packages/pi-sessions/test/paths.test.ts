import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import {
	cleanName, cwdDirName, displayTitle, isArchived, readHeader,
	relativeTime, sessionIdFromFile, twinPaths,
} from "../src/paths.ts";

beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-sessions-paths-"));
});

test("cwdDirName encodes a path the way pi does", () => {
	assert.equal(cwdDirName("/home/sion/dev/x"), "--home-sion-dev-x--");
});

test("twinPaths maps between sessions and sessions-archive", () => {
	const root = process.env.PI_CODING_AGENT_DIR!;
	const live = join(root, "sessions", "--work--", "a.jsonl");
	const archived = join(root, "sessions-archive", "--work--", "a.jsonl");
	assert.deepEqual(twinPaths(live).sort(), [live, archived].sort());
	assert.deepEqual(twinPaths(archived).sort(), [live, archived].sort());
	assert.deepEqual(twinPaths("/elsewhere/a.jsonl"), ["/elsewhere/a.jsonl"]);
});

test("isArchived only accepts paths under the archive root", () => {
	const root = process.env.PI_CODING_AGENT_DIR!;
	assert.equal(isArchived(join(root, "sessions-archive", "--a--", "x.jsonl")), true);
	assert.equal(isArchived(join(root, "sessions", "--a--", "x.jsonl")), false);
});

test("cleanName strips legacy tags and displayTitle falls back to firstMessage", () => {
	assert.equal(cleanName("[ARCHIVE] feature work"), "feature work");
	assert.equal(cleanName(undefined), "(unnamed)");
	assert.equal(displayTitle({ name: "[ARCHIVE] x", firstMessage: "hi" }), "x");
	assert.equal(displayTitle({ name: "", firstMessage: "hello" }), "hello");
});

test("sessionIdFromFile returns the uuid suffix", () => {
	assert.equal(sessionIdFromFile("2026-01-01T00-00-00-000Z_01a1e4c7-ba85-7503-b4be-2317175c2b8b.jsonl"), "01a1e4c7-ba85-7503-b4be-2317175c2b8b");
});

test("relativeTime formats from a fixed now", () => {
	const now = Date.parse("2026-01-01T12:00:00Z");
	assert.equal(relativeTime(new Date(now - 30_000), now), "just now");
	assert.equal(relativeTime(new Date(now - 5 * 60_000), now), "5m ago");
	assert.equal(relativeTime(new Date(now - 3 * 3_600_000), now), "3h ago");
	assert.equal(relativeTime(new Date(now - 2 * 86_400_000), now), "2d ago");
});

test("readHeader reads cwd and parentSession", () => {
	const file = join(process.env.PI_CODING_AGENT_DIR!, "h.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "session", id: "abc", cwd: "/work", parentSession: "/p.jsonl" })}\n`);
	assert.deepEqual(readHeader(file), { id: "abc", cwd: "/work", parentSession: "/p.jsonl" });
});
