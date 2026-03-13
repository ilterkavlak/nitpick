import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import type { NitpikConfig, ReviewerRole, ReviewerConfig } from "./types";

const ALL_ROLES: ReviewerRole[] = ["security", "performance", "architecture", "testing", "dx"];

function isValidRole(r: string): r is ReviewerRole {
  return ALL_ROLES.includes(r as ReviewerRole);
}

export function loadConfig(dir?: string): NitpikConfig {
  const searchDir = dir ?? process.cwd();
  const filePath = resolve(searchDir, ".nitpik.yaml");

  if (!existsSync(filePath)) {
    // Also check .nitpik.yml
    const altPath = resolve(searchDir, ".nitpik.yml");
    if (existsSync(altPath)) return parseConfigFile(altPath);

    // Backward compatibility with old Gavel config names
    const legacyYaml = resolve(searchDir, ".gavel.yaml");
    if (existsSync(legacyYaml)) return parseConfigFile(legacyYaml);
    const legacyYml = resolve(searchDir, ".gavel.yml");
    if (existsSync(legacyYml)) return parseConfigFile(legacyYml);
    return {};
  }

  return parseConfigFile(filePath);
}

function parseConfigFile(filePath: string): NitpikConfig {
  const content = readFileSync(filePath, "utf-8");
  const raw = parseYaml(content);

  if (!raw || typeof raw !== "object") return {};

  const config: NitpikConfig = {};

  if (Array.isArray(raw.roles)) {
    config.roles = raw.roles.filter(isValidRole);
  }

  if (typeof raw.model === "string") {
    config.model = raw.model;
  }

  if (typeof raw.auto === "boolean") {
    config.auto = raw.auto;
  }

  if (typeof raw.report === "boolean") {
    config.report = raw.report;
  }

  if (typeof raw.output === "string") {
    config.output = raw.output;
  }

  if (typeof raw.postReview === "boolean") {
    config.postReview = raw.postReview;
  }

  if (typeof raw.summary === "boolean") {
    config.summary = raw.summary;
  }

  if (raw.reviewers && typeof raw.reviewers === "object") {
    config.reviewers = {};
    for (const [role, cfg] of Object.entries(raw.reviewers)) {
      if (!isValidRole(role) || !cfg || typeof cfg !== "object") continue;
      const rc: ReviewerConfig = {};
      const c = cfg as Record<string, unknown>;
      if (typeof c.model === "string") rc.model = c.model;
      if (typeof c.promptOverride === "string") rc.promptOverride = c.promptOverride;
      if (rc.model || rc.promptOverride) config.reviewers[role] = rc;
    }
  }

  if (raw.scanners && typeof raw.scanners === "object") {
    config.scanners = {};
    const s = raw.scanners as Record<string, unknown>;

    for (const key of ["secrets", "linter", "dependencies"] as const) {
      const val = s[key];
      if (typeof val === "boolean") {
        config.scanners[key] = val;
      } else if (val && typeof val === "object") {
        const obj = val as Record<string, unknown>;
        const sc: { enabled: boolean; commands?: string[] } = {
          enabled: obj.enabled !== false,
        };
        if (Array.isArray(obj.commands)) {
          sc.commands = obj.commands.filter((c): c is string => typeof c === "string");
        }
        config.scanners[key] = sc;
      }
    }
  }

  return config;
}

export interface MergedOptions {
  roles: ReviewerRole[];
  writeReport: boolean;
  outputPath: string | undefined;
  auto: boolean;
  postReview: boolean;
  summary: boolean;
  reviewerConfigs: Record<string, ReviewerConfig>;
  scanners: {
    secrets: boolean;
    linter: boolean | { enabled: boolean; commands?: string[] };
    dependencies: boolean;
  };
}

export function mergeConfigWithFlags(
  config: NitpikConfig,
  flags: {
    roles?: string[];
    writeReport?: boolean;
    outputPath?: string;
    auto?: boolean;
    postReview?: boolean;
    summary?: boolean;
    scanners?: { secrets: boolean; linter: boolean; dependencies: boolean };
    reviewerConfigs?: Record<string, ReviewerConfig>;
  }
): MergedOptions {
  // CLI/interactive flags override config file
  const roles: ReviewerRole[] = flags.roles
    ? flags.roles.filter(isValidRole)
    : config.roles ?? ALL_ROLES;

  const writeReport = flags.writeReport ?? config.report ?? true;
  const outputPath = flags.outputPath ?? config.output;
  const auto = flags.auto ?? config.auto ?? false;
  const postReview = flags.postReview ?? config.postReview ?? false;
  const summary = flags.summary ?? (config.summary !== false); // default true

  // Merge reviewer configs: config file as base, CLI flags override
  const reviewerConfigs: Record<string, ReviewerConfig> = {};

  // Apply global model from config as base
  if (config.model) {
    for (const role of roles) {
      reviewerConfigs[role] = { model: config.model };
    }
  }

  // Apply per-reviewer config from config file
  if (config.reviewers) {
    for (const [role, rc] of Object.entries(config.reviewers)) {
      reviewerConfigs[role] = { ...reviewerConfigs[role], ...rc };
    }
  }

  // Apply CLI-provided reviewer configs (override everything)
  if (flags.reviewerConfigs) {
    for (const [role, rc] of Object.entries(flags.reviewerConfigs)) {
      reviewerConfigs[role] = { ...reviewerConfigs[role], ...rc };
    }
  }

  // Scanners: interactive/flag overrides take precedence, then config, then default (all on)
  const scanners = {
    secrets: flags.scanners !== undefined
      ? flags.scanners.secrets
      : resolveScannerEnabled(config.scanners?.secrets, true),
    linter: flags.scanners !== undefined
      ? flags.scanners.linter
      : resolveScannerConfig(config.scanners?.linter, true),
    dependencies: flags.scanners !== undefined
      ? flags.scanners.dependencies
      : resolveScannerEnabled(config.scanners?.dependencies, true),
  };

  return {
    roles,
    writeReport,
    outputPath,
    auto,
    postReview,
    summary,
    reviewerConfigs,
    scanners,
  };
}

function resolveScannerEnabled(
  val: boolean | { enabled: boolean } | undefined,
  defaultVal: boolean
): boolean {
  if (val === undefined) return defaultVal;
  if (typeof val === "boolean") return val;
  return val.enabled;
}

function resolveScannerConfig(
  val: boolean | { enabled: boolean; commands?: string[] } | undefined,
  defaultVal: boolean
): boolean | { enabled: boolean; commands?: string[] } {
  if (val === undefined) return defaultVal;
  return val;
}
