# Nitpik

A CLI tool that runs multiple AI reviewer roles and automated scanners against a GitHub pull request in parallel, lets you triage the findings, then generates a verdict with a merge recommendation and a markdown report.

## Features

- **Interactive mode** — browse your GitHub repos, pick a PR, select roles, configure models and prompts, all from the terminal
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
- **`.nitpik.yaml` config** — set default roles, model, scanners, and reviewer overrides per repository
- **Live terminal output** — severity-colored findings stream in as reviewers work
- **Markdown report** — summary, blockers, all findings, risk score, merge recommendation, and suggested commits

## Setup

```bash
npm install
cp .env.example .env
```

Fill in your `.env`:

| Variable | Description |
| --- | --- |
| `UPSTASH_BOX_API_KEY` | Upstash Box API key for running AI agents (optional if using keychain/1Password/command fallback) |
| `GITHUB_READ_TOKEN` | Fine-grained PAT with **read-only** repo access (optional if `gh auth token` is available) |
| `GITHUB_REVIEW_TOKEN` | Fine-grained PAT with **Pull requests: write** (optional if `gh auth token` has that scope; used for `--post-review`) |

GitHub token fallback:
- If `GITHUB_READ_TOKEN` / `GITHUB_REVIEW_TOKEN` are not set, Nitpik automatically tries `gh auth token`.
- Run `gh auth login` once to use this flow.

Box API key fallback (checked in this order):
1. `UPSTASH_BOX_API_KEY`
2. Credentials file at `~/.box/credentials` (or `NITPIK_BOX_CREDENTIALS_FILE`)
3. macOS Keychain via `NITPIK_BOX_KEYCHAIN_SERVICE` (default: `nitpik_upstash_box_api_key`)
4. 1Password via `NITPIK_BOX_OP_REF` (`op read <ref>`)
5. Custom command via `NITPIK_BOX_API_KEY_COMMAND`

First-run helper:
- If no Box key is found and you are in interactive mode, Nitpik prompts for the key and asks where to save it:
  - Auto (first available secure store)
  - macOS Keychain
  - `~/.box/credentials`
  - Session-only (do not persist)

Examples:

```bash
# macOS Keychain (store once)
security add-generic-password -a "$USER" -s nitpik_upstash_box_api_key -w "<YOUR_UPSTASH_BOX_API_KEY>" -U

# 1Password (in .env)
NITPIK_BOX_OP_REF=op://Dev/Nitpik/UPSTASH_BOX_API_KEY

# Credentials file location override (optional)
NITPIK_BOX_CREDENTIALS_FILE=~/.box/credentials

# Custom command (in .env)
NITPIK_BOX_API_KEY_COMMAND='security find-generic-password -a "$USER" -s nitpik_upstash_box_api_key -w'
```

Security model:
- All Box git operations use `GITHUB_READ_TOKEN` only.
- The only write path to GitHub is PR review/comment posting via `GITHUB_REVIEW_TOKEN`.
- No git push/branch/commit operations are performed by this tool.

Install as executable:

```bash
npm link
nitpik --help
```

Compatibility:
- Legacy `prlens` command is still available as an alias.
- Legacy `.prlens.yaml` / `.prlens.yml` and `PRLENS_*` Box env vars are still supported.

## Usage

### Interactive mode

Run without arguments to browse repos and PRs interactively:

```bash
npm start
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
npm run review -- https://github.com/org/repo/pull/42
```

### Options

| Flag | Description |
| --- | --- |
| `--roles <roles>` | Comma-separated reviewer roles (default: all) |
| `--output <file>` | Output markdown report path (default: `pr-review-<number>.md`) |
| `--no-report` | Skip writing markdown report to local file |
| `--auto` | Skip interactive triage — accept all findings automatically |
| `--post-review` | Post verdict and inline comments as a GitHub PR review |
| `--help` | Show help |

Note: when `--post-review` is enabled, Nitpik can still post a review body even if there are zero final findings (for example, after verification/triage).

### Examples

```bash
# Interactive — browse repos and PRs
npm start

# Review a specific PR with all roles
npm run review -- https://github.com/org/repo/pull/42

# Only security and performance, skip triage
npm run review -- https://github.com/org/repo/pull/42 --roles security,performance --auto

# Custom output path
npm run review -- https://github.com/org/repo/pull/42 --output report.md

# Run without writing a local markdown report
npm run review -- https://github.com/org/repo/pull/42 --no-report

# Post review to GitHub
npm run review -- https://github.com/org/repo/pull/42 --auto --post-review
```

## Configuration

Create a `.nitpik.yaml` in your repository root to set defaults:

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

CLI flags always override `.nitpik.yaml` values.

Legacy compatibility: `.gavel.yaml` and `.gavel.yml` are still supported if present.

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

Auto-detects the project's linter (ESLint, pylint, golangci-lint, etc.) or uses commands from `.nitpik.yaml`. Runs inside an Upstash Box sandbox and reports issues on changed files.

## Available models

Interactive model choices are populated from the installed `@upstash/box` SDK at runtime.

- ClaudeCode models are available for reviewers.
- OpenAI Codex models may also be available depending on SDK version.
- Verifier defaults to a different model family than reviewers when possible.

## Scripts

| Script | Description |
| --- | --- |
| `npm start` | Launch interactive mode |
| `npm run review` | Run CLI review (pass `-- <url>` and flags) |
| `npm run lint` | Run ESLint on `src/` |

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
