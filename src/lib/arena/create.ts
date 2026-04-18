import { generateId } from "../utils";
import type { ArenaSession, ReviewerRole, ReviewerRun } from "../types";
import { fetchCompareMetadata, fetchPrMetadata } from "../github";
import { setArena, setReviewers } from "./status";

function initReviewerRuns(arenaId: string, roles: ReviewerRole[]): void {
  const runs: Record<string, ReviewerRun> = {};
  for (const role of roles) {
    runs[role] = { role, arenaId, status: "queued" };
  }
  setReviewers(arenaId, runs);
}

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
    mode: "pr",
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

  setArena(session);
  initReviewerRuns(id, selectedRoles);

  return session;
}

export async function createArenaFromRefs(
  owner: string,
  repo: string,
  baseRef: string,
  headRef: string,
  selectedRoles: ReviewerRole[]
): Promise<ArenaSession> {
  const metadata = await fetchCompareMetadata(owner, repo, baseRef, headRef);
  const id = generateId();
  const now = new Date().toISOString();

  const session: ArenaSession = {
    id,
    mode: "ref",
    repoOwner: owner,
    repoName: repo,
    baseRef,
    headRef,
    baseSha: metadata.baseSha,
    headSha: metadata.headSha,
    selectedRoles,
    status: "queued",
    createdAt: now,
  };

  setArena(session);
  initReviewerRuns(id, selectedRoles);

  return session;
}
