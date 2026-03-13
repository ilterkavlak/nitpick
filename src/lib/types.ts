export type ArenaStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ReviewerRole = "security" | "performance" | "architecture" | "testing" | "dx";
export type ScannerRole = "secrets" | "linter" | "dependencies";
export type AnyRole = ReviewerRole | ScannerRole;
export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface ArenaSession {
  id: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  prAuthor: string;
  baseSha: string;
  headSha: string;
  selectedRoles: ReviewerRole[];
  status: ArenaStatus;
  createdAt: string;
  completedAt?: string;
}

export interface ReviewerRun {
  role: ReviewerRole;
  arenaId: string;
  status: ArenaStatus;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  cost?: ReviewerCost;
  error?: string;
}

export interface ReviewerCost {
  inputTokens: number;
  outputTokens: number;
  totalUsd: number;
}

export interface Finding {
  id: string;
  arenaId: string;
  reviewerRole: AnyRole;
  severity: Severity;
  category: string;
  title: string;
  description: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  evidence?: string;
  recommendation: string;
  confidence: number;
  dedupeKey: string;
  verified?: boolean;
  verifierNote?: string;
  originalSeverity?: Severity;
  originalConfidence?: number;
}

export interface Verdict {
  arenaId: string;
  riskScore: number;
  mergeRecommendation: "approve" | "request_changes" | "needs_discussion";
  blockers: Finding[];
  improvements: Finding[];
  summary: string;
  suggestedCommits: string[];
  createdAt: string;
}

export type ArenaEvent =
  | { type: "arena_status"; status: ArenaStatus }
  | { type: "reviewer_status"; role: ReviewerRole; status: ArenaStatus; error?: string }
  | { type: "finding_upsert"; finding: Finding }
  | { type: "reviewer_finish"; role: ReviewerRole; cost?: ReviewerCost; summary?: string }
  | { type: "jury_verdict"; summary: string; riskScore: number }
  | { type: "pr_summary"; summary: PrSummary }
  | { type: "scanner_finish"; role: ScannerRole; findingCount: number };

export interface ArenaEventEnvelope {
  seq: number;
  ts: number;
  event: ArenaEvent;
}

export interface ReviewerConfig {
  model?: string;
  promptOverride?: string;
}

export interface WorkerPayload {
  arenaId: string;
  role: ReviewerRole;
  owner: string;
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  config?: ReviewerConfig;
}

export interface PrSummary {
  overview: string;
  keyChanges: string[];
  hotspotFiles: string[];
}

export interface ScannerConfig {
  enabled: boolean;
  commands?: string[];
}

export interface NitpikConfig {
  roles?: ReviewerRole[];
  model?: string;
  auto?: boolean;
  report?: boolean;
  output?: string;
  postReview?: boolean;
  summary?: boolean;
  reviewers?: Partial<Record<ReviewerRole, ReviewerConfig>>;
  scanners?: {
    secrets?: boolean | ScannerConfig;
    linter?: boolean | ScannerConfig;
    dependencies?: boolean | ScannerConfig;
  };
}
