import type { Finding, Verdict, Severity } from "@/lib/types";

const verdicts = new Map<string, Verdict>();
const locks = new Set<string>();

const SEVERITY_WEIGHTS: Record<Severity, number> = {
  critical: 10,
  high: 6,
  medium: 3,
  low: 1,
  info: 0.5,
};

export function computeRiskScore(findings: Finding[]): number {
  const raw = findings.reduce(
    (sum, f) => sum + SEVERITY_WEIGHTS[f.severity] * f.confidence,
    0
  );
  return Math.min(100, Math.round(raw));
}

function getMergeRecommendation(
  riskScore: number,
  blockers: Finding[]
): "approve" | "request_changes" | "needs_discussion" {
  if (blockers.length > 0 || riskScore >= 50) return "request_changes";
  if (riskScore >= 20) return "needs_discussion";
  return "approve";
}

export async function generateVerdict(
  arenaId: string,
  findings: Finding[],
  options?: { hadReviewerFailures?: boolean }
): Promise<Verdict | null> {
  const existing = verdicts.get(arenaId);
  if (existing) return existing;

  // Prevent duplicate verdict generation
  if (locks.has(arenaId)) return null;
  locks.add(arenaId);

  try {
    const riskScore = computeRiskScore(findings);

    const blockers = findings.filter(
      (f) =>
        (f.severity === "critical" || f.severity === "high") &&
        f.confidence >= 0.7
    );
    const improvements = findings.filter(
      (f) =>
        f.severity === "medium" || f.severity === "low" || f.severity === "info"
    );

    let mergeRecommendation = getMergeRecommendation(riskScore, blockers);
    const hadReviewerFailures = options?.hadReviewerFailures === true;
    if (hadReviewerFailures && mergeRecommendation === "approve") {
      mergeRecommendation = "needs_discussion";
    }

    const summaryParts: string[] = [];
    summaryParts.push(
      `Found ${findings.length} issue(s) across all reviewers.`
    );
    if (blockers.length > 0) {
      summaryParts.push(
        `${blockers.length} blocking issue(s) require attention before merge.`
      );
    }
    summaryParts.push(`Overall risk score: ${riskScore}/100.`);
    if (hadReviewerFailures) {
      summaryParts.push(
        "One or more reviewer jobs failed; recommendation is downgraded for manual follow-up."
      );
    }
    summaryParts.push(
      mergeRecommendation === "approve"
        ? "This PR looks good to merge."
        : mergeRecommendation === "request_changes"
          ? "Changes are requested before merging."
          : "This PR needs further discussion."
    );

    const suggestedCommits: string[] = [];
    for (const b of blockers.slice(0, 5)) {
      suggestedCommits.push(`fix: ${b.title.toLowerCase()}`);
    }

    const verdict: Verdict = {
      arenaId,
      riskScore,
      mergeRecommendation,
      blockers,
      improvements,
      summary: summaryParts.join(" "),
      suggestedCommits,
      createdAt: new Date().toISOString(),
    };

    verdicts.set(arenaId, verdict);
    return verdict;
  } finally {
    locks.delete(arenaId);
  }
}

export async function getVerdict(arenaId: string): Promise<Verdict | null> {
  return verdicts.get(arenaId) ?? null;
}

export function clearVerdict(arenaId: string): void {
  verdicts.delete(arenaId);
  locks.delete(arenaId);
}
