/**
 * Claude Code-style status output for every action in the review flow.
 *
 * Usage:
 *   const done = status.start("Fetching PR metadata");
 *   const meta = await fetchPrMetadata(...);
 *   done("PR Title by @author (12 files, +340/-120)");
 *
 * Or for instant actions:
 *   status.ok("Environment validated");
 *   status.warn("GITHUB_REVIEW_TOKEN has limited scopes");
 *   status.fail("Missing UPSTASH_BOX_API_KEY");
 */

const E = "\x1b";
const R = `${E}[0m`;
const B = `${E}[1m`;
const D = `${E}[2m`;

const BRAND = `${E}[38;5;75m`;
const ACCENT = `${E}[38;5;114m`;
const WARN_C = `${E}[33m`;
const ERR_C = `${E}[31m`;
const MUTED = `${E}[38;5;240m`;

const OK = `${ACCENT}✓${R}`;
const SPIN = `${BRAND}●${R}`;
const WARN_ICON = `${WARN_C}⚠${R}`;
const FAIL_ICON = `${ERR_C}✗${R}`;

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 1) return `${ms}ms`;
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

/**
 * Start a long-running action. Returns a `done(detail?)` callback.
 * While running, prints a "●" spinner line.
 * When done, replaces it with a "✓" line including elapsed time.
 */
function start(message: string): (detail?: string) => void {
  const t0 = Date.now();
  process.stdout.write(`  ${SPIN}  ${message}…`);
  return (detail?: string) => {
    const elapsed = formatElapsed(Date.now() - t0);
    const suffix = detail ? `  ${D}${detail}${R}` : "";
    const time = `  ${MUTED}${elapsed}${R}`;
    process.stdout.write(`\r  ${OK}  ${message}${suffix}${time}\n`);
  };
}

/** Instant success line */
function ok(message: string, detail?: string): void {
  const suffix = detail ? `  ${D}${detail}${R}` : "";
  console.log(`  ${OK}  ${message}${suffix}`);
}

/** Warning line */
function warn(message: string): void {
  console.log(`  ${WARN_ICON}  ${message}`);
}

/** Failure line */
function fail(message: string): void {
  console.log(`  ${FAIL_ICON}  ${message}`);
}

/** Section header (like Claude Code's bold action group) */
function header(title: string): void {
  console.log("");
  console.log(`  ${BRAND}${B}${title}${R}`);
  console.log(`  ${MUTED}${"─".repeat(50)}${R}`);
}

/** Blank separator */
function gap(): void {
  console.log("");
}

export const status = { start, ok, warn, fail, header, gap };
