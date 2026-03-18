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

async function deleteWithTimeout(
  box: BoxInstance,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      box.delete(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Box delete timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function deleteTrackedBox(
  box: BoxInstance,
  options?: { retries?: number; timeoutMs?: number }
): Promise<boolean> {
  const retries = options?.retries ?? 2;
  const timeoutMs = options?.timeoutMs ?? 15_000;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await deleteWithTimeout(box, timeoutMs);
      activeBoxes.delete(box);
      return true;
    } catch {
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  return false;
}

export async function cleanupAllBoxes(
  onProgress?: (done: number, total: number) => void
): Promise<{ total: number; failed: number }> {
  const boxes = Array.from(activeBoxes);
  const total = boxes.length;
  let done = 0;
  let failed = 0;

  await Promise.allSettled(
    boxes.map(async (b) => {
      const deleted = await deleteTrackedBox(b, { retries: 1, timeoutMs: 15_000 });
      if (!deleted) {
        failed++;
      }
      done++;
      onProgress?.(done, total);
    })
  );

  return { total, failed };
}

export async function cancelAllBoxRuns(
  onProgress?: (done: number, total: number) => void
): Promise<{ total: number; failed: number; cancelled: number }> {
  const boxes = Array.from(activeBoxes);
  const total = boxes.length;
  let done = 0;
  let failed = 0;
  let cancelled = 0;

  await Promise.allSettled(
    boxes.map(async (box) => {
      try {
        const runs = await Promise.race([
          box.listRuns(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("List runs timeout")), 5_000)
          ),
        ]);
        const running = runs.filter((r) => r.status === "running");
        for (const run of running) {
          try {
            const requester = (box as unknown as {
              _request: (method: string, path: string, options?: { body?: unknown; timeout?: number }) => Promise<unknown>;
            })._request;
            await requester("POST", `/v2/box/${box.id}/runs/${run.id}/cancel`, {
              timeout: 5_000,
            });
            cancelled++;
          } catch {
            failed++;
          }
        }
      } catch {
        failed++;
      } finally {
        done++;
        onProgress?.(done, total);
      }
    })
  );

  return { total, failed, cancelled };
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
