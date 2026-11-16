import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { deferArchive, runSessions } from "./commands.ts";

export default function piSessions(pi: ExtensionAPI): void {
	pi.registerCommand("sessions", {
		description: "Browse and resume sessions, including archived ones",
		handler: (args, ctx) => runSessions(pi, ctx, args),
	});
	pi.registerCommand("archive", {
		description: "Archive the current session when it closes",
		handler: async (_args, ctx) => deferArchive(pi, ctx),
	});
}
