# Security Policy

## Supported versions

Only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's [private vulnerability reporting](https://github.com/ilterkavlak/nitpick/security/advisories/new). Do not open a public issue.

Include what you found, how to reproduce it, and the impact you expect. You should get an initial response within 7 days.

## Scope

Nitpick passes untrusted pull request content to LLM agents running in Upstash Box sandboxes. Reports are especially welcome for:

- GitHub tokens, the Box API key or other credentials reaching a sandbox, logs, reports or posted reviews
- Pull request content (code, titles, prompt injections) that can run code on, or write files to, the machine running Nitpick
- Terminal escape-sequence injection through rendered output
- Ways to make Nitpick post to GitHub, or exit successfully as a CI gate, when it should not

The [security model](README.md#security-model) in the README describes the intended trust boundaries and the known residual risks.
