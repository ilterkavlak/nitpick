import { test } from "node:test";
import assert from "node:assert/strict";
import { computeExitCode } from "./review";

test("computeExitCode fails closed when every AI reviewer failed", () => {
  assert.equal(computeExitCode("blockers", null, [], true), 1);
  assert.equal(computeExitCode("findings", null, [], true), 1);
});

test("computeExitCode ignores reviewer failures when no gate is set", () => {
  assert.equal(computeExitCode("none", null, [], true), 0);
});

test("computeExitCode passes a clean run", () => {
  assert.equal(computeExitCode("blockers", null, [], false), 0);
});
