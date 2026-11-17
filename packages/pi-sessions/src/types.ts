/**
 * Types shared by the loader, the search and the picker.
 *
 * They live here rather than beside their main consumer (`sessions.ts`) so
 * `search.ts` and `sessions.ts` can both use them without importing each
 * other.
 */
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

/** Which sessions the picker loads: this working directory or every one. */
export type Scope = "current" | "all";

/**
 * How matched sessions are ordered:
 * - `threaded` nests child sessions under their parent and otherwise ranks by relevance,
 * - `recent` keeps the newest first,
 * - `relevance` ranks by name, then message text, then fuzzy match.
 */
export type SortMode = "threaded" | "recent" | "relevance";

/** Which archive states the picker shows. */
export type ArchiveFilter = "active" | "archived" | "all";

/**
 * How the picker expands the tree:
 * - `collapsed` shows no children,
 * - `children` expands fork/clone subtrees and hides subagent rows,
 * - `all` expands everything, subagents included.
 */
export type ExpansionMode = "collapsed" | "children" | "all";

/**
 * How a child session came to be, from its file content:
 * - `fork`: a clone/fork copied this session's parent entries,
 * - `subagent`: a fresh subagent session (possibly with textual inherited context).
 */
export type SessionRelation = "fork" | "subagent";

/** A loaded session file plus what the archive tree knows about it. */
export interface SessionRecord {
	info: SessionInfo;
	archived: boolean;
	/** Archive time from the index, falling back to `info.modified`. */
	archiveDate: Date;
	/** Set on child sessions only; a root has no relation. */
	relation?: SessionRelation;
}
