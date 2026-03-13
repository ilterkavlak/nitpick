import type { ArenaEventEnvelope, Severity } from "../lib/types";

// ── ANSI ───────────────────────────────────────────────────────────
const ESC = "\x1b";
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const CLR = `${ESC}[2J`;
const HOME = `${ESC}[H`;
const R = `${ESC}[0m`;
const B = `${ESC}[1m`;
const D = `${ESC}[2m`;
const ITALIC = `${ESC}[3m`;
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const BLUE = `${ESC}[34m`;
const MAGENTA = `${ESC}[35m`;
const CYAN = `${ESC}[36m`;
const WHITE = `${ESC}[37m`;
const GRAY = `${ESC}[90m`;
const BR_RED = `${ESC}[91m`;
const BR_WHITE = `${ESC}[97m`;

// 256-color accents
const C = (n: number) => `${ESC}[38;5;${n}m`;
const BG = (n: number) => `${ESC}[48;5;${n}m`;

const BRAND = C(75);     // soft blue
const ACCENT = C(114);   // sage green
const WARN = C(208);     // orange
const ERR = C(203);      // coral
const MUTED = C(240);    // mid gray
const FAINT = C(236);    // dark gray

// ── Spinner (only shown when active) ──────────────────────────────
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ── Role theming ───────────────────────────────────────────────────
const RCOL: Record<string, string> = {
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

const RTAG: Record<string, string> = {
  security: "SEC",
  performance: "PRF",
  architecture: "ARC",
  testing: "TST",
  dx: "DX ",
  secrets: "KEY",
  linter: "LNT",
  dependencies: "DEP",
  verifier: "VRF",
};

const SEV_PILL: Record<Severity, string> = {
  critical: `${BG(196)}${BR_WHITE}${B} CRT ${R}`,
  high: `${BG(202)}${BR_WHITE}${B} HGH ${R}`,
  medium: `${BG(220)}${ESC}[30m${B} MED ${R}`,
  low: `${BG(39)}${BR_WHITE}${B} LOW ${R}`,
  info: `${BG(240)}${WHITE} INF ${R}`,
};

// ── Box art — computer inside a product box ───────────────────────
//    12 printable chars wide, 4 lines
//
//     ┏━━━━━━━━┓
//     ┃ ┌SCRN┐ ┃      SCRN = 4-char screen area
//     ┃ └─══─┘ ┃      ══ = monitor stand
//     ┗━━━━━━━━┛

const BOX_TOP = " ┏━━━━━━━━┓ ";
const BOX_SCR = " ┃ ┌SCRN┐ ┃ ";
const BOX_BAS = " ┃ └─══─┘ ┃ ";
const BOX_BOT = " ┗━━━━━━━━┛ ";

// Screen animation frames — a pulse sliding across (only when active)
const SCREEN_STREAM = ["▓░░░", "░▓░░", "░░▓░", "░░░▓"];

function screenContent(w: Worker, frame: number): string {
  switch (w.status) {
    case "queued":
      return `${FAINT}····${R}`;
    case "completed":
      return `${ACCENT} ✓  ${R}`;
    case "failed":
      return `${ERR} ✗  ${R}`;
    case "running": {
      const age = w.lastActivity ? Date.now() - w.lastActivity : Infinity;
      if (age < 3000) {
        // Active — green animated pulse
        return `${GREEN}${SCREEN_STREAM[frame % SCREEN_STREAM.length]}${R}`;
      }
      // Idle — dim static
      return `${FAINT}░░░░${R}`;
    }
  }
}

function boxArt(w: Worker, frame: number): string[] {
  const scr = screenContent(w, frame);
  return [
    BOX_TOP,
    BOX_SCR.replace("SCRN", scr),
    BOX_BAS,
    BOX_BOT,
  ];
}

// ── Types ──────────────────────────────────────────────────────────
type WS = "queued" | "running" | "completed" | "failed";

interface Worker {
  role: string;
  status: WS;
  findings: number;
  lastActivity?: number;
  startedAt?: number;
  finishedAt?: number;
}

interface FE {
  sev: Severity;
  role: string;
  title: string;
  loc: string;
  ts: number;
}

interface State {
  title: string;
  workers: Map<string, Worker>;
  feed: FE[];
  t0: number;
  frame: number;
  timer: ReturnType<typeof setInterval> | null;
  lastWidth: number;
  lastHeight: number;
}

let S: State | null = null;

// ── Layout constants ───────────────────────────────────────────────
const CW = 20;            // card inner width
const CO = CW + 2;        // card outer width (with │ borders)
const GAP = 2;

// ── Helpers ────────────────────────────────────────────────────────
function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function vlen(s: string): number {
  return strip(s).length;
}

function pr(s: string, w: number): string {
  const g = w - vlen(s);
  return g > 0 ? s + " ".repeat(g) : s;
}

function cen(s: string, w: number): string {
  const v = vlen(s);
  if (v >= w) return s;
  const l = Math.floor((w - v) / 2);
  return " ".repeat(l) + s + " ".repeat(w - v - l);
}

function clock(): string {
  if (!S) return "00:00";
  const sec = Math.floor((Date.now() - S.t0) / 1000);
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

// ── Progress bar ───────────────────────────────────────────────────
function progressBar(done: number, total: number, width: number): string {
  if (total === 0) return "";
  const pct = done / total;
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const bar = `${ACCENT}${"▓".repeat(filled)}${FAINT}${"░".repeat(empty)}${R}`;
  const label = `${D}${done}/${total} done${R}`;
  return `${bar} ${label}`;
}

// ── Card rendering ─────────────────────────────────────────────────
function cardTop(role: string): string {
  const col = RCOL[role] ?? GRAY;
  const tag = RTAG[role] ?? role.slice(0, 3).toUpperCase();
  const label = ` ${tag} ${role} `;
  const fill = CW - label.length;
  const l = Math.floor(fill / 2);
  const r = fill - l;
  return `${MUTED}╭${"─".repeat(l)}${R}${col}${B}${label}${R}${MUTED}${"─".repeat(r)}╮${R}`;
}

function cardBot(): string {
  return `${MUTED}╰${"─".repeat(CW)}╯${R}`;
}

function cline(content: string): string {
  return `${MUTED}│${R}${pr(content, CW)}${MUTED}│${R}`;
}

function workerElapsed(w: Worker): string {
  if (!w.startedAt) return "";
  const end = w.finishedAt ?? Date.now();
  const sec = Math.floor((end - w.startedAt) / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

function statusText(w: Worker, frame: number): string {
  const elapsed = workerElapsed(w);
  switch (w.status) {
    case "queued":
      return `${MUTED} ○  Waiting       ${R}`;
    case "running": {
      // Spinner only moves when there's actual activity
      const age = w.lastActivity ? Date.now() - w.lastActivity : Infinity;
      const t = elapsed ? ` ${MUTED}${elapsed}${R}` : "";
      if (age < 3000) {
        const sp = SPIN[frame % SPIN.length];
        return `${BRAND} ${sp}  ${ITALIC}Working${R}${t}    `;
      }
      return `${MUTED} ○  ${ITALIC}Thinking${R}${t}   `;
    }
    case "completed": {
      const t = elapsed ? ` ${MUTED}${elapsed}${R}` : "";
      return `${ACCENT} ✓  Done${R}${t}        `;
    }
    case "failed": {
      const t = elapsed ? ` ${MUTED}${elapsed}${R}` : "";
      return `${ERR} ✗  Failed${R}${t}      `;
    }
  }
}

function statsText(w: Worker): string {
  if (w.status === "queued") return `${MUTED}       ─          ${R}`;
  if (w.findings === 0) return `${ACCENT} ○  0 findings    ${R}`;
  const n = w.findings;
  const word = n === 1 ? "finding " : "findings";
  const col = n >= 3 ? WARN : YELLOW;
  return `${col} ●  ${n} ${word}    ${R}`;
}

function card(w: Worker, frame: number): string[] {
  const artLines = boxArt(w, frame);

  return [
    cardTop(w.role),
    cline(statusText(w, frame)),
    ...artLines.map((l) => cline(cen(l, CW))),
    cline(statsText(w)),
    cardBot(),
  ];
}

// ── Merge cards side-by-side ───────────────────────────────────────
function merge(cards: string[][], gap: number): string[] {
  const h = Math.max(...cards.map((c) => c.length));
  const blank = " ".repeat(CO);
  const sp = " ".repeat(gap);
  const out: string[] = [];
  for (let r = 0; r < h; r++) {
    out.push(cards.map((c) => c[r] ?? blank).join(sp));
  }
  return out;
}

// ── Render ─────────────────────────────────────────────────────────
function render(): void {
  if (!S) return;

  const tw = process.stdout.columns || 80;
  const th = process.stdout.rows || 40;
  const resized = tw !== S.lastWidth || th !== S.lastHeight;
  if (resized) {
    S.lastWidth = tw;
    S.lastHeight = th;
  }
  const time = clock();
  const buf: string[] = [];

  // ── Header ─────────────────────────────────────────────────────
  const logo = `${BRAND}${B}  🔎  Nitpick${R}`;
  const sub = `${MUTED}${S.title}${R}`;
  const hPad = Math.max(1, tw - vlen(logo) - vlen(sub) - time.length - 6);
  buf.push("");
  buf.push(`${logo}  ${sub}${" ".repeat(hPad)}${D}${time}${R}`);

  // ── Progress bar ───────────────────────────────────────────────
  const workers = Array.from(S.workers.values());
  const done = workers.filter((w) => w.status === "completed" || w.status === "failed").length;
  const barW = Math.max(8, Math.min(tw - 16, 50));
  buf.push(`  ${progressBar(done, workers.length, barW)}`);
  buf.push("");

  // ── Worker grid ────────────────────────────────────────────────
  const perRow = Math.max(1, Math.floor((tw + GAP) / (CO + GAP)));

  for (let i = 0; i < workers.length; i += perRow) {
    const row = workers.slice(i, i + perRow);
    const cards = row.map((w) => card(w, S!.frame));
    const merged = merge(cards, GAP);
    const rowW = vlen(merged[0] ?? "");
    const lp = Math.max(0, Math.floor((tw - rowW) / 2));
    const px = " ".repeat(lp);
    for (const line of merged) buf.push(px + line);
    buf.push("");
  }

  // ── Separator ──────────────────────────────────────────────────
  buf.push(`  ${MUTED}${"─".repeat(Math.max(1, tw - 4))}${R}`);
  buf.push(`  ${B}Recent findings${R}`);
  buf.push("");

  // ── Feed ───────────────────────────────────────────────────────
  const used = buf.length + 2;
  const maxF = Math.max(2, th - used - 1);
  const shown = S.feed.slice(-maxF);

  if (shown.length === 0) {
    buf.push(`  ${MUTED}${ITALIC}  Waiting for findings…${R}`);
  } else {
    for (const f of shown) {
      const pill = SEV_PILL[f.sev] ?? f.sev;
      const rc = RCOL[f.role] ?? GRAY;
      const ago = timeSince(f.ts, S.t0);
      const loc = f.loc ? ` ${MUTED}${f.loc}${R}` : "";
      const title = f.title.length > tw - 45
        ? f.title.slice(0, tw - 48) + "…"
        : f.title;
      buf.push(
        `  ${MUTED}${ago}${R}  ${pill} ${rc}${RTAG[f.role] ?? f.role}${R} ${title}${loc}`
      );
    }
  }

  // fill so old content is overwritten
  while (buf.length < th - 1) buf.push("");

  // ── Footer ─────────────────────────────────────────────────────
  const total = workers.reduce((s, w) => s + w.findings, 0);
  const foot = `  ${MUTED}${total} finding(s) so far  ·  Ctrl+C to cancel${R}`;
  buf.push(foot + " ".repeat(Math.max(0, tw - vlen(foot))));

  const prefix = resized ? `${CLR}${HOME}` : HOME;
  process.stdout.write(prefix + buf.join("\n"));
}

function timeSince(ts: number, t0: number): string {
  const sec = Math.floor((ts - t0) / 1000);
  if (sec < 60) return `${String(sec).padStart(3)}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}`;
}

// ── Public API ─────────────────────────────────────────────────────

export function startDashboard(title: string, roles: string[]): void {
  S = {
    title,
    workers: new Map(),
    feed: [],
    t0: Date.now(),
    frame: 0,
    timer: null,
    lastWidth: process.stdout.columns || 80,
    lastHeight: process.stdout.rows || 40,
  };

  for (const role of roles) {
    S.workers.set(role, { role, status: "queued", findings: 0 });
  }

  process.stdout.write(HIDE + CLR);
  render();

  S.timer = setInterval(() => {
    if (!S) return;
    S.frame++;
    render();
  }, 120); // fast spinner

  process.stdout.on("resize", render);
}

/** Add a worker card to the dashboard dynamically (e.g. verifier after review phase) */
export function addWorkerToBoard(role: string): void {
  if (!S) return;
  if (!S.workers.has(role)) {
    S.workers.set(role, { role, status: "queued", findings: 0 });
    render();
  }
}

export function updateWorkerStatus(
  role: string,
  newStatus: "queued" | "running" | "completed" | "failed"
): void {
  const w = S?.workers.get(role);
  if (w) {
    if (newStatus === "running" && !w.startedAt) {
      w.startedAt = Date.now();
    }
    if ((newStatus === "completed" || newStatus === "failed") && !w.finishedAt) {
      w.finishedAt = Date.now();
    }
    w.status = newStatus;
    render();
  }
}

export function pingWorkerActivity(role: string): void {
  const w = S?.workers.get(role);
  if (w) {
    w.lastActivity = Date.now();
  }
}

export function handleDashboardEvent(
  _arenaId: string,
  envelope: ArenaEventEnvelope
): void {
  if (!S) return;

  const { event } = envelope;

  switch (event.type) {
    case "reviewer_status": {
      const w = S.workers.get(event.role);
      if (w) {
        if (event.status === "running") {
          w.status = "running";
          if (!w.startedAt) w.startedAt = Date.now();
        } else if (event.status === "completed") {
          w.status = "completed";
          if (!w.finishedAt) w.finishedAt = Date.now();
        } else if (event.status === "failed" || event.status === "cancelled") {
          w.status = "failed";
          if (!w.finishedAt) w.finishedAt = Date.now();
        }
      }
      break;
    }

    case "finding_upsert": {
      const f = event.finding;
      const w = S.workers.get(f.reviewerRole);
      if (w) w.findings++;

      S.feed.push({
        sev: f.severity,
        role: f.reviewerRole,
        title: f.title,
        loc: f.filePath
          ? `${f.filePath}${f.lineStart ? `:${f.lineStart}` : ""}`
          : "",
        ts: Date.now(),
      });
      break;
    }

    case "reviewer_finish": {
      const w = S.workers.get(event.role);
      if (w) {
        w.status = "completed";
        if (!w.finishedAt) w.finishedAt = Date.now();
      }
      break;
    }

    case "scanner_finish": {
      const w = S.workers.get(event.role);
      if (w) {
        w.status = "completed";
        w.findings = event.findingCount;
        if (!w.finishedAt) w.finishedAt = Date.now();
      }
      break;
    }

    default:
      break;
  }

  render();
}

export interface DashboardSummary {
  text: string;
  workerTimes: { role: string; elapsed: string; findings: number; status: WS }[];
  totalTime: string;
}

export function stopDashboard(): DashboardSummary {
  if (!S) return { text: "", workerTimes: [], totalTime: "00:00" };

  if (S.timer) {
    clearInterval(S.timer);
    S.timer = null;
  }

  process.stdout.removeListener("resize", render);

  const workers = Array.from(S.workers.values());
  const total = workers.reduce((s, w) => s + w.findings, 0);
  const done = workers.filter((w) => w.status === "completed").length;
  const failed = workers.filter((w) => w.status === "failed").length;
  const time = clock();

  let text = `${done}/${workers.length} completed`;
  if (failed > 0) text += `, ${failed} failed`;
  text = `Review finished — ${text} — ${total} finding(s) in ${time}`;

  const workerTimes = workers.map((w) => ({
    role: w.role,
    elapsed: workerElapsed(w),
    findings: w.findings,
    status: w.status,
  }));

  S = null;
  process.stdout.write(SHOW + CLR + HOME);

  return { text, workerTimes, totalTime: time };
}
