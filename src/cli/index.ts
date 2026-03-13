#!/usr/bin/env tsx

import { runReview } from "./review";
import { runInteractive } from "./interactive";
import { loadConfig, mergeConfigWithFlags } from "../lib/config";
import { cleanupAllBoxes } from "../lib/box";

const E = "\x1b";
const R = `${E}[0m`;
const B = `${E}[1m`;
const D = `${E}[2m`;
const BRAND = `${E}[38;5;75m`;
const ACCENT = `${E}[38;5;114m`;
const MUTED = `${E}[38;5;240m`;

function printUsage() {
  console.log(`
  ${BRAND}${B}🔎  Nitpick${R}  ${D}AI-powered PR review${R}

  ${B}Usage${R}
    ${ACCENT}nitpick review${R} ${D}[github-pr-url] [options]${R}

    If no URL is provided, launches interactive mode to browse
    your repositories and open PRs.

  ${B}Options${R}
    ${ACCENT}--roles${R} <roles>    Comma-separated reviewer roles ${D}(default: all)${R}
                       ${D}Available: security, performance, architecture, testing, dx${R}
    ${ACCENT}--output${R} <file>    Output markdown report path ${D}(default: pr-review-<number>.md)${R}
    ${ACCENT}--no-report${R}        Skip writing markdown report to local file
    ${ACCENT}--auto${R}             Skip interactive triage, accept all findings automatically
    ${ACCENT}--post-review${R}      Post review as GitHub PR review with inline comments
    ${ACCENT}--help${R}             Show this help message

  ${B}Config${R}
    Place a ${ACCENT}.nitpick.yaml${R} in your repo root to set defaults for roles,
    model, scanners, and more. CLI flags override config file values.

  ${B}Examples${R}
    ${MUTED}$${R} nitpick review
    ${MUTED}$${R} nitpick review https://github.com/org/repo/pull/42
    ${MUTED}$${R} nitpick review https://github.com/org/repo/pull/42 --roles security,performance
    ${MUTED}$${R} nitpick review https://github.com/org/repo/pull/42 --auto --post-review
    ${MUTED}$${R} nitpick review https://github.com/org/repo/pull/42 --no-report
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  const positionals: string[] = [];

  // Parse flags from all args
  let roles: string[] | undefined;
  let output: string | undefined;
  let writeReport: boolean | undefined;
  let auto = false;
  let postReview = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--roles" && args[i + 1]) {
      roles = args[i + 1].split(",").map((r) => r.trim());
      i++;
    } else if (args[i] === "--roles") {
      throw new Error("Missing value for --roles");
    } else if (args[i] === "--output" && args[i + 1]) {
      output = args[i + 1];
      i++;
    } else if (args[i] === "--output") {
      throw new Error("Missing value for --output");
    } else if (args[i] === "--no-report") {
      writeReport = false;
    } else if (args[i] === "--auto") {
      auto = true;
    } else if (args[i] === "--post-review") {
      postReview = true;
    } else if (args[i].startsWith("--")) {
      throw new Error(`Unknown option: ${args[i]}`);
    } else {
      positionals.push(args[i]);
    }
  }

  // Load .nitpick.yaml config
  const config = loadConfig();

  // No args at all → interactive
  if (!command) {
    const result = await runInteractive(output, writeReport);
    const merged = mergeConfigWithFlags(config, {
      roles: roles ?? result.roles,
      writeReport: result.writeReport,
      outputPath: result.output,
      auto: auto || undefined,
      postReview: postReview || result.postReview || undefined,
      summary: result.summary,
      scanners: {
        secrets: result.scanners.includes("secrets"),
        linter: result.scanners.includes("linter"),
        dependencies: result.scanners.includes("dependencies"),
      },
      reviewerConfigs: result.reviewerConfigs,
    });
    await runReview(result.prUrl, { mergedConfig: merged });
    process.exit(0);
  }

  if (command !== "review") {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  // Find the PR URL (first positional argument after "review")
  const prUrl = positionals[0];

  if (!prUrl) {
    // No URL → interactive mode, but pass any flags through
    const result = await runInteractive(output, writeReport);
    const merged = mergeConfigWithFlags(config, {
      roles: roles ?? result.roles,
      writeReport: result.writeReport,
      outputPath: result.output,
      auto: auto || undefined,
      postReview: postReview || result.postReview || undefined,
      summary: result.summary,
      scanners: {
        secrets: result.scanners.includes("secrets"),
        linter: result.scanners.includes("linter"),
        dependencies: result.scanners.includes("dependencies"),
      },
      reviewerConfigs: result.reviewerConfigs,
    });
    await runReview(result.prUrl, { mergedConfig: merged });
    process.exit(0);
  }

  const merged = mergeConfigWithFlags(config, {
    roles,
    writeReport,
    outputPath: output,
    auto: auto || undefined,
    postReview: postReview || undefined,
  });
  await runReview(prUrl, { mergedConfig: merged });
  process.exit(0);
}

// Ensure boxes are destroyed on SIGTERM (e.g. container shutdown, kill)
process.on("SIGTERM", async () => {
  console.error("\nReceived SIGTERM, cleaning up boxes...");
  await cleanupAllBoxes();
  process.exit(0);
});

main().catch(async (err) => {
  // Last-resort cleanup: destroy any boxes still alive after an unhandled error
  await cleanupAllBoxes();
  console.error("Fatal error:", err.message ?? err);
  process.exit(1);
});
