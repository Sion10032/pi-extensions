import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import piSessions from "../src/index.ts";
import { archiveRoot, cwdDirName, sessionsRoot } from "../src/paths.ts";
import { readPending, setPending } from "../src/state.ts";

const CWD = "/work/project";
const ID = "01a0aaaa-0000-7000-8000-000000000001";
const header = JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: CWD });

type Handler = (...args: any[]) => unknown;
function fakePi() {
	const handlers = new Map<string, Handler>();
	const tools: string[] = [];
	const commands: string[] = [];
	let tool: any;
	const pi = {
		registerTool: (t: any) => { tools.push(t.name); tool = t; },
		registerCommand: (name: string) => commands.push(name),
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getSessionName: () => "work",
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	return { pi, handlers, tools, commands, getTool: () => tool };
}

let live: string;
let file: string;
beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-sessions-lifecycle-"));
	live = join(sessionsRoot(), cwdDirName(CWD));
	mkdirSync(live, { recursive: true });
	file = join(live, `a_${ID}.jsonl`);
	writeFileSync(file, `${header}\n`);
});

const ctx = {
	sessionManager: { getSessionFile: () => file, getSessionId: () => ID, getCwd: () => CWD },
	ui: { notify: () => {} },
} as unknown as ExtensionContext;

test("registers the tool, /archive and /sessions", () => {
	const { pi, tools, commands } = fakePi();
	piSessions(pi);
	assert.deepEqual(tools, ["archive_session"]);
	assert.deepEqual(commands.sort(), ["archive", "sessions"]);
});

test("session_shutdown archives a pending current session", () => {
	const { pi, handlers } = fakePi();
	piSessions(pi);
	setPending(ID, { path: file, cwd: CWD, requestedAt: "2026-01-01T00:00:00.000Z" });
	handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
	assert.equal(existsSync(join(archiveRoot(), cwdDirName(CWD), `a_${ID}.jsonl`)), true);
	assert.equal(existsSync(file), false);
});

test("reload does not move the file", () => {
	const { pi, handlers } = fakePi();
	piSessions(pi);
	setPending(ID, { path: file, cwd: CWD, requestedAt: "2026-01-01T00:00:00.000Z" });
	handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
	assert.equal(existsSync(file), true);
});

test("shutdown clears pending when the file is already gone", () => {
	const { pi, handlers } = fakePi();
	piSessions(pi);
	setPending(ID, { path: file, cwd: CWD, requestedAt: "2026-01-01T00:00:00.000Z" });
	unlinkSync(file);
	handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
	assert.equal(readPending()[ID], undefined);
});

test("switching to an already-archived target does not move it again", () => {
	const { pi, handlers } = fakePi();
	piSessions(pi);
	setPending(ID, { path: file, cwd: CWD, requestedAt: "2026-01-01T00:00:00.000Z" });
	handlers.get("session_shutdown")!({ reason: "switch", targetSessionFile: file }, ctx);
	assert.equal(existsSync(file), true);
});

test("session_start keeps pending armed for a live session", () => {
	const { pi, handlers } = fakePi();
	piSessions(pi);
	setPending(ID, { path: file, cwd: CWD, requestedAt: "2026-01-01T00:00:00.000Z" });
	assert.doesNotThrow(() => handlers.get("session_start")!({ reason: "startup" }, ctx));
});

test("the archive_session tool reports the deferred archive", async () => {
	const { pi, getTool } = fakePi();
	piSessions(pi);
	const result = await getTool().execute("call-1", {}, undefined, () => {}, ctx as any);
	assert.match(result.content[0].text, /archived when it closes/);
	assert.ok(readPending()[ID]);
});
