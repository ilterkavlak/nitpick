import { Box, Agent, ClaudeCode, OpenAICodex, BoxApiKey } from "@upstash/box";
import { requireBoxApiKey } from "./auth";

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
            await box._request("POST", `/v2/box/${box.id}/runs/${run.id}/cancel`, {
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

/** Names of user-level env vars the Box account injects into every box. */
export async function listAccountEnvKeys(): Promise<string[]> {
  try {
    return Object.keys(await Box.listEnv({ apiKey: requireBoxApiKey() }));
  } catch {
    return [];
  }
}

export const DEFAULT_MODEL_KEY = "Opus_5_5";
export const FAST_MODEL_KEY = "Haiku_5_5";

// ── Model registry ────────────────────────────────────────────────
export interface ModelEntry {
  key: string;
  value: string;
  harness: Agent;
  provider: "claude" | "openai";
}

const CLAUDE_MODELS: ModelEntry[] = Object.entries(ClaudeCode).map(
  ([key, value]) => ({ key, value, harness: Agent.ClaudeCode, provider: "claude" as const })
);

const OPENAI_MODELS: ModelEntry[] = Object.entries(OpenAICodex).map(
  ([key, value]) => ({ key, value, harness: Agent.Codex, provider: "openai" as const })
);

export const AVAILABLE_MODELS: ModelEntry[] = [...CLAUDE_MODELS, ...OPENAI_MODELS];

function resolveModelEntry(key?: string): ModelEntry {
  const fallback = CLAUDE_MODELS.find((m) => m.key === DEFAULT_MODEL_KEY) ?? CLAUDE_MODELS[0];
  if (!key) return fallback;
  return AVAILABLE_MODELS.find((m) => m.key === key) ?? fallback;
}

/**
 * Pass `gitToken` only for private repositories. setupRepo() removes it from
 * the box before any agent or repository code runs.
 */
export async function createReviewerBox(modelKey?: string, gitToken?: string) {
  const entry = resolveModelEntry(modelKey);
  const box = await Box.create({
    apiKey: requireBoxApiKey(),
    runtime: "node",
    agent: {
      harness: entry.harness,
      model: entry.value,
      apiKey: BoxApiKey.UpstashKey,
    },
    ...(gitToken ? { git: { token: gitToken } } : {}),
  });
  trackBox(box);
  return box;
}

export interface SetupRepoOptions {
  prNumber?: number;
}

export async function setupRepo(
  box: Awaited<ReturnType<typeof Box.create>>,
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  options?: SetupRepoOptions
) {
  if (!/^[0-9a-f]{7,40}$/i.test(baseSha) || !/^[0-9a-f]{7,40}$/i.test(headSha)) {
    throw new Error("Invalid commit SHA received for diff generation");
  }

  const git = async (args: string[]) => {
    const res = await box.git.exec({ args });
    if (res.exit_code !== 0) {
      throw new Error(`git ${args[0]} failed in box (exit ${res.exit_code})`);
    }
  };
  const sh = async (command: string, what: string) => {
    const run = await box.exec.command(command);
    if (run.exitCode !== 0) {
      throw new Error(`${what} failed in box (exit ${run.exitCode})`);
    }
  };

  await box.git.clone({ repo: `https://github.com/${owner}/${repo}` });
  await box.cd(repo);

  if (options?.prNumber !== undefined) {
    await git(["fetch", "origin", `pull/${options.prNumber}/head:pr-${options.prNumber}`]);
    await box.git.checkout({ branch: `pr-${options.prNumber}` });
  } else {
    // Ref mode: fetch both SHAs explicitly and check out head
    await git(["fetch", "origin", baseSha]);
    await git(["fetch", "origin", headSha]);
    await git(["checkout", headSha]);
  }

  // Prepare diff artifacts for focused review
  await sh(
    `git diff --name-only ${baseSha}...${headSha} > /workspace/home/changed_files.txt && ` +
      `git diff ${baseSha}...${headSha} > /workspace/home/pr.patch`,
    "Diff generation"
  );

  // Box stores git credentials in plaintext (git credential store + gh CLI
  // config). Remove them before the agent or any repository code runs.
  await sh(
    "rm -f ~/.git-credentials ~/.config/gh/hosts.yml && " +
      "test ! -e ~/.git-credentials && test ! -e ~/.config/gh/hosts.yml",
    "Credential cleanup"
  );
}
