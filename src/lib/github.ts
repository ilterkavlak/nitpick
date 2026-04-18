import { z } from "zod";
import { getGitReadToken } from "./auth";

export interface PrMetadata {
  title: string;
  author: string;
  baseSha: string;
  headSha: string;
  baseBranch: string;
  headBranch: string;
  changedFiles: number;
  additions: number;
  deletions: number;
}

export interface GitHubRepo {
  fullName: string;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  updatedAt: string;
  openIssuesCount: number;
}

export interface GitHubPr {
  number: number;
  title: string;
  author: string;
  updatedAt: string;
  headBranch: string;
  baseBranch: string;
  draft: boolean;
  url: string;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "nitpick-cli",
  };
  const token = getGitReadToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function githubGet(url: string): Promise<Response> {
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }
  return res;
}

const githubRepoSchema = z.object({
  full_name: z.string(),
  owner: z.object({ login: z.string() }),
  name: z.string(),
  description: z.string().nullable(),
  private: z.boolean(),
  updated_at: z.string(),
  open_issues_count: z.number(),
});

export async function fetchUserRepos(): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  let page = 1;

  while (true) {
    const res = await githubGet(
      `https://api.github.com/user/repos?sort=pushed&per_page=100&page=${page}`
    );
    const raw = await res.json();
    const parsed = z.array(githubRepoSchema).parse(raw);

    if (parsed.length === 0) break;

    for (const r of parsed) {
      repos.push({
        fullName: r.full_name,
        owner: r.owner.login,
        name: r.name,
        description: r.description ?? "",
        isPrivate: r.private,
        updatedAt: r.updated_at,
        openIssuesCount: r.open_issues_count,
      });
    }

    // Stop after 5 pages (500 repos) to avoid excessive API calls
    if (parsed.length < 100 || page >= 5) break;
    page++;
  }

  return repos;
}

const githubPrListSchema = z.object({
  number: z.number(),
  title: z.string(),
  user: z.object({ login: z.string() }).nullable().optional(),
  updated_at: z.string(),
  head: z.object({ ref: z.string() }),
  base: z.object({ ref: z.string() }),
  draft: z.boolean(),
  html_url: z.string(),
});

export async function fetchOpenPrs(owner: string, repo: string): Promise<GitHubPr[]> {
  const res = await githubGet(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&sort=updated&per_page=100`
  );
  const raw = await res.json();
  const parsed = z.array(githubPrListSchema).parse(raw);

  return parsed.map((pr) => ({
    number: pr.number,
    title: pr.title,
    author: pr.user?.login ?? "unknown",
    updatedAt: pr.updated_at,
    headBranch: pr.head.ref,
    baseBranch: pr.base.ref,
    draft: pr.draft,
    url: pr.html_url,
  }));
}

const githubPrSchema = z.object({
  title: z.string(),
  user: z.object({ login: z.string() }).nullable().optional(),
  base: z.object({
    sha: z.string(),
    ref: z.string(),
  }),
  head: z.object({
    sha: z.string(),
    ref: z.string(),
  }),
  changed_files: z.number(),
  additions: z.number(),
  deletions: z.number(),
});

export async function fetchPrDiff(
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    {
      headers: {
        ...githubHeaders(),
        Accept: "application/vnd.github.v3.diff",
      },
    }
  );
  if (!res.ok) {
    throw new Error(`GitHub API error fetching diff: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

export async function fetchPrMetadata(
  owner: string,
  repo: string,
  prNumber: number
): Promise<PrMetadata> {
  const res = await githubGet(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`
  );
  const raw = await res.json();
  const data = githubPrSchema.parse(raw);

  return {
    title: data.title,
    author: data.user?.login ?? "unknown",
    baseSha: data.base.sha,
    headSha: data.head.sha,
    baseBranch: data.base.ref,
    headBranch: data.head.ref,
    changedFiles: data.changed_files,
    additions: data.additions,
    deletions: data.deletions,
  };
}

export interface CompareMetadata {
  baseSha: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  aheadBy: number;
  behindBy: number;
}

const githubCompareSchema = z.object({
  merge_base_commit: z.object({ sha: z.string() }),
  base_commit: z.object({ sha: z.string() }),
  status: z.string(),
  ahead_by: z.number(),
  behind_by: z.number(),
  total_commits: z.number(),
  commits: z.array(z.object({ sha: z.string() })),
  files: z
    .array(
      z.object({
        filename: z.string(),
        additions: z.number(),
        deletions: z.number(),
      })
    )
    .optional(),
});

export async function fetchCompareMetadata(
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<CompareMetadata> {
  const res = await githubGet(
    `https://api.github.com/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  );
  const raw = await res.json();
  const data = githubCompareSchema.parse(raw);

  // Use merge base as the "base" for diff semantics (mirrors PR behavior).
  const mergeBaseSha = data.merge_base_commit.sha;
  const headSha =
    data.commits.length > 0
      ? data.commits[data.commits.length - 1].sha
      : data.base_commit.sha;

  const files = data.files ?? [];
  const additions = files.reduce((acc, f) => acc + f.additions, 0);
  const deletions = files.reduce((acc, f) => acc + f.deletions, 0);

  return {
    baseSha: mergeBaseSha,
    headSha,
    baseRef: base,
    headRef: head,
    changedFiles: files.length,
    additions,
    deletions,
    aheadBy: data.ahead_by,
    behindBy: data.behind_by,
  };
}

export async function fetchCompareDiff(
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    {
      headers: {
        ...githubHeaders(),
        Accept: "application/vnd.github.v3.diff",
      },
    }
  );
  if (!res.ok) {
    throw new Error(`GitHub API error fetching compare diff: ${res.status} ${res.statusText}`);
  }
  return res.text();
}
