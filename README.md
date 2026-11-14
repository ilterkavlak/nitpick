<div align="center">

# 🔎 Nitpick

**Parallel AI code review for GitHub pull requests, run in isolated sandboxes.**

[![CI](https://github.com/ilterkavlak/nitpick/actions/workflows/lint-main.yml/badge.svg)](https://github.com/ilterkavlak/nitpick/actions/workflows/lint-main.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

</div>

Nitpick runs several specialized AI reviewers (security, performance, architecture, testing, developer experience) and automated scanners against a pull request or a git ref range at the same time. A separate verifier agent then checks every finding against the code. You triage what remains, and Nitpick produces a risk score, a merge recommendation, a markdown report and, if you ask for it, a GitHub PR review with inline comments.

Every AI agent runs in its own [Upstash Box](https://upstash.com/docs/box): a disposable, isolated sandbox. Repository code never runs on your machine.

> [!NOTE]
> **Honest disclosure: this project was vibe coded.** Most of the code was written with AI coding assistants under human direction and review. It has a test suite, CI checks, pinned dependencies and a documented [security model](#security-model), but it is young software. Read the security model before pointing it at private code, and give it least-privilege tokens.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Installation](#installation)
- [Authentication](#authentication)
- [Usage](#usage)
- [Configuration](#configuration)
- [Models](#models)
- [Scanners](#scanners)
- [Using Nitpick from AI agents and CI](#using-nitpick-from-ai-agents-and-ci)
- [How it works](#how-it-works)
- [Security model](#security-model)
- [Development](#development)
- [Known limitations](#known-limitations)
- [Contributing](#contributing) · [Security policy](#reporting-a-vulnerability) · [License](#license)

## Features

| | |
| --- | --- |
| **5 AI reviewer roles** | `security`, `performance`, `architecture`, `testing`, `dx`, in any combination, in parallel |
| **3 scanners** | `secrets` (regex, local), `dependencies` ([OSV.dev](https://osv.dev)), `linter` (runs in a sandbox) |
| **Verification stage** | A verifier on a different model family confirms, adjusts, deduplicates or rejects findings |
| **PR summary** | Overview, key changes and hotspot files before you read the findings |
| **Triage** | Accept or dismiss each finding before the verdict is computed (or `--auto`) |
| **Verdict** | Risk score (0–100), merge recommendation, blockers, suggested commits |
| **GitHub review** | Optional review with inline comments (`--post-review`) |
| **Three modes** | Interactive picker, direct PR URL, or ref range (`--repo --base --head`) without a PR |
| **Automation-friendly** | `--json` output with a stable schema, `--exit-on` gates, `--non-interactive` |
| **Per-reviewer config** | Model and prompt override per role via flags, interactive setup or `.nitpick.yaml` |

## Quick start

```bash
git clone https://github.com/ilterkavlak/nitpick.git && cd nitpick
pnpm install
export UPSTASH_BOX_API_KEY=...        # https://console.upstash.com
pnpm start                            # interactive: pick a repo and a PR
```

Or review a specific public pull request without triage:

```bash
pnpm review https://github.com/org/repo/pull/42 --auto
```

## Installation

**Requirements:** Node.js ≥ 22, [pnpm](https://pnpm.io) 10 (pinned via `packageManager`), an [Upstash Box](https://upstash.com/docs/box) API key with agent access, and optionally the [GitHub CLI](https://cli.github.com).

Install as a global command from a local checkout:

```bash
pnpm install
pnpm pack
pnpm add -g "$PWD"/nitpick-*.tgz
nitpick --help
```

`pnpm add -g` resolves relative paths against pnpm's global directory, so the tarball path must be absolute. The installed copy keeps working if you delete the checkout.

<details>
<summary>Reinstall, link for development, uninstall</summary>

```bash
# Clean reinstall after updating
pnpm remove -g nitpick      # also `npm uninstall -g nitpick` if installed with npm
rm -f nitpick-*.tgz && pnpm pack && pnpm add -g "$PWD"/nitpick-*.tgz && hash -r

# Development symlink (breaks if the checkout moves)
pnpm link --global
pnpm unlink --global nitpick

# Uninstall
pnpm remove -g nitpick
```

</details>

## Authentication

Nitpick reads credentials from environment variables. It does **not** load `.env` files itself. Export them in your shell, use a tool such as [direnv](https://direnv.net), or `set -a; source .env; set +a` with a copy of [`.env.example`](.env.example).

| Variable | Required | Purpose |
| --- | --- | --- |
| `UPSTASH_BOX_API_KEY` | Yes (or a fallback below) | Creates the sandboxes and runs the AI agents |
| `GITHUB_READ_TOKEN` | For private repos | Reads PR metadata and diffs; cloned into the sandbox **only for private repositories** |
| `GITHUB_REVIEW_TOKEN` | Only with `--post-review` | Posts the review; never sent to the sandbox |

### GitHub tokens

Use **fine-grained personal access tokens** scoped to the repositories you review:

| Token | Repository permissions |
| --- | --- |
| `GITHUB_READ_TOKEN` | `Contents: Read`, `Pull requests: Read` |
| `GITHUB_REVIEW_TOKEN` | `Pull requests: Read and write` |

Public repositories can be reviewed with no GitHub token at all (GitHub's anonymous API rate limit applies).

If a variable is unset, Nitpick falls back to `gh auth token`. That token is usually broad: it covers every repository your account can reach, often with write and workflow scopes. Prefer dedicated fine-grained tokens, especially for automation.

### Upstash Box API key

Nitpick looks for the key in this order:

1. `UPSTASH_BOX_API_KEY`
2. Credentials file `~/.box/credentials` (`api_key=...`), or the path in `NITPICK_BOX_CREDENTIALS_FILE`
3. macOS Keychain, service `NITPICK_BOX_KEYCHAIN_SERVICE` (default `nitpick_upstash_box_api_key`)
4. 1Password, via `op read "$NITPICK_BOX_OP_REF"`
5. The output of `NITPICK_BOX_API_KEY_COMMAND`

When no key is found in an interactive terminal, Nitpick asks for it and offers to save it to the Keychain, the credentials file (mode `0600`) or the current session only.

```bash
# macOS Keychain (store once)
security add-generic-password -a "$USER" -s nitpick_upstash_box_api_key -w "<YOUR_UPSTASH_BOX_API_KEY>" -U

# 1Password
export NITPICK_BOX_OP_REF=op://Dev/Nitpick/UPSTASH_BOX_API_KEY
```

The Box account needs an agent LLM key: either the Upstash-managed key or a key stored in the Upstash console. Without one, every reviewer fails with `agent API key is required`.

> [!IMPORTANT]
> Use a **dedicated Box account or API key** for Nitpick. Account-level Box environment variables and global attached headers are injected into every sandbox, where repository code and agents can read or use them. Nitpick prints a warning at startup if it detects account-level environment variables.

## Usage

| Use case | Command |
| --- | --- |
| Browse repos and pick a PR | `nitpick` |
| Review a PR with human triage | `nitpick review <pr-url>` |
| Review a PR, skip triage, post a GitHub review | `nitpick review <pr-url> --auto --post-review` |
| Review a branch without a PR | `nitpick review --repo org/repo --base main --head feature` |
| CI gate that fails on blockers | `nitpick review <pr-url> --auto --non-interactive --exit-on blockers` |
| Coding-agent fix loop | `nitpick review --repo org/repo --base main --head feature --auto --non-interactive --json - --exit-on blockers` |

**Interactive mode** (`nitpick` with no arguments) walks you through seven steps: repository, pull request, reviewer roles, per-reviewer model and prompt, scanners, review options (summary, GitHub posting, report) and output path. The review then runs with a live dashboard, followed by verification, the PR summary, triage, the verdict and the report.

**Ref mode** reviews the diff between any two refs that exist on GitHub (branches, tags or SHAs). It needs no PR and no human, which makes it the mode for CI and autonomous agents.

### Options

| Flag | Description |
| --- | --- |
| `<github-pr-url>` | Review a pull request |
| `--repo <owner/name>` · `--base <ref>` · `--head <ref>` | Ref mode target |
| `--roles <roles>` | Comma-separated reviewer roles (default: all) |
| `--output <file>` | Markdown report path (default `pr-review-<number>.md` or `ref-review-<base>...<head>.md`) |
| `--no-report` | Don't write a markdown report |
| `--auto` | Skip triage and accept all verified findings |
| `--post-review` | Post the verdict and inline comments as a GitHub review (PR mode only) |
| `--json <file\|->` | Write the JSON report to a file, or `-` for stdout |
| `--exit-on <mode>` | `none` (default), `findings`, `blockers`, `changes-requested` |
| `--non-interactive` | Never prompt; fail fast on missing credentials or target |
| `--help` | Show help |

With `--post-review`, Nitpick posts a review body even when no findings remain after verification and triage.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success, or `--exit-on none` |
| `1` | Fatal error (invalid flags, missing credentials, …), or `--exit-on` is set and **every AI reviewer failed**, so the gate fails closed instead of passing an unreviewed change |
| `2` | The `--exit-on` condition matched |
| `130` | Interrupted (Ctrl+C) |
| `143` | Terminated (SIGTERM) after sandbox cleanup |

<details>
<summary>JSON output schema</summary>

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

In ref mode `pr` is `null` and `refs` is `{ "base": "...", "head": "..." }`.

</details>

## Configuration

Nitpick reads `.nitpick.yaml` (or `.nitpick.yml`) from the directory it runs in. That is the checkout root for `pnpm start` / `pnpm review`, and the package install directory for the global `nitpick` binary. CLI flags always override the file.

```yaml
roles: [security, performance, architecture]   # default reviewer roles
model: Sonnet_5_5                               # default model for all reviewers
auto: false                                     # skip triage
report: true                                    # write the markdown report
postReview: false                               # post a GitHub review
summary: true                                   # generate the PR summary
# json: report.json                             # true/false for stdout, or a file path
exitOn: none                                    # none | findings | blockers | changes-requested
nonInteractive: false                           # never prompt (agents/CI)

reviewers:                                      # per-role overrides
  security:
    model: Opus_5_5
  dx:
    promptOverride: "Focus only on naming and readability."

scanners:
  secrets: true
  dependencies: true
  linter:
    enabled: true
    commands: [npm run lint]
```

## Models

Model keys are the enum names from the installed [`@upstash/box`](https://www.npmjs.com/package/@upstash/box) SDK (`ClaudeCode` and `OpenAICodex`), so new models show up in the interactive picker as soon as the SDK is updated.

| Stage | Default | Notes |
| --- | --- | --- |
| Reviewers | `Opus_5_5` | Override globally (`model:`) or per role |
| PR summary, linter | `Haiku_5_5` | Fast, inexpensive |
| Verifier | `GPT_6_1_Sol` | Uses a different provider than the reviewers; falls back to `Opus_5_5` if the reviewers use `GPT_6_1_Sol` |

Other selectable models include `Fable_5_1`, `Sonnet_5_5` and the GPT-6 family. `Fable_5_2` arrives with `@upstash/box` 0.8.0, which the repository's 7-day minimum release age currently blocks.

## Scanners

- **Secrets.** Runs locally on the added lines of the diff. It detects AWS, GitHub, Slack, Stripe, Google, SendGrid, Twilio, npm and PyPI credentials, private key headers, credentials in database URLs, generic secret assignments, JWTs, and Bearer and Basic auth. Evidence shows only the first four characters of a match, never the source line.
- **Dependencies.** Parses added lines in `package-lock.json`, `package.json`, `requirements*.txt`, `go.sum` and `Gemfile.lock`, and queries [OSV.dev](https://osv.dev) for known vulnerabilities in npm, PyPI, Go and RubyGems packages.
- **Linter.** An agent in a sandbox detects and runs the project's linter (or the commands from `.nitpick.yaml`) on the changed files.

## Using Nitpick from AI agents and CI

Nitpick is built to be called by other agents (Claude Code, SDK-based agents, PR bots) and CI jobs. The building blocks are: ref mode (no PR needed), `--auto` (no triage), `--non-interactive` (never prompts), `--json` (machine-readable), `--exit-on` (exit code `2` means "not done yet") and `--no-report` (keeps the working tree clean).

```bash
nitpick review --repo org/repo --base main --head "$(git rev-parse --abbrev-ref HEAD)" \
  --auto --non-interactive --no-report --json nitpick.json --exit-on blockers
```

`0` means no blockers. `2` means blockers exist: read the JSON, fix, push and rerun. `1` means something failed, including every reviewer failing; surface stderr and don't retry blindly. The `stats` block (`findingsTotal`, `blockers`, `riskScore`, `mergeRecommendation`) is enough to branch on. `acceptedFindings` holds the full instructions (`severity`, `filePath`, `lineStart`, `title`, `description`, `recommendation`).

<details>
<summary>Ready-to-use prompts</summary>

**One-shot review**

```
You have nitpick installed. Review the changes on the current branch against main:

  nitpick review --repo <owner>/<repo> --base main --head <current-branch> \
    --auto --non-interactive --no-report --json nitpick.json

Read nitpick.json and summarise for me:
- the merge recommendation (verdict.mergeRecommendation)
- any blockers (verdict.blockers) with file:line and a one-sentence explanation
- the risk score

Do not modify any files. Just report what nitpick found.
```

**Fix-until-clean loop**

```
You are a coding agent working on branch <branch>. Use nitpick as a gate.

Loop, at most 5 iterations:
  1. Push the current branch: `git push origin <branch>`
  2. Run:
        nitpick review --repo <owner>/<repo> --base main --head <branch> \
          --auto --non-interactive --no-report --json nitpick.json --exit-on blockers
  3. Inspect the exit code:
       - 0 → you are done, stop the loop and report success
       - 2 → read verdict.blockers from nitpick.json; for each blocker, edit the
         file at filePath:lineStart and apply the recommendation
       - anything else → stop and surface the stderr output
  4. Commit the fixes with a short message referencing the blocker titles.
     Go back to step 1.

Rules:
- Never force-push, rebase shared history, or delete branches.
- If the same blocker appears in two consecutive iterations with no change in
  file/line, stop and surface it to me — you are stuck.
- After the final successful run, print the JSON `stats` block.
```

**Pre-PR polish**

```
Before I open a PR for branch <branch>, run nitpick against main in ref mode and
fix anything it flags as a blocker or high-severity finding.

  nitpick review --repo <owner>/<repo> --base main --head <branch> \
    --auto --non-interactive --no-report --json nitpick.json

For each item in `acceptedFindings` with severity "critical" or "high", apply the
recommendation. Ignore "medium"/"low"/"info" unless it is also in verdict.blockers.
Commit related fixes together, using verdict.suggestedCommits when applicable.
Stop after one pass, then push and open the PR.
```

**CI reviewer bot**

```
You run on every PR push via CI. For PR <pr-url>:

  nitpick review <pr-url> --auto --non-interactive --post-review \
    --json nitpick.json --exit-on changes-requested

- Exit 0: job passes. Post nothing else.
- Exit 2: job fails. The review is already posted. Print verdict.summary and the
  top 3 blockers (title + file:line) to the CI logs.
- Any other exit: job fails with the stderr output. Do not retry.
```

</details>

What Nitpick deliberately does **not** do: no `git push`, commits, branch creation or history rewrites; no state kept between runs; no network calls other than GitHub, Upstash Box and OSV.dev.

## How it works

```
                 ┌──────────── Upstash Box (one per agent) ────────────┐
 PR / ref ──▶    │ clone → checkout → diff → remove git credentials     │
 metadata        │ → agent reviews the diff → structured findings      │
                 └──────────────────────────────────────────────────────┘
   security · performance · architecture · testing · dx · linter · summary
                                   │
 secrets + dependency scanners ────┤   (run locally / via OSV.dev, in parallel)
                                   ▼
                     verifier agent (different model family)
                                   ▼
                     triage (you, or --auto) → verdict
                                   ▼
             terminal output · markdown report · JSON · GitHub review
```

1. Nitpick fetches PR or compare metadata from the GitHub API and checks whether the repository is private.
2. Each reviewer role, the linter and the summarizer get their own Box. Inside it the repository is cloned and the head is checked out, the diff and the changed-files list are written, and stored git credentials are deleted before any agent runs.
3. Agents return schema-validated findings (severity, confidence, file, line, evidence, recommendation). The local scanners run in parallel.
4. A verifier agent on a different model family re-reads the code, then confirms, adjusts, deduplicates or rejects each finding.
5. You triage. The verdict is computed from the accepted findings: a severity × confidence risk score, blockers (critical/high with ≥ 0.7 confidence) and a recommendation.
6. Every Box is deleted when its job finishes, and again on exit, Ctrl+C or SIGTERM.

## Security model

Nitpick feeds **untrusted input** (the code, text and metadata of someone else's pull request) to LLM agents. A pull request can contain prompt injections or malicious build scripts. The design assumes that can happen.

**Trust boundaries**

| Runs on | What runs there | What it can access |
| --- | --- | --- |
| Your machine | The Nitpick CLI, the secrets scanner, verdict and reporting | Your tokens; never runs repository code |
| Upstash Box (one per agent) | Agents and repository code (the linter may run `npm run lint`, etc.) | The cloned repository; **no GitHub credentials** once setup finishes |
| GitHub | Metadata and diff reads; review posting with `--post-review` | Read token; the review token only when posting |
| OSV.dev | Vulnerability lookups | Package names and versions from added dependency lines |

**Credential handling**

- **Public repositories** are cloned without any token: no GitHub credential enters the sandbox.
- **Private repositories** need the read token for the clone. Box stores it in plaintext (`~/.git-credentials`, `~/.config/gh/hosts.yml`), so Nitpick deletes both files after setup and checks they are gone. If removal fails, the review aborts before any agent or repository code runs.
- The **review token** is used only from your machine to post the review. It is never sent to a sandbox.
- The **Box API key** stays on your machine and is never injected into a sandbox. Agents use an LLM key managed by Box.

**Output handling**

- Text from pull requests and LLMs (titles, findings, summaries, verifier notes, errors) has control characters removed before it reaches your terminal, which blocks ANSI/OSC escape-sequence injection.
- Agent output is validated against a schema. Findings are posted only as review comments on the pull request under review.
- Secret-scanner evidence never includes the line that contains the secret.

**What leaves your machine**

- **To Upstash Box and the selected LLM provider:** the repository contents and diff of the PR under review, plus the prompts. Check Upstash's and your model provider's data-handling terms before reviewing proprietary code.
- **To OSV.dev:** names and versions of newly added dependencies.
- **To GitHub:** API requests, and the review when you use `--post-review`.

**Residual risks**

- Sandboxes use Box's default network policy (`allow-all`), so repository code and agents can reach the internet. They hold no credentials, and for a private repository the PR author already has read access to its code. A restrictive egress policy is planned once the agent harness's required hosts are confirmed.
- A prompt-injected agent can still write misleading findings. Verification and triage reduce this; treat findings as advice, not truth.
- Account-level Box environment variables and global attached headers reach every sandbox. Use a dedicated Box key (see [Authentication](#upstash-box-api-key)).

**Supply chain**

Dependencies are locked (`--frozen-lockfile`), lifecycle scripts are disabled (`ignore-scripts`), and pnpm refuses package versions younger than 7 days (`minimum-release-age`). CI runs lint, typecheck, tests and `pnpm audit` with Actions pinned to commit SHAs and read-only permissions.

## Development

```bash
pnpm install
pnpm start          # interactive mode
pnpm review <url>   # review from source
pnpm lint           # ESLint
pnpm typecheck      # tsc --noEmit
pnpm test           # node --test via tsx
```

The code is TypeScript (ESM), run directly with `tsx`. The main directories:

```
src/cli/     argument parsing, interactive picker, dashboard, triage, rendering, reports
src/lib/     Box sandbox lifecycle, GitHub API, auth, config, reviewer/verifier agents, scanners
bin/         the `nitpick` executable
```

## Known limitations

- `--json -` writes progress lines to stdout before the JSON document. For machine parsing, use `--json <file>`.
- The global `nitpick` binary reads `.nitpick.yaml` and writes relative report paths in its install directory, not your current directory.
- Nitpick reviews GitHub-hosted repositories only.

## Contributing

Issues and pull requests are welcome. Please run `pnpm lint && pnpm typecheck && pnpm test` before opening a PR, keep changes focused, and add a regression test for any bug you fix.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
