import { createReviewerBox, setupRepo, deleteTrackedBox, FAST_MODEL_KEY } from "./box";
import { stripControlChars } from "./utils";
import type { PrSummary } from "./types";

const SUMMARY_PROMPT = `You are a PR summarizer. Analyze the pull request diff and provide a concise summary.

Read the changed files list at /workspace/home/changed_files.txt and the diff at /workspace/home/pr.patch.

Respond with ONLY a JSON object (no markdown, no code fences) with this exact structure:
{
  "overview": "A 2-3 sentence high-level description of what this PR does and why",
  "keyChanges": ["Change 1 description", "Change 2 description", ...],
  "hotspotFiles": ["path/to/most-important-file.ts", ...]
}

Rules:
- overview: Focus on the "what" and "why", not file-by-file details
- keyChanges: List the 3-7 most significant changes, each as a concise sentence
- hotspotFiles: List the 3-5 files that are most critical to review (highest risk or complexity)
`;

export async function generatePrSummary(
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  options: { prNumber?: number; modelKey?: string; gitToken?: string } = {}
): Promise<PrSummary> {
  const box = await createReviewerBox(options.modelKey ?? FAST_MODEL_KEY, options.gitToken);

  try {
    await setupRepo(box, owner, repo, baseSha, headSha, { prNumber: options.prNumber });

    const run = await box.agent.run({
      prompt: SUMMARY_PROMPT,
      maxRetries: 0,
      timeout: 2 * 60 * 1000,
    });

    const text = typeof run.result === "string"
      ? run.result
      : JSON.stringify(run.result);

    // Extract JSON from response (handle possible markdown fences)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return fallbackSummary();
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      overview: typeof parsed.overview === "string" ? stripControlChars(parsed.overview) : "No overview available.",
      keyChanges: stringList(parsed.keyChanges),
      hotspotFiles: stringList(parsed.hotspotFiles),
    };
  } catch {
    return fallbackSummary();
  } finally {
    await deleteTrackedBox(box);
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").map(stripControlChars);
}

function fallbackSummary(): PrSummary {
  return {
    overview: "Summary generation failed. Review findings below for details.",
    keyChanges: [],
    hotspotFiles: [],
  };
}
