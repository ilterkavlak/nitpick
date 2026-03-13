import { generateId } from "../utils";
import type { Finding, Severity } from "../types";

interface OsvVulnerability {
  id: string;
  summary?: string;
  details?: string;
  severity?: Array<{ type: string; score: string }>;
  references?: Array<{ type: string; url: string }>;
  affected?: Array<{
    package?: { name: string; ecosystem: string };
    ranges?: Array<{ events: Array<{ introduced?: string; fixed?: string }> }>;
  }>;
}

interface OsvQueryResponse {
  vulns?: OsvVulnerability[];
}

interface ParsedDep {
  name: string;
  version: string;
  ecosystem: string;
  filePath: string;
  lineStart: number;
}

function parseLockfileDiff(diff: string): ParsedDep[] {
  const deps: ParsedDep[] = [];
  let currentFile = "";
  let lineNumber = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      lineNumber = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1);

      // package-lock.json: "name": "version"
      if (currentFile.includes("package-lock.json") || currentFile.includes("npm-shrinkwrap.json")) {
        const npmMatch = content.match(/"resolved":\s*"https:\/\/registry\.npmjs\.org\/([^/]+)\/-\/\1-(\d[^"]+)\.tgz"/);
        const versionMatch = content.match(/"version":\s*"(\d[^"]+)"/);
        if (npmMatch) {
          deps.push({ name: npmMatch[1], version: npmMatch[2], ecosystem: "npm", filePath: currentFile, lineStart: lineNumber });
        } else if (versionMatch) {
          // Try to get package name from context (simplified)
          const nameLineMatch = content.match(/"([^"]+)":\s*\{/);
          if (nameLineMatch) {
            deps.push({ name: nameLineMatch[1], version: versionMatch[1], ecosystem: "npm", filePath: currentFile, lineStart: lineNumber });
          }
        }
      }

      // package.json: "package": "^version"
      if (currentFile.endsWith("package.json")) {
        const pkgMatch = content.match(/"([^"@]+)":\s*"[\^~>=]*(\d[^"]+)"/);
        if (pkgMatch && !pkgMatch[1].startsWith("@")) {
          deps.push({ name: pkgMatch[1], version: pkgMatch[2], ecosystem: "npm", filePath: currentFile, lineStart: lineNumber });
        }
        // Scoped packages
        const scopedMatch = content.match(/"(@[^"]+)":\s*"[\^~>=]*(\d[^"]+)"/);
        if (scopedMatch) {
          deps.push({ name: scopedMatch[1], version: scopedMatch[2], ecosystem: "npm", filePath: currentFile, lineStart: lineNumber });
        }
      }

      // requirements.txt / Pipfile
      if (currentFile.includes("requirements") && currentFile.endsWith(".txt")) {
        const pyMatch = content.match(/^([a-zA-Z0-9_-]+)==(\d[^\s;#]+)/);
        if (pyMatch) {
          deps.push({ name: pyMatch[1], version: pyMatch[2], ecosystem: "PyPI", filePath: currentFile, lineStart: lineNumber });
        }
      }

      // go.sum
      if (currentFile.endsWith("go.sum")) {
        const goMatch = content.match(/^([^\s]+)\s+v(\d[^\s/]+)/);
        if (goMatch) {
          deps.push({ name: goMatch[1], version: goMatch[2], ecosystem: "Go", filePath: currentFile, lineStart: lineNumber });
        }
      }

      // Gemfile.lock
      if (currentFile.endsWith("Gemfile.lock")) {
        const gemMatch = content.match(/^\s+([a-zA-Z0-9_-]+)\s+\((\d[^)]+)\)/);
        if (gemMatch) {
          deps.push({ name: gemMatch[1], version: gemMatch[2], ecosystem: "RubyGems", filePath: currentFile, lineStart: lineNumber });
        }
      }

      lineNumber++;
    } else if (!line.startsWith("-")) {
      lineNumber++;
    }
  }

  // Deduplicate by name+version
  const seen = new Set<string>();
  return deps.filter((d) => {
    const key = `${d.ecosystem}:${d.name}@${d.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cvssToSeverity(score: number): Severity {
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  if (score > 0) return "low";
  return "info";
}

function extractSeverity(vuln: OsvVulnerability): Severity {
  if (vuln.severity) {
    for (const s of vuln.severity) {
      if (s.type === "CVSS_V3" || s.type === "CVSS_V4") {
        const score = parseFloat(s.score);
        if (!isNaN(score)) return cvssToSeverity(score);
      }
    }
  }
  // Default to high if severity info is missing
  return "high";
}

async function queryOsv(dep: ParsedDep): Promise<OsvVulnerability[]> {
  try {
    const res = await fetch("https://api.osv.dev/v1/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        package: { name: dep.name, ecosystem: dep.ecosystem },
        version: dep.version,
      }),
    });

    if (!res.ok) return [];

    const data = (await res.json()) as OsvQueryResponse;
    return data.vulns ?? [];
  } catch {
    return [];
  }
}

export async function scanDependencies(arenaId: string, diff: string): Promise<Finding[]> {
  const deps = parseLockfileDiff(diff);

  if (deps.length === 0) return [];

  // Query OSV.dev in parallel (batch of 5 to avoid rate limits)
  const findings: Finding[] = [];
  const batchSize = 5;

  for (let i = 0; i < deps.length; i += batchSize) {
    const batch = deps.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (dep) => ({ dep, vulns: await queryOsv(dep) })));

    for (const { dep, vulns } of results) {
      for (const vuln of vulns) {
        const severity = extractSeverity(vuln);
        const refUrl = vuln.references?.find((r) => r.type === "ADVISORY")?.url
          ?? vuln.references?.[0]?.url;
        const fixedVersion = vuln.affected?.[0]?.ranges?.[0]?.events?.find((e) => e.fixed)?.fixed;

        findings.push({
          id: generateId(),
          arenaId,
          reviewerRole: "dependencies",
          severity,
          category: "dependency-vulnerability",
          title: `${vuln.id}: ${dep.name}@${dep.version}`,
          description: vuln.summary ?? vuln.details?.slice(0, 200) ?? `Known vulnerability in ${dep.name}@${dep.version}`,
          filePath: dep.filePath,
          lineStart: dep.lineStart,
          evidence: refUrl ? `Reference: ${refUrl}` : undefined,
          recommendation: fixedVersion
            ? `Upgrade ${dep.name} to version ${fixedVersion} or later.`
            : `Check ${vuln.id} for remediation guidance. Consider removing or replacing this dependency.`,
          confidence: 0.95,
          dedupeKey: `dependency-vulnerability|${dep.filePath}|${dep.lineStart}|${vuln.id.toLowerCase().slice(0, 40)}`,
        });
      }
    }
  }

  return findings;
}
