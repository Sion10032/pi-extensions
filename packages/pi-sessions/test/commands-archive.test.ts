import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { archiveSessionFile } from "../src/archive.ts";
import { deferArchive, toggleArchive } from "../src/commands.ts";
import { archiveRoot, cwdDirName, sessionsRoot } from "../src/paths.ts";
import { readPending } from "../src/state.ts";
import type { SessionRecord } from "../src/types.ts";

const CWD = "/work/project";
const ID = "01a0aaaa-0000-7000-8000-000000000001";
const header = JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: CWD });

const record = (path: string, archived: boolean): SessionRecord => ({
	info: { path, id: ID, cwd: CWD, created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "hello", allMessagesText: "hello", name: "hello" },
	archived, archiveDate: new Date(),
});

const notices: string[] = [];
const ctx = { ui: { notify: (m: string) => notices.push(m) }, sessionManager: { getSessionFile: () => currentFile, getSessionId: () => "current", getCwd: () => CWD }, cwd: CWD } as unknown as ExtensionCommandContext;
const pi = { getSessionName: () => "hello" } as unknown as ExtensionAPI;

let live: string;
let currentFile: string;
beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-sessions-actions-"));
	live = join(sessionsRoot(), cwdDirName(CWD));
	mkdirSync(live, { recursive: true });
	currentFile = join(live, "current.jsonl");
	writeFileSync(currentFile, `${JSON.stringify({ ...JSON.parse(header), id: "current" })}\n`);
	notices.length = 0;
});

test("toggleArchive archives a non-current session and reports the moved count", async () => {
	const file = join(live, `a_${ID}.jsonl`);
	writeFileSync(file, `${header}\n`);
	const result = await toggleArchive(pi, ctx, record(file, false));
	assert.equal(result.deferred, false);
	assert.equal(existsSync(join(archiveRoot(), cwdDirName(CWD), `a_${ID}.jsonl`)), true);
	assert.match(notices.at(-1)!, /Archived/);
});

test("toggleArchive restores an archived session", async () => {
	const file = join(live, `a_${ID}.jsonl`);
	writeFileSync(file, `${header}\n`);
	const { archiveSessionFile } = await import("../src/archive.ts");
	archiveSessionFile(file);
	const archived = join(archiveRoot(), cwdDirName(CWD), `a_${ID}.jsonl`);
	const result = await toggleArchive(pi, ctx, record(archived, true));
	assert.equal(result.deferred, false);
	assert.equal(existsSync(file), true);
	assert.match(notices.at(-1)!, /Restored|Unarchived/);
});

test("archiving the current session defers and records pending state", async () => {
	const result = await toggleArchive(pi, ctx, record(currentFile, false));
	assert.equal(result.deferred, true);
	assert.equal(existsSync(currentFile), true);
	assert.equal(readPending()["current"].path, currentFile);
});

test("deferArchive writes pending for the current session", () => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-sessions-defer-"));
	deferArchive(pi, ctx);
	assert.ok(readPending()["current"]);
});

test("archiving a parent reports the child sessions it moved", async () => {
	const file = join(live, `a_${ID}.jsonl`);
	const childId = "01a0aaaa-0000-7000-8000-000000000002";
	const child = join(live, `b_${childId}.jsonl`);
	writeFileSync(file, `${header}\n`);
	writeFileSync(child, `${JSON.stringify({ ...JSON.parse(header), id: childId, parentSession: file })}\n`);
	const result = await toggleArchive(pi, ctx, record(file, false));
	assert.deepEqual(result.moved, [
		join(archiveRoot(), cwdDirName(CWD), `a_${ID}.jsonl`),
		join(archiveRoot(), cwdDirName(CWD), `b_${childId}.jsonl`),
	]);
	assert.match(notices.at(-1)!, /Archived hello \(\+1 child sessions\)/);
});

test("restoring an archived session with a live twin warns and keeps the archive", async () => {
	const file = join(live, `a_${ID}.jsonl`);
	writeFileSync(file, `${header}\n`);
	archiveSessionFile(file);
	// pi kept writing to the live path after the archive, so a live copy exists.
	writeFileSync(file, `${header}\n`);
	const archived = join(archiveRoot(), cwdDirName(CWD), `a_${ID}.jsonl`);
	const result = await toggleArchive(pi, ctx, record(archived, true));
	assert.deepEqual(result.moved, []);
	assert.equal(result.deferred, false);
	assert.equal(existsSync(archived), true);
	assert.equal(notices.at(-1), "A live copy already exists");
});
