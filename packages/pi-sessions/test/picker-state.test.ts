import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { archiveRoot, cwdDirName, sessionsRoot } from "../src/paths.ts";
import { PickerState } from "../src/picker-state.ts";
import type { SessionRecord } from "../src/types.ts";

beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-sessions-state-machine-"));
});

const rec = (path: string, over: Partial<SessionRecord> = {}): SessionRecord => ({
	info: {
		path, id: path, cwd: "/work", created: new Date("2026-01-01T00:00:00Z"),
		modified: new Date("2026-01-01T00:00:00Z"), messageCount: 1,
		firstMessage: path, allMessagesText: path,
	},
	archived: false, archiveDate: new Date("2026-01-01T00:00:00Z"), ...over,
});

const parent = rec("/w/a.jsonl", { info: { ...rec("/w/a.jsonl").info, name: "root" } });
const child = rec("/w/b.jsonl", { info: { ...rec("/w/b.jsonl").info, name: "kid", parentSessionPath: "/w/a.jsonl" } });
const archived = rec("/w/c.jsonl", { archived: true });

test("defaults: active filter, current scope, threaded sort, collapsed", () => {
	const state = new PickerState([parent, child, archived], parent.info.path, "/work");
	assert.equal(state.archiveFilter, "active");
	assert.equal(state.scope, "current");
	assert.equal(state.sort, "threaded");
	assert.deepEqual(state.rows().map((r) => r.record.info.path), [parent.info.path]);
	assert.equal(state.rows()[0].descendantCount, 1);
	assert.deepEqual(state.counts, { active: 2, archived: 1 });
});

test("toggleExpand reveals children and persists across filters", () => {
	const state = new PickerState([parent, child, archived], parent.info.path, "/work");
	state.toggleExpand();
	assert.deepEqual(state.rows().map((r) => r.record.info.path), [parent.info.path, child.info.path]);
	state.cycleArchiveFilter();
	assert.equal(state.archiveFilter, "archived");
	state.cycleArchiveFilter();
	assert.equal(state.archiveFilter, "all");
	assert.equal(state.rows().length, 3);
});

test("setArchiveFilter picks the archive state directly", () => {
	const state = new PickerState([parent, child, archived], undefined, "/work");
	state.setArchiveFilter("archived");
	assert.equal(state.archiveFilter, "archived");
	assert.deepEqual(state.rows().map((r) => r.record.info.path), [archived.info.path]);
	state.setArchiveFilter("all");
	assert.equal(state.archiveFilter, "all");
	assert.deepEqual(
		state.rows().map((r) => r.record.info.path),
		[parent.info.path, archived.info.path],
	);
});

test("selection is kept by path across filter changes and clamped", () => {
	const state = new PickerState([parent, child, archived], undefined, "/work");
	state.toggleExpand();
	state.move(1);
	assert.equal(state.selectedRow()?.record.info.path, child.info.path);
	state.cycleArchiveFilter(); // active -> archived
	assert.equal(state.selectedRow()?.record.info.path, archived.info.path);
	state.cycleArchiveFilter(); // archived -> all
	assert.equal(state.selectedRow()?.record.info.path, archived.info.path);
});

test("archiveAction reflects selected record and current session", () => {
	const state = new PickerState([parent, child, archived], parent.info.path, "/work");
	assert.equal(state.archiveAction(), "deferred-archive");
	state.toggleExpand();
	state.move(1);
	assert.equal(state.archiveAction(), "archive");
	state.cycleArchiveFilter();
	state.cycleArchiveFilter(); // all
	state.setQuery("kid");
	assert.equal(state.archiveAction(), "archive");
	state.setQuery("");
	state.move(1);
	assert.equal(state.selectedRow()?.record.info.path, archived.info.path);
	assert.equal(state.archiveAction(), "unarchive");
});

test("the current session cannot be unarchived from the picker", () => {
	const currentArchived = rec("/w/d.jsonl", { archived: true });
	const state = new PickerState([currentArchived], currentArchived.info.path, "/work");
	assert.equal(state.archiveAction(), "none");
});

test("an archived current session stays untouchable when it is visible", () => {
	const currentArchived = rec("/w/d.jsonl", { archived: true });
	const state = new PickerState([currentArchived], currentArchived.info.path, "/work");
	state.cycleArchiveFilter(); // active -> archived: the current file is now shown
	assert.equal(state.selectedRow()?.record.info.path, currentArchived.info.path);
	assert.equal(state.archiveAction(), "none");
});

test("a query flattens the list", () => {
	const state = new PickerState([parent, child, archived], undefined, "/work");
	state.setQuery("kid");
	assert.deepEqual(state.rows().map((r) => r.depth), [0]);
});

test("descendantCount counts every loaded record, archived twins included", () => {
	const dir = cwdDirName("/work");
	const parentPath = join(sessionsRoot(), dir, "a.jsonl");
	const liveChildPath = join(sessionsRoot(), dir, "b.jsonl");
	const archivedTwin = join(archiveRoot(), dir, "a.jsonl");
	const twinChildPath = join(sessionsRoot(), dir, "c.jsonl");
	const withParent = (path: string, parentSessionPath: string): SessionRecord =>
		rec(path, { info: { ...rec(path).info, parentSessionPath } });
	const root = rec(parentPath, { info: { ...rec(parentPath).info, name: "root" } });
	const liveChild = withParent(liveChildPath, parentPath);
	const twinChild = withParent(twinChildPath, archivedTwin);
	const state = new PickerState([root, liveChild, twinChild], undefined, "/work");

	// A child that recorded the archived twin of its parent still counts.
	assert.equal(state.descendantCount(root), 2);
	assert.equal(state.descendantCount(liveChild), 0);

	// Filters and sorts hide rows; the count stays the real archive size.
	state.setQuery("root");
	state.cycleSort();
	assert.equal(state.descendantCount(root), 2);
});

test("the remaining controls cycle and toggle", () => {
	const state = new PickerState([parent, child], undefined, "/work");
	state.cycleSort();
	assert.equal(state.sort, "recent");
	state.cycleSort();
	assert.equal(state.sort, "relevance");
	state.cycleSort();
	assert.equal(state.sort, "threaded");
	state.cycleScope();
	assert.equal(state.scope, "all");
	state.toggleNamed();
	assert.equal(state.namedOnly, true);
	state.togglePath();
	assert.equal(state.showPath, true);
	state.toggleExpand();
	assert.equal(state.isExpanded(parent.info.path), true);
});

test("move stops at the boundaries", () => {
	const state = new PickerState([parent, child], undefined, "/work");
	state.toggleExpand();
	state.move(-1);
	assert.equal(state.selectedRow()?.record.info.path, parent.info.path);
	state.move(1);
	state.move(1);
	assert.equal(state.selectedRow()?.record.info.path, child.info.path);
});

test("setRecords keeps the selection by path, not by index", () => {
	const older = rec("/w/a.jsonl");
	const newer = rec("/w/b.jsonl", { info: { ...rec("/w/b.jsonl").info, modified: new Date("2026-02-01T00:00:00Z") } });
	const state = new PickerState([older, newer], undefined, "/work");
	state.move(1); // newest first: newer, older
	assert.equal(state.selectedRow()?.record.info.path, older.info.path);
	const newest = rec("/w/c.jsonl", { info: { ...rec("/w/c.jsonl").info, modified: new Date("2026-03-01T00:00:00Z") } });
	state.setRecords([older, newer, newest]);
	assert.equal(state.selectedRow()?.record.info.path, older.info.path);
	assert.deepEqual(state.counts, { active: 3, archived: 0 });
});
