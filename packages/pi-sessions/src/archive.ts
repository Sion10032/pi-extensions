/**
 * File-level primitives for archiving sessions.
 *
 * A session owns more than its JSONL file: subagent runs and forks live in a
 * sibling directory, agent-browser keeps screenshots per session id, and
 * subagent artifacts are grouped by run. These helpers find and move those
 * companions, fold a late tail back into an archived file, strip the legacy
 * archive tag, and discover derived sessions by their parent chain.
 *
 * Moves are best effort: one failing companion never aborts the rest.
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	basename,
	dirname,
	join,
	resolve,
} from "node:path";

import {
	ARCHIVE_TAG,
	readHeader,
	sessionIdFromFile,
	twinPaths,
} from "./paths.ts";

function parentSessionId(metaFile: string): string | undefined {
	try {
		return JSON.parse(readFileSync(metaFile, "utf8")).parentSessionId;
	} catch {
		return undefined;
	}
}

const SUBAGENT_ARTIFACT_SUFFIX = /^_(?:input\.md|output\.md|meta\.json|transcript\.jsonl)$/;

/**
 * Paths, relative to a per-cwd sessions dir, that belong to a session beside its
 * file: its `<file>/` dir (subagent runs, forks), its subagent-artifacts runs, and its agent-browser screenshots.
 */
export function findCompanions(dir: string, file: string): string[] {
	const id = sessionIdFromFile(file);
	const found = [basename(file, ".jsonl"), join(".pi-agent-browser-artifacts", id)].filter((rel) =>
		existsSync(join(dir, rel)),
	);
	const artifactsDir = join(dir, "subagent-artifacts");
	if (!existsSync(artifactsDir)) return found;
	const names = readdirSync(artifactsDir);
	for (const meta of names.filter((name) => name.endsWith("_meta.json"))) {
		if (parentSessionId(join(artifactsDir, meta)) !== id) continue;
		const run = meta.slice(0, -"_meta.json".length);
		for (const name of names) {
			if (name.startsWith(run) && SUBAGENT_ARTIFACT_SUFFIX.test(name.slice(run.length))) {
				found.push(join("subagent-artifacts", name));
			}
		}
	}
	return found;
}

/** Best effort: a companion whose destination already exists stays where it is. */
export function moveCompanions(fromDir: string, toDir: string, file: string): void {
	for (const rel of findCompanions(fromDir, file)) {
		const target = join(toDir, rel);
		if (existsSync(target)) continue;
		try {
			mkdirSync(dirname(target), { recursive: true });
			renameSync(join(fromDir, rel), target);
		} catch {}
	}
}

function parseEntries(file: string): { id?: string; parentId?: string | null; type?: string }[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return {};
			}
		});
}

/**
 * A headerless file at the live path is the tail pi kept writing after an
 * earlier move: append it to the archived copy when all its entries chain onto it.
 */
export function appendIfContinuation(fragment: string, archived: string): boolean {
	const tail = parseEntries(fragment);
	if (tail.length === 0 || tail[0].type === "session") return false;
	const archivedIds = new Set(parseEntries(archived).map((entry) => entry.id));
	const tailIds = new Set(tail.map((entry) => entry.id));
	const parents = tail.map((entry) => entry.parentId).filter((id): id is string => typeof id === "string");
	if (!parents.some((id) => archivedIds.has(id))) return false;
	if (!parents.every((id) => archivedIds.has(id) || tailIds.has(id))) return false;
	const separator = readFileSync(archived, "utf8").endsWith("\n") ? "" : "\n";
	appendFileSync(archived, separator + readFileSync(fragment, "utf8"));
	unlinkSync(fragment);
	return true;
}

/**
 * Strip the [ARCHIVE] tag from the last session_info name, editing the file
 * in place (temp file + rename so a crash cannot truncate it). Restoring
 * needs this: a restored file that keeps the tag would be re-archived on its
 * next close by the self-heal logic. Best effort; the move already succeeded.
 */
export function stripLegacyTag(file: string): void {
	try {
		const lines = readFileSync(file, "utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (!line.includes('"type":"session_info"')) continue;
			const match = line.match(/"name":"((?:[^"\\]|\\.)*)"/);
			if (!match) return;
			const decoded = JSON.parse(`"${match[1]}"`);
			if (!decoded.startsWith(ARCHIVE_TAG)) return;
			const stripped = JSON.stringify(decoded.slice(ARCHIVE_TAG.length)).slice(1, -1);
			lines[i] = line.replace(`"name":"${match[1]}"`, `"name":"${stripped}"`);
			const tmp = `${file}.pi-sessions-tmp`;
			writeFileSync(tmp, lines.join("\n"));
			renameSync(tmp, file);
			return;
		}
	} catch {
		// best effort: a malformed file must not abort the surrounding operation
	}
}

/**
 * Session files in `dir` whose header names `rootFile` or one of its
 * descendants as their `parentSession`, walking the chain breadth first.
 * Parent headers may point at either the live or archived path of a file,
 * so twin paths are compared as well.
 */
export function descendantFiles(dir: string, rootFile: string): string[] {
	const parents = new Map<string, string | undefined>();
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const file = join(dir, name);
		parents.set(file, readHeader(file)?.parentSession);
	}
	const seen = new Set<string>();
	const result: string[] = [];
	const queue = [rootFile];
	while (queue.length > 0) {
		const current = queue.shift()!;
		const keys = new Set(twinPaths(current).map((p) => resolve(p)));
		for (const [path, parent] of parents) {
			if (!parent || seen.has(path)) continue;
			if (!keys.has(resolve(parent))) continue;
			seen.add(path);
			result.push(path);
			queue.push(path);
		}
	}
	return result;
}
