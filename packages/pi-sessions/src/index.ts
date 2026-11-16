import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runSessions } from "./commands.ts";

export default function piSessions(pi: ExtensionAPI): void {
	pi.registerCommand("sessions", {
		description: "Browse and resume sessions, including archived ones",
		handler: (args, ctx) => runSessions(pi, ctx, args),
	});
}
