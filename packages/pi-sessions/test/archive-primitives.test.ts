import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { appendIfContinuation, descendantFiles, findCompanions, moveCompanions, stripLegacyTag } from "../src/archive.ts";
import { twinPaths } from "../src/paths.ts";

const ID = "01a0aaaa-0000-7000-8000-000000000001";
const CHILD = "01a0bbbb-0000-7000-8000-000000000002";
const GRAND = "01a0cccc-0000-7000-8000-000000000003";
const header = (id: string, cwd: string, parent?: string) =>
	JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd, ...(parent ? { parentSession: parent } : {}) });

let dir: string;
beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "pi-sessions-primitives-"));
	process.env.PI_CODING_AGENT_DIR = root;
	dir = join(root, "sessions");
	mkdirSync(dir, { recursive: true });
});

test("findCompanions lists the session dir, browser artifacts and subagent artifacts", () => {
	const file = join(dir, `a_${ID}.jsonl`);
	writeFileSync(file, `${header(ID, "/work")}\n`);
	mkdirSync(join(dir, `a_${ID}`, "run-0"), { recursive: true });
	mkdirSync(join(dir, ".pi-agent-browser-artifacts", ID), { recursive: true });
	mkdirSync(join(dir, "subagent-artifacts"), { recursive: true });
	writeFileSync(join(dir, "subagent-artifacts", `run-${ID}_meta.json`), JSON.stringify({ parentSessionId: ID }));
	writeFileSync(join(dir, "subagent-artifacts", `run-${ID}_input.md`), "x");
	assert.deepEqual(findCompanions(dir, file).sort(), [
		`.pi-agent-browser-artifacts/${ID}`,
		`a_${ID}`,
		`subagent-artifacts/run-${ID}_input.md`,
		`subagent-artifacts/run-${ID}_meta.json`,
	].sort());
});

test("moveCompanions skips a destination that already exists", () => {
	const file = join(dir, "live", `a_${ID}.jsonl`);
	mkdirSync(join(dir, "live", `a_${ID}`), { recursive: true });
	writeFileSync(join(dir, "live", `a_${ID}`, "x"), "1");
	mkdirSync(join(dir, "archive", `a_${ID}`), { recursive: true });
	writeFileSync(join(dir, "archive", `a_${ID}`, "x"), "2");
	moveCompanions(join(dir, "live"), join(dir, "archive"), file);
	assert.equal(existsSync(join(dir, "live", `a_${ID}`)), true);
	assert.equal(readFileSync(join(dir, "archive", `a_${ID}`, "x"), "utf8"), "2");
});

test("appendIfContinuation appends a chained headerless tail", () => {
	const archived = join(dir, "a.jsonl");
	const tail = join(dir, "tail.jsonl");
	writeFileSync(archived, `${header(ID, "/w")}\n${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "t" })}\n`);
	writeFileSync(tail, `${JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "t" })}\n`);
	assert.equal(appendIfContinuation(tail, archived), true);
	assert.equal(readFileSync(archived, "utf8").includes('"id":"m2"'), true);
	assert.equal(existsSync(tail), false);
});

test("appendIfContinuation refuses a tail with a session header", () => {
	const archived = join(dir, "a.jsonl");
	const tail = join(dir, "tail.jsonl");
	writeFileSync(archived, `${header(ID, "/w")}\n`);
	writeFileSync(tail, `${header(CHILD, "/w")}\n`);
	assert.equal(appendIfContinuation(tail, archived), false);
});

test("stripLegacyTag rewrites the last session_info name", () => {
	const file = join(dir, "a.jsonl");
	writeFileSync(file, [
		header(ID, "/w"),
		JSON.stringify({ type: "session_info", id: "s1", parentId: null, timestamp: "t", name: "[ARCHIVE] keep me" }),
	].join("\n") + "\n");
	stripLegacyTag(file);
	const text = readFileSync(file, "utf8");
	assert.equal(text.includes("[ARCHIVE]"), false);
	assert.equal(text.includes('"name":"keep me"'), true);
});

test("descendantFiles walks the parent chain and matches archived twins", () => {
	const parent = join(dir, `a_${ID}.jsonl`);
	const child = join(dir, `b_${CHILD}.jsonl`);
	const grand = join(dir, `c_${GRAND}.jsonl`);
	const other = join(dir, `d_${"01a0dddd-0000-7000-8000-000000000004"}.jsonl`);
	writeFileSync(parent, `${header(ID, "/w")}\n`);
	const archivedParent = twinPaths(parent).find((p) => p !== parent)!;
	writeFileSync(child, `${header(CHILD, "/w", archivedParent)}\n`);
	writeFileSync(grand, `${header(GRAND, "/w", child)}\n`);
	writeFileSync(other, `${header("01a0dddd-0000-7000-8000-000000000004", "/w")}\n`);
	assert.deepEqual(descendantFiles(dir, parent).sort(), [child, grand].sort());
});
