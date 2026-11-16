import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { archiveSessionFile, restoreSessionFile } from "../src/archive.ts";
import { archiveRoot, cwdDirName, sessionsRoot } from "../src/paths.ts";
import { readIndex, writeIndex } from "../src/state.ts";

const CWD = "/work/project";
const ID = "01a0aaaa-0000-7000-8000-000000000001";
const CHILD = "01a0bbbb-0000-7000-8000-000000000002";
const GRAND = "01a0cccc-0000-7000-8000-000000000003";
const OTHER = "01a0dddd-0000-7000-8000-000000000004";
const file = (id: string) => `2026-01-01T00-00-00-000Z_${id}.jsonl`;
const header = (id: string, parent?: string) =>
	JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: CWD, ...(parent ? { parentSession: parent } : {}) });

let live: string;
beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-sessions-archive-"));
	live = join(sessionsRoot(), cwdDirName(CWD));
	mkdirSync(live, { recursive: true });
});

function seedTree(): string {
	const parent = join(live, file(ID));
	writeFileSync(parent, `${header(ID)}\n`);
	writeFileSync(join(live, file(CHILD)), `${header(CHILD, parent)}\n`);
	writeFileSync(join(live, file(GRAND)), `${header(GRAND, join(live, file(CHILD)))}\n`);
	writeFileSync(join(live, file(OTHER)), `${header(OTHER)}\n`);
	return parent;
}

test("archiveSessionFile moves the session, all descendants and companions", () => {
	const parent = seedTree();
	mkdirSync(join(live, file(ID).replace(".jsonl", "")), { recursive: true });
	writeFileSync(join(live, file(ID).replace(".jsonl", ""), "run"), "x");
	const moved = archiveSessionFile(parent, { now: new Date("2026-02-01T00:00:00Z") });
	const archived = join(archiveRoot(), cwdDirName(CWD));
	assert.deepEqual(moved.map((p) => p.split("/").pop()).sort(), [file(ID), file(CHILD), file(GRAND)].sort());
	assert.equal(existsSync(join(archived, file(ID))), true);
	assert.equal(existsSync(join(archived, file(CHILD))), true);
	assert.equal(existsSync(join(archived, file(GRAND))), true);
	assert.equal(existsSync(join(live, file(OTHER))), true);
	assert.equal(existsSync(join(archived, file(ID).replace(".jsonl", ""), "run")), true);
	const entry = readIndex()[join(cwdDirName(CWD), file(ID))];
	assert.equal(entry.cwd, CWD);
	assert.equal(entry.archivedAt, "2026-02-01T00:00:00.000Z");
});

test("restoreSessionFile moves the subtree back and clears index entries", () => {
	const parent = seedTree();
	archiveSessionFile(parent);
	const archived = join(archiveRoot(), cwdDirName(CWD));
	const moved = restoreSessionFile(join(archived, file(ID)));
	assert.deepEqual(moved.map((p) => p.split("/").pop()).sort(), [file(ID), file(CHILD), file(GRAND)].sort());
	assert.equal(existsSync(join(live, file(ID))), true);
	assert.equal(existsSync(join(live, file(GRAND))), true);
	assert.deepEqual(readIndex(), {});
});

test("archiving and restoring a single child leaves the parent alone", () => {
	const parent = seedTree();
	const moved = archiveSessionFile(join(live, file(CHILD)));
	assert.deepEqual(moved.map((p) => p.split("/").pop()).sort(), [file(CHILD), file(GRAND)].sort());
	assert.equal(existsSync(join(live, file(ID))), true);
	const restored = restoreSessionFile(join(archiveRoot(), cwdDirName(CWD), file(CHILD)));
	assert.deepEqual(restored.map((p) => p.split("/").pop()).sort(), [file(CHILD), file(GRAND)].sort());
});

test("restore keeps the archived copy when a live copy exists", () => {
	const parent = seedTree();
	archiveSessionFile(parent);
	const archived = join(archiveRoot(), cwdDirName(CWD), file(ID));
	writeFileSync(join(live, file(ID)), `${header(ID)}\n`);
	assert.deepEqual(restoreSessionFile(archived), []);
	assert.equal(existsSync(archived), true);
});

test("restore strips a legacy [ARCHIVE] name tag", () => {
	const parent = join(live, file(ID));
	writeFileSync(parent, [
		header(ID),
		JSON.stringify({ type: "session_info", id: "s1", parentId: null, timestamp: "t", name: "[ARCHIVE] keep" }),
	].join("\n") + "\n");
	archiveSessionFile(parent);
	const restored = restoreSessionFile(join(archiveRoot(), cwdDirName(CWD), file(ID)));
	assert.equal(restored.length, 1);
	assert.equal(readFileSync(join(live, file(ID)), "utf8").includes("[ARCHIVE]"), false);
});

test("archiving a session that is already archived is a no-op", () => {
	const parent = seedTree();
	archiveSessionFile(parent);
	assert.deepEqual(archiveSessionFile(join(archiveRoot(), cwdDirName(CWD), file(ID))), []);
});

test("files outside the sessions root are left alone", () => {
	const outside = join(mkdtempSync(join(tmpdir(), "pi-sessions-outside-")), `x_${OTHER}.jsonl`);
	writeFileSync(outside, `${header(OTHER)}\n`);
	assert.deepEqual(archiveSessionFile(outside), []);
	assert.equal(existsSync(outside), true);
	assert.deepEqual(restoreSessionFile(outside), []);
});
