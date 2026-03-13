import { parsePrUrl } from "../lib/utils";
import { createArena } from "../lib/arena/create";
import { setOnEvent, clearEvents } from "../lib/arena/events";
import { publishEvent } from "../lib/arena/events";
import { getFindings, clearFindings, saveFinding } from "../lib/arena/findings";
import {
  updateArenaStatus,
  getArena,
  getAllReviewers,
  checkAllReviewersDone,
  clearArenaState,
} from "../lib/arena/status";
import { executeReviewerJob } from "../lib/reviewer/worker";
import { generateVerdict, getVerdict, clearVerdict } from "../lib/arena/verdict";
import { renderEvent, renderVerdict, renderSummary } from "./renderer";
import {
  startDashboard,
  addWorkerToBoard,
  handleDashboardEvent,
  updateWorkerStatus,
  pingWorkerActivity,
  stopDashboard,
} from "./dashboard";
import type { DashboardSummary } from "./dashboard";
import { generateMarkdownReport } from "./markdown";
import { triageFindings } from "./triage";
import { fetchPrDiff } from "../lib/github";
import { generatePrSummary } from "../lib/summarizer";
import { scanSecretsInDiff } from "../lib/scanners/secrets";
import { scanDependencies } from "../lib/scanners/dependencies";
import { scanWithLinter } from "../lib/scanners/linter";
import { submitPrReview } from "../lib/github-review";
import type { PostProgress } from "../lib/github-review";
import { cleanupAllBoxes, getActiveBoxCount } from "../lib/box";
import {
  ensureBoxApiKeyInteractive,
  requireBoxApiKey,
  requireGitReadToken,
  requireGitReviewToken,
} from "../lib/auth";
import { verifyFindings } from "../lib/reviewer/verifier";
import type {
  ReviewerRole,
  ReviewerConfig,
  WorkerPayload,
  PrSummary,
  Finding,
  Verdict,
} from "../lib/types";
import type { MergedOptions } from "../lib/config";
import { writeFileSync } from "fs";
import { status } from "./status";

const ALL_ROLES: ReviewerRole[] = ["security", "performance", "architecture", "testing", "dx"];

const RCOL: Record<string, string> = {
  security: "\x1b[31m", performance: "\x1b[33m", architecture: "\x1b[35m",
  testing: "\x1b[32m", dx: "\x1b[36m", secrets: "\x1b[91m", linter: "\x1b[34m",
  dependencies: "\x1b[38;5;208m", verifier: "\x1b[38;5;183m",
};

function renderDashboardSummary(ds: DashboardSummary): void {
  const ok = `\x1b[38;5;114m✓\x1b[0m`;
  const fail = `\x1b[31m✗\x1b[0m`;
  const dim = `\x1b[2m`;
  const r = `\x1b[0m`;
  const b = `\x1b[1m`;

  console.log(`\n  ${ok}  ${b}${ds.text}${r}\n`);

  for (const w of ds.workerTimes) {
    const col = RCOL[w.role] ?? "\x1b[90m";
    const icon = w.status === "failed" ? fail : ok;
    const t = w.elapsed ? `${dim}${w.elapsed}${r}` : `${dim}—${r}`;
    const f = w.findings > 0 ? `  ${dim}${w.findings} finding(s)${r}` : "";
    console.log(`  ${icon}  ${col}${w.role}${r}  ${t}${f}`);
  }
  console.log("");
}

export interface ReviewOptions {
  roles?: string[];
  outputPath?: string;
  auto?: boolean;
  postReview?: boolean;
  reviewerConfigs?: Record<string, ReviewerConfig>;
  mergedConfig?: MergedOptions;
}

export async function runReview(
  prUrl: string,
  options: ReviewOptions = {}
): Promise<void> {
  // Use merged config if provided, otherwise fall back to raw options
  const merged = options.mergedConfig;
  const roles = merged?.roles ?? options.roles;
  const writeReport = merged?.writeReport ?? true;
  const outputPath = merged?.outputPath ?? options.outputPath;
  const auto = merged?.auto ?? options.auto ?? false;
  const postReview = merged?.postReview ?? options.postReview ?? false;
  const enableSummary = merged?.summary ?? true;
  const reviewerConfigs = merged?.reviewerConfigs ?? options.reviewerConfigs;
  const scanners = merged?.scanners ?? { secrets: true, linter: true, dependencies: true };

  // ── Setup phase: visible status for every step ───────────────
  status.header("🔎  Nitpik");

  // Validate env
  try {
    requireBoxApiKey();
  } catch {
    await ensureBoxApiKeyInteractive();
  }
  requireGitReadToken();
  if (postReview) {
    requireGitReviewToken();
  }
  status.ok(
    "Environment validated",
    postReview
      ? "Box API key, GitHub read token, GitHub review token"
      : "Box API key, GitHub read token"
  );

  // Parse PR URL
  const parsed = parsePrUrl(prUrl);
  if (!parsed) {
    status.fail("Invalid PR URL");
    throw new Error(
      "Invalid GitHub PR URL. Expected: https://github.com/<owner>/<repo>/pull/<number>"
    );
  }

  const { owner, repo, prNumber } = parsed;
  status.ok("Parsed PR URL", `${owner}/${repo}#${prNumber}`);

  // Resolve roles
  const selectedRoles: ReviewerRole[] = roles
    ? (typeof roles[0] === "string" ? roles : []).filter((r): r is ReviewerRole => ALL_ROLES.includes(r as ReviewerRole))
    : ALL_ROLES;

  if (selectedRoles.length === 0) {
    status.fail("No valid roles selected");
    throw new Error(`No valid roles. Choose from: ${ALL_ROLES.join(", ")}`);
  }
  status.ok("Roles", selectedRoles.join(", "));

  // Determine which scanners are active
  const enabledScanners: string[] = [];
  if (scanners.secrets) enabledScanners.push("secrets");
  if (typeof scanners.linter === "boolean" ? scanners.linter : scanners.linter.enabled)
    enabledScanners.push("linter");
  if (scanners.dependencies) enabledScanners.push("dependencies");
  if (enabledScanners.length > 0) {
    status.ok("Scanners", enabledScanners.join(", "));
  }
  status.ok("PR comments", postReview ? "enabled" : "disabled");

  // Fetch PR metadata and create arena session
  const doneMeta = status.start("Fetching PR metadata");
  const session = await createArena(prUrl, owner, repo, prNumber, selectedRoles);
  doneMeta(`"${session.prTitle}" by @${session.prAuthor}`);

  status.ok("Review session created", session.id.slice(0, 8));
  status.gap();

  // Decide rendering mode: dashboard (TTY) vs plain (piped / non-TTY)
  const useDashboard = Boolean(process.stdout.isTTY);

  if (useDashboard) {
    startDashboard(
      `${owner}/${repo} #${prNumber}`,
      [...selectedRoles, ...enabledScanners]
    );
  }

  // Register the correct event handler
  setOnEvent(useDashboard ? handleDashboardEvent : renderEvent);

  // Mark arena running
  await updateArenaStatus(session.id, "running");

  // Build payloads
  const payloads: WorkerPayload[] = selectedRoles.map((role) => ({
    arenaId: session.id,
    role,
    owner,
    repo,
    prNumber,
    baseSha: session.baseSha,
    headSha: session.headSha,
    config: reviewerConfigs?.[role],
  }));

  // SIGINT handler for graceful shutdown
  let interrupted = false;
  const sigintHandler = () => {
    if (interrupted) {
      if (useDashboard) stopDashboard();
      process.exit(1);
    }
    interrupted = true;
    if (!useDashboard) {
      console.log(
        "\n\nInterrupted. Marking run as cancelled and waiting for in-flight reviewers to stop..."
      );
    }
  };
  process.on("SIGINT", sigintHandler);

  let prSummary: PrSummary | undefined;
  let reviewerFailures = false;

  const postReviewToGitHub = async (
    findingsToPost: Finding[],
    verdictToPost: Verdict,
    dismissedCount = 0
  ) => {
    if (!postReview) return;
    try {
          status.header("⚖  Posting to GitHub");

      const onProgress = (ev: PostProgress) => {
        const ok = `\x1b[38;5;114m✓\x1b[0m`;
        const warn = `\x1b[33m⚠\x1b[0m`;
        const spin = `\x1b[38;5;75m●\x1b[0m`;
        const dim = `\x1b[2m`;
        const r = `\x1b[0m`;

        switch (ev.step) {
          case "diff_fetch":
            if (ev.status === "start") {
              process.stdout.write(`  ${spin}  Fetching diff for validation...`);
            } else if (ev.status === "done") {
              process.stdout.write(
                `\r  ${ok}  Fetched diff ${dim}· ${ev.commentableLines} commentable lines${r}\n`
              );
            } else {
              process.stdout.write(
                `\r  ${warn}  Diff not available, skipping validation\n`
              );
            }
            break;
          case "validate":
            if (ev.skipped > 0) {
              console.log(
                `  ${ok}  ${ev.valid} valid comments ${dim}· ${ev.skipped} skipped (not in diff)${r}`
              );
            } else {
              console.log(`  ${ok}  ${ev.valid} inline comment(s) validated`);
            }
            break;
          case "submit":
            if (ev.status === "start") {
              const cmts =
                ev.commentCount > 0 ? ` with ${ev.commentCount} comment(s)` : "";
              const tag =
                ev.attempt > 1 ? ` ${dim}(attempt ${ev.attempt})${r}` : "";
              process.stdout.write(
                `  ${spin}  Submitting as ${ev.event}${cmts}${tag}...`
              );
            } else {
              process.stdout.write(
                `\r  ${ok}  Review submitted                                \n`
              );
            }
            break;
          case "retry":
            process.stdout.write(
              `\n  ${warn}  ${ev.detail} — ${dim}${ev.strategy.replace(/_/g, " ")}${r}\n`
            );
            break;
          case "warn":
            console.log(`  ${warn}  ${ev.message}`);
            break;
          case "fail":
            process.stdout.write(`\n  \x1b[31m✗\x1b[0m  ${ev.message}\n`);
            break;
        }
      };

      const result = await submitPrReview(
        owner,
        repo,
        prNumber,
        session.headSha,
        findingsToPost,
        verdictToPost,
        prSummary,
        dismissedCount,
        onProgress
      );

      status.ok("Review posted", result.url);
      status.gap();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      status.fail(`Failed to post review: ${msg}`);
      status.gap();
    }
  };

  try {
    // Fetch diff for scanners (needed by secrets + dependencies)
    const needsDiff = scanners.secrets || scanners.dependencies;
    const diffPromise = needsDiff
      ? (async () => {
          if (!useDashboard) {
            const doneDiff = status.start("Fetching PR diff");
            const d = await fetchPrDiff(owner, repo, prNumber);
            doneDiff(`${d.split("\n").length} lines`);
            return d;
          }
          return fetchPrDiff(owner, repo, prNumber);
        })()
      : Promise.resolve("");

    // Start PR summary generation in parallel with reviewers
    const summaryPromise = enableSummary
      ? (async () => {
          if (!useDashboard) {
            const doneSummary = status.start("Generating PR summary");
            const s = await generatePrSummary(owner, repo, prNumber, session.baseSha, session.headSha).catch(
              () => undefined
            );
            if (s) doneSummary(`${s.keyChanges.length} key changes`);
            else doneSummary("skipped");
            return s;
          }
          return generatePrSummary(owner, repo, prNumber, session.baseSha, session.headSha).catch(
            () => undefined
          );
        })()
      : Promise.resolve(undefined);

    // Run all AI reviewers in parallel
    const reviewerPromise = Promise.allSettled(
      payloads.map((p) =>
        executeReviewerJob(p, {
          shouldStop: () => interrupted,
          onActivity: useDashboard ? () => pingWorkerActivity(p.role) : undefined,
        })
      )
    );

    // Run scanners in parallel with AI reviewers
    const diff = await diffPromise;
    const scannerPromises: Promise<void>[] = [];

    if (scanners.secrets && diff) {
      scannerPromises.push(
        (async () => {
          if (useDashboard) updateWorkerStatus("secrets", "running");
          const secretFindings = scanSecretsInDiff(session.id, diff);
          for (const f of secretFindings) {
            const saved = await saveFinding(f);
            if (saved) {
              await publishEvent(session.id, { type: "finding_upsert", finding: f });
            }
          }
          await publishEvent(session.id, {
            type: "scanner_finish",
            role: "secrets",
            findingCount: secretFindings.length,
          });
        })()
      );
    }

    if (scanners.dependencies && diff) {
      scannerPromises.push(
        (async () => {
          if (useDashboard) updateWorkerStatus("dependencies", "running");
          const depFindings = await scanDependencies(session.id, diff);
          for (const f of depFindings) {
            const saved = await saveFinding(f);
            if (saved) {
              await publishEvent(session.id, { type: "finding_upsert", finding: f });
            }
          }
          await publishEvent(session.id, {
            type: "scanner_finish",
            role: "dependencies",
            findingCount: depFindings.length,
          });
        })()
      );
    }

    const linterEnabled =
      typeof scanners.linter === "boolean" ? scanners.linter : scanners.linter.enabled;
    const linterCommands =
      typeof scanners.linter === "object" && "commands" in scanners.linter
        ? scanners.linter.commands
        : undefined;

    if (linterEnabled) {
      scannerPromises.push(
        (async () => {
          if (useDashboard) updateWorkerStatus("linter", "running");
          const lintFindings = await scanWithLinter(
            session.id,
            owner,
            repo,
            prNumber,
            session.baseSha,
            session.headSha,
            {
              commands: linterCommands,
              onActivity: useDashboard ? () => pingWorkerActivity("linter") : undefined,
            }
          );
          for (const f of lintFindings) {
            const saved = await saveFinding(f);
            if (saved) {
              await publishEvent(session.id, { type: "finding_upsert", finding: f });
            }
          }
          await publishEvent(session.id, {
            type: "scanner_finish",
            role: "linter",
            findingCount: lintFindings.length,
          });
        })()
      );
    }

    // Wait for all reviewers and scanners
    await Promise.all([reviewerPromise, ...scannerPromises]);

    // Get summary result
    prSummary = await summaryPromise;

    if (interrupted) {
      if (useDashboard) {
        renderDashboardSummary(stopDashboard());
      }
      await updateArenaStatus(session.id, "cancelled");
      status.warn("Run cancelled");
      return;
    }

    // Check for failures/cancellations
    const allDone = await checkAllReviewersDone(session.id);
    if (allDone) {
      const reviewers = await getAllReviewers(session.id);
      const hasCancelled = Object.values(reviewers).some((r) => r.status === "cancelled");
      const hasFailures = Object.values(reviewers).some((r) => r.status === "failed");
      if (hasCancelled) {
        if (useDashboard) renderDashboardSummary(stopDashboard());
        await updateArenaStatus(session.id, "cancelled");
        status.warn("Run cancelled (some reviewers were cancelled)");
        return;
      }
      if (hasFailures) {
        reviewerFailures = true;
        status.warn("Some reviewers failed");
      }
    }

    // Fetch raw findings (includes AI reviewer + scanner findings)
    const allFindings = await getFindings(session.id);
    status.ok("Review phase complete", `${allFindings.length} finding(s) collected`);

    if (allFindings.length === 0) {
      if (useDashboard) {
        renderDashboardSummary(stopDashboard());
      }
      if (reviewerFailures) {
        status.warn("No findings, but one or more reviewers failed");
        await updateArenaStatus(session.id, "failed");
      } else {
        status.ok("No findings reported by any reviewer or scanner");
        await updateArenaStatus(session.id, "completed");
      }
      const emptyVerdict = await generateVerdict(session.id, [], {
        hadReviewerFailures: reviewerFailures,
      });
      if (emptyVerdict) {
        await postReviewToGitHub([], emptyVerdict);
      }
      return;
    }

    // ── Verification phase ─────────────────────────────────────
    let doneVerify: ((detail?: string) => void) | undefined;
    if (useDashboard) {
      addWorkerToBoard("verifier");
      updateWorkerStatus("verifier", "running");
    } else {
      doneVerify = status.start(`Verifying ${allFindings.length} finding(s)`);
    }

    // Determine the primary reviewer model so verifier picks a different one
    const primaryReviewerModel =
      reviewerConfigs && Object.values(reviewerConfigs).find((c) => c.model)?.model;

    const verificationResult = await verifyFindings(
      allFindings,
      owner,
      repo,
      prNumber,
      session.baseSha,
      session.headSha,
      primaryReviewerModel,
      useDashboard ? () => pingWorkerActivity("verifier") : undefined
    );

    if (useDashboard) {
      updateWorkerStatus("verifier", "completed");
    }

    const verifiedFindings = verificationResult.verified;
    const rejectedFindings = verificationResult.rejected;

    if (doneVerify) {
      doneVerify(`${verifiedFindings.length} confirmed, ${rejectedFindings.length} rejected`);
    }

    // ── Dashboard phase done — switch to normal stdout ──────────
    if (useDashboard) {
      renderDashboardSummary(stopDashboard());
    }

    // Show verification summary
    if (rejectedFindings.length > 0) {
      status.ok(
        "Verification",
        `${verifiedFindings.length} confirmed · ${rejectedFindings.length} rejected`
      );
      console.log(`  \x1b[2m${verificationResult.summary}\x1b[0m\n`);
    } else {
      status.ok("Verification", `${verifiedFindings.length} finding(s) confirmed`);
      status.gap();
    }

    // Show PR summary (in normal stdout now)
    if (prSummary) {
      await publishEvent(session.id, { type: "pr_summary", summary: prSummary });
      renderSummary(prSummary);
    }

    if (verifiedFindings.length === 0) {
      status.ok("All findings were rejected by verification — no issues remain");
      await updateArenaStatus(session.id, "completed");
      const emptyVerdict = await generateVerdict(session.id, [], {
        hadReviewerFailures: reviewerFailures,
      });
      if (emptyVerdict) {
        await postReviewToGitHub([], emptyVerdict);
      }
      return;
    }

    // Triage: let operator accept/dismiss findings (unless --auto)
    let acceptedFindings = verifiedFindings;
    let dismissedCount = 0;

    if (!auto) {
      const triage = await triageFindings(verifiedFindings);
      acceptedFindings = triage.accepted;
      dismissedCount = triage.dismissed.length;
    }

    // Generate verdict from accepted findings only
    const doneVerdict = status.start("Generating verdict");
    const verdict = await generateVerdict(session.id, acceptedFindings, {
      hadReviewerFailures: reviewerFailures,
    });

    if (verdict) {
      doneVerdict(`risk ${verdict.riskScore}/100 · ${verdict.mergeRecommendation.replace(/_/g, " ")}`);

      await publishEvent(session.id, {
        type: "jury_verdict",
        summary: verdict.summary,
        riskScore: verdict.riskScore,
      });
      await updateArenaStatus(session.id, "completed");
      renderVerdict(verdict);

      if (dismissedCount > 0) {
        console.log(`  \x1b[2m${dismissedCount} finding(s) dismissed during triage\x1b[0m\n`);
      }

      await postReviewToGitHub(acceptedFindings, verdict, dismissedCount);
    } else {
      doneVerdict("no verdict");
      status.warn("No verdict generated");
    }

    // Write markdown report
    const finalSession = await getArena(session.id);
    const finalVerdict = await getVerdict(session.id);
    if (!writeReport) {
      status.ok("Report", "skipped (--no-report)");
    } else if (finalSession && finalVerdict) {
      const mdPath = outputPath ?? `pr-review-${prNumber}.md`;
      const doneReport = status.start("Writing report");
      const report = generateMarkdownReport(
        finalSession,
        acceptedFindings,
        finalVerdict,
        dismissedCount,
        prSummary,
        rejectedFindings.length
      );
      writeFileSync(mdPath, report, "utf-8");
      doneReport(mdPath);
    }
  } finally {
    process.off("SIGINT", sigintHandler);
    setOnEvent(null);
    // Ensure dashboard is cleaned up even on errors
    if (useDashboard) {
      try {
        stopDashboard();
      } catch {
        /* already stopped */
      }
    }
    // Destroy any boxes that weren't cleaned up by individual workers
    const cleanupTotal = getActiveBoxCount();
    const doneCleanup = status.start("Cleaning up");
    const cleanupResult = await cleanupAllBoxes((done, total) => {
      if (total > 0) {
        process.stdout.write(
          `\r  \x1b[38;5;75m●\x1b[0m  Cleaning up… \x1b[2m${done}/${total} box(es)\x1b[0m`
        );
      }
    });
    clearEvents(session.id);
    clearFindings(session.id);
    clearVerdict(session.id);
    clearArenaState(session.id);
    if (cleanupTotal === 0) {
      doneCleanup("no active boxes");
    } else if (cleanupResult.failed > 0) {
      doneCleanup(
        `${cleanupResult.total} box(es), ${cleanupResult.failed} deletion failure(s)`
      );
    } else {
      doneCleanup(`${cleanupResult.total} box(es) deleted`);
    }
    status.gap();
  }
}
