# Nitpick

A CLI tool that runs multiple AI reviewer roles and automated scanners against a GitHub pull request in parallel, lets you triage the findings, then generates a verdict with a merge recommendation and a markdown report.

## Features

- **Interactive mode** — browse your GitHub repos, pick a PR, select roles, configure models and prompts, all from the terminal
- **Direct PR mode** — `nitpick review <pr-url>` to review a specific pull request
- **Ref mode** — `--repo --base --head` to review a branch or commit range without opening a PR
- **Agent/CI mode** — `--auto --non-interactive --json - --exit-on <mode>` for autonomous loops and CI gates
- **5 AI reviewer roles**: `security`, `performance`, `architecture`, `testing`, `dx` — run any combination in parallel
- **3 automated scanners**: `secrets`, `linter`, `dependencies` — run alongside AI reviewers
- **PR summary & walkthrough** — AI-generated overview, key changes, and hotspot files before findings
- **Verification stage** — a separate verifier agent confirms/adjusts/rejects findings before triage
- **Per-reviewer configuration** — choose a different model or edit the system prompt for each role
- **Finding triage** — after reviewers finish, walk through each finding and accept or dismiss it before the verdict is computed
- **GitHub PR review comments** — post the verdict and inline comments directly on the PR with `--post-review`
- **Secret detection** — regex-based scanning of added lines for API keys, tokens, private keys, and credentials
- **Dependency vulnerability scanning** — queries OSV.dev for known vulnerabilities in newly added dependencies
- **Linter integration** — auto-detects and runs project linters inside a sandbox, reports issues on changed files
- **Structured JSON output** — stable schema emitted to stdout or a file, meant to be consumed by other agents or scripts
- **Meaningful exit codes** — `--exit-on` maps findings/blockers/recommendation to exit codes suitable for CI gates and loop convergence
- **`.nitpick.yaml` config** — set default roles, model, scanners, and reviewer overrides per repository
- **Live terminal output** — severity-colored findings stream in as reviewers work
- **Markdown report** — summary, blockers, all findings, risk score, merge recommendation, and suggested commits

## Setup

```bash
pnpm install
cp .env.example .env
```

Fill in your `.env`:

| Variable | Description |
| --- | --- |
| `UPSTASH_BOX_API_KEY` | Upstash Box API key for running AI agents (optional if using keychain/1Password/command fallback) |
| `GITHUB_READ_TOKEN` | Fine-grained PAT with **read-only** repo access (optional if `gh auth token` is available) |
| `GITHUB_REVIEW_TOKEN` | Fine-grained PAT with **Pull requests: write** (optional if `gh auth token` has that scope; used for `--post-review`) |

GitHub token fallback:
- If `GITHUB_READ_TOKEN` / `GITHUB_REVIEW_TOKEN` are not set, Nitpick automatically tries `gh auth token`.
- Run `gh auth login` once to use this flow.

Box API key fallback (checked in this order):
1. `UPSTASH_BOX_API_KEY`
2. Credentials file at `~/.box/credentials` (or `NITPICK_BOX_CREDENTIALS_FILE`)
3. macOS Keychain via `NITPICK_BOX_KEYCHAIN_SERVICE` (default: `nitpick_upstash_box_api_key`)
4. 1Password via `NITPICK_BOX_OP_REF` (`op read <ref>`)
5. Custom command via `NITPICK_BOX_API_KEY_COMMAND`

First-run helper:
- If no Box key is found and you are in interactive mode, Nitpick prompts for the key and asks where to save it:
  - Auto (first available secure store)
  - macOS Keychain
  - `~/.box/credentials`
  - Session-only (do not persist)

Examples:

```bash
# macOS Keychain (store once)
security add-generic-password -a "$USER" -s nitpick_upstash_box_api_key -w "<YOUR_UPSTASH_BOX_API_KEY>" -U

# 1Password (in .env)
NITPICK_BOX_OP_REF=op://Dev/Nitpick/UPSTASH_BOX_API_KEY

# Credentials file location override (optional)
NITPICK_BOX_CREDENTIALS_FILE=~/.box/credentials

# Custom command (in .env)
NITPICK_BOX_API_KEY_COMMAND='security find-generic-password -a "$USER" -s nitpick_upstash_box_api_key -w'
```

Security model:
- All Box git operations use `GITHUB_READ_TOKEN` only.
- The only write path to GitHub is PR review/comment posting via `GITHUB_REVIEW_TOKEN`.
- No git push/branch/commit operations are performed by this tool.

Install as executable:

```bash
pnpm pack
pnpm add -g ./nitpick-*.tgz
nitpick --help
```

This installs a real global package copy, so `nitpick` keeps working even if you delete this repo folder later.

If you hit issues after updating, do a clean reinstall:

```bash
pnpm remove -g nitpick
rm -f nitpick-*.tgz
pnpm pack
pnpm add -g ./nitpick-*.tgz
hash -r
nitpick --help
```

Development-only alternative:

```bash
pnpm link --global
```

`pnpm link --global` is a symlink to your local repo and will break if the repo is moved/deleted.

Uninstall:

```bash
# Remove global install (tarball/registry install)
pnpm remove -g nitpick
```

If you installed with `pnpm link --global`, unlink it too:

```bash
pnpm unlink --global nitpick
```

## Usage

### Which mode do I want?

| Use case | Command shape |
| --- | --- |
| Browse repos and pick a PR by hand | `nitpick` |
| Review a specific PR, human triage | `nitpick review <pr-url>` |
| Review a PR, skip triage, post comments | `nitpick review <pr-url> --auto --post-review` |
| Review a branch without opening a PR | `nitpick review --repo org/repo --base main --head feature` |
| CI gate (fail job on blockers) | `nitpick review <pr-url> --auto --non-interactive --exit-on blockers` |
| Coding agent fix loop | `nitpick review --repo org/repo --base main --head feature --auto --non-interactive --json - --exit-on blockers` |

### Interactive mode

Run without arguments to browse repos and PRs interactively:

```bash
nitpick
```

This walks you through:

1. **Select a repository** (searchable list of all repos your token can access)
2. **Select a pull request** (open PRs in that repo)
3. **Select reviewer roles** (multi-select, all checked by default)
4. **Configure reviewers** (model and prompt per role — defaults are one Enter away)
5. AI reviewers + scanners run in parallel with live output
6. **PR summary** displays overview and hotspot files
7. **Triage findings** (accept/dismiss each one)
8. Verdict, markdown report, and optional GitHub PR review

### Direct mode

Pass a PR URL directly:

```bash
nitpick review https://github.com/org/repo/pull/42
```

### Ref mode (no PR required)

Review the diff between two git refs without needing an open pull request:

```bash
nitpick review --repo org/repo --base main --head feature-branch --auto --json -
```

Both refs must exist on GitHub (branches, tags, or commit SHAs). This is the mode to use from CI or an autonomous agent loop, since it requires no PR and no human triage.

### Options

| Flag | Description |
| --- | --- |
| `<github-pr-url>` | Positional — review a pull request |
| `--repo <owner/name>` | Repository for ref mode |
| `--base <ref>` | Base ref (branch, tag, or SHA) for ref mode |
| `--head <ref>` | Head ref for ref mode |
| `--roles <roles>` | Comma-separated reviewer roles (default: all) |
| `--output <file>` | Output markdown report path (default: `pr-review-<number>.md`) |
| `--no-report` | Skip writing markdown report to local file |
| `--auto` | Skip interactive triage — accept all findings automatically |
| `--post-review` | Post verdict and inline comments as a GitHub PR review (PR mode only) |
| `--json <file\|->` | Write structured JSON report to file, or `-` for stdout |
| `--exit-on <mode>` | Non-zero exit when: `none` (default), `findings`, `blockers`, `changes-requested` |
| `--non-interactive` | Fail fast on missing credentials, never prompt, never enter interactive picker |
| `--help` | Show help |

Note: when `--post-review` is enabled, Nitpick can still post a review body even if there are zero final findings (for example, after verification/triage). `--post-review` is ignored in ref mode.

### Exit codes

| Exit code | Meaning |
| --- | --- |
| `0` | Success (or `--exit-on none`, default) |
| `1` | Fatal error (invalid flags, missing credentials in non-interactive mode, etc.) |
| `2` | `--exit-on` condition matched (findings/blockers/changes requested) |
| `130` | Interrupted with Ctrl+C |

### JSON output shape

Stable top-level fields emitted by `--json`:

```json
{
  "version": 1,
  "sessionId": "...",
  "mode": "pr",
  "repo": { "owner": "org", "name": "repo" },
  "pr": { "number": 42, "url": "...", "title": "...", "author": "..." },
  "refs": null,
  "baseSha": "...",
  "headSha": "...",
  "roles": ["security", "performance", "architecture", "testing", "dx"],
  "status": "completed",
  "summary": { "overview": "...", "keyChanges": [], "hotspotFiles": [] },
  "findings": [],
  "acceptedFindings": [],
  "dismissedFindings": [],
  "rejectedFindings": [],
  "verdict": {
    "riskScore": 0,
    "mergeRecommendation": "approve",
    "blockers": [],
    "improvements": [],
    "summary": "...",
    "suggestedCommits": []
  },
  "stats": {
    "findingsTotal": 0,
    "findingsAccepted": 0,
    "findingsDismissed": 0,
    "findingsRejected": 0,
    "blockers": 0,
    "improvements": 0,
    "riskScore": 0,
    "mergeRecommendation": "approve"
  },
  "hadReviewerFailures": false,
  "interrupted": false,
  "reviewUrl": null,
  "exitCode": 0,
  "createdAt": "..."
}
```

In ref mode `pr` is `null` and `refs` contains `{ "base": "...", "head": "..." }`.

### Examples

```bash
# Interactive — browse repos and PRs
nitpick

# Review a specific PR with all roles
nitpick review https://github.com/org/repo/pull/42

# Only security and performance, skip triage
nitpick review https://github.com/org/repo/pull/42 --roles security,performance --auto

# Custom output path
nitpick review https://github.com/org/repo/pull/42 --output report.md

# Run without writing a local markdown report
nitpick review https://github.com/org/repo/pull/42 --no-report

# Post review to GitHub
nitpick review https://github.com/org/repo/pull/42 --auto --post-review

# Agent/CI run: ref mode, JSON to stdout, non-zero exit when blockers exist
nitpick review --repo org/repo --base main --head feature \
  --auto --non-interactive --json - --exit-on blockers
```

## Agentic workflow

Nitpick is designed to be called from another AI agent (Claude Code, an autonomous SWE bot, a CI job that wraps an LLM, etc.). The building blocks:

- **Ref mode** (`--repo --base --head`) — no PR needed, just two refs on GitHub
- **`--auto`** — no human triage, all verified findings are accepted
- **`--non-interactive`** — fails fast if credentials or target are missing; never prompts
- **`--json -`** — structured output to stdout for the calling agent to parse
- **`--exit-on blockers`** (or `changes-requested`) — exit code 2 signals "not done yet"
- **`--no-report`** — don't litter the working tree with markdown files

The canonical agent invocation:

```bash
nitpick review \
  --repo org/repo \
  --base main \
  --head $(git rev-parse --abbrev-ref HEAD) \
  --auto --non-interactive --no-report \
  --json - --exit-on blockers
```

Exit code `0` → no blockers, ship it. Exit code `2` → blockers exist, read JSON, fix, push, rerun.

### Parsing the result

The JSON report has a small, stable `stats` block the caller can key off without parsing every finding:

```json
{
  "exitCode": 2,
  "stats": {
    "findingsTotal": 5,
    "findingsAccepted": 5,
    "blockers": 2,
    "riskScore": 68,
    "mergeRecommendation": "request_changes"
  }
}
```

The `acceptedFindings` array contains the full findings (with `severity`, `filePath`, `lineStart`, `title`, `description`, `recommendation`) — these are the instructions the calling agent should act on. `verdict.suggestedCommits` is a list of small scoped commit messages the verdict agent suggests to land the fixes.

### Prompts

Copy any of these into a coding agent (Claude Code, an SDK-based agent, a PR bot). They assume the agent can run shell commands and edit files, and that the nitpick CLI is already installed and authenticated.

#### Prompt: one-shot review

```
You have nitpick installed. Review the changes on the current branch against main:

  nitpick review --repo <owner>/<repo> --base main --head <current-branch> \
    --auto --non-interactive --no-report --json -

Read the resulting JSON from stdout. Summarise for me:
- the merge recommendation (verdict.mergeRecommendation)
- any blockers (verdict.blockers) with file:line and a one-sentence explanation
- the risk score

Do not modify any files. Just report what nitpick found.
```

#### Prompt: fix-until-clean loop

```
You are a coding agent working on branch <branch>. Use nitpick as a gate.

Loop, at most 5 iterations:
  1. Push the current branch: `git push origin <branch>`
  2. Run:
        nitpick review --repo <owner>/<repo> --base main --head <branch> \
          --auto --non-interactive --no-report --json - --exit-on blockers
  3. Capture the JSON from stdout and inspect:
       - exit code 0 → you are done, stop the loop and report success
       - exit code 2 → read verdict.blockers; for each blocker, edit the
         file at filePath:lineStart and apply the recommendation
  4. Stage and commit the fixes with a short message referencing the
     blocker titles. Go back to step 1.

Rules:
- Never force-push, rebase shared history, or delete branches.
- If the same blocker title appears in two consecutive iterations with no
  change in file/line, stop looping and surface it to me — you are stuck.
- After the final successful run, print the JSON `stats` block and the
  risk score.
- If exit code is neither 0 nor 2 (e.g. 1 for a fatal error), stop and
  surface the stderr output.
```

#### Prompt: pre-PR polish

```
Before I open a PR for branch <branch>, run nitpick against main in ref
mode and fix anything it flags as a blocker or high-severity finding.

  nitpick review --repo <owner>/<repo> --base main --head <branch> \
    --auto --non-interactive --no-report --json -

For each item in `acceptedFindings` where severity is "critical" or "high",
apply the recommendation. Ignore "medium"/"low"/"info" unless it is also a
blocker in verdict.blockers.

Commit each group of related fixes together with messages from
verdict.suggestedCommits when applicable. Stop after one pass — do not
loop. Then push and open the PR.
```

#### Prompt: CI reviewer bot

```
You run on every PR push via CI. For PR <pr-url>:

  nitpick review <pr-url> --auto --non-interactive --post-review \
    --json - --exit-on changes-requested

- Exit 0: job passes. Post nothing else.
- Exit 2: job fails. The review is already posted via --post-review.
  Additionally, print the JSON `verdict.summary` and the top 3 blockers
  (title + file:line) to the CI logs.
- Any other exit: job fails with the stderr output. Do not retry.

Do not comment on the PR from this job unless nitpick itself posted — the
GitHub review is the single source of truth.
```

### Safety rails

Things nitpick intentionally does **not** do, so the calling agent should not rely on them:

- No `git push`, `git commit`, branch creation, or history rewrites — all write-paths to the repo are the caller's responsibility.
- No network calls beyond the GitHub API (read-only) and Upstash Box (sandbox).
- No persistence of findings between runs — each invocation is stateless. If the agent needs to detect "the same blocker keeps coming back," it must compare across invocations itself.

## Configuration

Create a `.nitpick.yaml` in your repository root to set defaults:

```yaml
# Default reviewer roles
roles:
  - security
  - performance
  - architecture

# Default model for all reviewers
model: Sonnet_4_6

# Skip triage
auto: false

# Write markdown report to local file
report: true

# Post review to GitHub
postReview: false

# Generate PR summary
summary: true

# Emit JSON report (true/false for stdout, or a file path)
# json: report.json

# Exit code policy: none | findings | blockers | changes-requested
exitOn: none

# Never prompt or enter interactive mode (agents/CI)
nonInteractive: false

# Per-reviewer overrides
reviewers:
  security:
    model: Opus_4_6
  dx:
    promptOverride: "Focus only on naming and readability."

# Scanner configuration
scanners:
  secrets: true
  linter:
    enabled: true
    commands:
      - npm run lint
  dependencies: true
```

CLI flags always override `.nitpick.yaml` values.

## Scanners

### Secret detection

Scans added lines in the PR diff for common secret patterns:
- AWS keys, GitHub tokens, Slack tokens, Stripe keys, Google API keys
- Private keys (RSA, SSH, PGP, EC)
- Database connection strings with credentials
- Generic password/secret/token assignments
- JWT tokens, Bearer tokens, Basic auth

Runs locally — no Box or API calls needed.

### Dependency vulnerability scanning

Parses lockfile diffs (package-lock.json, requirements.txt, go.sum, Gemfile.lock) for newly added dependencies and queries [OSV.dev](https://osv.dev) for known vulnerabilities. Supports npm, PyPI, Go, and RubyGems ecosystems.

### Linter integration

Auto-detects the project's linter (ESLint, pylint, golangci-lint, etc.) or uses commands from `.nitpick.yaml`. Runs inside an Upstash Box sandbox and reports issues on changed files.

## Available models

Interactive model choices are populated from the installed `@upstash/box` SDK at runtime.

- ClaudeCode models are available for reviewers.
- OpenAI Codex models may also be available depending on SDK version.
- Verifier defaults to a different model family than reviewers when possible.

## Contributor scripts

Scripts for working on the nitpick codebase itself (not needed if you only want to use the installed `nitpick` command):

| Script | Description |
| --- | --- |
| `pnpm start` | Launch interactive mode |
| `pnpm review` | Run CLI review (pass `<url>` and flags) |
| `pnpm lint` | Run ESLint on `src/` |
| `pnpm typecheck` | Run TypeScript type checker (`tsc --noEmit`) |

## How it works

1. Each AI reviewer role gets its own [Upstash Box](https://upstash.com/docs/box) — an isolated sandbox with the repo cloned and the PR checked out
2. Scanners (secrets, dependencies, linter) run in parallel with AI reviewers
3. A PR summary is generated using a lightweight AI model
4. Role-specific AI agents analyze the diff and return structured findings with severity, confidence, file locations, and recommendations
5. A verifier agent re-checks findings and can reject or adjust them
6. Findings from all sources are deduplicated
7. You triage findings interactively (or skip with `--auto`)
8. A verdict is computed from accepted findings: risk score, merge recommendation (approve / request changes / needs discussion), blockers, and suggested fix commits
9. Results are printed to the terminal and written as a markdown report
10. Optionally, the verdict and inline comments are posted as a GitHub PR review

## Token Permissions

Recommended fine-grained PAT setup:

- `GITHUB_READ_TOKEN`:
  - Repository access to target repo(s)
  - `Contents: Read`
  - `Pull requests: Read`
- `GITHUB_REVIEW_TOKEN` (only if using `--post-review`):
  - Repository access to target repo(s)
  - `Pull requests: Write`
