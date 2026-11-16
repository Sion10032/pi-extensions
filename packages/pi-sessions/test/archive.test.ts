import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("restore strips a bare legacy [ARCHIVE] tag", () => {
	const parent = join(live, file(ID));
	writeFileSync(parent, [
		header(ID),
		JSON.stringify({ type: "session_info", id: "s1", parentId: null, timestamp: "t", name: "[ARCHIVE]" }),
	].join("\n") + "\n");
	archiveSessionFile(parent);
	const restored = restoreSessionFile(join(archiveRoot(), cwdDirName(CWD), file(ID)));
	assert.equal(restored.length, 1);
	const text = readFileSync(join(live, file(ID)), "utf8");
	assert.equal(text.includes("[ARCHIVE]"), false);
	assert.match(text, /"name":""/);
});

test("a protected descendant stays live with its companions", () => {
	const parent = seedTree();
	const child = join(live, file(CHILD));
	const companion = join(live, file(CHILD).replace(".jsonl", ""));
	mkdirSync(companion, { recursive: true });
	writeFileSync(join(companion, "run"), "x");
	const before = readFileSync(child, "utf8");

	const moved = archiveSessionFile(parent, { protect: [child] });

	// The selected root moves; the protected session and everything below it
	// stay where pi keeps writing them.
	assert.deepEqual(moved, [join(archiveRoot(), cwdDirName(CWD), file(ID))]);
	assert.equal(existsSync(child), true);
	assert.equal(readFileSync(child, "utf8"), before);
	assert.equal(existsSync(join(live, file(GRAND))), true);
	assert.equal(existsSync(join(companion, "run")), true);
	assert.equal(existsSync(join(archiveRoot(), cwdDirName(CWD), file(CHILD).replace(".jsonl", ""))), false);
	assert.equal(existsSync(join(archiveRoot(), cwdDirName(CWD), file(CHILD))), false);
});

test("a protected root moves nothing", () => {
	const parent = seedTree();
	assert.deepEqual(archiveSessionFile(parent, { protect: [parent] }), []);
	assert.equal(existsSync(parent), true);
	assert.equal(existsSync(join(live, file(CHILD))), true);
});

test("restoring never moves a protected live session", () => {
	const parent = seedTree();
	archiveSessionFile(parent);
	const archived = join(archiveRoot(), cwdDirName(CWD), file(ID));
	// The current session is the live child; restoring the parent must leave
	// the child and its subtree in the archive copy.
	const child = join(archiveRoot(), cwdDirName(CWD), file(CHILD));
	const moved = restoreSessionFile(archived, { protect: [join(live, file(CHILD))] });
	assert.deepEqual(moved, [join(live, file(ID))]);
	assert.equal(existsSync(child), true);
	assert.equal(existsSync(join(live, file(CHILD))), false);
});

test("archiving a headerless continuation merges it into the archived copy", () => {
	const source = join(live, file(ID));
	const archived = join(archiveRoot(), cwdDirName(CWD), file(ID));
	mkdirSync(dirname(archived), { recursive: true });
	writeFileSync(archived, [
		header(ID),
		JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "t" }),
	].join("\n") + "\n");
	// The live file holds only the tail pi kept writing after the earlier move.
	writeFileSync(source, `${JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "t" })}\n`);

	const moved = archiveSessionFile(source);

	assert.deepEqual(moved, [archived]);
	assert.equal(existsSync(source), false);
	assert.match(readFileSync(archived, "utf8"), /"id":"m2"/);
	const superseded = readdirSync(dirname(archived)).filter((name) => name.includes(".superseded-"));
	assert.deepEqual(superseded, []);
});

test("archiving a new session over an old archived copy supersedes the old one", () => {
	const source = join(live, file(ID));
	const archived = join(archiveRoot(), cwdDirName(CWD), file(ID));
	mkdirSync(dirname(archived), { recursive: true });
	writeFileSync(archived, [
		header(ID),
		JSON.stringify({ type: "message", id: "old", parentId: null, timestamp: "t" }),
	].join("\n") + "\n");
	writeFileSync(source, [
		header(ID),
		JSON.stringify({ type: "message", id: "new", parentId: null, timestamp: "t" }),
	].join("\n") + "\n");

	const moved = archiveSessionFile(source, { now: new Date("2026-02-01T00:00:00Z") });

	assert.deepEqual(moved, [archived]);
	const superseded = `${archived}.superseded-2026-02-01T00-00-00-000Z`;
	assert.equal(existsSync(superseded), true);
	assert.match(readFileSync(superseded, "utf8"), /"id":"old"/);
	assert.match(readFileSync(archived, "utf8"), /"id":"new"/);
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
