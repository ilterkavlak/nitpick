// Minimal markdown → ANSI renderer scoped to the output shape that
// generateMarkdownReport produces. Handles: ATX headings (# .. ###),
// **bold**, *italic*, `inline code`, fenced ```code blocks```, GFM tables,
// horizontal rules, lists, and inline [text](url) links.

const E = "\x1b";
const R = `${E}[0m`;
const B = `${E}[1m`;
const D = `${E}[2m`;
const ITALIC = `${E}[3m`;
const UNDERLINE = `${E}[4m`;

const C = (n: number) => `${E}[38;5;${n}m`;
const BRAND = C(75);
const ACCENT = C(114);
const MUTED = C(240);
const CODE = C(208);

const STRIP_ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(STRIP_ANSI_RE, "");
}

function visualWidth(s: string): number {
  return stripAnsi(s).length;
}

function pad(s: string, width: number): string {
  const gap = width - visualWidth(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

/** Apply inline transforms to a single line of prose.
 *  Order is load-bearing: we must extract constructs with bracket/backtick
 *  syntax BEFORE injecting any ANSI, because `\x1b[1m...` contains a literal
 *  `[` that would otherwise confuse the link regex into matching across the
 *  ANSI sequence. Flow: replace code spans and links with sentinels first,
 *  then run bold/italic on the ANSI-free intermediate, then reinstate the
 *  sentineled constructs with their ANSI wrappers. */
function renderInline(input: string): string {
  const placeholders: string[] = [];
  const placehold = (rendered: string): string => {
    placeholders.push(rendered);
    return `\x00${placeholders.length - 1}\x00`;
  };

  // 1. Inline code `...`
  let s = input.replace(/`([^`]+)`/g, (_, code: string) =>
    placehold(`${CODE}${code}${R}`)
  );

  // 2. Links [text](url). Skip images ![text](url) so the leading '!' stays.
  s = s.replace(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, url: string) =>
    placehold(`${UNDERLINE}${text}${R} ${MUTED}(${url})${R}`)
  );

  // 3. Bold before italic so `**x**` isn't matched as two italic spans.
  s = s.replace(/\*\*([^*]+)\*\*/g, `${B}$1${R}`);
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, `$1${ITALIC}$2${R}`);

  // 4. Reinstate the sentineled constructs.
  s = s.replace(/\x00(\d+)\x00/g, (_, idx: string) => placeholders[Number(idx)]);
  return s;
}

function renderHr(): string {
  return `${MUTED}${"─".repeat(60)}${R}`;
}

function renderHeading(level: number, text: string): string {
  const rendered = renderInline(text);
  switch (level) {
    case 1:
      return `\n${BRAND}${B}${rendered}${R}\n${MUTED}${"═".repeat(Math.min(60, visualWidth(rendered)))}${R}`;
    case 2:
      return `\n${ACCENT}${B}${rendered}${R}\n${MUTED}${"─".repeat(Math.min(60, visualWidth(rendered)))}${R}`;
    default:
      return `\n${B}${rendered}${R}`;
  }
}

/** GFM table parser. Expects rows like `| a | b |` with a `| --- | --- |`
 *  separator row. Returns rendered block and consumed row count. */
function tryRenderTable(lines: string[], start: number): { block: string; consumed: number } | null {
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  if (!isRow(lines[start])) return null;
  if (start + 1 >= lines.length || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[start + 1])) return null;

  const parseRow = (row: string) =>
    row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  const header = parseRow(lines[start]);
  const body: string[][] = [];
  let i = start + 2;
  for (; i < lines.length && isRow(lines[i]); i++) {
    body.push(parseRow(lines[i]));
  }

  const colCount = Math.max(header.length, ...body.map((r) => r.length));
  const rendered = [header, ...body].map((row) =>
    Array.from({ length: colCount }, (_, c) => renderInline(row[c] ?? ""))
  );
  const widths = Array.from({ length: colCount }, (_, c) =>
    Math.max(...rendered.map((r) => visualWidth(r[c])))
  );

  const sep = `${MUTED}${widths.map((w) => "─".repeat(w + 2)).join("┼")}${R}`;
  const fmtRow = (row: string[]) =>
    row.map((cell, c) => ` ${pad(cell, widths[c])} `).join(`${MUTED}│${R}`);

  const out: string[] = [];
  out.push(fmtRow(rendered[0].map((c) => `${B}${c}${R}`)));
  out.push(sep);
  for (const r of rendered.slice(1)) out.push(fmtRow(r));

  return { block: out.join("\n"), consumed: i - start };
}

export function renderMarkdownToTerminal(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inCodeFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^```/.test(line)) {
      inCodeFence = !inCodeFence;
      out.push(`${MUTED}${"─".repeat(40)}${R}`);
      continue;
    }

    if (inCodeFence) {
      out.push(`  ${CODE}${line}${R}`);
      continue;
    }

    // Horizontal rule
    if (/^-{3,}\s*$/.test(line)) {
      out.push(renderHr());
      continue;
    }

    // Headings
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      out.push(renderHeading(heading[1].length, heading[2]));
      continue;
    }

    // Tables — need at least header + separator + one row of context
    const table = tryRenderTable(lines, i);
    if (table) {
      out.push(table.block);
      i += table.consumed - 1;
      continue;
    }

    // Bullets
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      out.push(`${bullet[1]}${ACCENT}•${R} ${renderInline(bullet[2])}`);
      continue;
    }

    if (line.trim() === "") {
      out.push("");
      continue;
    }

    out.push(renderInline(line));
  }

  return out.join("\n");
}
