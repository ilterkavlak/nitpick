import { generateId } from "@/lib/utils";
import type { ArenaSession, ReviewerRole, ReviewerRun } from "@/lib/types";
import { fetchPrMetadata } from "@/lib/github";
import { setArena, setReviewers } from "./status";

export async function createArena(
  prUrl: string,
  owner: string,
  repo: string,
  prNumber: number,
  selectedRoles: ReviewerRole[]
): Promise<ArenaSession> {
  const metadata = await fetchPrMetadata(owner, repo, prNumber);
  const id = generateId();
  const now = new Date().toISOString();

  const session: ArenaSession = {
    id,
    repoOwner: owner,
    repoName: repo,
    prNumber,
    prUrl,
    prTitle: metadata.title,
    prAuthor: metadata.author,
    baseSha: metadata.baseSha,
    headSha: metadata.headSha,
    selectedRoles,
    status: "queued",
    createdAt: now,
  };

  // Store in-memory
  setArena(session);

  // Initialize reviewer runs
  const runs: Record<string, ReviewerRun> = {};
  for (const role of selectedRoles) {
    runs[role] = {
      role,
      arenaId: id,
      status: "queued",
    };
  }
  setReviewers(id, runs);

  return session;
}
