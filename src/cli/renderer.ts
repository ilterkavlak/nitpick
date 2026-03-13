import type { ArenaEventEnvelope, Severity, AnyRole, PrSummary } from "../lib/types";

const E = "\x1b";
const R = `${E}[0m`;
const B = `${E}[1m`;
const D = `${E}[2m`;
const ITALIC = `${E}[3m`;

const RED = `${E}[31m`;
const GREEN = `${E}[32m`;
const YELLOW = `${E}[33m`;
const BLUE = `${E}[34m`;
const MAGENTA = `${E}[35m`;
const CYAN = `${E}[36m`;
const GRAY = `${E}[90m`;
const BR_RED = `${E}[91m`;
const BR_WHITE = `${E}[97m`;

const C = (n: number) => `${E}[38;5;${n}m`;
const BG = (n: number) => `${E}[48;5;${n}m`;

const BRAND = C(75);
const ACCENT = C(114);
const WARN = C(208);
const ERR = C(203);

const ROLE_COLORS: Record<string, string> = {
  security: RED,
  performance: YELLOW,
  architecture: MAGENTA,
  testing: GREEN,
  dx: CYAN,
  secrets: BR_RED,
  linter: BLUE,
  dependencies: WARN,
  verifier: C(183),
};

const SEV_PILL: Record<Severity, string> = {
  critical: `${BG(196)}${BR_WHITE}${B} CRT ${R}`,
  high: `${BG(202)}${BR_WHITE}${B} HGH ${R}`,
  medium: `${BG(220)}${E}[30m${B} MED ${R}`,
  low: `${BG(39)}${BR_WHITE}${B} LOW ${R}`,
  info: `${BG(240)}${BR_WHITE} INF ${R}`,
};

function roleTag(role: AnyRole): string {
  return `${ROLE_COLORS[role] ?? GRAY}${role}${R}`;
}

function severityTag(severity: Severity): string {
  return SEV_PILL[severity];
}

function line(ch = "─", width = 60): string {
  return `${GRAY}${ch.repeat(width)}${R}`;
}

export function renderEvent(_arenaId: string, envelope: ArenaEventEnvelope): void {
  const { event } = envelope;

  switch (event.type) {
    case "arena_status":
      if (event.status === "running") {
        console.log(`\n${BRAND}${B}  🔎  Nitpick${R}  ${D}review started${R}\n`);
      } else if (event.status === "completed") {
        console.log(`\n${ACCENT}${B}  ✓  Review completed${R}\n`);
      } else if (event.status === "failed") {
        console.log(`\n${ERR}${B}  ✗  Review failed${R}\n`);
      }
      break;

    case "reviewer_status":
      if (event.status === "running") {
        console.log(`  ${D}▸${R} ${roleTag(event.role)}  ${ITALIC}${D}starting…${R}`);
      } else if (event.status === "failed") {
        console.log(`  ${ERR}✗${R} ${roleTag(event.role)}  ${ERR}failed: ${event.error ?? "unknown"}${R}`);
      }
      break;

    case "finding_upsert": {
      const f = event.finding;
      const loc = f.filePath
        ? ` ${D}${f.filePath}${f.lineStart ? `:${f.lineStart}` : ""}${R}`
        : "";
      console.log(
        `  ${severityTag(f.severity)} ${roleTag(f.reviewerRole)}  ${f.title}${loc}`
      );
      break;
    }

    case "reviewer_finish": {
      const cost = event.cost
        ? ` ${D}$${event.cost.totalUsd.toFixed(4)}${R}`
        : "";
      console.log(`  ${ACCENT}✓${R} ${roleTag(event.role)}  done${cost}`);
      if (event.summary) {
        console.log(`    ${D}${event.summary}${R}`);
      }
      break;
    }

    case "jury_verdict":
      break;

    case "pr_summary":
      renderSummary(event.summary);
      break;

    case "scanner_finish":
      console.log(`  ${ACCENT}✓${R} ${roleTag(event.role)}  scanner done — ${event.findingCount} issue(s)`);
      break;
  }
}

// ── PR Summary ─────────────────────────────────────────────────────

export function renderSummary(summary: PrSummary): void {
  console.log("");
  console.log(`  ${BRAND}${B}PR Summary${R}`);
  console.log(`  ${line("─", 56)}`);
  console.log("");
  console.log(`  ${summary.overview}`);

  if (summary.keyChanges.length > 0) {
    console.log("");
    console.log(`  ${B}Key changes${R}`);
    for (const c of summary.keyChanges) {
      console.log(`  ${D}▸${R} ${c}`);
    }
  }

  if (summary.hotspotFiles.length > 0) {
    console.log("");
    console.log(`  ${B}Hotspot files${R}`);
    for (const f of summary.hotspotFiles) {
      console.log(`  ${D}  ${f}${R}`);
    }
  }
  console.log("");
}

// ── Risk score bar ─────────────────────────────────────────────────

function riskBar(score: number, width = 30): string {
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;

  let barColor: string;
  if (score >= 50) barColor = `${BG(196)}`;
  else if (score >= 20) barColor = `${BG(208)}`;
  else barColor = `${BG(34)}`;

  return `${barColor}${" ".repeat(filled)}${R}${BG(236)}${" ".repeat(empty)}${R}`;
}

function recBadge(rec: string): string {
  switch (rec) {
    case "approve":
      return `${BG(34)}${BR_WHITE}${B}  APPROVE  ${R}`;
    case "request_changes":
      return `${BG(196)}${BR_WHITE}${B}  REQUEST CHANGES  ${R}`;
    default:
      return `${BG(208)}${BR_WHITE}${B}  NEEDS DISCUSSION  ${R}`;
  }
}

// ── Verdict ────────────────────────────────────────────────────────

export function renderVerdict(verdict: {
  riskScore: number;
  mergeRecommendation: string;
  summary: string;
  blockers: { title: string; severity: Severity }[];
  improvements: { title: string; severity: Severity }[];
  suggestedCommits: string[];
}): void {
  console.log("");
  console.log(`  ${line("━", 60)}`);
  console.log(`  ${BRAND}${B}⚖  VERDICT${R}`);
  console.log(`  ${line("━", 60)}`);
  console.log("");

  // Risk score with visual bar
  const scoreColor =
    verdict.riskScore >= 50 ? ERR
      : verdict.riskScore >= 20 ? WARN
        : ACCENT;
  console.log(`  ${B}Risk${R}     ${riskBar(verdict.riskScore)}  ${scoreColor}${B}${verdict.riskScore}${R}${D}/100${R}`);
  console.log("");

  // Recommendation badge
  console.log(`  ${B}Verdict${R}  ${recBadge(verdict.mergeRecommendation)}`);
  console.log("");

  // Summary
  console.log(`  ${verdict.summary}`);
  console.log("");

  // Blockers
  if (verdict.blockers.length > 0) {
    console.log(`  ${ERR}${B}Blockers${R}`);
    console.log("");
    for (const b of verdict.blockers) {
      console.log(`  ${severityTag(b.severity)}  ${b.title}`);
    }
    console.log("");
  }

  // Improvements
  if (verdict.improvements.length > 0) {
    console.log(`  ${WARN}${B}Improvements${R}`);
    console.log("");
    for (const imp of verdict.improvements) {
      console.log(`  ${severityTag(imp.severity)}  ${imp.title}`);
    }
    console.log("");
  }

  // Suggested commits
  if (verdict.suggestedCommits.length > 0) {
    console.log(`  ${B}Suggested commits${R}`);
    console.log("");
    for (const c of verdict.suggestedCommits) {
      console.log(`  ${D}▸${R} ${D}${c}${R}`);
    }
    console.log("");
  }

  console.log(`  ${line("━", 60)}`);
  console.log("");
}
