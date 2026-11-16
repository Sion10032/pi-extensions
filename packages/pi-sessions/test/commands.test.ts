import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { archiveSessionFile } from "../src/archive.ts";
import { formatOption, parseFilterArg, resolveResumeTarget, runSessions } from "../src/commands.ts";
import piSessions from "../src/index.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { archiveRoot, cwdDirName, sessionsRoot } from "../src/paths.ts";
import type { SessionRecord } from "../src/types.ts";

const CWD = "/work/project";
const ID = "01a0aaaa-0000-7000-8000-000000000001";
const OTHER_ID = "01a0aaaa-0000-7000-8000-000000000002";
const header = JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: CWD });
const headerWith = (id: string, timestamp: string) =>
	JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: CWD });

const record = (path: string, archived: boolean): SessionRecord => ({
	info: { path, id: ID, cwd: CWD, created: new Date("2026-01-01T00:00:00Z"), modified: new Date("2026-01-01T00:00:00Z"), messageCount: 1, firstMessage: "hello", allMessagesText: "hello" },
	archived, archiveDate: new Date("2026-01-01T00:00:00Z"),
});

beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-sessions-commands-"));
});

/** The live directory for `CWD`, created on demand. */
function liveDir(): string {
	const dir = join(sessionsRoot(), cwdDirName(CWD));
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Stubs the TUI picker needs to render without a terminal. */
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};
const tui = { requestRender() {} };
const keybindings = { matches: () => false };

interface FakeCtxOptions {
	mode: "tui" | "print";
	/** Answer for `ui.select`; receives the rendered options. */
	select?: (options: string[]) => string | undefined;
	/** Called with the rendered picker in TUI mode. */
	onPicker?: (rendered: string) => void;
}

/** A command context that records what the command asked the host to do. */
function fakeCtx(options: FakeCtxOptions) {
	const switched: string[] = [];
	const notices: string[] = [];
	let shown: string[] = [];
	const ctx = {
		mode: options.mode,
		cwd: CWD,
		sessionManager: { getSessionFile: () => undefined },
		ui: {
			notify: (message: string) => notices.push(message),
			select: async (_title: string, labels: string[]) => {
				shown = labels;
				return options.select?.(labels);
			},
			custom: async (factory: (
				stubTui: typeof tui,
				stubTheme: typeof theme,
				stubKeybindings: typeof keybindings,
				done: (result: null) => void,
			) => { render(width: number): string[] }) => {
				const picker = factory(tui, theme, keybindings, () => {});
				options.onPicker?.(picker.render(80).join("\n"));
				return null;
			},
		},
		switchSession: async (path: string) => {
			switched.push(path);
			return { cancelled: false };
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, switched, notices, labels: () => shown };
}

test("parseFilterArg accepts the three filters", () => {
	assert.equal(parseFilterArg("archived"), "archived");
	assert.equal(parseFilterArg(" all "), "all");
	assert.equal(parseFilterArg("nope"), undefined);
});

test("formatOption marks archived sessions", () => {
	assert.match(formatOption(record("/w/a.jsonl", true)), /\[archived\]/);
	assert.doesNotMatch(formatOption(record("/w/a.jsonl", false)), /\[archived\]/);
});

test("resolveResumeTarget restores an archived session first", () => {
	const live = join(sessionsRoot(), cwdDirName(CWD));
	mkdirSync(live, { recursive: true });
	const file = join(live, `a_${ID}.jsonl`);
	writeFileSync(file, `${header}\n`);
	archiveSessionFile(file);
	const archived = join(archiveRoot(), cwdDirName(CWD), `a_${ID}.jsonl`);
	const result = resolveResumeTarget(record(archived, true));
	assert.equal(result.target, file);
	assert.deepEqual(result.restored, [file]);
});

test("resolveResumeTarget prefers an existing live twin", () => {
	const live = join(sessionsRoot(), cwdDirName(CWD));
	mkdirSync(live, { recursive: true });
	const file = join(live, `a_${ID}.jsonl`);
	writeFileSync(file, `${header}\n`);
	const archived = join(archiveRoot(), cwdDirName(CWD), `a_${ID}.jsonl`);
	const result = resolveResumeTarget(record(archived, true));
	assert.equal(result.target, file);
	assert.deepEqual(result.restored, []);
});

test("registers the sessions command", () => {
	const names: string[] = [];
	const pi = { registerCommand: (name: string) => names.push(name), registerTool: () => {}, on: () => {} } as unknown as ExtensionAPI;
	piSessions(pi);
	assert.ok(names.includes("sessions"));
});

test("the non-TUI list resumes the numbered choice when titles collide", async () => {
	const live = liveDir();
	const older = join(live, `a_${ID}.jsonl`);
	const newer = join(live, `b_${OTHER_ID}.jsonl`);
	writeFileSync(older, `${headerWith(ID, "2026-01-01T00:00:00.000Z")}\n`);
	writeFileSync(newer, `${headerWith(OTHER_ID, "2026-02-01T00:00:00.000Z")}\n`);
	const { ctx, switched, labels } = fakeCtx({ mode: "print", select: (options) => options[1] });
	await runSessions({} as ExtensionAPI, ctx, "");
	assert.equal(labels().length, 2);
	assert.match(labels()[0], /^1\. /);
	// Newest first, so index 1 is the older file even though both titles match.
	assert.deepEqual(switched, [older]);
});

test("the non-TUI list shows archived sessions and restores the choice", async () => {
	const live = liveDir();
	const file = join(live, `a_${ID}.jsonl`);
	writeFileSync(file, `${header}\n`);
	archiveSessionFile(file);

	// Without an argument the list still shows archived sessions: `select` has
	// no `ctrl+t`, so a hidden archive would be unreachable from a non-TUI mode.
	const browsing = fakeCtx({ mode: "print", select: () => undefined });
	await runSessions({} as ExtensionAPI, browsing.ctx, "");
	assert.match(browsing.labels()[0], /\[archived\]/);
	assert.deepEqual(browsing.switched, []);

	const resuming = fakeCtx({ mode: "print", select: (options) => options[0] });
	await runSessions({} as ExtensionAPI, resuming.ctx, "archived");
	assert.deepEqual(resuming.switched, [file]);
	assert.deepEqual(resuming.notices, ["Restored to the active sessions list"]);
});

test("a chosen session whose file vanished is not switched", async () => {
	const live = liveDir();
	const file = join(live, `a_${ID}.jsonl`);
	writeFileSync(file, `${header}\n`);
	const { ctx, switched, notices } = fakeCtx({
		mode: "print",
		select: (options) => {
			rmSync(file);
			return options[0];
		},
	});
	await runSessions({} as ExtensionAPI, ctx, "");
	assert.deepEqual(switched, []);
	assert.deepEqual(notices, ["Session file is missing"]);
});

test("the TUI picker still opens when the current folder has no sessions", async () => {
	let renders = 0;
	let rendered = "";
	const { ctx, notices } = fakeCtx({
		mode: "tui",
		onPicker: (text) => {
			renders++;
			rendered = text;
		},
	});
	await runSessions({} as ExtensionAPI, ctx, "");
	// No early "nothing to show" return, so `tab` can still reload the all scope.
	assert.equal(renders, 1);
	assert.deepEqual(notices, []);
	assert.match(rendered, /No sessions match/);
});

test("the TUI picker applies the archive filter argument", async () => {
	const live = liveDir();
	const file = join(live, `a_${ID}.jsonl`);
	writeFileSync(file, `${header}\n`);
	archiveSessionFile(file);

	let rendered = "";
	const active = fakeCtx({ mode: "tui", onPicker: (text) => { rendered = text; } });
	await runSessions({} as ExtensionAPI, active.ctx, "");
	assert.doesNotMatch(rendered, /\[archived\]/);
	assert.match(rendered, /No sessions match/);

	const archived = fakeCtx({ mode: "tui", onPicker: (text) => { rendered = text; } });
	await runSessions({} as ExtensionAPI, archived.ctx, "archived");
	assert.match(rendered, /\[archived\]/);
	assert.deepEqual(archived.switched, []);
});
