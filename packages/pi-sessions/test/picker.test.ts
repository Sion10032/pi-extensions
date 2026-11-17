import assert from "node:assert/strict";
import { test } from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { SessionPicker } from "../src/picker.ts";
import { PickerState } from "../src/picker-state.ts";
import type { SessionRecord } from "../src/types.ts";

const rec = (path: string, over: Partial<SessionRecord["info"]> = {}): SessionRecord => ({
	info: {
		path, id: path, cwd: "/work", created: new Date("2026-01-01T00:00:00Z"),
		modified: new Date("2026-01-01T00:00:00Z"), messageCount: 1,
		firstMessage: path, allMessagesText: path, ...over,
	},
	archived: false, archiveDate: new Date("2026-01-01T00:00:00Z"),
});

const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;
const tui = { requestRender() {} } as unknown as TUI;
const kb = { matches: (data: string, action: string) => ({ "tui.select.confirm": "\r", "tui.select.cancel": "\u001b", "tui.select.up": "\u001b[A", "tui.select.down": "\u001b[B", "tui.select.pageUp": "\u001b[5~", "tui.select.pageDown": "\u001b[6~", "tui.input.tab": "\t", "app.session.toggleSort": "\u0013", "app.session.toggleNamedFilter": "\u000e", "app.session.togglePath": "\u0010" } as Record<string, string>)[action] === data } as unknown as KeybindingsManager;

function makePicker(records: SessionRecord[], current?: string, pickerTheme: Theme = theme) {
	const calls: string[] = [];
	const reloads: string[] = [];
	const state = new PickerState(records, current, "/work");
	const picker = new SessionPicker({
		state, theme: pickerTheme, tui, keybindings: kb,
		onResume: (r) => calls.push(`resume:${r.info.path}`),
		onToggleArchive: (r) => calls.push(`toggle:${r.info.path}`),
		onCancel: () => calls.push("cancel"),
		onReload: (scope) => reloads.push(scope),
	});
	return { picker, state, calls, reloads };
}

const parent = rec("/w/a.jsonl", { name: "root" });
const child = rec("/w/b.jsonl", { name: "kid", parentSessionPath: "/w/a.jsonl" });
// `rec` always creates a live record; the fixture has to flip the flag explicitly.
const archived: SessionRecord = { ...rec("/w/c.jsonl", { name: "old" }), archived: true };

test("render shows the header, filter and rows", () => {
	const { picker } = makePicker([parent, child, archived], parent.info.path);
	const text = picker.render(80).join("\n");
	assert.match(text, /Sessions/);
	assert.match(text, /root/);
	assert.match(text, /↳1/);
	assert.doesNotMatch(text, /kid/);
	assert.match(text, /ctrl\+t/);
});

test("ctrl+e cycles the global expansion preset and wraps", () => {
	const { picker, state } = makePicker([parent, child], parent.info.path);
	assert.doesNotMatch(picker.render(80).join("\n"), /kid/);
	picker.handleInput("\u0005");
	assert.equal(state.expansionMode, "children");
	assert.match(picker.render(80).join("\n"), /kid/);
	picker.handleInput("\u0005");
	assert.equal(state.expansionMode, "all");
	picker.handleInput("\u0005");
	assert.equal(state.expansionMode, "collapsed");
	assert.doesNotMatch(picker.render(80).join("\n"), /kid/);
});

test("ctrl+e cycles under the Kitty keyboard protocol", () => {
	const { picker, state } = makePicker([parent, child], parent.info.path);
	picker.handleInput("\u001b[101;5u"); // ctrl+e as CSI-u
	assert.equal(state.expansionMode, "children");
	picker.handleInput("\u001b[101;5u");
	assert.equal(state.expansionMode, "all");
});

test("ctrl+a archives under the Kitty keyboard protocol", () => {
	const { picker, calls } = makePicker([archived], undefined);
	picker.handleInput("\u001b[116;5u"); // ctrl+t -> archived view
	picker.handleInput("\u001b[97;5u"); // ctrl+a
	assert.match(picker.render(80).join("\n"), /Unarchive this session\?/);
	picker.handleInput("\r");
	assert.deepEqual(calls, ["toggle:/w/c.jsonl"]);
});

test("a long title keeps the descendant badge visible", () => {
	const long = rec("/w/long.jsonl", { firstMessage: "x".repeat(200), allMessagesText: "x" });
	const kid = rec("/w/kid.jsonl", { name: "kid", parentSessionPath: "/w/long.jsonl" });
	const { picker } = makePicker([long, kid], undefined);
	const line = picker.render(60).find((candidate) => candidate.includes("xxxx"));
	assert.ok(line);
	assert.match(line, /↳1/);
});

test("the descendant badge follows the message", () => {
	const { picker } = makePicker([parent, child], parent.info.path);
	const line = picker.render(80).find((candidate) => candidate.includes("root"));
	assert.ok(line);
	assert.match(line, /root ↳1/);
});

test("the selected row background covers the right metadata", () => {
	const backgroundLines: string[] = [];
	const bgTheme = {
		fg: (_c: string, s: string) => s,
		bold: (s: string) => s,
		bg: (_c: string, s: string) => {
			backgroundLines.push(s);
			return s;
		},
	} as unknown as Theme;
	const long = rec("/w/current.jsonl", { name: "current", firstMessage: "x".repeat(120), allMessagesText: "x" });
	const kid = rec("/w/kid.jsonl", { name: "kid", parentSessionPath: "/w/current.jsonl" });
	const { picker } = makePicker([long, kid], long.info.path, bgTheme);
	picker.render(60);
	assert.equal(backgroundLines.length, 1);
	assert.match(backgroundLines[0], /↳1/);
	// A full ANSI reset inside the title would clear selectedBg for the rest.
	assert.doesNotMatch(backgroundLines[0], /\u001b\[0m/);
});

test("the children preset uses the native tree prefix", () => {
	const { picker } = makePicker([parent, child], parent.info.path);
	picker.handleInput("\u0005");
	const kidLine = picker.render(80).find((line) => line.includes("kid"));
	assert.ok(kidLine);
	assert.match(kidLine, /(?:├─|└─) kid/);
	assert.doesNotMatch(kidLine, /│\s+(?:├─|└─)/);
});

test("changing the sort keeps child sessions collapsed", () => {
	const { picker } = makePicker([parent, child], parent.info.path);
	picker.handleInput("\u0013"); // ctrl+s: threaded -> recent
	const text = picker.render(80).join("\n");
	assert.match(text, /↳1/);
	assert.doesNotMatch(text, /kid/);
});

test("the header uses the native scope title and filter prompt", () => {
	const { picker } = makePicker([parent], undefined);
	const text = picker.render(120).join("\n");
	assert.match(text, /Sessions \(Current Folder\)/);
	assert.match(text, /◉ Current Folder/);
	assert.match(text, /Name: All/);
	assert.match(text, /Sort: Threaded/);
	assert.match(text, /Filter: Active/);
	assert.doesNotMatch(text, /Showing:/);
	assert.match(text, /^> /m);
});

test("the confirmation prompt replaces the header hints", () => {
	const { picker } = makePicker([parent], parent.info.path);
	picker.handleInput("\u0001");
	const lines = picker.render(80);
	const promptIndex = lines.findIndex((line) => line.includes("Archive the current session"));
	const inputIndex = lines.findIndex((line) => line.trimStart().startsWith(">"));
	assert.ok(promptIndex >= 0);
	assert.ok(inputIndex > promptIndex);
	assert.doesNotMatch(lines.join("\n"), /ctrl\+s sort/);
});

test("ctrl+c cancels a pending confirmation", () => {
	const { picker, calls } = makePicker([parent], parent.info.path);
	picker.handleInput("\u0001");
	picker.handleInput("\u0003"); // ctrl+c
	assert.deepEqual(calls, []);
	assert.doesNotMatch(picker.render(80).join("\n"), /enter confirm/);
});

test("typing filters and enter resumes the selection", () => {
	const { picker, state, calls } = makePicker([parent, child], undefined);
	picker.handleInput("kid");
	assert.equal(state.query, "kid");
	picker.handleInput("\r");
	assert.deepEqual(calls, ["resume:/w/b.jsonl"]);
});

test("ctrl+a on a parent with children asks for confirmation first", () => {
	const { picker, calls } = makePicker([parent, child], "/w/x.jsonl");
	picker.handleInput("\u0001");
	assert.match(picker.render(80).join("\n"), /Archive this session and 1 child sessions\?/);
	assert.deepEqual(calls, []);
	picker.handleInput("\r");
	assert.deepEqual(calls, ["toggle:/w/a.jsonl"]);
});

test("ctrl+a on a single session asks for confirmation too", () => {
	const single = rec("/w/s.jsonl", { name: "solo" });
	const { picker, calls } = makePicker([single], undefined);
	picker.handleInput("\u0001");
	assert.match(picker.render(80).join("\n"), /Archive this session\?/);
	assert.deepEqual(calls, []);
	picker.handleInput("\r");
	assert.deepEqual(calls, ["toggle:/w/s.jsonl"]);
});

test("ctrl+a on the current session confirms the deferred archive", () => {
	const { picker, calls } = makePicker([parent], parent.info.path);
	picker.handleInput("\u0001");
	assert.match(
		picker.render(80).join("\n"),
		/Archive the current session when it closes\?/,
	);
	assert.deepEqual(calls, []);
	picker.handleInput("\r");
	assert.deepEqual(calls, ["toggle:/w/a.jsonl"]);
});

test("the confirmation prompt omits a long title", () => {
	const longName = "very-long-session-title-".repeat(8);
	const long = rec("/w/long.jsonl", { name: longName });
	const { picker } = makePicker([long], undefined);
	picker.handleInput("\u0001");
	const promptLine = picker.render(120).find((line) => line.includes("Archive this session"));
	assert.ok(promptLine);
	assert.doesNotMatch(promptLine, /very-long-session-title/);
});

test("ctrl+a counts hidden descendants when a query flattens the list", () => {
	const { picker, state, calls } = makePicker([parent, child], "/w/x.jsonl");
	state.setQuery("root");
	// The row still reports the full subtree total; archiving never trusts the
	// flat view's visible row count.
	assert.equal(state.rows().length, 1);
	assert.equal(state.rows()[0].descendantCount, 1);

	picker.handleInput("\u0001");

	assert.match(picker.render(80).join("\n"), /Archive this session and 1 child sessions\?/);
	assert.deepEqual(calls, []);
	picker.handleInput("\r");
	assert.deepEqual(calls, ["toggle:/w/a.jsonl"]);
});

test("ctrl+a on an archived session asks before unarchiving", () => {
	const { picker, calls } = makePicker([archived], undefined);
	picker.handleInput("\u0014"); // archive filter -> archived
	picker.handleInput("\u0001");
	assert.match(picker.render(80).join("\n"), /Unarchive this session\?/);
	assert.deepEqual(calls, []);
	picker.handleInput("\r");
	assert.deepEqual(calls, ["toggle:/w/c.jsonl"]);
});

test("the archived marker is rendered dim", () => {
	const dimCalls: string[] = [];
	const spyTheme = {
		fg: (color: string, text: string) => {
			if (color === "dim") dimCalls.push(text);
			return text;
		},
		bg: (_c: string, s: string) => s,
		bold: (s: string) => s,
	} as unknown as Theme;
	const { picker } = makePicker([archived], undefined, spyTheme);
	picker.handleInput("\u0014"); // archive filter -> archived
	picker.render(80);
	assert.ok(dimCalls.some((text) => text.includes("[archived]")));
});

test("esc cancels", () => {
	const { picker, calls } = makePicker([parent], undefined);
	picker.handleInput("\u001b");
	assert.deepEqual(calls, ["cancel"]);
});

test("ctrl+e changes the preset while the search has text", () => {
	const { picker, state } = makePicker([parent], undefined);
	picker.handleInput("abc");
	picker.handleInput("\u0005");
	assert.equal(state.query, "abc");
	assert.equal(state.expansionMode, "children");
});

test("plain left/right no longer expand rows", () => {
	const { picker, state } = makePicker([parent, child], parent.info.path);
	picker.handleInput("\u001b[C"); // right
	assert.doesNotMatch(picker.render(80).join("\n"), /kid/);
	assert.equal(state.expansionMode, "collapsed");
	picker.handleInput("\u001b[D"); // left
	assert.doesNotMatch(picker.render(80).join("\n"), /kid/);
	assert.equal(state.expansionMode, "collapsed");
});

test("left/right edit the query when the search has text", () => {
	const { picker, state } = makePicker([parent], undefined);
	picker.handleInput("abc");
	picker.handleInput("\u001b[D");
	picker.handleInput("X");
	assert.equal(state.query, "abXc");
	assert.equal(state.expansionMode, "collapsed");
});

test("the header shows the expansion preset", () => {
	const { picker } = makePicker([parent], undefined);
	assert.match(picker.render(120).join("\n"), /Expand: Collapsed/);
	picker.handleInput("\u0005");
	assert.match(picker.render(120).join("\n"), /Expand: Children/);
});

test("shortcut keys use dim, not accent", () => {
	const calls: Array<[string, string]> = [];
	const spyTheme = {
		fg: (color: string, text: string) => {
			calls.push([color, text]);
			return text;
		},
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
	const { picker } = makePicker([parent], undefined, spyTheme);
	picker.render(120);
	assert.ok(calls.some(([color, text]) => color === "dim" && text === "ctrl+e"));
	assert.ok(calls.some(([color, text]) => color === "dim" && text === "tab"));
	assert.ok(!calls.some(([color, text]) => color === "accent" && text === "ctrl+e"));
});

test("children preset hides subagent rows and All reveals them", () => {
	const fork: SessionRecord = { ...rec("/w/f.jsonl", { name: "fork", parentSessionPath: "/w/a.jsonl" }), relation: "fork" };
	const sub: SessionRecord = { ...rec("/w/s.jsonl", { name: "subkid", parentSessionPath: "/w/a.jsonl" }), relation: "subagent" };
	const { picker } = makePicker([parent, fork, sub], undefined);
	picker.handleInput("\u0005");
	const children = picker.render(80).join("\n");
	assert.match(children, /fork/);
	assert.doesNotMatch(children, /subkid/);
	picker.handleInput("\u0005");
	assert.match(picker.render(80).join("\n"), /subkid/);
});

test("the loading line replaces the empty state while records stream in", () => {
	const { picker, state } = makePicker([], undefined);
	state.beginLoading();
	const loading = picker.render(80).join("\n");
	assert.match(loading, /Loading sessions/);
	assert.doesNotMatch(loading, /No sessions/);
	state.setRecords([parent]);
	state.setLoadingProgress(1, 2, "live");
	assert.match(picker.render(80).join("\n"), /Loading sessions… 1\/2/);
	state.finishLoading([parent]);
	assert.doesNotMatch(picker.render(80).join("\n"), /Loading sessions/);
});

test("tab switches the scope and asks the owner to reload it", () => {
	const { picker, state, reloads } = makePicker([parent], undefined);
	picker.handleInput("\t");
	assert.equal(state.scope, "all");
	assert.deepEqual(reloads, ["all"]);
});

test("control characters in a title never reach the terminal", () => {
	const multiline = rec("/w/m.jsonl", { firstMessage: "first line\nsecond\u001b[31mred" });
	const { picker } = makePicker([multiline], undefined);
	const titleLine = picker.render(80).find((line) => line.includes("first line"));
	assert.ok(titleLine);
	assert.match(titleLine, /first line second \[31mred/);
	assert.doesNotMatch(titleLine, /[\u0000-\u001f\u007f-\u009f]/);
});
