import assert from "node:assert/strict";
import { test } from "node:test";

import { hasName, matchScore, parseQuery, sortRecords } from "../src/search.ts";
import type { SessionRecord } from "../src/types.ts";

const record = (over: Partial<SessionRecord["info"]>): SessionRecord => ({
	info: {
		path: `/x/${over.id ?? "id"}.jsonl`, id: "id", cwd: "/work",
		created: new Date("2026-01-01T00:00:00Z"), modified: new Date("2026-01-01T00:00:00Z"),
		messageCount: 1, firstMessage: "hello world", allMessagesText: "hello world", ...over,
	},
	archived: false, archiveDate: new Date("2026-01-01T00:00:00Z"),
});

const paths = (records: SessionRecord[]): string[] => records.map((r) => r.info.path);

test("parseQuery handles tokens, phrases and regex", () => {
	assert.deepEqual(parseQuery("").empty, true);
	assert.deepEqual(parseQuery("foo bar").tokens.map((t) => t.value), ["foo", "bar"]);
	assert.equal(parseQuery('foo "exact phrase"').tokens[1].kind, "phrase");
	assert.equal(parseQuery("re:^fix").regex?.test("FIXME"), true);
	assert.ok(parseQuery("re:(").error);
});

test("name matches rank above message matches and fuzzy matches", () => {
	const named = record({ path: "/x/a.jsonl", name: "target" });
	const text = record({ path: "/x/b.jsonl", firstMessage: "about target", allMessagesText: "about target" });
	const fuzzy = record({ path: "/x/c.jsonl", name: "t-a-r-g-e-t" });
	const rows = sortRecords([text, fuzzy, named], parseQuery("target"), "relevance");
	assert.deepEqual(rows.map((r) => r.info.path), ["/x/a.jsonl", "/x/b.jsonl", "/x/c.jsonl"]);
});

test("recent sort keeps modified order among matches", () => {
	const older = record({ path: "/x/a.jsonl", name: "hit", modified: new Date("2026-01-01T00:00:00Z") });
	const newer = record({ path: "/x/b.jsonl", name: "hit", modified: new Date("2026-02-01T00:00:00Z") });
	assert.deepEqual(sortRecords([older, newer], parseQuery("hit"), "recent").map((r) => r.info.path), ["/x/b.jsonl", "/x/a.jsonl"]);
});

test("hasName ignores missing, blank and bare legacy tags", () => {
	assert.equal(hasName(record({}).info), false);
	assert.equal(hasName(record({ name: "   " }).info), false);
	assert.equal(hasName(record({ name: "[ARCHIVE] " }).info), false);
	assert.equal(hasName(record({ name: "[ARCHIVE]" }).info), false);
	assert.equal(hasName(record({ name: "[ARCHIVE] target" }).info), true);
});

test("no query keeps every record in modified order, an invalid regex matches nothing", () => {
	const older = record({ path: "/x/a.jsonl", name: "alpha", modified: new Date("2026-01-01T00:00:00Z") });
	const newer = record({ path: "/x/b.jsonl", name: "beta", modified: new Date("2026-03-01T00:00:00Z") });
	for (const sort of ["threaded", "recent", "relevance"] as const) {
		assert.deepEqual(paths(sortRecords([older, newer], parseQuery("  "), sort)), ["/x/b.jsonl", "/x/a.jsonl"]);
	}
	assert.deepEqual(sortRecords([older, newer], parseQuery("re:("), "recent"), []);
	assert.deepEqual(paths(sortRecords([older, newer], parseQuery("alpha"), "threaded")), ["/x/a.jsonl"]);
});

test("multiple tokens take the worst token score", () => {
	const both = record({ path: "/x/a.jsonl", name: "alpha beta" });
	const split = record({ path: "/x/b.jsonl", name: "alpha", allMessagesText: "alpha beta" });
	assert.deepEqual(paths(sortRecords([split, both], parseQuery("alpha beta"), "relevance")), ["/x/a.jsonl", "/x/b.jsonl"]);
});

test("phrases match across collapsed whitespace and regex ranks names first", () => {
	const phraseName = record({ path: "/x/a.jsonl", name: "Exact   Phrase" });
	const phraseText = record({ path: "/x/b.jsonl", name: "other", allMessagesText: "some exact phrase here" });
	assert.deepEqual(paths(sortRecords([phraseText, phraseName], parseQuery('"exact phrase"'), "relevance")), ["/x/a.jsonl", "/x/b.jsonl"]);

	const regexName = record({ path: "/x/c.jsonl", name: "fixme now" });
	const regexText = record({ path: "/x/d.jsonl", name: "other", allMessagesText: "fixme" });
	assert.deepEqual(paths(sortRecords([regexText, regexName], parseQuery("re:^fix"), "relevance")), ["/x/c.jsonl", "/x/d.jsonl"]);
});

test("cached message text follows in-place updates", () => {
	const info = record({ name: "other", allMessagesText: "Alpha\none" }).info;
	assert.equal(matchScore(info, parseQuery("alpha")), 1_000_000);
	assert.equal(matchScore(info, parseQuery('"alpha one"')), 1_000_000);
	assert.equal(matchScore(info, parseQuery("re:Alpha\\s+one")), 1_000_000);
	info.allMessagesText = "Beta two";
	assert.equal(matchScore(info, parseQuery("alpha")), undefined);
	assert.equal(matchScore(info, parseQuery('"alpha one"')), undefined);
	assert.equal(matchScore(info, parseQuery("re:Alpha")), undefined);
	assert.equal(matchScore(info, parseQuery("beta")), 1_000_000);
});
