import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WORKFLOW_PATH = join(ROOT, ".github/workflows/npm-runtime-trusted-publish.yml");

describe("npm Runtime Trusted Publishing design", () => {
  test("is manual-only, exact-tag-bound, and protected by the current fail-closed policy", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");
    expect(workflow).toMatch(/^on:\n  workflow_dispatch:/m);
    expect(workflow).not.toMatch(/^  (push|pull_request|schedule|release):/m);
    expect(workflow).toContain("ref: refs/tags/${{ inputs.tag }}");
    expect(workflow).toContain("git rev-list -n 1 \"$RELEASE_TAG^{commit}\"");
    expect(workflow).toContain("environment: npm-runtime-release");
    expect(workflow).toContain("readNativeSigningPolicy");
    expect(workflow).toContain("native-release-protected-stage");
    expect(workflow).toContain("CHENGFENG_VIDEOCUT_NATIVE_WORKFLOW_RUN_ID: ${{ inputs.protected_native_run_id }}");
    expect(workflow).toContain("release:native:verify:stage");
    expect(workflow).toContain("npm-runtime:stage");
    expect(workflow).toContain("npm-runtime:verify");
    expect(workflow).not.toContain("continue-on-error");

    const policy = JSON.parse(await readFile(
      join(ROOT, "installer/native-release-signing-policy.json"),
      "utf8",
    ));
    expect(policy.status).toBe("UNCONFIGURED");
    expect(policy.githubAttestation.signerRepository).toBeNull();

    const nativeWorkflow = await readFile(
      join(ROOT, ".github/workflows/native-release-signing.yml"),
      "utf8",
    );
    const windowsJob = nativeWorkflow.slice(nativeWorkflow.indexOf("  windows-authenticode:"));
    expect(windowsJob).toContain("environment: native-release");
    expect(windowsJob).toContain("release:native:verify:windows");
    expect(windowsJob).toContain("release:native:write:windows-receipt");
  });

  test("grants OIDC only to the final publish job and never carries an npm token", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");
    expect(workflow.match(/id-token:\s*write/g)).toHaveLength(1);
    const publishJob = workflow.slice(workflow.indexOf("  publish-with-oidc:"));
    expect(publishJob).toContain("id-token: write");
    expect(publishJob).toContain("node-version: 24.6.0");
    expect(publishJob).toContain("npm install --global npm@11.6.2");
    expect(publishJob).toContain("npm publish");
    expect(publishJob).toContain("--provenance");
    expect(publishJob).toContain("--access public");
    expect(workflow).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|npm_token|secrets\.[A-Za-z0-9_]*NPM/i);
  });

  test("pins every external action and makes publish depend on the verified stage", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");
    const useLines = workflow.split(/\r?\n/).filter((line) => /\buses:/.test(line));
    expect(useLines.length).toBeGreaterThan(0);
    for (const line of useLines) {
      const reference = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/.exec(line)?.[1];
      expect(reference, `unparsed uses line: ${line}`).toBeDefined();
      expect(reference).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/);
    }
    const publishJob = workflow.slice(workflow.indexOf("  publish-with-oidc:"));
    expect(publishJob).toMatch(/needs:\n      - source-and-policy-gate\n      - stage-and-verify/);
    expect(publishJob.indexOf("npm-runtime:verify")).toBeLessThan(publishJob.indexOf("npm publish"));
    expect(publishJob.indexOf("npm view")).toBeLessThan(publishJob.indexOf("npm publish"));
  });
});
