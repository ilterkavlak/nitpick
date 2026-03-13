import { confirm, select } from "@inquirer/prompts";
import type { Finding, Severity, AnyRole } from "../lib/types";

const E = "\x1b";
const R = `${E}[0m`;
const B = `${E}[1m`;
const D = `${E}[2m`;
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

const ROLE_COLORS: Record<AnyRole, string> = {
  security: RED,
  performance: YELLOW,
  architecture: MAGENTA,
  testing: GREEN,
  dx: CYAN,
  secrets: BR_RED,
  linter: BLUE,
  dependencies: WARN,
};

const SEV_PILL: Record<Severity, string> = {
  critical: `${BG(196)}${BR_WHITE}${B} CRT ${R}`,
  high: `${BG(202)}${BR_WHITE}${B} HGH ${R}`,
  medium: `${BG(220)}${E}[30m${B} MED ${R}`,
  low: `${BG(39)}${BR_WHITE}${B} LOW ${R}`,
  info: `${BG(240)}${BR_WHITE} INF ${R}`,
};

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

function progressBar(current: number, total: number, width = 20): string {
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  return `${ACCENT}${"▓".repeat(filled)}${C(236)}${"░".repeat(empty)}${R}`;
}

function renderFindingCard(f: Finding, index: number, total: number): void {
  const roleCol = ROLE_COLORS[f.reviewerRole] ?? GRAY;
  const loc = f.filePath
    ? `${D}${f.filePath}${f.lineStart ? `:${f.lineStart}` : ""}${R}`
    : "";
  const conf = `${D}${(f.confidence * 100).toFixed(0)}% confidence${R}`;

  console.log("");
  console.log(`  ${D}─────────────────────────────────────────────────────────${R}`);
  console.log(
    `  ${D}${index + 1}/${total}${R}  ${progressBar(index + 1, total)}  ${SEV_PILL[f.severity]}  ${roleCol}${f.reviewerRole}${R}`
  );
  console.log("");
  console.log(`  ${B}${f.title}${R}`);
  if (loc) console.log(`  ${loc}  ${conf}`);
  else console.log(`  ${conf}`);
  console.log("");
  console.log(`  ${f.description}`);

  if (f.evidence) {
    console.log("");
    console.log(`  ${D}Evidence${R}`);
    console.log(`  ${D}${f.evidence}${R}`);
  }

  if (f.verifierNote) {
    console.log("");
    const adj = f.originalSeverity ? ` ${D}(was ${f.originalSeverity})${R}` : "";
    console.log(`  ${MAGENTA}Verifier${R}${adj}  ${D}${f.verifierNote}${R}`);
  }

  console.log("");
  console.log(`  ${BRAND}Recommendation${R}  ${f.recommendation}`);
}

export interface TriageResult {
  accepted: Finding[];
  dismissed: Finding[];
}

export async function triageFindings(findings: Finding[]): Promise<TriageResult> {
  if (findings.length === 0) {
    return { accepted: [], dismissed: [] };
  }

  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );

  console.log("");
  console.log(`  ${BRAND}${B}⚖  Triage${R}  ${D}— ${sorted.length} finding(s) to review${R}`);
  console.log(`  ${D}Accept findings into the verdict or dismiss them.${R}`);

  if (sorted.length > 5) {
    const acceptAll = await confirm({
      message: `Accept all ${sorted.length} findings without reviewing?`,
      default: false,
    });
    if (acceptAll) {
      return { accepted: sorted, dismissed: [] };
    }
  }

  const accepted: Finding[] = [];
  const dismissed: Finding[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    renderFindingCard(f, i, sorted.length);

    const action = await select<"accept" | "dismiss" | "accept_rest" | "dismiss_rest">({
      message: "Action",
      choices: [
        { name: `${GREEN}✓${R} Accept`, value: "accept" as const },
        { name: `${RED}✗${R} Dismiss`, value: "dismiss" as const },
        { name: `${GREEN}✓✓${R} Accept all remaining (${sorted.length - i})`, value: "accept_rest" as const },
        { name: `${RED}✗✗${R} Dismiss all remaining (${sorted.length - i})`, value: "dismiss_rest" as const },
      ],
    });

    if (action === "accept") {
      accepted.push(f);
    } else if (action === "dismiss") {
      dismissed.push(f);
    } else if (action === "accept_rest") {
      accepted.push(...sorted.slice(i));
      break;
    } else if (action === "dismiss_rest") {
      dismissed.push(...sorted.slice(i));
      break;
    }
  }

  console.log("");
  console.log(
    `  ${ACCENT}${B}Triage complete${R}  ${GREEN}${accepted.length} accepted${R}  ${D}·${R}  ${RED}${dismissed.length} dismissed${R}`
  );

  return { accepted, dismissed };
}
