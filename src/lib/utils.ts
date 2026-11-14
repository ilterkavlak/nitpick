import { nanoid } from "nanoid";

export function generateId(): string {
  return nanoid(12);
}

// C0/C1 control characters except tab and newline. Untrusted text (PR
// metadata, LLM output, diff content) must not carry terminal escape sequences.
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function stripControlChars(s: string): string {
  return s.replace(CONTROL_CHARS_RE, "");
}

export function parsePrUrl(url: string): {
  owner: string;
  repo: string;
  prNumber: number;
} | null {
  const match = url.match(
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/
  );
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    prNumber: parseInt(match[3], 10),
  };
}
