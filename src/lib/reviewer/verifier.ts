import { z } from "zod";
import { createReviewerBox, setupRepo, deleteTrackedBox } from "../box";
import type { Finding } from "../types";

// Verifier uses a different provider than the reviewers (OpenAI GPT-5.x latest)
const VERIFIER_DEFAULT_MODEL = "GPT_5_3_Codex";
const VERIFIER_FALLBACK_MODEL = "Opus_4_6";

const verifierResponseSchema = z.object({
  verifications: z.array(
    z.object({
      findingId: z.string(),
      status: z.enum(["confirmed", "adjusted", "rejected"]),
      adjustedSeverity: z
        .enum(["critical", "high", "medium", "low", "info"])
        .optional(),
      adjustedConfidence: z.number().min(0).max(1).optional(),
      note: z.string(),
    })
  ),
  duplicateGroups: z
    .array(
      z.object({
        findingIds: z.array(z.string()).min(2),
        keepFindingId: z.string(),
        reason: z.string(),
      })
    )
    .optional(),
  summary: z.string(),
});

function buildVerifierPrompt(findings: Finding[]): string {
  const findingsJson = JSON.stringify(
    findings.map((f) => ({
      id: f.id,
      reviewerRole: f.reviewerRole,
      severity: f.severity,
      category: f.category,
      title: f.title,
      description: f.description,
      filePath: f.filePath,
      lineStart: f.lineStart,
      lineEnd: f.lineEnd,
      evidence: f.evidence,
      recommendation: f.recommendation,
      confidence: f.confidence,
    })),
    null,
    2
  );

  return `You are an independent Verification Agent. Your job is to rigorously verify findings produced by multiple AI code reviewers.

You have access to:
- The repository checked out at the current directory
- Changed files list at /workspace/home/changed_files.txt
- Diff patch at /workspace/home/pr.patch

Here are the findings to verify:

${findingsJson}

For EACH finding, you MUST:
1. Read the actual source code at the file path and line numbers referenced
2. Cross-reference against the PR diff to confirm the issue exists in the changed code
3. Determine one of:
   - "confirmed" — the finding is valid and accurately described
   - "adjusted" — the finding is valid but severity or confidence should be changed (provide adjustedSeverity and/or adjustedConfidence)
   - "rejected" — the finding is a false positive, not applicable, or references unchanged code

Verification rules:
- REJECT findings that reference code not actually changed in the PR diff
- REJECT findings where the described issue doesn't exist when you read the actual code
- ADJUST severity DOWN if the impact is overstated given the actual code context
- ADJUST severity UP if you find the impact is worse than described
- ADJUST confidence DOWN if the evidence is weak or speculative
- ADJUST confidence UP if you can confirm with stronger evidence from the code
- When in doubt between confirming and rejecting, lean towards confirming
- Provide a brief, specific note explaining each verification decision

After verification, identify DUPLICATE findings — separate findings (often from different reviewers) that describe the same underlying issue. Two findings are duplicates when they:
- Reference the same root cause in the same code location (same file, overlapping lines or the same logical construct), AND
- Would be fixed by the same change, even if titles, categories, severities, or descriptions differ

For each duplicate group, populate "duplicateGroups" with:
- "findingIds": all finding IDs in the group (>= 2)
- "keepFindingId": the single best representative — prefer the one with the most accurate description, then the highest confidence, then the highest severity
- "reason": a one-sentence explanation of why these are the same issue

Do NOT group findings that touch the same file but describe genuinely different problems. Only group true duplicates of the same underlying defect.

Respond with your verification results as structured output.`;
}

interface DuplicateGroup {
  findingIds: string[];
  keepFindingId: string;
  reason: string;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function pickKeeper(group: Finding[], preferredId: string): Finding {
  const preferred = group.find((f) => f.id === preferredId);
  if (preferred) return preferred;
  return [...group].sort((a, b) => {
    const sev = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (sev !== 0) return sev;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  })[0];
}

function dedupeVerified(
  verified: Finding[],
  groups: DuplicateGroup[]
): { verified: Finding[]; rejected: Finding[] } {
  if (groups.length === 0) return { verified, rejected: [] };

  const byId = new Map(verified.map((f) => [f.id, f]));
  const removed = new Set<string>();
  const rejected: Finding[] = [];

  for (const group of groups) {
    const members = group.findingIds
      .map((id) => byId.get(id))
      .filter((f): f is Finding => !!f && !removed.has(f.id));
    if (members.length < 2) continue;

    const keeper = pickKeeper(members, group.keepFindingId);
    const note = `Duplicate of ${keeper.id} (${keeper.reviewerRole}) — ${group.reason}`;

    for (const f of members) {
      if (f.id === keeper.id) continue;
      removed.add(f.id);
      rejected.push({ ...f, verified: false, verifierNote: note });
    }
  }

  return {
    verified: verified.filter((f) => !removed.has(f.id)),
    rejected,
  };
}

/**
 * Resolve which model the verifier should use — always different from reviewers.
 */
function pickVerifierModel(reviewerModelKey?: string): string {
  if (reviewerModelKey === VERIFIER_DEFAULT_MODEL) {
    return VERIFIER_FALLBACK_MODEL;
  }
  return VERIFIER_DEFAULT_MODEL;
}

export async function verifyFindings(
  findings: Finding[],
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  options: {
    prNumber?: number;
    reviewerModelKey?: string;
    onActivity?: () => void;
  } = {}
): Promise<{ verified: Finding[]; rejected: Finding[]; summary: string }> {
  if (findings.length === 0) {
    return { verified: [], rejected: [], summary: "No findings to verify." };
  }

  const { prNumber, reviewerModelKey, onActivity } = options;
  const verifierModel = pickVerifierModel(reviewerModelKey);
  const box = await createReviewerBox(verifierModel);

  try {
    await setupRepo(box, owner, repo, baseSha, headSha, { prNumber });

    const prompt = buildVerifierPrompt(findings);

    const run = await box.agent.run({
      prompt,
      responseSchema: verifierResponseSchema,
      maxRetries: 0,
      timeout: 5 * 60 * 1000,
      onToolUse: onActivity ? () => onActivity() : undefined,
    });

    if (!run.result?.verifications) {
      return {
        verified: findings.map((f) => ({ ...f, verified: true })),
        rejected: [],
        summary: "Verification produced no results — all findings kept.",
      };
    }

    const verificationMap = new Map(
      run.result.verifications.map((v) => [v.findingId, v])
    );

    const verified: Finding[] = [];
    const rejected: Finding[] = [];

    for (const finding of findings) {
      const v = verificationMap.get(finding.id);

      if (!v) {
        verified.push({ ...finding, verified: true });
        continue;
      }

      if (v.status === "rejected") {
        rejected.push({
          ...finding,
          verified: false,
          verifierNote: v.note,
        });
        continue;
      }

      const updated: Finding = {
        ...finding,
        verified: true,
        verifierNote: v.note,
      };

      if (v.status === "adjusted") {
        if (v.adjustedSeverity && v.adjustedSeverity !== finding.severity) {
          updated.originalSeverity = finding.severity;
          updated.severity = v.adjustedSeverity;
        }
        if (
          v.adjustedConfidence != null &&
          v.adjustedConfidence !== finding.confidence
        ) {
          updated.originalConfidence = finding.confidence;
          updated.confidence = v.adjustedConfidence;
        }
      }

      verified.push(updated);
    }

    const { verified: deduped, rejected: dupRejected } = dedupeVerified(
      verified,
      run.result.duplicateGroups ?? []
    );

    return {
      verified: deduped,
      rejected: [...rejected, ...dupRejected],
      summary: run.result.summary,
    };
  } catch {
    return {
      verified: findings.map((f) => ({
        ...f,
        verified: false,
        verifierNote: "Verification failed",
      })),
      rejected: [],
      summary: "Verification agent failed — all findings kept unverified.",
    };
  } finally {
    await deleteTrackedBox(box);
  }
}
