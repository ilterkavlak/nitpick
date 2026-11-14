import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSecretsInDiff } from "./secrets";

function diffAdding(line: string): string {
  return ["diff --git a/config.json b/config.json", "+++ b/config.json", "@@ -0,0 +1,1 @@", `+${line}`].join("\n");
}

test("secret evidence never contains the source line", () => {
  const a = "ghp_" + "A".repeat(36);
  const b = "ghp_" + "B".repeat(36);
  const findings = scanSecretsInDiff("arena", diffAdding(`{"a": "${a}", "b": "${b}"}`));
  assert.ok(findings.length > 0);
  for (const f of findings) {
    assert.ok(!f.evidence?.includes("AAAA") && !f.evidence?.includes("BBBB"), f.evidence);
  }
});

test("secret evidence does not leak a single-line PEM body", () => {
  const body = "MIIEowIBAAKCAQEA" + "x".repeat(64);
  const findings = scanSecretsInDiff(
    "arena",
    diffAdding(`{"key": "-----BEGIN RSA PRIVATE KEY-----\\n${body}\\n-----END RSA PRIVATE KEY-----"}`)
  );
  assert.ok(findings.some((f) => f.title.startsWith("RSA Private Key")));
  for (const f of findings) {
    assert.ok(!f.evidence?.includes("MIIE"), f.evidence);
  }
});

for (const [name, line] of [
  ["database URL", "postgres://a:".repeat(32000)],
  ["JWT", "eyJ".repeat(128000)],
  ["generic assignment", "token='".repeat(50000)],
  ["bearer", "Bearer ".repeat(50000)],
]) {
  test(`secret scanning stays linear on adversarial input (${name})`, () => {
    const start = Date.now();
    scanSecretsInDiff("arena", diffAdding(line));
    assert.ok(Date.now() - start < 1000, `took ${Date.now() - start}ms`);
  });
}

test("JWT is still detected", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const findings = scanSecretsInDiff("arena", diffAdding(`const t = "${jwt}";`));
  assert.ok(findings.some((f) => f.title.startsWith("JWT")));
});

test("database URL with credentials is still detected", () => {
  const findings = scanSecretsInDiff("arena", diffAdding('DB="postgres://user:hunter2pass@db.example.com:5432/app"'));
  assert.ok(findings.some((f) => f.title.startsWith("Database URL")));
});
