import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";

import { clearPending, indexPath, readIndex, readPending, setPending, statePath, writeIndex, writeJsonAtomic } from "../src/state.ts";

beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-sessions-state-"));
});

test("readIndex returns {} for a missing or corrupt file", () => {
	assert.deepEqual(readIndex(), {});
	mkdirSync(dirname(indexPath()), { recursive: true });
	writeFileSync(indexPath(), "{not json");
	assert.deepEqual(readIndex(), {});
});

test("index round-trips", () => {
	writeIndex({ "--work--/a.jsonl": { name: "a", cwd: "/work", archivedAt: "2026-01-01T00:00:00.000Z" } });
	assert.equal(readIndex()["--work--/a.jsonl"].name, "a");
});

test("pending round-trips per session id", () => {
	setPending("id-1", { path: "/p/a.jsonl", cwd: "/p", requestedAt: "2026-01-01T00:00:00.000Z" });
	assert.equal(readPending()["id-1"].path, "/p/a.jsonl");
	clearPending("id-1");
	assert.deepEqual(readPending(), {});
});

test("writeJsonAtomic creates parents and replaces atomically", () => {
	const file = join(process.env.PI_CODING_AGENT_DIR!, "nested", "state.json");
	writeJsonAtomic(file, { a: 1 });
	writeJsonAtomic(file, { a: 2 });
	assert.equal(existsSync(file), true);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 2 });
});
