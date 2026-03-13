import { execFileSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { password, select } from "@inquirer/prompts";

let ghCliTokenCache: string | null | undefined;
let boxApiKeyCache: string | null | undefined;

const DEFAULT_BOX_KEYCHAIN_SERVICE = "nitpik_upstash_box_api_key";
const DEFAULT_BOX_CREDENTIALS_PATH = join(homedir(), ".box", "credentials");

function getGhCliToken(): string | undefined {
  if (ghCliTokenCache !== undefined) {
    return ghCliTokenCache ?? undefined;
  }

  try {
    const raw = execFileSync("gh", ["auth", "token"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const token = raw.trim();
    ghCliTokenCache = token.length > 0 ? token : null;
    return ghCliTokenCache ?? undefined;
  } catch {
    ghCliTokenCache = null;
    return undefined;
  }
}

function runCommand(command: string, args: string[]): string | undefined {
  try {
    const raw = execFileSync(command, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const out = raw.trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function setBoxApiKeyForSession(key: string): string {
  boxApiKeyCache = key;
  process.env.UPSTASH_BOX_API_KEY = key;
  return key;
}

function getBoxApiKeyFromCommand(): string | undefined {
  const cmd = process.env.NITPIK_BOX_API_KEY_COMMAND;
  if (!cmd || cmd.trim().length === 0) return undefined;

  // Execute through sh -c so users can pass a simple one-liner command.
  return runCommand("sh", ["-c", cmd]);
}

function getBoxApiKeyFromKeychain(): string | undefined {
  const service = process.env.NITPIK_BOX_KEYCHAIN_SERVICE || DEFAULT_BOX_KEYCHAIN_SERVICE;
  return runCommand("security", [
    "find-generic-password",
    "-a",
    process.env.USER || "",
    "-s",
    service,
    "-w",
  ]);
}

function getBoxApiKeyFrom1Password(): string | undefined {
  const ref = process.env.NITPIK_BOX_OP_REF;
  if (!ref || ref.trim().length === 0) return undefined;
  return runCommand("op", ["read", ref]);
}

function getBoxCredentialsPath(): string {
  return process.env.NITPIK_BOX_CREDENTIALS_FILE?.trim() || DEFAULT_BOX_CREDENTIALS_PATH;
}

function getBoxApiKeyFromCredentialsFile(): string | undefined {
  const path = getBoxCredentialsPath();
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf-8");
    const m = raw.match(/^\s*api_key\s*=\s*(.+)\s*$/m);
    if (!m) return undefined;
    const value = m[1].trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function saveBoxApiKeyToKeychain(key: string): boolean {
  const service = process.env.NITPIK_BOX_KEYCHAIN_SERVICE || DEFAULT_BOX_KEYCHAIN_SERVICE;
  try {
    execFileSync("security", [
      "add-generic-password",
      "-a",
      process.env.USER || "",
      "-s",
      service,
      "-w",
      key,
      "-U",
    ]);
    return true;
  } catch {
    return false;
  }
}

function saveBoxApiKeyToCredentialsFile(key: string): boolean {
  const path = getBoxCredentialsPath();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

    const content = existsSync(path)
      ? readFileSync(path, "utf-8")
      : "[default]\n";
    const withKey = /^\s*api_key\s*=.*$/m.test(content)
      ? content.replace(/^\s*api_key\s*=.*$/m, `api_key=${key}`)
      : `${content}${content.endsWith("\n") ? "" : "\n"}api_key=${key}\n`;

    writeFileSync(path, withKey, { mode: 0o600 });
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

function autoPersistBoxApiKey(key: string): string | null {
  if (process.platform === "darwin" && saveBoxApiKeyToKeychain(key)) {
    return `macOS Keychain (${process.env.NITPIK_BOX_KEYCHAIN_SERVICE || DEFAULT_BOX_KEYCHAIN_SERVICE})`;
  }
  if (saveBoxApiKeyToCredentialsFile(key)) {
    return getBoxCredentialsPath();
  }
  return null;
}

export function getGitReadToken(): string | undefined {
  const token = process.env.GITHUB_READ_TOKEN;
  if (token && token.trim().length > 0) return token;
  return getGhCliToken();
}

export function getGitReviewToken(): string | undefined {
  const token = process.env.GITHUB_REVIEW_TOKEN;
  if (token && token.trim().length > 0) return token;
  return getGhCliToken();
}

export function getBoxApiKey(): string | undefined {
  if (boxApiKeyCache !== undefined) {
    return boxApiKeyCache ?? undefined;
  }

  const envKey = process.env.UPSTASH_BOX_API_KEY;
  if (envKey && envKey.trim().length > 0) {
    return setBoxApiKeyForSession(envKey);
  }

  const fromCredentials = getBoxApiKeyFromCredentialsFile();
  if (fromCredentials) {
    return setBoxApiKeyForSession(fromCredentials);
  }

  const fromKeychain = getBoxApiKeyFromKeychain();
  if (fromKeychain) {
    return setBoxApiKeyForSession(fromKeychain);
  }

  const from1Password = getBoxApiKeyFrom1Password();
  if (from1Password) {
    return setBoxApiKeyForSession(from1Password);
  }

  const fromCommand = getBoxApiKeyFromCommand();
  if (fromCommand) {
    return setBoxApiKeyForSession(fromCommand);
  }

  boxApiKeyCache = null;
  return undefined;
}

export function requireGitReadToken(): string {
  const token = getGitReadToken();
  if (!token) {
    throw new Error(
      "GITHUB_READ_TOKEN is not set and GH CLI token is unavailable (run `gh auth login`)"
    );
  }
  return token;
}

export function requireGitReviewToken(): string {
  const token = getGitReviewToken();
  if (!token) {
    throw new Error(
      "GITHUB_REVIEW_TOKEN is not set and GH CLI token is unavailable (run `gh auth login`)"
    );
  }
  return token;
}

export function requireBoxApiKey(): string {
  const key = getBoxApiKey();
  if (!key) {
    throw new Error(
      "Upstash Box API key not found. Set UPSTASH_BOX_API_KEY, use ~/.box/credentials, or configure keychain/1Password/command fallback."
    );
  }
  return key;
}

export async function ensureBoxApiKeyInteractive(): Promise<string> {
  const existing = getBoxApiKey();
  if (existing) return existing;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Upstash Box API key not found and interactive setup is unavailable in non-TTY mode."
    );
  }

  const key = (await password({
    message: "Enter Upstash Box API key",
    mask: "*",
    validate: (v) =>
      v.trim().length > 0 ? true : "API key cannot be empty",
  })).trim();

  const choice = await select<"auto" | "keychain" | "credentials" | "session">({
    message: "Where should Nitpik store this key?",
    default: "auto",
    choices: [
      {
        name: "Auto (recommended) - first available secure store",
        value: "auto",
      },
      ...(process.platform === "darwin"
        ? [{ name: "macOS Keychain", value: "keychain" as const }]
        : []),
      {
        name: `Credentials file (${getBoxCredentialsPath()})`,
        value: "credentials",
      },
      { name: "Session only (do not persist)", value: "session" },
    ],
  });

  let stored = false;
  let location = "session only";

  if (choice === "auto") {
    const where = autoPersistBoxApiKey(key);
    stored = where !== null;
    if (where) location = where;
  } else if (choice === "keychain") {
    stored = saveBoxApiKeyToKeychain(key);
    location = `macOS Keychain (${process.env.NITPIK_BOX_KEYCHAIN_SERVICE || DEFAULT_BOX_KEYCHAIN_SERVICE})`;
  } else if (choice === "credentials") {
    stored = saveBoxApiKeyToCredentialsFile(key);
    location = getBoxCredentialsPath();
  }

  if ((choice === "auto" || choice === "keychain" || choice === "credentials") && !stored) {
    console.warn("Could not persist key to selected store. Using session-only.");
  } else if (stored) {
    console.log(`Saved Box API key to ${location}.`);
  }

  return setBoxApiKeyForSession(key);
}
