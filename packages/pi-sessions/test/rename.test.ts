import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { archiveRoot, cwdDirName, sessionsRoot } from "../src/paths.ts";
import { renameSessionFile } from "../src/rename.ts";

const ID = "01a0aaaa-0000-7000-8000-000000000001";
const header = JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work/project" });
const message = JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "t", message: { role: "user", content: "hi" } });

let live: string;
beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-sessions-rename-"));
	live = join(sessionsRoot(), cwdDirName("/work/project"));
	mkdirSync(live, { recursive: true });
});

function seed(): string {
	const file = join(live, `a_${ID}.jsonl`);
	writeFileSync(file, `${header}\n${message}\n`);
	return file;
}

test("writes a session_info entry the manager reads back", () => {
	const file = seed();
	assert.equal(renameSessionFile(file, "  新名字  "), true);
	assert.equal(SessionManager.open(file).getSessionName(), "新名字");
});

test("collapses newlines in the name instead of writing one", () => {
	const file = seed();
	renameSessionFile(file, "a\nb");
	// header + message + session_info：名称没有拆成新行
	assert.equal(readFileSync(file, "utf8").split("\n").filter(Boolean).length, 3);
	assert.equal(SessionManager.open(file).getSessionName(), "a b");
});

test("an empty name writes nothing", () => {
	const file = seed();
	const before = readFileSync(file, "utf8");
	assert.equal(renameSessionFile(file, "   "), false);
	assert.equal(readFileSync(file, "utf8"), before);
});

test("renames a session that lives in the archive tree", () => {
	const archivedDir = join(archiveRoot(), cwdDirName("/work/project"));
	mkdirSync(archivedDir, { recursive: true });
	const file = join(archivedDir, `a_${ID}.jsonl`);
	writeFileSync(file, `${header}\n${message}\n`);
	assert.equal(renameSessionFile(file, "旧档案"), true);
	assert.equal(SessionManager.open(file).getSessionName(), "旧档案");
});
