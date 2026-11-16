import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeEach, test } from "node:test";

import { archiveSessionFile } from "../src/archive.ts";
import { archiveRoot, cwdDirName, sessionsRoot } from "../src/paths.ts";
import { parseQuery } from "../src/search.ts";
import { buildRows, filterRecords, loadSessions } from "../src/sessions.ts";
import { writeIndex } from "../src/state.ts";

const CWD = "/work/project";
const ID = "01a0aaaa-0000-7000-8000-000000000001";
const CHILD = "01a0bbbb-0000-7000-8000-000000000002";
const header = (id: string, parent?: string, name?: string) =>
	[
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: CWD, ...(parent ? { parentSession: parent } : {}) }),
		...(name ? [JSON.stringify({ type: "session_info", id: "s1", parentId: null, timestamp: "t", name })] : []),
	];

let live: string;
beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-sessions-tree-"));
	live = join(sessionsRoot(), cwdDirName(CWD));
	mkdirSync(live, { recursive: true });
});

function seed(): { parent: string; child: string } {
	const parent = join(live, `a_${ID}.jsonl`);
	const child = join(live, `b_${CHILD}.jsonl`);
	writeFileSync(parent, `${header(ID, undefined, "root").join("\n")}\n`);
	writeFileSync(child, `${header(CHILD, parent, "kid").join("\n")}\n`);
	return { parent, child };
}

test("loadSessions merges live and archived sessions for the current scope", async () => {
	const { parent } = seed();
	archiveSessionFile(parent);
	const records = await loadSessions("current", CWD);
	assert.equal(records.length, 2);
	assert.equal(records.filter((r) => r.archived).length, 2);
});

test("archiveDate falls back to modified when index.json is corrupt", async () => {
	const { parent } = seed();
	archiveSessionFile(parent);
	mkdirSync(archiveRoot(), { recursive: true });
	writeFileSync(join(archiveRoot(), "index.json"), "{oops");
	const records = await loadSessions("current", CWD);
	assert.equal(records.length, 2);
	assert.equal(records.filter((r) => r.archived).length, 2);
});

test("a session outside the sessions tree is not loaded", async () => {
	seed();
	const outside = join(process.env.PI_CODING_AGENT_DIR!, "custom", `x_${CHILD}.jsonl`);
	mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "custom"), { recursive: true });
	writeFileSync(outside, `${header(CHILD).join("\n")}\n`);
	const records = await loadSessions("current", CWD);
	assert.equal(records.some((r) => r.info.path === outside), false);
});

test("a live session reports its own activity, not a stale archive date", async () => {
	const { parent } = seed();
	archiveSessionFile(parent);
	// pi kept writing to the live path after the archive, so both copies exist.
	writeFileSync(parent, `${header(ID, undefined, "root").join("\n")}\n`);
	writeIndex({
		[join(cwdDirName(CWD), basename(parent))]: { name: "root", cwd: CWD, archivedAt: "2026-02-01T00:00:00.000Z" },
	});
	const records = await loadSessions("current", CWD);
	const record = records.find((candidate) => candidate.info.path === parent);
	assert.ok(record);
	assert.equal(record.archived, false);
	// The live inode's date comes from the session itself, never from the index
	// entry its archived twin left behind.
	assert.notEqual(record.archiveDate.toISOString(), "2026-02-01T00:00:00.000Z");
});

test("default active filter hides archived sessions and their children", async () => {
	const { parent } = seed();
	archiveSessionFile(parent);
	const records = await loadSessions("current", CWD);
	const rows = buildRows(filterRecords(records, { archiveFilter: "active", query: parseQuery("") }), {
		query: parseQuery(""), sort: "threaded", expand: new Set(),
	});
	assert.deepEqual(rows, []);
});

test("archived parent with a live child keeps the child nested in the all view", async () => {
	const { parent, child } = seed();
	archiveSessionFile(parent);
	writeFileSync(child, `${header(CHILD, parent, "kid").join("\n")}\n`);
	const records = await loadSessions("current", CWD);
	const rows = buildRows(filterRecords(records, { archiveFilter: "all", query: parseQuery("") }), {
		query: parseQuery(""), sort: "threaded", expand: new Set(),
	});
	assert.equal(rows.length, 1);
	// The archived parent record lives at the archive twin of `parent`; twin
	// resolution still nests the live child under it.
	assert.equal(rows[0].record.info.path, join(archiveRoot(), cwdDirName(CWD), basename(parent)));
	assert.equal(rows[0].descendantCount, 1);
});

test("expanding a parent emits its children with tree metadata", async () => {
	const { parent } = seed();
	const records = await loadSessions("current", CWD);
	const collapsed = buildRows(records, { query: parseQuery(""), sort: "threaded", expand: new Set() });
	assert.equal(collapsed.length, 1);
	const expanded = buildRows(records, { query: parseQuery(""), sort: "threaded", expand: new Set([parent]) });
	assert.equal(expanded.length, 2);
	assert.equal(expanded[1].depth, 1);
	assert.equal(expanded[1].isLast, true);
});

test("a query produces a flat list", async () => {
	seed();
	const records = await loadSessions("current", CWD);
	const rows = buildRows(records, { query: parseQuery("kid"), sort: "relevance", expand: new Set() });
	assert.equal(rows.length, 1);
	assert.equal(rows[0].depth, 0);
});
