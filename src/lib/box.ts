import { Box, Agent, ClaudeCode, OpenAICodex, BoxApiKey } from "@upstash/box";
import { requireBoxApiKey, requireGitReadToken } from "./auth";

export type BoxInstance = Awaited<ReturnType<typeof Box.create>>;

// ── Central box registry for cleanup on crash / SIGINT ─────────────
const activeBoxes = new Set<BoxInstance>();

export function trackBox(box: BoxInstance): void {
  activeBoxes.add(box);
}

export function untrackBox(box: BoxInstance): void {
  activeBoxes.delete(box);
}

export function getActiveBoxCount(): number {
  return activeBoxes.size;
}

export async function cleanupAllBoxes(
  onProgress?: (done: number, total: number) => void
): Promise<{ total: number; failed: number }> {
  const boxes = Array.from(activeBoxes);
  activeBoxes.clear();
  const total = boxes.length;
  let done = 0;
  let failed = 0;

  const results = await Promise.allSettled(
    boxes.map(async (b) => {
      try {
        await b.delete();
      } catch {
        failed++;
      } finally {
        done++;
        onProgress?.(done, total);
      }
    })
  );

  // Keep this in place in case upstream behavior changes and throws outside
  // inner try/catch.
  for (const r of results) {
    if (r.status === "rejected") {
      failed++;
    }
  }

  return { total, failed };
}

export const DEFAULT_MODEL_KEY = "Opus_4_6";

// ── Model registry ────────────────────────────────────────────────
export interface ModelEntry {
  key: string;
  value: string;
  runner: Agent;
  provider: "claude" | "openai";
}

const CLAUDE_MODELS: ModelEntry[] = Object.entries(ClaudeCode).map(
  ([key, value]) => ({ key, value, runner: Agent.ClaudeCode, provider: "claude" as const })
);

const OPENAI_MODELS: ModelEntry[] = Object.entries(OpenAICodex).map(
  ([key, value]) => ({ key, value, runner: Agent.Codex, provider: "openai" as const })
);

export const AVAILABLE_MODELS: ModelEntry[] = [...CLAUDE_MODELS, ...OPENAI_MODELS];

function resolveModelEntry(key?: string): ModelEntry {
  const fallback = CLAUDE_MODELS.find((m) => m.key === DEFAULT_MODEL_KEY) ?? CLAUDE_MODELS[0];
  if (!key) return fallback;
  return AVAILABLE_MODELS.find((m) => m.key === key) ?? fallback;
}

export async function createReviewerBox(modelKey?: string) {
  const entry = resolveModelEntry(modelKey);
  const gitReadToken = requireGitReadToken();
  const boxApiKey = requireBoxApiKey();
  const box = await Box.create({
    apiKey: boxApiKey,
    runtime: "node",
    agent: {
      runner: entry.runner as string,
      model: entry.value as string,
      apiKey: BoxApiKey.UpstashKey,
    },
    git: {
      token: gitReadToken,
    },
  });
  trackBox(box);
  return box;
}

export async function setupRepo(
  box: Awaited<ReturnType<typeof Box.create>>,
  owner: string,
  repo: string,
  prNumber: number,
  baseSha: string,
  headSha: string
) {
  if (!/^[0-9a-f]{7,40}$/i.test(baseSha) || !/^[0-9a-f]{7,40}$/i.test(headSha)) {
    throw new Error("Invalid commit SHA received for diff generation");
  }

  await box.git.clone({ repo: `https://github.com/${owner}/${repo}` });
  await box.cd(repo);
  await box.git.exec({
    args: ["fetch", "origin", `pull/${prNumber}/head:pr-${prNumber}`],
  });
  await box.git.checkout({ branch: `pr-${prNumber}` });

  // Prepare diff artifacts for focused review
  await box.exec.command(
    `git diff --name-only ${baseSha}...${headSha} > /workspace/home/changed_files.txt && ` +
      `git diff ${baseSha}...${headSha} > /workspace/home/pr.patch`
  );
}
