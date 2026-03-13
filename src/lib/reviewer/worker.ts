import { createReviewerBox, setupRepo, untrackBox } from "@/lib/box";
import { reviewerResponseSchema } from "./response-schema";
import { buildReviewerPrompt } from "./prompts";
import { normalizeFinding, saveFinding } from "@/lib/arena/findings";
import { publishEvent } from "@/lib/arena/events";
import { updateReviewerStatus } from "@/lib/arena/status";
import type { WorkerPayload } from "@/lib/types";

interface ExecuteReviewerOptions {
  shouldStop?: () => boolean;
  onActivity?: () => void;
}

export async function executeReviewerJob(
  payload: WorkerPayload,
  options?: ExecuteReviewerOptions
) {
  const { arenaId, role, owner, repo, prNumber, baseSha, headSha, config } = payload;
  const shouldStop = options?.shouldStop;
  const onActivity = options?.onActivity;

  if (shouldStop?.()) {
    await updateReviewerStatus(arenaId, role, "cancelled");
    return;
  }

  // Mark running
  await updateReviewerStatus(arenaId, role, "running");
  let box: Awaited<ReturnType<typeof createReviewerBox>> | null = null;

  try {
    if (shouldStop?.()) {
      await updateReviewerStatus(arenaId, role, "cancelled");
      return;
    }

    box = await createReviewerBox(config?.model);

    // Clone and checkout PR
    await setupRepo(box, owner, repo, prNumber, baseSha, headSha);

    // Build role-specific prompt
    const prompt = buildReviewerPrompt(role, baseSha, headSha, repo, config?.promptOverride);

    // Run agent with structured output
    const run = await box.agent.run({
      prompt,
      responseSchema: reviewerResponseSchema,
      maxRetries: 1,
      timeout: 4 * 60 * 1000,
      onToolUse: onActivity ? () => onActivity() : undefined,
    });

    // Parse and persist findings
    if (run.result?.findings) {
      for (const rawFinding of run.result.findings) {
        if (shouldStop?.()) {
          await updateReviewerStatus(arenaId, role, "cancelled");
          return;
        }
        const finding = normalizeFinding(arenaId, role, rawFinding);
        const saved = await saveFinding(finding);
        if (saved) {
          await publishEvent(arenaId, {
            type: "finding_upsert",
            finding,
          });
        }
      }
    }

    if (shouldStop?.()) {
      await updateReviewerStatus(arenaId, role, "cancelled");
      return;
    }

    // Mark completed
    await updateReviewerStatus(arenaId, role, "completed", {
      summary: run.result?.summary,
      cost: run.cost
        ? {
            inputTokens: run.cost.inputTokens,
            outputTokens: run.cost.outputTokens,
            totalUsd: run.cost.totalUsd,
          }
        : undefined,
    });

    await publishEvent(arenaId, {
      type: "reviewer_finish",
      role,
      cost: run.cost
        ? {
            inputTokens: run.cost.inputTokens,
            outputTokens: run.cost.outputTokens,
            totalUsd: run.cost.totalUsd,
          }
        : undefined,
      summary: run.result?.summary,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    if (shouldStop?.()) {
      await updateReviewerStatus(arenaId, role, "cancelled");
    } else {
      await updateReviewerStatus(arenaId, role, "failed", {
        error: errorMessage,
      });
    }
  } finally {
    if (box) {
      untrackBox(box);
      await box.delete().catch(() => {});
    }
  }

}
