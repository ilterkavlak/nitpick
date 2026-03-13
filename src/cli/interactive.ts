import { search, select, checkbox, confirm, editor, input, Separator } from "@inquirer/prompts";
import { fetchUserRepos, fetchOpenPrs } from "../lib/github";
import type { GitHubRepo, GitHubPr } from "../lib/github";
import { ROLE_PROMPTS } from "../lib/reviewer/prompts";
import { AVAILABLE_MODELS, DEFAULT_MODEL_KEY } from "../lib/box";
import type { ModelEntry } from "../lib/box";
import type { ReviewerRole, ReviewerConfig, ScannerRole } from "../lib/types";

const E = "\x1b";
const R = `${E}[0m`;
const B = `${E}[1m`;
const D = `${E}[2m`;
const ITALIC = `${E}[3m`;

const C = (n: number) => `${E}[38;5;${n}m`;
const BRAND = C(75);
const ACCENT = C(114);
const MUTED = C(240);

const ALL_ROLES: ReviewerRole[] = ["security", "performance", "architecture", "testing", "dx"];

// ── Screen management ─────────────────────────────────────────────

const CLEAR = `${E}[2J${E}[H`;
const TOTAL_STEPS = 7;

interface CompletedStep {
  label: string;
  value: string;
}

const completed: CompletedStep[] = [];

function clearScreen(): void {
  process.stdout.write(CLEAR);
}

/** Render the full page: banner + completed summary + current step header */
function renderPage(step: number, title: string): void {
  clearScreen();

  // Banner
  console.log("");
  console.log(`  ${BRAND}${B}  🔎  Nitpik${R}`);
  console.log(`  ${MUTED}  AI-powered PR review${R}`);
  console.log("");

  // Completed steps summary
  if (completed.length > 0) {
    for (const s of completed) {
      console.log(`  ${ACCENT}✓${R}  ${MUTED}${s.label}${R}  ${D}${s.value}${R}`);
    }
    console.log("");
  }

  // Current step header
  console.log(`  ${BRAND}${B}${step}${R}${MUTED}/${TOTAL_STEPS}${R}  ${B}${title}${R}`);
  console.log(`  ${MUTED}${"─".repeat(50)}${R}`);
  console.log("");
}

function addCompleted(label: string, value: string): void {
  completed.push({ label, value });
}

// ── Model display helpers ─────────────────────────────────────────

function formatModelName(entry: ModelEntry): string {
  return entry.key
    .replace(/_/g, " ")
    .replace(/(\d) (\d)/g, "$1.$2")
    .replace(/^GPT /i, "GPT-")
    .replace(/^(GPT-[\d.]+)/, "$1");
}

function formatModelChoice(entry: ModelEntry): string {
  const name = formatModelName(entry);
  const providerTag =
    entry.provider === "openai"
      ? `${MUTED}openai${R}  `
      : `${MUTED}claude${R}  `;
  const defaultTag = entry.key === DEFAULT_MODEL_KEY ? ` ${D}(default)${R}` : "";
  return `${providerTag}${name}${defaultTag}`;
}

function buildModelChoices(): Array<
  { name: string; value: string } | Separator
> {
  const claude = AVAILABLE_MODELS.filter((m) => m.provider === "claude");
  const openai = AVAILABLE_MODELS.filter((m) => m.provider === "openai");

  const choices: Array<{ name: string; value: string } | Separator> = [];

  if (claude.length > 0) {
    choices.push(new Separator(`${MUTED}── Claude ──${R}`));
    for (const m of claude) {
      choices.push({ name: formatModelChoice(m), value: m.key });
    }
  }
  if (openai.length > 0) {
    choices.push(new Separator(`${MUTED}── OpenAI ──${R}`));
    for (const m of openai) {
      choices.push({ name: formatModelChoice(m), value: m.key });
    }
  }

  return choices;
}

const MODEL_CHOICES = buildModelChoices();

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

// ── Step 1: Repository ─────────────────────────────────────────────

async function pickRepo(): Promise<GitHubRepo> {
  renderPage(1, "Repository");
  console.log(`  ${D}${ITALIC}Fetching your repositories…${R}\n`);
  const repos = await fetchUserRepos();

  if (repos.length === 0) {
    throw new Error("No repositories found for this GitHub token.");
  }

  // Re-render after fetch to clear the "Fetching..." message
  renderPage(1, "Repository");

  const repo = await search<GitHubRepo>({
    message: "Search and select a repository",
    source: async (term_input) => {
      const term = (term_input ?? "").toLowerCase();
      return repos
        .filter((r) => {
          if (!term) return true;
          return (
            r.fullName.toLowerCase().includes(term) ||
            r.description.toLowerCase().includes(term)
          );
        })
        .map((r) => ({
          name: `${r.fullName}${r.isPrivate ? ` ${D}(private)${R}` : ""}`,
          value: r,
          description: r.description
            ? `${D}${r.description.slice(0, 55)}${R}  ${MUTED}${timeAgo(r.updatedAt)}${R}`
            : `${MUTED}${timeAgo(r.updatedAt)}${R}`,
        }));
    },
  });

  addCompleted("Repository", repo.fullName);
  return repo;
}

// ── Step 2: Pull Request ───────────────────────────────────────────

async function pickPr(owner: string, repo: string): Promise<GitHubPr> {
  renderPage(2, "Pull Request");
  console.log(`  ${D}${ITALIC}Fetching open PRs for ${owner}/${repo}…${R}\n`);
  const prs = await fetchOpenPrs(owner, repo);

  if (prs.length === 0) {
    throw new Error(`No open PRs found in ${owner}/${repo}.`);
  }

  renderPage(2, "Pull Request");

  const pr = await search<GitHubPr>({
    message: "Search and select a pull request",
    source: async (term_input) => {
      const term = (term_input ?? "").toLowerCase();
      return prs
        .filter((p) => {
          if (!term) return true;
          return (
            p.title.toLowerCase().includes(term) ||
            p.author.toLowerCase().includes(term) ||
            p.headBranch.toLowerCase().includes(term) ||
            String(p.number).includes(term)
          );
        })
        .map((p) => ({
          name: `${D}#${p.number}${R} ${p.title}${p.draft ? ` ${D}(draft)${R}` : ""}`,
          value: p,
          description: `${MUTED}${p.author}  ${p.headBranch} → ${p.baseBranch}  ${timeAgo(p.updatedAt)}${R}`,
        }));
    },
  });

  addCompleted("Pull Request", `#${pr.number} ${pr.title}`);
  return pr;
}

// ── Step 3: Reviewer Roles ─────────────────────────────────────────

async function pickRoles(): Promise<ReviewerRole[]> {
  renderPage(3, "Reviewer Roles");

  const roles = await checkbox<ReviewerRole>({
    message: "Select reviewer roles",
    choices: ALL_ROLES.map((r) => ({
      name: r,
      value: r,
      checked: true,
    })),
    required: true,
  });

  addCompleted("Roles", roles.join(", "));
  return roles;
}

// ── Step 4: Reviewer Configuration ─────────────────────────────────

function defaultModelDisplayName(): string {
  const entry = AVAILABLE_MODELS.find((m) => m.key === DEFAULT_MODEL_KEY);
  return entry ? formatModelName(entry) : DEFAULT_MODEL_KEY;
}

async function configureReviewers(
  roles: ReviewerRole[]
): Promise<Record<string, ReviewerConfig>> {
  renderPage(4, "Reviewer Configuration");

  const useDefaults = await confirm({
    message: `Use defaults for all ${roles.length} reviewer(s)? (${defaultModelDisplayName()}, built-in prompts)`,
    default: true,
  });

  if (useDefaults) {
    addCompleted("Config", `defaults (${defaultModelDisplayName()})`);
    return {};
  }

  const configs: Record<string, ReviewerConfig> = {};

  const modelStrategy = await select<"same" | "per-role">({
    message: "Model selection",
    choices: [
      { name: "Same model for all reviewers", value: "same" as const },
      { name: "Choose model per reviewer", value: "per-role" as const },
    ],
  });

  let sharedModel: string | undefined;

  if (modelStrategy === "same") {
    sharedModel = await select<string>({
      message: "Select model for all reviewers",
      choices: MODEL_CHOICES,
      default: DEFAULT_MODEL_KEY,
    });
  }

  for (const role of roles) {
    console.log(`\n  ${BRAND}▸${R} ${B}${role}${R}`);

    let model = sharedModel;

    if (modelStrategy === "per-role") {
      model = await select<string>({
        message: `Model for ${role}`,
        choices: MODEL_CHOICES,
        default: DEFAULT_MODEL_KEY,
      });
    }

    const editPrompt = await confirm({
      message: `Edit prompt for ${role}?`,
      default: false,
    });

    let promptOverride: string | undefined;

    if (editPrompt) {
      const defaultPrompt = ROLE_PROMPTS[role];
      const edited = await editor({
        message: `Editing prompt for ${role} (save and close editor when done)`,
        default: defaultPrompt,
      });

      const trimmed = edited.trim();
      if (trimmed && trimmed !== defaultPrompt.trim()) {
        promptOverride = trimmed;
      }
    }

    if ((model && model !== DEFAULT_MODEL_KEY) || promptOverride) {
      configs[role] = {
        ...(model && model !== DEFAULT_MODEL_KEY ? { model } : {}),
        ...(promptOverride ? { promptOverride } : {}),
      };
    }
  }

  const customCount = Object.keys(configs).length;
  addCompleted("Config", customCount > 0 ? `${customCount} customized` : "defaults");
  return configs;
}

// ── Step 5: Scanners ───────────────────────────────────────────────

const ALL_SCANNERS: { name: string; value: ScannerRole; desc: string }[] = [
  { name: "Secret detection", value: "secrets", desc: "Scan for API keys, tokens, and credentials" },
  { name: "Dependency vulnerabilities", value: "dependencies", desc: "Check against OSV.dev" },
  { name: "Linter", value: "linter", desc: "Auto-detect and run linters on changed files" },
];

async function pickScanners(): Promise<ScannerRole[]> {
  renderPage(5, "Scanners");

  const scanners = await checkbox<ScannerRole>({
    message: "Select scanners to run alongside AI reviewers",
    choices: ALL_SCANNERS.map((s) => ({
      name: `${s.name}  ${D}${s.desc}${R}`,
      value: s.value,
      checked: true,
    })),
  });

  addCompleted("Scanners", scanners.length > 0 ? scanners.join(", ") : "none");
  return scanners;
}

// ── Step 6: Review Options ─────────────────────────────────────────

interface ReviewOptionsInteractive {
  summary: boolean;
  postReview: boolean;
  writeReport: boolean;
  output?: string;
}

async function pickReviewOptions(_prNumber: number): Promise<ReviewOptionsInteractive> {
  renderPage(6, "Review Options");

  const summary = await confirm({
    message: "Generate PR summary & walkthrough?",
    default: true,
  });

  const postReview = await confirm({
    message: "Post review as GitHub PR review with inline comments?",
    default: false,
  });

  if (postReview) {
    const confirmPost = await confirm({
      message: "Confirm: post comments/review to GitHub for this run?",
      default: true,
    });
    if (!confirmPost) {
      addCompleted("PR comments", "disabled");
      addCompleted("Summary", summary ? "enabled" : "disabled");
      const writeReport = await confirm({
        message: "Write markdown report to local file?",
        default: true,
      });
      addCompleted("Report", writeReport ? "enabled" : "disabled");
      return { summary, postReview: false, writeReport };
    }
  }

  const writeReport = await confirm({
    message: "Write markdown report to local file?",
    default: true,
  });

  addCompleted("Summary", summary ? "enabled" : "disabled");
  addCompleted("PR comments", postReview ? "enabled" : "disabled");
  addCompleted("Report", writeReport ? "enabled" : "disabled");

  return { summary, postReview, writeReport };
}

// ── Step 7: Output ─────────────────────────────────────────────────

async function pickOutput(prNumber: number): Promise<string | undefined> {
  renderPage(7, "Output");

  const defaultPath = `pr-review-${prNumber}.md`;
  const outputPath = await input({
    message: `Report file path`,
    default: defaultPath,
  });

  const trimmed = outputPath.trim();
  if (trimmed) addCompleted("Output", trimmed);
  return trimmed || undefined;
}

// ── Main Flow ──────────────────────────────────────────────────────

export interface InteractiveResult {
  prUrl: string;
  roles: ReviewerRole[];
  reviewerConfigs: Record<string, ReviewerConfig>;
  scanners: ScannerRole[];
  summary: boolean;
  postReview: boolean;
  writeReport: boolean;
  output?: string;
}

export async function runInteractive(
  presetOutput?: string,
  presetWriteReport?: boolean
): Promise<InteractiveResult> {
  // Reset state for fresh run
  completed.length = 0;

  const repo = await pickRepo();
  const pr = await pickPr(repo.owner, repo.name);
  const roles = await pickRoles();
  const reviewerConfigs = await configureReviewers(roles);
  const scanners = await pickScanners();
  const reviewOptions = await pickReviewOptions(pr.number);
  const writeReport = presetWriteReport ?? reviewOptions.writeReport;
  const output = writeReport ? (presetOutput ?? await pickOutput(pr.number)) : undefined;

  // Final confirmation page
  clearScreen();
  console.log("");
  console.log(`  ${BRAND}${B}  🔎  Nitpik${R}`);
  console.log(`  ${MUTED}  AI-powered PR review${R}`);
  console.log("");

  for (const s of completed) {
    console.log(`  ${ACCENT}✓${R}  ${MUTED}${s.label}${R}  ${D}${s.value}${R}`);
  }

  console.log("");
  console.log(`  ${ACCENT}${B}✓  Ready to review${R}  ${D}${pr.url}${R}`);
  console.log("");

  return {
    prUrl: pr.url,
    roles,
    reviewerConfigs,
    scanners,
    summary: reviewOptions.summary,
    postReview: reviewOptions.postReview,
    writeReport,
    output,
  };
}
