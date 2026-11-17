import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeEach, test } from "node:test";

import { archiveSessionFile } from "../src/archive.ts";
import { archiveRoot, cwdDirName, sessionsRoot } from "../src/paths.ts";
import { parseQuery } from "../src/search.ts";
import { buildRows, descendantRecords, filterRecords, loadSessions } from "../src/sessions.ts";
import { writeIndex } from "../src/state.ts";
import type { SessionRecord } from "../src/types.ts";

const CWD = "/work/project";
const ID = "01a0aaaa-0000-7000-8000-000000000001";
const CHILD = "01a0bbbb-0000-7000-8000-000000000002";
const OTHER = "01a0cccc-0000-7000-8000-000000000003";
const header = (id: string, parent?: string, name?: string, firstEntry = `m_${id}`) =>
	[
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: CWD, ...(parent ? { parentSession: parent } : {}) }),
		JSON.stringify({ type: "model_change", id: firstEntry, parentId: null, timestamp: "t", provider: "test", modelId: "test" }),
		...(name ? [JSON.stringify({ type: "session_info", id: `s_${id}`, parentId: firstEntry, timestamp: "t", name })] : []),
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

test("loadSessions tells copied forks from fresh subagents", async () => {
	const parent = join(live, `a_${ID}.jsonl`);
	const fork = join(live, `b_${CHILD}.jsonl`);
	const sub = join(live, `c_${OTHER}.jsonl`);
	const sharedFirstEntry = `m_${ID}`;
	writeFileSync(parent, `${header(ID, undefined, "root", sharedFirstEntry).join("\n")}\n`);
	writeFileSync(fork, `${header(CHILD, parent, "fork", sharedFirstEntry).join("\n")}\n`);
	writeFileSync(sub, `${header(OTHER, parent, "sub", `m_${OTHER}`).join("\n")}\n`);

	const records = await loadSessions("current", CWD);
	const byPath = new Map(records.map((record) => [record.info.path, record]));
	assert.equal(byPath.get(parent)?.relation, undefined);
	assert.equal(byPath.get(fork)?.relation, "fork");
	assert.equal(byPath.get(sub)?.relation, "subagent");
});

test("loadSessions streams partial records while it loads", async () => {
	seed();
	const sizes: number[] = [];
	const records = await loadSessions("current", CWD, {
		onProgress: (partial) => sizes.push(partial.length),
	});
	assert.equal(records.length, 2);
	assert.ok(sizes.length > 0);
	assert.equal(sizes.at(-1), 2);
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

test("recent sort keeps children nested and collapsed", async () => {
	const { parent } = seed();
	const records = await loadSessions("current", CWD);
	const collapsed = buildRows(records, { query: parseQuery(""), sort: "recent", expand: new Set() });
	assert.equal(collapsed.length, 1);
	assert.equal(collapsed[0].descendantCount, 1);
	const expanded = buildRows(records, { query: parseQuery(""), sort: "recent", expand: new Set([parent]) });
	assert.equal(expanded.length, 2);
	assert.equal(expanded[1].depth, 1);
});

test("a child of a non-last root is indented, not drawn in a continuation column", async () => {
	const { parent, child } = seed();
	const other = join(live, `c_${OTHER}.jsonl`);
	writeFileSync(other, `${header(OTHER, undefined, "other").join("\n")}\n`);
	const records = await loadSessions("current", CWD);
	const rows = buildRows(records, { query: parseQuery(""), sort: "threaded", expand: new Set([parent]) });
	const childRow = rows.find((row) => row.record.info.path === child);
	assert.ok(childRow);
	// Native flattenSessionTree appends `false` for a child of a depth-0 root;
	// the renderer turns that into spaces, never a `│  ` column.
	assert.deepEqual(childRow.ancestorContinues, [false]);
});

const sessionRecord = (path: string, parent?: string): SessionRecord => ({
	info: {
		path, id: path, cwd: CWD, created: new Date("2026-01-01T00:00:00Z"),
		modified: new Date("2026-01-01T00:00:00Z"), messageCount: 1,
		firstMessage: path, allMessagesText: path, ...(parent ? { parentSessionPath: parent } : {}),
	},
	archived: false, archiveDate: new Date("2026-01-01T00:00:00Z"),
});

test("descendantRecords returns every loaded descendant, excluding the root", () => {
	const root = sessionRecord("/w/a.jsonl");
	const kid = sessionRecord("/w/b.jsonl", "/w/a.jsonl");
	const grand = sessionRecord("/w/c.jsonl", "/w/b.jsonl");
	const other = sessionRecord("/w/d.jsonl");
	const paths = descendantRecords([root, kid, grand, other], root).map((r) => r.info.path).sort();
	assert.deepEqual(paths, [kid.info.path, grand.info.path].sort());
	assert.deepEqual(descendantRecords([root, kid, grand], kid), [grand]);
	assert.deepEqual(descendantRecords([root, kid, grand], grand), []);
});

test("descendantRecords follows a parent that lives in the other tree", () => {
	const liveRoot = join(sessionsRoot(), cwdDirName(CWD), "a.jsonl");
	const archivedKid = sessionRecord(join(archiveRoot(), cwdDirName(CWD), "b.jsonl"), liveRoot);
	const root = sessionRecord(liveRoot);
	assert.deepEqual(descendantRecords([root, archivedKid], root), [archivedKid]);
});
