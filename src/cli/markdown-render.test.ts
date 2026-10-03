import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownToTerminal } from "./markdown-render";

const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const RESET = "\x1b[0m";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Inline transforms ────────────────────────────────────────────────

test("renders ATX headings without leaving # markers in the output", () => {
  const out = renderMarkdownToTerminal("# Top\n## Section\n### Subsection");
  assert.doesNotMatch(stripAnsi(out), /^#+\s/m, "raw '# ' markers must be replaced");
  assert.match(stripAnsi(out), /Top/);
  assert.match(stripAnsi(out), /Section/);
  assert.match(stripAnsi(out), /Subsection/);
});

test("**bold** becomes an ANSI bold sequence and the asterisks are gone", () => {
  const out = renderMarkdownToTerminal("hello **world** today");
  assert.ok(out.includes(`${BOLD}world${RESET}`), `expected bold 'world', got: ${out}`);
  assert.equal(stripAnsi(out), "hello world today");
});

test("*italic* becomes an ANSI italic sequence and the asterisks are gone", () => {
  const out = renderMarkdownToTerminal("hello *world* today");
  assert.ok(out.includes(`${ITALIC}world${RESET}`), `expected italic 'world', got: ${out}`);
  assert.equal(stripAnsi(out), "hello world today");
});

test("**bold** is not parsed as two italic spans", () => {
  // If the italic regex runs before bold, `**foo**` becomes `*<i>foo</i>*`.
  const out = renderMarkdownToTerminal("**tight**");
  assert.ok(out.includes(`${BOLD}tight${RESET}`));
  assert.doesNotMatch(stripAnsi(out), /\*/);
});

test("inline `code` is rendered without backticks", () => {
  const out = renderMarkdownToTerminal("run `npm test` now");
  assert.doesNotMatch(stripAnsi(out), /`/, "backticks must not appear in visible output");
  assert.match(stripAnsi(out), /npm test/);
});

test("**bold** inside `code` is left literal", () => {
  // Code spans should protect their content from bold/italic parsing.
  const out = renderMarkdownToTerminal("literal `**not bold**` marker");
  assert.match(stripAnsi(out), /\*\*not bold\*\*/);
});

test("[text](url) renders text underlined with dimmed url, no brackets", () => {
  const out = renderMarkdownToTerminal("see [the docs](https://example.com)");
  assert.ok(out.includes(`${UNDERLINE}the docs${RESET}`));
  assert.match(stripAnsi(out), /\(https:\/\/example\.com\)/);
  assert.doesNotMatch(stripAnsi(out), /\[the docs\]/);
});

test("bold immediately followed by a link both render correctly", () => {
  // Regression: the link regex used to run AFTER bold injected a literal
  // '[' into the string (as part of `\x1b[1m`), so `[text](url)` after a
  // `**bold**` section would match across the ANSI and garble both. The
  // fix is to sentinel-extract links before bold runs.
  const out = renderMarkdownToTerminal("**PR:** [#42](https://example.com/42)");
  const plain = stripAnsi(out);
  assert.equal(plain, "PR: #42 (https://example.com/42)");
  assert.ok(out.includes(`${BOLD}PR:${RESET}`), `'PR:' must stay bolded, got: ${JSON.stringify(out)}`);
  assert.ok(out.includes(`${UNDERLINE}#42${RESET}`), `'#42' must stay underlined, got: ${JSON.stringify(out)}`);
});

test("images ![alt](url) are not turned into clickable links", () => {
  // The `!` before `[alt](url)` is the markdown image marker. We don't
  // render images — but we must not swallow the '!' either.
  const out = renderMarkdownToTerminal("![logo](https://x/y.png)");
  const plain = stripAnsi(out);
  assert.match(plain, /^!/);
});

// ── Block constructs ─────────────────────────────────────────────────

test("horizontal rule produces a divider, not the literal dashes", () => {
  const out = renderMarkdownToTerminal("above\n---\nbelow");
  const plain = stripAnsi(out);
  assert.doesNotMatch(plain, /^---$/m, "literal '---' must not survive");
  assert.match(plain, /above/);
  assert.match(plain, /below/);
});

test("fenced code blocks preserve content verbatim and suppress inline parsing", () => {
  const md = "before\n```\nconst x = **not bold**;\n```\nafter";
  const out = renderMarkdownToTerminal(md);
  const plain = stripAnsi(out);
  // The code line still contains its raw characters — no markdown parsing inside.
  assert.match(plain, /const x = \*\*not bold\*\*;/);
  // And the fence delimiters themselves don't leak.
  assert.doesNotMatch(plain, /^```/m);
});

test("bullet lines turn into bullets without the '- ' marker", () => {
  const out = renderMarkdownToTerminal("- first\n- second");
  const plain = stripAnsi(out);
  assert.doesNotMatch(plain, /^-\s/m, "raw '- ' must be replaced by a bullet glyph");
  assert.match(plain, /first/);
  assert.match(plain, /second/);
});

test("nested bullets preserve their indentation", () => {
  const out = renderMarkdownToTerminal("- top\n  - nested");
  const plain = stripAnsi(out);
  assert.match(plain, /^  •\s+nested/m, "nested bullet keeps two-space indent");
});

test("GFM tables render cells without leaving raw pipes and ignore the '---' separator row", () => {
  const md = "| Metric | Value |\n| --- | --- |\n| Risk Score | 42/100 |\n| Recommendation | approve |";
  const out = renderMarkdownToTerminal(md);
  const plain = stripAnsi(out);
  assert.match(plain, /Metric/);
  assert.match(plain, /42\/100/);
  assert.match(plain, /approve/);
  // The separator row should not appear literally with dashes between pipes.
  assert.doesNotMatch(plain, /\|\s*---\s*\|/);
});

// ── End-to-end shape on a realistic report ───────────────────────────

test("end-to-end: a full generated report has no leftover markdown syntax", () => {
  const md = [
    "# PR Review: Fix login",
    "",
    "**PR:** [#42](https://github.com/x/y/pull/42)",
    "**Author:** alice",
    "",
    "## Verdict",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    "| Risk Score | **30/100** |",
    "| Recommendation | **approve** |",
    "",
    "## Blockers",
    "",
    "### 🔴 SQL injection",
    "",
    "Use parameterized queries.",
    "",
    "**File:** `src/db.ts:42`",
    "",
    "```",
    "db.query('SELECT * FROM u WHERE id=' + id)",
    "```",
    "",
    "**Recommendation:** switch to prepared statements",
    "",
    "---",
    "*Generated by Nitpick*",
    "",
  ].join("\n");

  const out = renderMarkdownToTerminal(md);
  const plain = stripAnsi(out);

  // The interesting content is all still there.
  for (const needle of [
    "PR Review: Fix login",
    "alice",
    "Verdict",
    "30/100",
    "SQL injection",
    "parameterized queries",
    "switch to prepared statements",
    "Generated by Nitpick",
  ]) {
    assert.match(plain, new RegExp(needle.replace(/[()]/g, "\\$&")), `expected '${needle}' in output`);
  }

  // None of the raw markdown block markers survived.
  assert.doesNotMatch(plain, /^#+\s/m, "no raw heading markers");
  assert.doesNotMatch(plain, /^---$/m, "no raw hr markers");
  assert.doesNotMatch(plain, /^```/m, "no raw fence markers");
  // Bold markers ** must not survive the bold transform.
  assert.doesNotMatch(plain, /\*\*/);
});
