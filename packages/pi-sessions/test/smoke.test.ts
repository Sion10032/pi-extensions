import assert from "node:assert/strict";
import { test } from "node:test";

import piSessions from "../src/index.ts";

test("extension module exports a factory", () => {
	assert.equal(typeof piSessions, "function");
});
