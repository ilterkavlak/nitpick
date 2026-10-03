import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  mergeConfigWithFlags,
  isValidExitOn,
  type MergedOptions,
} from "./config";
import type { NitpickConfig } from "./types";

// ── mergeConfigWithFlags: default values when nothing is set ──────────
//
// Regression guard for the class of bug where a side-effectful option
// (posts to GitHub, writes files, etc.) silently defaults to "on". Every
// opt-in action MUST default to false. If you flip one of these, you're
// almost certainly introducing a bug — read this test before doing so.

test("mergeConfigWithFlags: postReview defaults to false (opt-in)", () => {
  const merged = mergeConfigWithFlags({}, {});
  assert.equal(
    merged.postReview,
    false,
    "postReview MUST default to false — it performs a side-effect against GitHub"
  );
});

test("mergeConfigWithFlags: auto defaults to false (opt-in)", () => {
  const merged = mergeConfigWithFlags({}, {});
  assert.equal(merged.auto, false);
});

test("mergeConfigWithFlags: writeReport defaults to false (opt-in)", () => {
  const merged = mergeConfigWithFlags({}, {});
  assert.equal(merged.writeReport, false);
});

test("mergeConfigWithFlags: nonInteractive defaults to false", () => {
  const merged = mergeConfigWithFlags({}, {});
  assert.equal(merged.nonInteractive, false);
});

test("mergeConfigWithFlags: summary defaults to true", () => {
  // summary is a read-only action (generates text in-memory / in report),
  // so unlike postReview it's fine to default to on.
  const merged = mergeConfigWithFlags({}, {});
  assert.equal(merged.summary, true);
});

test("mergeConfigWithFlags: exitOn defaults to 'none'", () => {
  const merged = mergeConfigWithFlags({}, {});
  assert.equal(merged.exitOn, "none");
});

test("mergeConfigWithFlags: all scanners default to enabled", () => {
  const merged = mergeConfigWithFlags({}, {});
  assert.equal(merged.scanners.secrets, true);
  assert.equal(merged.scanners.linter, true);
  assert.equal(merged.scanners.dependencies, true);
});

test("mergeConfigWithFlags: roles default to the full reviewer list", () => {
  const merged = mergeConfigWithFlags({}, {});
  assert.deepEqual(
    [...merged.roles].sort(),
    ["architecture", "dx", "performance", "security", "testing"]
  );
});

// ── postReview precedence (the specific regression) ────────────────────
//
// The previously-shipped bug: user answered "no" in the interactive
// picker, which made `flags.postReview` undefined at the merge boundary,
// and the default `?? true` silently re-enabled posting. Lock down every
// combination of (flag, config) so this can't regress.

test("mergeConfigWithFlags: postReview=false flag overrides config=true", () => {
  const merged = mergeConfigWithFlags({ postReview: true }, { postReview: false });
  assert.equal(
    merged.postReview,
    false,
    "An explicit false from CLI/interactive must beat a true from .nitpick.yaml"
  );
});

test("mergeConfigWithFlags: postReview=true flag overrides config=false", () => {
  const merged = mergeConfigWithFlags({ postReview: false }, { postReview: true });
  assert.equal(merged.postReview, true);
});

test("mergeConfigWithFlags: postReview=true from config is respected when flag is unset", () => {
  const merged = mergeConfigWithFlags({ postReview: true }, {});
  assert.equal(merged.postReview, true);
});

test("mergeConfigWithFlags: postReview=false from config is respected when flag is unset", () => {
  const merged = mergeConfigWithFlags({ postReview: false }, {});
  assert.equal(merged.postReview, false);
});

test("mergeConfigWithFlags: postReview undefined in both flag & config defaults to false", () => {
  // This is the exact scenario the regression used to get wrong:
  // interactive picker collapses `false` → `undefined` via `|| undefined`
  // in index.ts, and we must NOT treat that as "user opted in".
  const merged = mergeConfigWithFlags({}, { postReview: undefined });
  assert.equal(merged.postReview, false);
});

// ── flag precedence for other booleans ─────────────────────────────────
// Generic defense-in-depth: the same `?? ` pattern is used for every
// boolean. If someone accidentally uses `||` instead of `??`, or flips a
// default to `true`, these tests catch it.

test("mergeConfigWithFlags: auto=false flag overrides config=true", () => {
  const merged = mergeConfigWithFlags({ auto: true }, { auto: false });
  assert.equal(merged.auto, false);
});

test("mergeConfigWithFlags: writeReport=false flag overrides config.report=true", () => {
  const merged = mergeConfigWithFlags({ report: true }, { writeReport: false });
  assert.equal(merged.writeReport, false);
});

test("mergeConfigWithFlags: explicit false from flag is NOT treated as unset", () => {
  // Canary for `||` vs `??` regressions. If any boolean ever merges with
  // `flag || config.x || default`, a false flag silently falls through.
  const cfg: NitpickConfig = {
    postReview: true,
    auto: true,
    report: true,
    nonInteractive: true,
    summary: true,
  };
  const merged = mergeConfigWithFlags(cfg, {
    postReview: false,
    auto: false,
    writeReport: false,
    nonInteractive: false,
    summary: false,
  });
  assert.equal(merged.postReview, false);
  assert.equal(merged.auto, false);
  assert.equal(merged.writeReport, false);
  assert.equal(merged.nonInteractive, false);
  assert.equal(merged.summary, false);
});

// ── roles ──────────────────────────────────────────────────────────────

test("mergeConfigWithFlags: roles flag overrides config roles", () => {
  const merged = mergeConfigWithFlags(
    { roles: ["architecture", "dx"] },
    { roles: ["security"] }
  );
  assert.deepEqual(merged.roles, ["security"]);
});

test("mergeConfigWithFlags: invalid role strings in flags are dropped", () => {
  const merged = mergeConfigWithFlags({}, { roles: ["security", "not-a-role"] });
  assert.deepEqual(merged.roles, ["security"]);
});

// ── scanner merging ────────────────────────────────────────────────────

test("mergeConfigWithFlags: scanner flags override config scanners", () => {
  const merged = mergeConfigWithFlags(
    { scanners: { secrets: true, linter: true, dependencies: true } },
    { scanners: { secrets: false, linter: false, dependencies: false } }
  );
  assert.equal(merged.scanners.secrets, false);
  assert.equal(merged.scanners.linter, false);
  assert.equal(merged.scanners.dependencies, false);
});

test("mergeConfigWithFlags: config scanner={enabled:false} is respected when no flag", () => {
  const merged = mergeConfigWithFlags(
    { scanners: { secrets: { enabled: false } } },
    {}
  );
  assert.equal(merged.scanners.secrets, false);
});

test("mergeConfigWithFlags: config scanner with commands preserves commands when no flag", () => {
  const merged = mergeConfigWithFlags(
    { scanners: { linter: { enabled: true, commands: ["pnpm lint"] } } },
    {}
  );
  assert.deepEqual(merged.scanners.linter, { enabled: true, commands: ["pnpm lint"] });
});

// ── reviewer config merging ────────────────────────────────────────────

test("mergeConfigWithFlags: global model applies to every selected role", () => {
  const merged = mergeConfigWithFlags(
    { model: "claude-sonnet-4-6", roles: ["security", "dx"] },
    {}
  );
  assert.equal(merged.reviewerConfigs.security?.model, "claude-sonnet-4-6");
  assert.equal(merged.reviewerConfigs.dx?.model, "claude-sonnet-4-6");
});

test("mergeConfigWithFlags: per-reviewer config overrides the global model", () => {
  const merged = mergeConfigWithFlags(
    {
      model: "claude-sonnet-4-6",
      reviewers: { security: { model: "claude-opus-4-7" } },
      roles: ["security", "dx"],
    },
    {}
  );
  assert.equal(merged.reviewerConfigs.security?.model, "claude-opus-4-7");
  assert.equal(merged.reviewerConfigs.dx?.model, "claude-sonnet-4-6");
});

test("mergeConfigWithFlags: CLI-supplied reviewerConfigs override config file", () => {
  const merged = mergeConfigWithFlags(
    { reviewers: { security: { model: "claude-sonnet-4-6" } } },
    { reviewerConfigs: { security: { model: "claude-opus-4-7" } } }
  );
  assert.equal(merged.reviewerConfigs.security?.model, "claude-opus-4-7");
});

// ── isValidExitOn ──────────────────────────────────────────────────────

test("isValidExitOn accepts documented modes", () => {
  for (const v of ["none", "findings", "blockers", "changes-requested"]) {
    assert.equal(isValidExitOn(v), true, `${v} should be valid`);
  }
});

test("isValidExitOn rejects unknown modes", () => {
  assert.equal(isValidExitOn("anything"), false);
  assert.equal(isValidExitOn(""), false);
  assert.equal(isValidExitOn("NONE"), false);
});

// ── loadConfig: parsing .nitpick.yaml ──────────────────────────────────

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "nitpick-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadConfig returns empty object when no config file exists", () => {
  withTempDir((dir) => {
    assert.deepEqual(loadConfig(dir), {});
  });
});

test("loadConfig parses postReview from .nitpick.yaml", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, ".nitpick.yaml"), "postReview: true\n");
    assert.equal(loadConfig(dir).postReview, true);
  });
});

test("loadConfig parses .nitpick.yml as a fallback", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, ".nitpick.yml"), "auto: true\n");
    assert.equal(loadConfig(dir).auto, true);
  });
});

test("loadConfig ignores unknown keys silently", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, ".nitpick.yaml"), "somethingUnknown: true\n");
    const cfg = loadConfig(dir);
    assert.deepEqual(cfg, {});
  });
});

test("loadConfig drops invalid roles and exitOn values", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, ".nitpick.yaml"),
      "roles: [security, bogus]\nexitOn: invalid\n"
    );
    const cfg = loadConfig(dir);
    assert.deepEqual(cfg.roles, ["security"]);
    assert.equal(cfg.exitOn, undefined);
  });
});

// ── full-stack check: YAML → loadConfig → mergeConfigWithFlags ─────────
// Simulates the exact flow index.ts runs. Exists because the regression
// only manifested after the whole pipeline ran, not at any single layer.

test("full merge: postReview defaults to false even with a YAML file that omits it", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, ".nitpick.yaml"), "auto: true\n");
    const config = loadConfig(dir);
    const merged: MergedOptions = mergeConfigWithFlags(config, {});
    assert.equal(merged.postReview, false);
    assert.equal(merged.auto, true);
  });
});

test("full merge: interactive 'no' (collapsed to undefined) does NOT re-enable posting", () => {
  // Recreates the production pipeline at src/cli/index.ts:~268, where the
  // interactive answer is coerced through `|| undefined` before merge.
  const interactivePostReviewAnswer = false;
  const flagsPostReview = false;
  const asPassedToMerge = flagsPostReview || interactivePostReviewAnswer || undefined;
  assert.equal(asPassedToMerge, undefined, "precondition: the pipeline collapses false → undefined");

  const merged = mergeConfigWithFlags({}, { postReview: asPassedToMerge });
  assert.equal(
    merged.postReview,
    false,
    "With no config file and no CLI flag, an interactive 'no' must stay 'no'"
  );
});
