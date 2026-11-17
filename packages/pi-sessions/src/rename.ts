/**
 * Renaming a session that is not the one pi is running.
 *
 * A session's display name is not stored in its header: it is the latest
 * `session_info` entry in the file, which is exactly what `pi.setSessionName`
 * appends for the running session and what pi's own picker appends through
 * `SessionManager.open(path).appendSessionInfo(name)` for any other one. Doing
 * the same keeps renames visible to `/resume`, `/sessions` and the footer, and
 * works on an archived file without moving it.
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Append `name` as the session's new display name. Whitespace-only names are
 * ignored (there is no way to clear a name this way, matching the native
 * picker) and return `false`; a write failure throws to the caller.
 */
export function renameSessionFile(file: string, name: string): boolean {
	const next = name.trim();
	if (next === "") return false;
	SessionManager.open(file).appendSessionInfo(next);
	return true;
}
