#!/usr/bin/env tsx

import { runReview } from "./review";
import type { ReviewTarget } from "./review";
import { runInteractive } from "./interactive";
import { isValidExitOn, loadConfig, mergeConfigWithFlags } from "../lib/config";
import { cleanupAllBoxes } from "../lib/box";
import { parsePrUrl } from "../lib/utils";
import type { ExitOnMode } from "../lib/types";

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
    ${ACCENT}nitpick review${R} ${D}--repo <owner/name> --base <ref> --head <ref> [options]${R}

    If no URL or ref target is provided, launches interactive mode
    (disabled when --non-interactive is set).

  ${B}Targets${R}
    ${ACCENT}<github-pr-url>${R}       Review a GitHub pull request
    ${ACCENT}--repo${R} <owner/name>   Repository (for ref mode)
    ${ACCENT}--base${R} <ref>          Base git ref / branch / tag / SHA
    ${ACCENT}--head${R} <ref>          Head git ref / branch / tag / SHA

  ${B}Options${R}
    ${ACCENT}--roles${R} <roles>       Comma-separated reviewer roles ${D}(default: all)${R}
                          ${D}Available: security, performance, architecture, testing, dx${R}
    ${ACCENT}--output${R} <file>       Output markdown report path
    ${ACCENT}--no-report${R}           Skip writing markdown report
    ${ACCENT}--auto${R}                Skip interactive triage, accept all findings automatically
    ${ACCENT}--post-review${R}         Post review as GitHub PR review with inline comments ${D}(PR mode only)${R}
    ${ACCENT}--json${R} <file|->       Write structured JSON report to file, or '-' for stdout
    ${ACCENT}--exit-on${R} <mode>      Set non-zero exit code based on verdict:
                          ${D}none (default) | findings | blockers | changes-requested${R}
    ${ACCENT}--non-interactive${R}     Fail fast on missing credentials, never prompt
    ${ACCENT}--help${R}                Show this help message

  ${B}Config${R}
    Place a ${ACCENT}.nitpick.yaml${R} in your repo root to set defaults for roles,
    model, scanners, and more. CLI flags override config file values.

  ${B}Examples${R}
    ${MUTED}$${R} nitpick review
    ${MUTED}$${R} nitpick review https://github.com/org/repo/pull/42
    ${MUTED}$${R} nitpick review https://github.com/org/repo/pull/42 --roles security,performance
    ${MUTED}$${R} nitpick review https://github.com/org/repo/pull/42 --auto --post-review
    ${MUTED}$${R} nitpick review --repo org/repo --base main --head feature --auto --json -
    ${MUTED}$${R} nitpick review <url> --auto --non-interactive --json out.json --exit-on blockers
`);
}

function parseRepoSlug(slug: string): { owner: string; repo: string } | null {
  const m = slug.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

interface ParsedFlags {
  roles?: string[];
  output?: string;
  writeReport?: boolean;
  auto: boolean;
  postReview: boolean;
  json?: string | boolean;
  exitOn?: ExitOnMode;
  nonInteractive: boolean;
  repo?: string;
  base?: string;
  head?: string;
  positionals: string[];
}

function parseArgs(args: string[]): ParsedFlags {
  const positionals: string[] = [];
  const out: ParsedFlags = {
    auto: false,
    postReview: false,
    nonInteractive: false,
    positionals,
  };

  const needsValue = (flag: string, value: string | undefined): string => {
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    switch (a) {
      case "--roles":
        out.roles = needsValue(a, next).split(",").map((r) => r.trim());
        i++;
        break;
      case "--output":
        out.output = needsValue(a, next);
        i++;
        break;
      case "--no-report":
        out.writeReport = false;
        break;
      case "--auto":
        out.auto = true;
        break;
      case "--post-review":
        out.postReview = true;
        break;
      case "--json":
        // Optional value: if next arg is absent or starts with "--", treat as stdout.
        if (next === undefined || next.startsWith("--")) {
          out.json = true;
        } else {
          out.json = next;
          i++;
        }
        break;
      case "--exit-on": {
        const v = needsValue(a, next);
        if (!isValidExitOn(v)) {
          throw new Error(
            `Invalid --exit-on value: ${v}. Expected one of: none, findings, blockers, changes-requested`
          );
        }
        out.exitOn = v;
        i++;
        break;
      }
      case "--non-interactive":
        out.nonInteractive = true;
        break;
      case "--repo":
        out.repo = needsValue(a, next);
        i++;
        break;
      case "--base":
        out.base = needsValue(a, next);
        i++;
        break;
      case "--head":
        out.head = needsValue(a, next);
        i++;
        break;
      default:
        if (a.startsWith("--")) {
          throw new Error(`Unknown option: ${a}`);
        }
        positionals.push(a);
    }
  }

  return out;
}

function resolveTarget(flags: ParsedFlags): ReviewTarget | null {
  const prUrl = flags.positionals[0];
  const usingRefFlags = flags.repo || flags.base || flags.head;

  if (prUrl && usingRefFlags) {
    throw new Error(
      "Cannot combine a PR URL with --repo/--base/--head. Choose one mode."
    );
  }

  if (prUrl) {
    const parsed = parsePrUrl(prUrl);
    if (!parsed) {
      throw new Error(
        "Invalid GitHub PR URL. Expected: https://github.com/<owner>/<repo>/pull/<number>"
      );
    }
    return {
      kind: "pr",
      prUrl,
      owner: parsed.owner,
      repo: parsed.repo,
      prNumber: parsed.prNumber,
    };
  }

  if (usingRefFlags) {
    if (!flags.repo || !flags.base || !flags.head) {
      throw new Error(
        "Ref mode requires --repo <owner/name>, --base <ref>, and --head <ref>."
      );
    }
    const parsed = parseRepoSlug(flags.repo);
    if (!parsed) {
      throw new Error(`Invalid --repo value: ${flags.repo}. Expected owner/name.`);
    }
    return {
      kind: "ref",
      owner: parsed.owner,
      repo: parsed.repo,
      baseRef: flags.base,
      headRef: flags.head,
    };
  }

  return null;
}

async function main() {
  const raw = process.argv.slice(2);

  if (raw.includes("--help") || raw.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const command = raw[0];
  let flagArgs = raw;
  if (command === "review") {
    flagArgs = raw.slice(1);
  } else if (command && command.startsWith("--") === false) {
    // Unknown command that is not a flag
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const flags = parseArgs(flagArgs);
  const config = loadConfig();

  const target = resolveTarget(flags);

  const sharedFlags = {
    roles: flags.roles,
    writeReport: flags.writeReport,
    outputPath: flags.output,
    auto: flags.auto || undefined,
    postReview: flags.postReview || undefined,
    json: flags.json,
    exitOn: flags.exitOn,
    nonInteractive: flags.nonInteractive || undefined,
  };

  if (target) {
    const merged = mergeConfigWithFlags(config, sharedFlags);
    const result = await runReview(target, { mergedConfig: merged });
    releaseStdin();
    process.exit(result?.exitCode ?? 0);
  }

  // No explicit target → interactive mode, unless forbidden.
  if (flags.nonInteractive) {
    console.error(
      "No target specified. Provide a PR URL or --repo/--base/--head (non-interactive mode blocks the picker)."
    );
    process.exit(1);
  }

  const interactiveResult = await runInteractive(flags.output, flags.writeReport);
  const merged = mergeConfigWithFlags(config, {
    roles: flags.roles ?? interactiveResult.roles,
    writeReport: interactiveResult.writeReport,
    outputPath: interactiveResult.output,
    auto: flags.auto || undefined,
    postReview: flags.postReview || interactiveResult.postReview || undefined,
    summary: interactiveResult.summary,
    json: flags.json,
    exitOn: flags.exitOn,
    nonInteractive: flags.nonInteractive || undefined,
    scanners: {
      secrets: interactiveResult.scanners.includes("secrets"),
      linter: interactiveResult.scanners.includes("linter"),
      dependencies: interactiveResult.scanners.includes("dependencies"),
    },
    reviewerConfigs: interactiveResult.reviewerConfigs,
  });
  const parsedPr = parsePrUrl(interactiveResult.prUrl);
  if (!parsedPr) {
    console.error("Invalid PR URL returned from interactive picker.");
    process.exit(1);
  }
  const interactiveTarget: ReviewTarget = {
    kind: "pr",
    prUrl: interactiveResult.prUrl,
    owner: parsedPr.owner,
    repo: parsedPr.repo,
    prNumber: parsedPr.prNumber,
  };
  const result = await runReview(interactiveTarget, { mergedConfig: merged });
  releaseStdin();
  process.exit(result?.exitCode ?? 0);
}

// Release any stdin ref-count inherited from inquirer/dashboard/etc so that
// we don't rely solely on process.exit() to kick a hung event loop free.
function releaseStdin(): void {
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  } catch {
    // ignore — stdin may already be detached
  }
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
