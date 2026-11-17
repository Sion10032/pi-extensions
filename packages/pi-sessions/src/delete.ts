/**
 * File-level primitives for deleting sessions.
 *
 * Deleting follows the same shape as archiving: a session is not just its
 * JSONL file. Its derived sessions (`parentSession` chain in the same folder)
 * belong to the subtree, its companions live beside it, and the same session
 * may also exist in the archive tree as a twin. All of them go together, or a
 * deleted session would come back as an orphan, a leftover directory, or a
 * row that reappears in the `archived` view.
 *
 * Moves go through the system trash first - the same `trash` CLI pi's own
 * picker tries - and fall back to a permanent `rm`. Everything is best
 * effort: one failure never stops the rest, and it is reported so the caller
 * can show it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { descendantFiles, findCompanions } from "./archive.ts";
import { archiveRoot, sessionIdFromFile, twinPaths, underRoot } from "./paths.ts";
import { clearPending, readIndex, writeIndex } from "./state.ts";

/** The two filesystem operations a delete needs; injectable for tests. */
export interface DeleteOps {
	/** Move every path to the system trash. True only when all of them are gone. */
	trash(paths: string[]): boolean;
	/** Remove one file or directory tree. Throws when it cannot. */
	remove(path: string): void;
}

export interface DeleteOptions {
	/**
	 * Session files that must not be deleted: typically the session pi is
	 * writing. A protected file anywhere in the subtree refuses the whole
	 * delete instead of leaving a half tree behind.
	 */
	protect?: readonly string[];
	ops?: Partial<DeleteOps>;
}

export interface DeleteResult {
	/** Paths that are gone, including companions and twins. */
	deleted: string[];
	/** Paths the filesystem refused to remove. */
	failed: string[];
	/** True when a protected file was part of the subtree; nothing was touched. */
	refused: boolean;
}

/** Trash arguments: `--` first, so a file named `-rf.jsonl` is not a flag. */
export function trashArgs(paths: string[]): string[] {
	return ["--", ...paths];
}

/**
 * The real operations. `trash` succeeds when the CLI exits 0 and the paths are
 * really gone (a `trash` that ignores its arguments must not look successful);
 * `remove` is recursive so one call covers files and companion directories.
 */
export function defaultDeleteOps(): DeleteOps {
	return {
		trash(paths: string[]): boolean {
			if (paths.length === 0) return true;
			const result = spawnSync("trash", trashArgs(paths), { encoding: "utf-8" });
			return result.status === 0 && paths.every((path) => !existsSync(path));
		},
		remove(path: string): void {
			rmSync(path, { recursive: true, force: true });
		},
	};
}

/** Resolved keys of the protected files, twins included. */
function protectedKeys(protect: readonly string[] | undefined): Set<string> {
	const keys = new Set<string>();
	for (const path of protect ?? []) {
		for (const twin of twinPaths(path)) keys.add(resolve(twin));
	}
	return keys;
}

/** Absolute paths, first occurrence wins. */
function unique(paths: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const path of paths) {
		const absolute = resolve(path);
		if (seen.has(absolute)) continue;
		seen.add(absolute);
		result.push(absolute);
	}
	return result;
}

/**
 * Delete `file` and its whole subtree, together with the companions and the
 * archive-tree twins of every session in it. Returns what disappeared and what
 * did not; a protected file inside the subtree refuses the delete whole.
 */
export function deleteSessionFile(file: string, options: DeleteOptions = {}): DeleteResult {
	const root = resolve(file);
	const protect = protectedKeys(options.protect);
	if (protect.has(root)) return { deleted: [], failed: [], refused: true };

	// Session files first, root first: their twins and descendants follow.
	const sessions = unique([root, ...descendantFiles(dirname(root), root)]);
	const sessionFiles = unique(
		sessions.flatMap((sessionFile) => twinPaths(sessionFile).filter((twin) => existsSync(twin))),
	);
	const companions = unique(
		sessionFiles.flatMap((sessionFile) => {
			const sessionDir = dirname(sessionFile);
			return findCompanions(sessionDir, sessionFile).map((rel) => join(sessionDir, rel));
		}),
	);
	if ([...sessionFiles, ...companions].some((path) => protect.has(path))) {
		return { deleted: [], failed: [], refused: true };
	}

	const base = defaultDeleteOps();
	const ops: DeleteOps = {
		trash: options.ops?.trash ?? base.trash,
		remove: options.ops?.remove ?? base.remove,
	};
	const deleted: string[] = [];
	const failed: string[] = [];

	// Trash handles the whole set in one call, companions included: a delete
	// that can be undone should be undone for the subagent artifacts and
	// screenshots too, not just for the JSONL files. A trash that cannot take
	// directories fails on the call and every path is removed individually.
	const all = [...sessionFiles, ...companions];
	if (all.length > 0) {
		if (ops.trash(all)) {
			deleted.push(...all);
		} else {
			for (const path of all) {
				try {
					ops.remove(path);
					deleted.push(path);
				} catch {
					failed.push(path);
				}
			}
		}
	}

	// The archive metadata follows the files: an index entry that names a deleted
	// file would keep a phantom archive alive. Only the removed keys are written
	// back, so a corrupt (empty-read) index is left untouched.
	const index = readIndex();
	let indexChanged = false;
	for (const path of deleted) {
		if (!path.endsWith(".jsonl")) continue;
		const key = underRoot(archiveRoot(), path);
		if (key !== undefined && key in index) {
			delete index[key];
			indexChanged = true;
		}
		clearPending(sessionIdFromFile(path));
	}
	if (indexChanged) writeIndex(index);

	return { deleted, failed, refused: false };
}
