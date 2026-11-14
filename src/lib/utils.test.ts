import { test } from "node:test";
import assert from "node:assert/strict";
import { stripControlChars } from "./utils";

test("stripControlChars removes terminal escape sequences", () => {
  assert.equal(stripControlChars("a\x1b[2J\x1b]52;c;ZXZpbA==\x07b"), "a[2J]52;c;ZXZpbA==b");
  assert.equal(stripControlChars("x\r\u009by"), "xy");
});

test("stripControlChars keeps newlines, tabs and unicode", () => {
  assert.equal(stripControlChars("line 1\n\tline 2 — ✓"), "line 1\n\tline 2 — ✓");
});
