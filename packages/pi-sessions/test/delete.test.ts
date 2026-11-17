import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { archiveSessionFile } from "../src/archive.ts";
import { deleteSessionFile, defaultDeleteOps, trashArgs } from "../src/delete.ts";
import { archiveRoot, cwdDirName, sessionsRoot } from "../src/paths.ts";
import { readIndex, readPending, setPending, writeIndex } from "../src/state.ts";

const CWD = "/work/project";
const ID = "01a0aaaa-0000-7000-8000-000000000001";
const CHILD = "01a0bbbb-0000-7000-8000-000000000002";
const OTHER = "01a0dddd-0000-7000-8000-000000000004";
const file = (id: string) => `2026-01-01T00-00-00-000Z_${id}.jsonl`;
const header = (id: string, parent?: string) =>
	JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: CWD, ...(parent ? { parentSession: parent } : {}) });

let live: string;
beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-sessions-delete-"));
	live = join(sessionsRoot(), cwdDirName(CWD));
	mkdirSync(live, { recursive: true });
});

function seedTree(): string {
	const parent = join(live, file(ID));
	writeFileSync(parent, `${header(ID)}\n`);
	writeFileSync(join(live, file(CHILD)), `${header(CHILD, parent)}\n`);
	writeFileSync(join(live, file(OTHER)), `${header(OTHER)}\n`);
	return parent;
}

test("deletes the selected subtree, its companions, and nothing else", () => {
	const parent = seedTree();
	const companion = join(live, file(ID).replace(".jsonl", ""));
	mkdirSync(join(companion, "run"), { recursive: true });
	writeFileSync(join(companion, "run", "log"), "x");
	const shots = join(live, ".pi-agent-browser-artifacts", ID);
	mkdirSync(shots, { recursive: true });
	writeFileSync(join(shots, "shot.png"), "x");
	mkdirSync(join(live, "subagent-artifacts"), { recursive: true });
	writeFileSync(join(live, "subagent-artifacts", "r1_meta.json"), JSON.stringify({ parentSessionId: ID }));
	writeFileSync(join(live, "subagent-artifacts", "r1_output.md"), "x");

	const result = deleteSessionFile(parent);
	assert.deepEqual(result.failed, []);
	assert.equal(result.refused, false);
	assert.equal(result.deleted.length, 6); // 2 sessions + 伴生目录 + 截图 + 2 个产物文件
	assert.equal(existsSync(parent), false);
	assert.equal(existsSync(join(live, file(CHILD))), false);
	assert.equal(existsSync(join(live, file(OTHER))), true);
	assert.equal(existsSync(companion), false);
	assert.equal(existsSync(shots), false);
	assert.equal(readdirSync(join(live, "subagent-artifacts")).length, 0);
});

test("refuses to delete a protected file without touching anything", () => {
	const parent = seedTree();
	const result = deleteSessionFile(parent, { protect: [parent] });
	assert.deepEqual(result, { deleted: [], failed: [], refused: true });
	assert.equal(existsSync(parent), true);
});

test("falls back to remove when trash fails", () => {
	const parent = seedTree();
	const removed: string[] = [];
	const ops = { trash: () => false, remove: (path: string) => removed.push(path) };
	const result = deleteSessionFile(parent, { ops });
	assert.equal(result.failed.length, 0);
	assert.equal(removed.length, 2);
	assert.deepEqual(result.deleted.sort(), removed.sort());
});

test("a symlink inside a companion directory is not followed", () => {
	const parent = seedTree();
	const outside = join(sessionsRoot(), "outside.txt");
	writeFileSync(outside, "keep me");
	const companion = join(live, file(ID).replace(".jsonl", ""));
	mkdirSync(companion, { recursive: true });
	symlinkSync(outside, join(companion, "link"));
	deleteSessionFile(parent);
	assert.equal(existsSync(outside), true);
});

test("trash receives -- before paths so a leading dash is not a flag", () => {
	assert.deepEqual(trashArgs(["-rf.jsonl", "b.jsonl"]), ["--", "-rf.jsonl", "b.jsonl"]);
	assert.equal(typeof defaultDeleteOps().trash, "function");
});

/** A trash that really removes: returning true without deleting would make
 * `deleted` a lie and the assertions below meaningless. */
const fakeTrash = (paths: string[]): boolean => {
	for (const path of paths) rmSync(path, { force: true });
	return true;
};

test("deletes the twin in the archive tree and both index entries", () => {
	const parent = seedTree();
	archiveSessionFile(parent); // 归档父会话与其子树
	const archived = join(archiveRoot(), cwdDirName(CWD), file(ID));
	// 归档后 pi 又写了活跃副本：两棵树各有一份
	writeFileSync(parent, `${header(ID)}\n`);
	writeFileSync(join(live, file(CHILD)), `${header(CHILD, parent)}\n`);
	writeIndex({ ...readIndex(), [`${cwdDirName(CWD)}/${file(OTHER)}`]: { name: "", cwd: "OTHER", archivedAt: "x" } });

	const result = deleteSessionFile(parent, { ops: { trash: fakeTrash } });
	assert.equal(result.refused, false);
	assert.equal(existsSync(parent), false);
	assert.equal(existsSync(archived), false);
	assert.equal(existsSync(join(archiveRoot(), cwdDirName(CWD), file(CHILD))), false);
	// 只摘掉被删会话的键，其他条目保留
	assert.deepEqual(Object.keys(readIndex()), [`${cwdDirName(CWD)}/${file(OTHER)}`]);
});

test("clears a pending archive for a deleted session", () => {
	const parent = seedTree();
	setPending(ID, { path: parent, cwd: CWD, requestedAt: "2026-01-01T00:00:00.000Z" });
	deleteSessionFile(parent, { ops: { trash: fakeTrash } });
	assert.deepEqual(readPending(), {});
});
