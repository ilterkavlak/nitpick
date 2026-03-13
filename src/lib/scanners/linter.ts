import { createReviewerBox, setupRepo, untrackBox } from "@/lib/box";
import { generateId } from "@/lib/utils";
import type { Finding, Severity } from "@/lib/types";

const AUTO_DETECT_PROMPT = `Look at the repository root and determine which linter commands are available.
Check for:
- package.json scripts containing "lint" (run: npm run lint)
- .eslintrc* or eslint.config.* (run: npx eslint .)
- pylint/flake8/ruff in requirements*.txt or pyproject.toml
- golangci-lint (run: golangci-lint run)
- Makefile with lint target (run: make lint)

Run the most appropriate linter command. If there are multiple, run the primary one (usually the package.json lint script).

IMPORTANT: Only run the linter on the changed files listed in /workspace/home/changed_files.txt when possible.

After running the linter, output ONLY a JSON array (no markdown fences) of lint issues found:
[
  {
    "file": "path/to/file.ts",
    "line": 42,
    "rule": "no-unused-vars",
    "message": "Description of the issue",
    "severity": "warning"
  }
]

If the linter passes with no issues, output an empty array: []
If the linter command fails to run, output: [{"file": "", "line": 0, "rule": "linter-error", "message": "Could not run linter: <reason>", "severity": "error"}]
`;

interface LintIssue {
  file: string;
  line: number;
  rule: string;
  message: string;
  severity: string;
}

function lintSeverityToSeverity(s: string): Severity {
  switch (s.toLowerCase()) {
    case "error": return "high";
    case "warning": return "medium";
    default: return "low";
  }
}

export async function scanWithLinter(
  arenaId: string,
  owner: string,
  repo: string,
  prNumber: number,
  baseSha: string,
  headSha: string,
  options?: { commands?: string[]; modelKey?: string; onActivity?: () => void }
): Promise<Finding[]> {
  const box = await createReviewerBox(options?.modelKey ?? "Haiku_4_5");

  try {
    await setupRepo(box, owner, repo, prNumber, baseSha, headSha);

    let prompt: string;
    if (options?.commands && options.commands.length > 0) {
      // User specified linter commands
      const cmds = options.commands.map((c) => `- ${c}`).join("\n");
      prompt = `Run these linter commands on the changed files listed in /workspace/home/changed_files.txt:
${cmds}

After running, output ONLY a JSON array (no markdown fences) of lint issues found:
[{"file": "path/to/file.ts", "line": 42, "rule": "rule-name", "message": "Description", "severity": "warning|error"}]

If no issues found, output: []`;
    } else {
      prompt = AUTO_DETECT_PROMPT;
    }

    const run = await box.agent.run({
      prompt,
      maxRetries: 1,
      timeout: 3 * 60 * 1000,
      onToolUse: options?.onActivity ? () => options.onActivity!() : undefined,
    });

    const text = typeof run.result === "string"
      ? run.result
      : JSON.stringify(run.result);

    // Extract JSON array from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const issues: LintIssue[] = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(issues) || issues.length === 0) return [];

    // Filter out meta-errors
    const realIssues = issues.filter((i) => i.file && i.line > 0);

    return realIssues.map((issue) => ({
      id: generateId(),
      arenaId,
      reviewerRole: "linter" as const,
      severity: lintSeverityToSeverity(issue.severity),
      category: "lint",
      title: `${issue.rule}: ${issue.message.slice(0, 80)}`,
      description: issue.message,
      filePath: issue.file,
      lineStart: issue.line,
      recommendation: `Fix the lint issue: ${issue.rule}`,
      confidence: 0.9,
      dedupeKey: `lint|${issue.file}|${issue.line}|${issue.rule.toLowerCase().slice(0, 40)}`,
    }));
  } catch {
    return [];
  } finally {
    untrackBox(box);
    await box.delete().catch(() => {});
  }
}
