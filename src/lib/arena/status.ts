import type { ArenaSession, ArenaStatus, ReviewerRole, ReviewerRun } from "@/lib/types";
import { publishEvent } from "./events";

const arenas = new Map<string, ArenaSession>();
const reviewers = new Map<string, Record<string, ReviewerRun>>();

export function setArena(session: ArenaSession): void {
  arenas.set(session.id, session);
}

export function setReviewers(arenaId: string, runs: Record<string, ReviewerRun>): void {
  reviewers.set(arenaId, runs);
}

export async function getArena(id: string): Promise<ArenaSession | null> {
  return arenas.get(id) ?? null;
}

export async function updateArenaStatus(
  id: string,
  status: ArenaStatus
): Promise<void> {
  const session = arenas.get(id);
  if (!session) return;

  session.status = status;
  if (status === "completed" || status === "failed" || status === "cancelled") {
    session.completedAt = new Date().toISOString();
  }
  arenas.set(id, session);
  await publishEvent(id, { type: "arena_status", status });
}

export async function getReviewer(
  arenaId: string,
  role: ReviewerRole
): Promise<ReviewerRun | null> {
  const runs = reviewers.get(arenaId);
  if (!runs) return null;
  return runs[role] ?? null;
}

export async function getAllReviewers(
  arenaId: string
): Promise<Record<string, ReviewerRun>> {
  return reviewers.get(arenaId) ?? {};
}

export async function updateReviewerStatus(
  arenaId: string,
  role: ReviewerRole,
  status: ArenaStatus,
  extra?: Partial<ReviewerRun>
): Promise<void> {
  const runs = reviewers.get(arenaId);
  if (!runs || !runs[role]) return;

  const current = runs[role];
  const updated: ReviewerRun = {
    ...current,
    ...extra,
    status,
  };

  if (status === "running" && !updated.startedAt) {
    updated.startedAt = new Date().toISOString();
  }
  if (status === "completed" || status === "failed" || status === "cancelled") {
    updated.completedAt = new Date().toISOString();
  }

  runs[role] = updated;
  reviewers.set(arenaId, runs);

  await publishEvent(arenaId, {
    type: "reviewer_status",
    role,
    status,
    ...(status === "failed" && extra?.error ? { error: extra.error } : {}),
  });
}

export async function checkAllReviewersDone(arenaId: string): Promise<boolean> {
  const runs = await getAllReviewers(arenaId);
  return Object.values(runs).every(
    (r) =>
      r.status === "completed" ||
      r.status === "failed" ||
      r.status === "cancelled"
  );
}

export function clearArenaState(arenaId: string): void {
  arenas.delete(arenaId);
  reviewers.delete(arenaId);
}
