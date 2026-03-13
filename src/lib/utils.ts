import { nanoid } from "nanoid";

export function generateId(): string {
  return nanoid(12);
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
