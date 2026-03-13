import { generateId } from "@/lib/utils";
import type { Finding, Severity } from "@/lib/types";

interface SecretPattern {
  name: string;
  pattern: RegExp;
  severity: Severity;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // API keys and tokens
  { name: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/g, severity: "critical" },
  { name: "AWS Secret Key", pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/g, severity: "critical" },
  { name: "GitHub Token", pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g, severity: "critical" },
  { name: "GitHub Personal Access Token (classic)", pattern: /ghp_[A-Za-z0-9]{36}/g, severity: "critical" },
  { name: "Slack Token", pattern: /xox[bporas]-[A-Za-z0-9-]+/g, severity: "critical" },
  { name: "Slack Webhook", pattern: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g, severity: "high" },
  { name: "Stripe Secret Key", pattern: /sk_live_[A-Za-z0-9]{24,}/g, severity: "critical" },
  { name: "Stripe Publishable Key", pattern: /pk_live_[A-Za-z0-9]{24,}/g, severity: "medium" },
  { name: "Google API Key", pattern: /AIza[0-9A-Za-z\-_]{35}/g, severity: "critical" },
  { name: "Google OAuth Client Secret", pattern: /GOCSPX-[A-Za-z0-9_-]{28}/g, severity: "critical" },
  { name: "Heroku API Key", pattern: /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, severity: "medium" },
  { name: "SendGrid API Key", pattern: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, severity: "critical" },
  { name: "Twilio API Key", pattern: /SK[0-9a-fA-F]{32}/g, severity: "high" },
  { name: "npm Token", pattern: /npm_[A-Za-z0-9]{36}/g, severity: "critical" },
  { name: "PyPI Token", pattern: /pypi-[A-Za-z0-9_-]{100,}/g, severity: "critical" },

  // Private keys
  { name: "RSA Private Key", pattern: /-----BEGIN RSA PRIVATE KEY-----/g, severity: "critical" },
  { name: "SSH Private Key", pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/g, severity: "critical" },
  { name: "PGP Private Key", pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g, severity: "critical" },
  { name: "EC Private Key", pattern: /-----BEGIN EC PRIVATE KEY-----/g, severity: "critical" },

  // Generic patterns
  { name: "Generic Secret Assignment", pattern: /(?:password|secret|token|api_key|apikey|access_key|auth_token|credentials)\s*[=:]\s*['"][A-Za-z0-9+/=_-]{16,}['"]/gi, severity: "high" },
  { name: "Bearer Token", pattern: /Bearer\s+[A-Za-z0-9_\-.~+/]+=*/g, severity: "high" },
  { name: "Basic Auth", pattern: /Basic\s+[A-Za-z0-9+/=]{20,}/g, severity: "high" },

  // Database connection strings
  { name: "Database URL with Credentials", pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@[^\s'"]+/gi, severity: "critical" },

  // JWT tokens
  { name: "JWT Token", pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, severity: "high" },
];

// Files to skip (common false-positive sources)
const SKIP_FILE_PATTERNS = [
  /\.lock$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.min\.js$/,
  /\.map$/,
  /\.snap$/,
  /\.test\.\w+$/,
  /\.spec\.\w+$/,
  /fixtures?\//,
  /__mocks__\//,
];

interface DiffHunk {
  filePath: string;
  lineStart: number;
  content: string;
}

function parseDiffAddedLines(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentFile = "";
  let lineNumber = 0;

  for (const line of diff.split("\n")) {
    // Track file path
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      continue;
    }

    // Track line numbers from hunk headers
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      lineNumber = parseInt(hunkMatch[1], 10);
      continue;
    }

    // Only scan added lines
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1);
      if (content.trim()) {
        hunks.push({ filePath: currentFile, lineStart: lineNumber, content });
      }
      lineNumber++;
    } else if (!line.startsWith("-")) {
      lineNumber++;
    }
  }

  return hunks;
}

export function scanSecretsInDiff(arenaId: string, diff: string): Finding[] {
  const hunks = parseDiffAddedLines(diff);
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const hunk of hunks) {
    // Skip files likely to have false positives
    if (SKIP_FILE_PATTERNS.some((p) => p.test(hunk.filePath))) continue;

    for (const sp of SECRET_PATTERNS) {
      // Reset regex lastIndex for global patterns
      sp.pattern.lastIndex = 0;

      if (sp.pattern.test(hunk.content)) {
        // Dedupe by pattern name + file + line
        const key = `${sp.name}|${hunk.filePath}|${hunk.lineStart}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Mask the matched secret for evidence
        sp.pattern.lastIndex = 0;
        const match = sp.pattern.exec(hunk.content);
        const evidence = match
          ? hunk.content.replace(match[0], match[0].slice(0, 8) + "..." + match[0].slice(-4))
          : hunk.content.slice(0, 80);

        findings.push({
          id: generateId(),
          arenaId,
          reviewerRole: "secrets",
          severity: sp.severity,
          category: "secret-detection",
          title: `${sp.name} detected in added code`,
          description: `A potential ${sp.name} was found in a newly added line. Secrets should never be committed to source control.`,
          filePath: hunk.filePath,
          lineStart: hunk.lineStart,
          evidence,
          recommendation: `Remove the ${sp.name.toLowerCase()} from source code. Use environment variables or a secrets manager instead. Rotate the exposed credential immediately.`,
          confidence: 0.85,
          dedupeKey: `secret-detection|${hunk.filePath}|${hunk.lineStart}|${sp.name.toLowerCase().slice(0, 40)}`,
        });
      }
    }
  }

  return findings;
}
