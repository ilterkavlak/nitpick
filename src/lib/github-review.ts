import type { Finding, Verdict, PrSummary, Severity } from "./types";
import { requireGitReviewToken } from "./auth";

function githubHeaders(): Record<string, string> {
  const reviewToken = requireGitReviewToken();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "nitpik-cli",
    "Content-Type": "application/json",
  };
  headers.Authorization = `Bearer ${reviewToken}`;
  return headers;
}

type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

function mapRecommendation(rec: string): ReviewEvent {
  switch (rec) {
    case "approve": return "APPROVE";
    case "request_changes": return "REQUEST_CHANGES";
    default: return "COMMENT";
  }
}

function severityEmoji(s: Severity): string {
  switch (s) {
    case "critical": return "🔴";
    case "high": return "🟠";
    case "medium": return "🟡";
    case "low": return "🔵";
    case "info": return "⚪";
  }
}

// ── Progress reporting ────────────────────────────────────────────

export type PostProgress =
  | { step: "diff_fetch"; status: "start" }
  | { step: "diff_fetch"; status: "done"; commentableLines: number }
  | { step: "diff_fetch"; status: "skip" }
  | { step: "validate"; status: "done"; total: number; valid: number; skipped: number }
  | { step: "submit"; status: "start"; event: string; commentCount: number; attempt: number }
  | { step: "submit"; status: "done"; url: string }
  | { step: "retry"; strategy: string; detail: string }
  | { step: "warn"; message: string }
  | { step: "fail"; message: string };

// ── GitHub 422 error parsing ──────────────────────────────────────

interface GitHubValidationError {
  message: string;
  errors?: Array<{
    resource?: string;
    field?: string;
    code?: string;
    message?: string;
  }>;
  documentation_url?: string;
}

function parseGitHubError(body: string): GitHubValidationError | null {
  try {
    return JSON.parse(body) as GitHubValidationError;
  } catch {
    return null;
  }
}

function isStaleCommitError(err: GitHubValidationError): boolean {
  return (
    err.errors?.some(
      (e) =>
        e.message?.includes("commit_id") ||
        e.message?.includes("not part of the pull request")
    ) ?? false
  );
}

function isOwnPrError(err: GitHubValidationError): boolean {
  return (
    err.message?.includes("can not request changes") === true ||
    err.errors?.some(
      (e) =>
        e.message?.includes("request changes") ||
        e.message?.includes("own pull request")
    ) === true
  );
}

function isCommentPositionError(err: GitHubValidationError): boolean {
  return (
    err.errors?.some(
      (e) =>
        e.field?.includes("line") ||
        e.field?.includes("position") ||
        e.message?.includes("must be part of the diff") ||
        e.message?.includes("pull_request_review_thread")
    ) ?? false
  );
}

// ── Diff parser — extract commentable lines ───────────────────────

function parseDiffCommentableLines(diff: string): Set<string> {
  const valid = new Set<string>();
  let currentFile: string | null = null;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/diff --git a\/.+ b\/(.+)/);
      currentFile = match?.[1] ?? null;
      newLine = 0;
      continue;
    }

    if (line.startsWith("@@")) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newLine = match ? parseInt(match[1], 10) : 0;
      continue;
    }

    if (!currentFile || newLine === 0) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      valid.add(`${currentFile}:${newLine}`);
      newLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // Deletion — doesn't advance new line counter
    } else if (!line.startsWith("\\")) {
      valid.add(`${currentFile}:${newLine}`);
      newLine++;
    }
  }

  return valid;
}

// ── Review body & comments ────────────────────────────────────────

interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

function buildReviewBody(
  findings: Finding[],
  verdict: Verdict,
  summary?: PrSummary,
  dismissedCount = 0,
  meta?: { skippedComments?: number }
): string {
  const lines: string[] = [];

  lines.push("## Nitpik Review");
  lines.push("");

  if (summary) {
    lines.push("### Summary");
    lines.push("");
    lines.push(summary.overview);
    if (summary.keyChanges.length > 0) {
      lines.push("");
      lines.push("**Key changes:**");
      for (const c of summary.keyChanges) {
        lines.push(`- ${c}`);
      }
    }
    lines.push("");
  }

  lines.push("### Verdict");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Risk Score | **${verdict.riskScore}/100** |`);
  lines.push(`| Recommendation | **${verdict.mergeRecommendation.replace(/_/g, " ")}** |`);
  lines.push(`| Findings | ${findings.length} accepted${dismissedCount > 0 ? `, ${dismissedCount} dismissed` : ""} |`);
  lines.push("");
  lines.push(verdict.summary);
  lines.push("");

  if (verdict.blockers.length > 0) {
    lines.push("### Blockers");
    lines.push("");
    for (const b of verdict.blockers) {
      const loc = b.filePath ? ` (\`${b.filePath}${b.lineStart ? `:${b.lineStart}` : ""}\`)` : "";
      lines.push(`- ${severityEmoji(b.severity)} **${b.severity.toUpperCase()}** ${b.title}${loc}`);
    }
    lines.push("");
  }

  const bodyOnlyFindings = findings.filter((f) => !f.filePath);
  if (bodyOnlyFindings.length > 0) {
    lines.push("### Other Findings");
    lines.push("");
    for (const f of bodyOnlyFindings) {
      lines.push(`- ${severityEmoji(f.severity)} **${f.severity.toUpperCase()}** [${f.reviewerRole}] ${f.title}`);
      lines.push(`  ${f.recommendation}`);
    }
    lines.push("");
  }

  if (verdict.suggestedCommits.length > 0) {
    lines.push("### Suggested Commits");
    lines.push("");
    for (const c of verdict.suggestedCommits) {
      lines.push(`- \`${c}\``);
    }
    lines.push("");
  }

  if (meta?.skippedComments) {
    lines.push(`> ${meta.skippedComments} inline comment(s) could not be posted (line not in diff).`);
    lines.push("");
  }

  lines.push("---");
  lines.push("*Generated by Nitpik*");

  return lines.join("\n");
}

function buildInlineComments(findings: Finding[]): ReviewComment[] {
  const comments: ReviewComment[] = [];

  for (const f of findings) {
    if (!f.filePath || !f.lineStart) continue;

    const body = [
      `${severityEmoji(f.severity)} **${f.severity.toUpperCase()}** — ${f.title}`,
      "",
      f.description,
      "",
      `**Recommendation:** ${f.recommendation}`,
      "",
      `*[${f.reviewerRole}] confidence: ${(f.confidence * 100).toFixed(0)}%*`,
    ].join("\n");

    comments.push({
      path: f.filePath,
      line: f.lineStart,
      body,
    });
  }

  return comments;
}

// ── Submission with retry strategies ──────────────────────────────

interface SubmitPayload {
  commit_id: string;
  body: string;
  event: ReviewEvent;
  comments?: Array<{ path: string; line: number; body: string; side: "RIGHT" }>;
}

async function postReview(
  owner: string,
  repo: string,
  prNumber: number,
  payload: SubmitPayload
): Promise<{ ok: true; url: string } | { ok: false; status: number; error: GitHubValidationError | null; raw: string }> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    {
      method: "POST",
      headers: githubHeaders(),
      body: JSON.stringify(payload),
    }
  );

  if (res.ok) {
    const data = (await res.json()) as { html_url: string };
    return { ok: true, url: data.html_url };
  }

  const raw = await res.text();
  return { ok: false, status: res.status, error: parseGitHubError(raw), raw };
}

async function fetchCurrentHeadSha(
  owner: string,
  repo: string,
  prNumber: number
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      { headers: githubHeaders() }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { head: { sha: string } };
    return data.head.sha;
  } catch {
    return null;
  }
}

async function fetchPrDiffForValidation(
  owner: string,
  repo: string,
  prNumber: number
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        headers: {
          ...githubHeaders(),
          Accept: "application/vnd.github.v3.diff",
        },
      }
    );
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

export interface ReviewPostResult {
  url: string;
  warnings: string[];
}

export async function submitPrReview(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  findings: Finding[],
  verdict: Verdict,
  summary?: PrSummary,
  dismissedCount = 0,
  onProgress?: (event: PostProgress) => void
): Promise<ReviewPostResult> {
  const emit = onProgress ?? (() => {});
  const warnings: string[] = [];
  let event = mapRecommendation(verdict.mergeRecommendation);
  let commitId = headSha;

  // ── Fetch diff & validate comments ──────────────────────────
  const allComments = buildInlineComments(findings);
  let validComments = allComments;
  let skippedComments = 0;

  if (allComments.length > 0) {
    emit({ step: "diff_fetch", status: "start" });
    const diff = await fetchPrDiffForValidation(owner, repo, prNumber);
    if (diff) {
      const commentable = parseDiffCommentableLines(diff);
      emit({ step: "diff_fetch", status: "done", commentableLines: commentable.size });

      validComments = allComments.filter((c) => commentable.has(`${c.path}:${c.line}`));
      skippedComments = allComments.length - validComments.length;

      emit({
        step: "validate",
        status: "done",
        total: allComments.length,
        valid: validComments.length,
        skipped: skippedComments,
      });

      if (skippedComments > 0) {
        warnings.push(
          `${skippedComments} inline comment(s) skipped (line not in diff)`
        );
      }
    } else {
      emit({ step: "diff_fetch", status: "skip" });
    }
  }

  // GitHub limits to 50 comments per review
  if (validComments.length > 50) {
    emit({ step: "warn", message: `Truncated to 50 comments (${validComments.length} total)` });
    warnings.push(
      `Truncated from ${validComments.length} to 50 inline comments (GitHub limit)`
    );
    validComments = validComments.slice(0, 50);
  }

  const body = buildReviewBody(
    findings,
    verdict,
    summary,
    dismissedCount,
    { skippedComments }
  );

  const comments =
    validComments.length > 0
      ? validComments.map((c) => ({
          path: c.path,
          line: c.line,
          body: c.body,
          side: "RIGHT" as const,
        }))
      : undefined;

  // ── Attempt 1: full review ──────────────────────────────────
  let attempt = 1;
  emit({ step: "submit", status: "start", event, commentCount: comments?.length ?? 0, attempt });
  const r1 = await postReview(owner, repo, prNumber, {
    commit_id: commitId,
    body,
    event,
    comments,
  });

  if (r1.ok) {
    emit({ step: "submit", status: "done", url: r1.url });
    return { url: r1.url, warnings };
  }

  // ── Diagnose & retry ────────────────────────────────────────
  const err = r1.error;

  // Strategy A: comment position still invalid → drop comments
  if (comments && err && isCommentPositionError(err)) {
    attempt++;
    emit({ step: "retry", strategy: "drop_comments", detail: "Inline comment positions invalid" });
    warnings.push("Inline comments removed (position validation failed)");

    emit({ step: "submit", status: "start", event, commentCount: 0, attempt });
    const r2 = await postReview(owner, repo, prNumber, {
      commit_id: commitId,
      body,
      event,
    });
    if (r2.ok) {
      emit({ step: "submit", status: "done", url: r2.url });
      return { url: r2.url, warnings };
    }
  }

  // Strategy B: stale commit → fetch fresh SHA
  if (err && isStaleCommitError(err)) {
    attempt++;
    emit({ step: "retry", strategy: "refresh_sha", detail: "HEAD SHA is stale" });

    const freshSha = await fetchCurrentHeadSha(owner, repo, prNumber);
    if (freshSha && freshSha !== commitId) {
      warnings.push(
        `HEAD SHA updated (${commitId.slice(0, 7)} → ${freshSha.slice(0, 7)})`
      );
      commitId = freshSha;
      emit({ step: "submit", status: "start", event, commentCount: 0, attempt });
      const r3 = await postReview(owner, repo, prNumber, {
        commit_id: commitId,
        body,
        event,
      });
      if (r3.ok) {
        emit({ step: "submit", status: "done", url: r3.url });
        return { url: r3.url, warnings };
      }
    }
  }

  // Strategy C: can't request changes on own PR → downgrade
  if (err && isOwnPrError(err) && event === "REQUEST_CHANGES") {
    attempt++;
    emit({ step: "retry", strategy: "downgrade_event", detail: "Cannot request changes on own PR" });
    warnings.push("Downgraded to COMMENT (cannot request changes on own PR)");
    event = "COMMENT";
    emit({ step: "submit", status: "start", event, commentCount: 0, attempt });
    const r4 = await postReview(owner, repo, prNumber, {
      commit_id: commitId,
      body,
      event,
    });
    if (r4.ok) {
      emit({ step: "submit", status: "done", url: r4.url });
      return { url: r4.url, warnings };
    }
  }

  // Strategy D: last resort
  attempt++;
  if (event !== "COMMENT") {
    event = "COMMENT";
    warnings.push("Downgraded to COMMENT as final fallback");
  }
  emit({ step: "retry", strategy: "last_resort", detail: "Final attempt as COMMENT" });

  const freshSha = await fetchCurrentHeadSha(owner, repo, prNumber);
  if (freshSha) commitId = freshSha;

  emit({ step: "submit", status: "start", event, commentCount: 0, attempt });
  const rFinal = await postReview(owner, repo, prNumber, {
    commit_id: commitId,
    body,
    event,
  });

  if (rFinal.ok) {
    emit({ step: "submit", status: "done", url: rFinal.url });
    return { url: rFinal.url, warnings };
  }

  // All attempts failed
  const details = rFinal.error;
  const errMsg = details?.errors?.map((e) => e.message).join("; ") ?? details?.message ?? rFinal.raw.slice(0, 300);
  emit({ step: "fail", message: errMsg });
  throw new Error(`GitHub review failed after all retries: ${rFinal.status} — ${errMsg}`);
}
