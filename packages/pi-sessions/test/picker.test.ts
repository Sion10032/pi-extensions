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
	const state = new PickerState(records, current, "/work");
	const picker = new SessionPicker({
		state, theme: pickerTheme, tui, keybindings: kb,
		onResume: (r) => calls.push(`resume:${r.info.path}`),
		onToggleArchive: (r) => calls.push(`toggle:${r.info.path}`),
		onCancel: () => calls.push("cancel"),
	});
	return { picker, state, calls };
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

test("ctrl+e expands the selected parent and rerenders children", () => {
	const { picker } = makePicker([parent, child], parent.info.path);
	picker.handleInput("\u0005");
	assert.match(picker.render(80).join("\n"), /kid/);
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
	assert.match(picker.render(80).join("\n"), /Archive .*child/);
	assert.deepEqual(calls, []);
	picker.handleInput("\r");
	assert.deepEqual(calls, ["toggle:/w/a.jsonl"]);
});

test("ctrl+a on an archived session toggles immediately", () => {
	const { picker, calls } = makePicker([archived], undefined);
	picker.handleInput("\u0014"); // archive filter -> archived
	picker.handleInput("\u0001");
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
