import { expect, test } from "bun:test";
import { skillDirectoryResponse } from "./skill-directory";
test("directory is a versioned source snapshot, never installed or compatible truth", async () => {
  const result = await skillDirectoryResponse(new Request("http://localhost/api/v1/skills"))!.json();
  expect(result.sourceKind).toBe("independent-local-candidates");
  expect(result.schemaVersion).toBe(2);
  expect(result.catalogSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.installUnit).toBe("independent-skill");
  expect(result.publicReleaseReady).toBe(false);
  expect(result.skills).toHaveLength(7);
  expect(result.skills.map((s: { name: string }) => s.name)).toContain("chengfeng-videocut-maintain");
  expect(result.skills.map((s: { name: string }) => s.name)).not.toContain("chengfeng-videocut-visual");
  for (const s of result.skills) {
    expect([s.installed, s.enabled, s.loaded, s.compatible]).toEqual(Array(4).fill("unknown"));
    expect(s.name).toMatch(/^[a-z0-9-]+$/);
  }
});
test("directory refuses mutations and source-path injection", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    expect(skillDirectoryResponse(new Request("http://localhost/api/v1/skills", { method }))!.status).toBe(405);
  }
  expect(skillDirectoryResponse(new Request("http://localhost/api/v1/skills?source=/etc/passwd"))!.status).toBe(400);
  expect(await skillDirectoryResponse(new Request("http://localhost/api/v1/skills", { method: "HEAD" }))!.text()).toBe("");
  expect(skillDirectoryResponse(new Request("http://localhost/another"))).toBeNull();
});
