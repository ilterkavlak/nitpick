import { generateId } from "@/lib/utils";
import type { Finding, AnyRole, Severity } from "@/lib/types";

const findings = new Map<string, Finding[]>();

interface RawFinding {
  severity: Severity;
  category: string;
  title: string;
  description: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  evidence?: string;
  recommendation: string;
  confidence: number;
}

export function buildDedupeKey(f: RawFinding): string {
  const parts = [
    f.category,
    f.filePath ?? "",
    f.lineStart?.toString() ?? "",
    f.title.toLowerCase().slice(0, 40),
  ];
  return parts.join("|");
}

export function normalizeFinding(
  arenaId: string,
  role: AnyRole,
  raw: RawFinding
): Finding {
  return {
    id: generateId(),
    arenaId,
    reviewerRole: role,
    severity: raw.severity,
    category: raw.category,
    title: raw.title,
    description: raw.description,
    filePath: raw.filePath,
    lineStart: raw.lineStart,
    lineEnd: raw.lineEnd,
    evidence: raw.evidence,
    recommendation: raw.recommendation,
    confidence: raw.confidence,
    dedupeKey: buildDedupeKey(raw),
  };
}

export async function saveFinding(finding: Finding): Promise<boolean> {
  const list = findings.get(finding.arenaId) ?? [];

  // Check for duplicate by dedupeKey
  const dupeIndex = list.findIndex((f) => f.dedupeKey === finding.dedupeKey);
  if (dupeIndex !== -1) {
    // Keep the higher confidence one
    if (list[dupeIndex].confidence >= finding.confidence) return false;
    list[dupeIndex] = finding;
    findings.set(finding.arenaId, list);
    return true;
  }

  list.push(finding);
  findings.set(finding.arenaId, list);
  return true;
}

export async function getFindings(arenaId: string): Promise<Finding[]> {
  return findings.get(arenaId) ?? [];
}

export function clearFindings(arenaId: string): void {
  findings.delete(arenaId);
}
