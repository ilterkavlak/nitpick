import { createArena, createArenaFromRefs } from "../lib/arena/create";
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
import { renderMarkdownToTerminal } from "./markdown-render";
import { triageFindings } from "./triage";
import { fetchCompareDiff, fetchPrDiff } from "../lib/github";
import { generatePrSummary } from "../lib/summarizer";
import { scanSecretsInDiff } from "../lib/scanners/secrets";
import { scanDependencies } from "../lib/scanners/dependencies";
import { scanWithLinter } from "../lib/scanners/linter";
import { submitPrReview } from "../lib/github-review";
import type { PostProgress } from "../lib/github-review";
import { cancelAllBoxRuns, cleanupAllBoxes, getActiveBoxCount } from "../lib/box";
import {
  ensureBoxApiKeyInteractive,
  requireBoxApiKey,
  requireGitReadToken,
  requireGitReviewToken,
} from "../lib/auth";
import { verifyFindings } from "../lib/reviewer/verifier";
import type {
  ArenaSession,
  ExitOnMode,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ReviewTarget =
  | { kind: "pr"; prUrl: string; owner: string; repo: string; prNumber: number }
  | { kind: "ref"; owner: string; repo: string; baseRef: string; headRef: string };

export interface ReviewOptions {
  roles?: string[];
  outputPath?: string;
  auto?: boolean;
  postReview?: boolean;
  reviewerConfigs?: Record<string, ReviewerConfig>;
  mergedConfig?: MergedOptions;
}

export interface ReviewResult {
  session: ArenaSession;
  findings: Finding[];
  acceptedFindings: Finding[];
  dismissedFindings: Finding[];
  rejectedFindings: Finding[];
  verdict: Verdict | null;
  summary: PrSummary | null;
  hadReviewerFailures: boolean;
  interrupted: boolean;
  reviewUrl?: string;
  exitCode: number;
}

function computeExitCode(
  mode: ExitOnMode,
  verdict: Verdict | null,
  acceptedFindings: Finding[]
): number {
  if (mode === "none") return 0;
  if (mode === "findings") {
    return acceptedFindings.length > 0 ? 2 : 0;
  }
  if (mode === "blockers") {
    return verdict && verdict.blockers.length > 0 ? 2 : 0;
  }
  if (mode === "changes-requested") {
    return verdict && verdict.mergeRecommendation !== "approve" ? 2 : 0;
  }
  return 0;
}

export async function runReview(
  target: ReviewTarget,
  options: ReviewOptions = {}
): Promise<ReviewResult> {
  const merged = options.mergedConfig;
  const roles = merged?.roles ?? options.roles;
  const writeReport = merged?.writeReport ?? true;
  const outputPath = merged?.outputPath ?? options.outputPath;
  const auto = merged?.auto ?? options.auto ?? false;
  const postReviewRequested = merged?.postReview ?? options.postReview ?? false;
  const postReview = postReviewRequested && target.kind === "pr";
  const enableSummary = merged?.summary ?? true;
  const reviewerConfigs = merged?.reviewerConfigs ?? options.reviewerConfigs;
  const scanners = merged?.scanners ?? { secrets: true, linter: true, dependencies: true };
  const jsonOutput = merged?.json;
  const exitOnMode: ExitOnMode = merged?.exitOn ?? "none";
  const nonInteractive = merged?.nonInteractive ?? false;

  // ── Setup phase: visible status for every step ───────────────
  status.header("🔎  Nitpick");

  // Validate env
  try {
    requireBoxApiKey();
  } catch {
    if (nonInteractive) {
      throw new Error(
        "Upstash Box API key not found. Non-interactive mode is enabled — set UPSTASH_BOX_API_KEY or configure a credentials store before running."
      );
    }
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

  const { owner, repo } = target;
  const prNumber = target.kind === "pr" ? target.prNumber : undefined;
  if (target.kind === "pr") {
    status.ok("Parsed PR URL", `${owner}/${repo}#${target.prNumber}`);
  } else {
    status.ok("Ref target", `${owner}/${repo} ${target.baseRef}...${target.headRef}`);
  }

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

  // Fetch PR/ref metadata and create arena session
  const doneMeta = status.start(
    target.kind === "pr" ? "Fetching PR metadata" : "Fetching compare metadata"
  );
  const session =
    target.kind === "pr"
      ? await createArena(target.prUrl, owner, repo, target.prNumber, selectedRoles)
      : await createArenaFromRefs(owner, repo, target.baseRef, target.headRef, selectedRoles);
  if (session.mode === "pr") {
    doneMeta(`"${session.prTitle}" by @${session.prAuthor}`);
  } else {
    doneMeta(`${session.baseSha.slice(0, 7)}...${session.headSha.slice(0, 7)}`);
  }

  status.ok("Review session created", session.id.slice(0, 8));
  status.gap();

  // Decide rendering mode: dashboard (TTY) vs plain (piped / non-TTY / JSON stdout)
  const jsonToStdout = jsonOutput === true || jsonOutput === "-";
  const useDashboard = Boolean(process.stdout.isTTY) && !jsonToStdout;

  if (useDashboard) {
    const title =
      target.kind === "pr"
        ? `${owner}/${repo} #${target.prNumber}`
        : `${owner}/${repo} ${target.baseRef}...${target.headRef}`;
    startDashboard(title, [...selectedRoles, ...enabledScanners]);
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
  let shutdownPromise: Promise<number> | null = null;
  let resolveInterrupted: (() => void) | null = null;
  const interruptedPromise = new Promise<void>((resolve) => {
    resolveInterrupted = resolve;
  });

  const stopDashboardSafe = () => {
    if (!useDashboard) return;
    try {
      stopDashboard();
    } catch {
      // already stopped
    }
  };

  const shutdownBoxesGracefully = async (): Promise<number> => {
    const deadline = Date.now() + 20_000;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt++;
      await withTimeout(cancelAllBoxRuns().catch(() => undefined), 6_000, undefined);
      await withTimeout(cleanupAllBoxes().catch(() => undefined), 8_000, undefined);
      const remaining = getActiveBoxCount();
      if (remaining === 0) {
        return 0;
      }
      await sleep(Math.min(500 * attempt, 2_000));
    }

    return getActiveBoxCount();
  };

  const ensureShutdownStarted = (): Promise<number> => {
    if (!shutdownPromise) {
      shutdownPromise = shutdownBoxesGracefully().finally(() => {
        stopDashboardSafe();
      });
    }
    return shutdownPromise;
  };

  const sigintHandler = () => {
    if (interrupted) {
      stopDashboardSafe();
      process.exit(130);
    }
    interrupted = true;
    resolveInterrupted?.();
    void ensureShutdownStarted();
    // Safety net: force exit if main flow gets stuck
    const forceExitTimer = setTimeout(() => {
      cleanupAllBoxes().catch(() => {}).finally(() => process.exit(130));
    }, 25_000);
    forceExitTimer.unref();
    if (!useDashboard) {
      console.log(
        "\n\nInterrupted. Marking run as cancelled and waiting for in-flight reviewers to stop..."
      );
    }
  };
  process.on("SIGINT", sigintHandler);

  let prSummary: PrSummary | undefined;
  let reviewerFailures = false;
  let lastReviewUrl: string | undefined;

  // State tracked for the final ReviewResult
  let allFindings: Finding[] = [];
  let verifiedFindings: Finding[] = [];
  let rejectedFindings: Finding[] = [];
  let acceptedFindings: Finding[] = [];
  let dismissedFindings: Finding[] = [];
  let verdict: Verdict | null = null;

  const snapshot = (): ReviewResult => ({
    session,
    findings: allFindings,
    acceptedFindings,
    dismissedFindings,
    rejectedFindings,
    verdict,
    summary: prSummary ?? null,
    hadReviewerFailures: reviewerFailures,
    interrupted,
    reviewUrl: lastReviewUrl,
    exitCode: computeExitCode(exitOnMode, verdict, acceptedFindings),
  });

  const postReviewToGitHub = async (
    findingsToPost: Finding[],
    verdictToPost: Verdict,
    dismissedCount = 0
  ) => {
    if (!postReview || target.kind !== "pr") return;
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
        target.prNumber,
        session.headSha,
        findingsToPost,
        verdictToPost,
        prSummary,
        dismissedCount,
        onProgress
      );

      lastReviewUrl = result.url;
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
    const fetchDiff = () =>
      target.kind === "pr"
        ? fetchPrDiff(owner, repo, target.prNumber)
        : fetchCompareDiff(owner, repo, target.baseRef, target.headRef);
    const diffPromise = needsDiff
      ? (async () => {
          if (!useDashboard) {
            const doneDiff = status.start("Fetching diff");
            const d = await fetchDiff();
            doneDiff(`${d.split("\n").length} lines`);
            return d;
          }
          return fetchDiff();
        })()
      : Promise.resolve("");

    // Start summary generation in parallel with reviewers
    const summaryPromise = enableSummary
      ? (async () => {
          const runSummary = () =>
            generatePrSummary(owner, repo, session.baseSha, session.headSha, {
              prNumber,
            }).catch(() => undefined);

          if (!useDashboard) {
            const doneSummary = status.start("Generating PR summary");
            const s = await runSummary();
            if (s) doneSummary(`${s.keyChanges.length} key changes`);
            else doneSummary("skipped");
            return s;
          }
          return runSummary();
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
            session.baseSha,
            session.headSha,
            {
              prNumber,
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

    // Wait for all reviewers and scanners, unless interrupted.
    const allWorkPromise = Promise.all([reviewerPromise, ...scannerPromises]).then(
      () => "completed" as const
    );
    const outcome = await Promise.race([
      allWorkPromise,
      interruptedPromise.then(() => "interrupted" as const),
    ]);

    if (outcome === "interrupted") {
      if (useDashboard) {
        try {
          renderDashboardSummary(stopDashboard());
        } catch {
          // already stopped
        }
      }
      await updateArenaStatus(session.id, "cancelled");
      status.warn("Run cancelled");

      // Start killing boxes so workers fail fast
      void ensureShutdownStarted();

      // Wait for workers to actually stop (they'll exit quickly once
      // shouldStop() returns true and their boxes are deleted)
      await withTimeout(
        allWorkPromise.catch(() => undefined),
        15_000,
        undefined
      );

      // Clean up any boxes workers created during shutdown
      await withTimeout(
        cleanupAllBoxes().catch(() => undefined),
        12_000,
        undefined
      );

      return snapshot();
    }

    // Get summary result
    prSummary = await summaryPromise;

    if (interrupted) {
      if (useDashboard) {
        renderDashboardSummary(stopDashboard());
      }
      await updateArenaStatus(session.id, "cancelled");
      status.warn("Run cancelled");
      return snapshot();
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
        return snapshot();
      }
      if (hasFailures) {
        reviewerFailures = true;
        status.warn("Some reviewers failed");
      }
    }

    // Fetch raw findings (includes AI reviewer + scanner findings)
    allFindings = await getFindings(session.id);
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
        verdict = emptyVerdict;
        await postReviewToGitHub([], emptyVerdict);
      }
      return snapshot();
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
      session.baseSha,
      session.headSha,
      {
        prNumber,
        reviewerModelKey: primaryReviewerModel,
        onActivity: useDashboard ? () => pingWorkerActivity("verifier") : undefined,
      }
    );

    if (useDashboard) {
      updateWorkerStatus("verifier", "completed");
    }

    verifiedFindings = verificationResult.verified;
    rejectedFindings = verificationResult.rejected;

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
        verdict = emptyVerdict;
        await postReviewToGitHub([], emptyVerdict);
      }
      return snapshot();
    }

    // Triage: let operator accept/dismiss findings (unless --auto)
    acceptedFindings = verifiedFindings;
    dismissedFindings = [];

    if (!auto) {
      if (nonInteractive) {
        status.ok("Triage", "skipped (non-interactive)");
      } else {
        const triage = await triageFindings(verifiedFindings);
        acceptedFindings = triage.accepted;
        dismissedFindings = triage.dismissed;
      }
    }
    const dismissedCount = dismissedFindings.length;

    // Generate verdict from accepted findings only
    const doneVerdict = status.start("Generating verdict");
    const newVerdict = await generateVerdict(session.id, acceptedFindings, {
      hadReviewerFailures: reviewerFailures,
    });

    if (newVerdict) {
      verdict = newVerdict;
      doneVerdict(`risk ${newVerdict.riskScore}/100 · ${newVerdict.mergeRecommendation.replace(/_/g, " ")}`);

      await publishEvent(session.id, {
        type: "jury_verdict",
        summary: newVerdict.summary,
        riskScore: newVerdict.riskScore,
      });
      await updateArenaStatus(session.id, "completed");
      renderVerdict(newVerdict);

      if (dismissedCount > 0) {
        console.log(`  \x1b[2m${dismissedCount} finding(s) dismissed during triage\x1b[0m\n`);
      }

      await postReviewToGitHub(acceptedFindings, newVerdict, dismissedCount);
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
      const defaultName =
        target.kind === "pr"
          ? `pr-review-${target.prNumber}.md`
          : `ref-review-${target.baseRef}...${target.headRef}.md`.replace(/[/\\]/g, "-");
      const mdPath = outputPath ?? defaultName;
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

      // In interactive / TTY mode, echo the rendered report so the reader
      // doesn't have to open the file to see the findings. Skip when JSON
      // is going to stdout — it would corrupt the machine-readable output.
      if (process.stdout.isTTY && !jsonToStdout) {
        console.log("");
        console.log(renderMarkdownToTerminal(report));
        console.log("");
      }
    }

    return snapshot();
  } finally {
    process.off("SIGINT", sigintHandler);
    setOnEvent(null);
    stopDashboardSafe();

    if (shutdownPromise) {
      await withTimeout(shutdownPromise, 22_000, getActiveBoxCount());
    }

    // Destroy any boxes that weren't cleaned up by individual workers
    const cleanupTotal = getActiveBoxCount();
    const doneCleanup = status.start("Cleaning up");
    const cleanupResult = await withTimeout(
      cleanupAllBoxes((done, total) => {
        if (total > 0) {
          process.stdout.write(
            `\r  \x1b[38;5;75m●\x1b[0m  Cleaning up… \x1b[2m${done}/${total} box(es)\x1b[0m`
          );
        }
      }),
      12_000,
      { total: cleanupTotal, failed: cleanupTotal }
    );
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

    // Emit JSON output if requested. Done after cleanup so the machine-readable
    // payload is the last thing on stdout when --json - is used.
    if (jsonOutput) {
      try {
        const jsonPayload = buildJsonPayload(snapshot());
        const serialized = JSON.stringify(jsonPayload, null, 2);
        if (jsonOutput === true || jsonOutput === "-") {
          process.stdout.write(serialized + "\n");
        } else {
          writeFileSync(jsonOutput, serialized + "\n", "utf-8");
          status.ok("JSON report", jsonOutput);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        status.fail(`Failed to emit JSON report: ${msg}`);
      }
    }

    if (interrupted) {
      process.exit(130);
    }
  }
}

function buildJsonPayload(result: ReviewResult): Record<string, unknown> {
  const { session } = result;
  return {
    version: 1,
    sessionId: session.id,
    mode: session.mode,
    repo: {
      owner: session.repoOwner,
      name: session.repoName,
    },
    pr:
      session.mode === "pr"
        ? {
            number: session.prNumber,
            url: session.prUrl,
            title: session.prTitle,
            author: session.prAuthor,
          }
        : null,
    refs:
      session.mode === "ref"
        ? {
            base: session.baseRef,
            head: session.headRef,
          }
        : null,
    baseSha: session.baseSha,
    headSha: session.headSha,
    roles: session.selectedRoles,
    status: session.status,
    summary: result.summary,
    findings: result.findings,
    acceptedFindings: result.acceptedFindings,
    dismissedFindings: result.dismissedFindings,
    rejectedFindings: result.rejectedFindings,
    verdict: result.verdict,
    stats: {
      findingsTotal: result.findings.length,
      findingsAccepted: result.acceptedFindings.length,
      findingsDismissed: result.dismissedFindings.length,
      findingsRejected: result.rejectedFindings.length,
      blockers: result.verdict?.blockers.length ?? 0,
      improvements: result.verdict?.improvements.length ?? 0,
      riskScore: result.verdict?.riskScore ?? null,
      mergeRecommendation: result.verdict?.mergeRecommendation ?? null,
    },
    hadReviewerFailures: result.hadReviewerFailures,
    interrupted: result.interrupted,
    reviewUrl: result.reviewUrl ?? null,
    exitCode: result.exitCode,
    createdAt: session.createdAt,
  };
}
