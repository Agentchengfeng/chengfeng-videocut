import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEditListFromCuts } from "@video-workbench/core";
import { serializeProjectOperation } from "@video-workbench/core/node";
import {
  EDL_PREVIEW_PAYLOAD_ATTRIBUTE,
  EDL_PREVIEW_RUNTIME_CONTRACT,
  KOUBO_PROJECTION_RUNTIME_VERSION,
  KOUBO_PROJECTION_SCHEMA_VERSION,
  renderKouboProjectIndex,
} from "@video-workbench/koubo-adapter";
import { createProductionStudioAdapter } from "./studio-adapter";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "videocut-studio-adapter-"));
  cleanupPaths.push(root);
  const projectsDir = join(root, "projects");
  const projectDir = join(projectsDir, "demo");
  const rendersDir = join(root, "renders");
  await mkdir(join(projectDir, "input"), { recursive: true });
  await mkdir(rendersDir, { recursive: true });
  await writeFile(join(projectDir, "project.json"), JSON.stringify({
    jobId: "demo",
    title: "Demo",
    inputVideo: "input/source.mp4",
    config: { aspectRatio: "4:3" },
  }));
  await writeFile(join(projectDir, "workbench.json"), JSON.stringify({
    projectId: "demo",
    aspectRatio: "4:3",
  }));
  const editList = buildEditListFromCuts({
    projectId: "demo",
    source: "input/source.mp4",
    sourceDuration: 10,
    cutsRevision: "a".repeat(64),
    transcriptRevision: "b".repeat(64),
    cutRanges: [{ start: 4, end: 6 }],
  });
  const editListRaw = `${JSON.stringify(editList, null, 2)}\n`;
  await writeFile(join(projectDir, "edit-list.json"), editListRaw);
  const currentIndex = renderKouboProjectIndex({
    title: "Demo",
    width: 1440,
    height: 1080,
    duration: editList.duration,
    videoSource: "input/source.mp4",
    editList,
  });
  await writeFile(
    join(projectDir, "index.html"),
    currentIndex.replace(/data-edit-list-revision="[^"]+"/, 'data-edit-list-revision="stale"'),
  );
  return { projectDir, projectsDir, rendersDir, editListRaw };
}

describe("production Studio projection gate", () => {
  it("repairs a stale EDL projection before bundling the project", async () => {
    const { projectDir, projectsDir, rendersDir, editListRaw } = await fixture();
    const adapter = createProductionStudioAdapter({ projectsDir, rendersDir });

    const bundle = await adapter.bundle(projectDir);

    const index = await readFile(join(projectDir, "index.html"), "utf8");
    const revision = createHash("sha256").update(editListRaw).digest("hex");
    expect(index).toContain(`data-edit-list-revision="${revision}"`);
    expect(index.match(/data-edl-segment-id=/g)).toHaveLength(2);
    expect(bundle).not.toBeNull();
    const backingTag = bundle?.match(
      /<video\b(?=[^>]*\bdata-videocut-edl-backing(?:\s*=|\s|>))[^>]*>/i,
    )?.[0];
    expect(backingTag).toBeDefined();
    expect(backingTag).not.toMatch(/\sdata-start(?:\s*=|\s|>)/i);
    expect(backingTag).not.toMatch(/\sdata-hf-auto-start(?:\s*=|\s|>)/i);
  });

  it("migrates a legacy runtime at the same EDL revision before serving Studio", async () => {
    const { projectDir, projectsDir, rendersDir, editListRaw } = await fixture();
    const indexPath = join(projectDir, "index.html");
    const revision = createHash("sha256").update(editListRaw).digest("hex");
    const customOverlay =
      '<div data-hf-id="custom-overlay" data-start="0" data-duration="1">KEEP ME</div>';
    const legacy = (await readFile(indexPath, "utf8"))
      .replace('data-edit-list-revision="stale"', `data-edit-list-revision="${revision}"`)
      .replaceAll(/\sdata-videocut-projection-(?:schema|runtime)="[^"]*"/g, "")
      .replace(
        /<script\b(?=[^>]*\bdata-chengfeng-videocut-edl-player="1")[^>]*>[\s\S]*?<\/script>/,
        '<script data-chengfeng-videocut-edl-player="1">window.__legacyEdlRuntime = true;</script>',
      )
      .replace(
        "<!-- chengfeng-videocut:a-roll:end -->",
        `<!-- chengfeng-videocut:a-roll:end -->\n${customOverlay}`,
      );
    await writeFile(indexPath, legacy);
    const adapter = createProductionStudioAdapter({ projectsDir, rendersDir });

    const bundle = await adapter.bundle(projectDir);

    const migrated = await readFile(indexPath, "utf8");
    expect(migrated).not.toContain("__legacyEdlRuntime");
    expect(migrated).toContain(customOverlay);
    expect(migrated).toContain(
      `data-videocut-projection-schema="${KOUBO_PROJECTION_SCHEMA_VERSION}"`,
    );
    expect(migrated).toContain(
      `data-videocut-projection-runtime="${KOUBO_PROJECTION_RUNTIME_VERSION}"`,
    );
    expect(bundle).not.toContain("__legacyEdlRuntime");
    expect(bundle).toContain(customOverlay);
  });

  it("uses a revisioned proxy only in the served Studio preview bundle", async () => {
    const { projectDir, projectsDir, rendersDir } = await fixture();
    const sourceSha256 = "c".repeat(64);
    const cacheKey = "d".repeat(64);
    const proxyRevision = `${cacheKey}-1784440000000-11`;
    const proxySource = `preview/${cacheKey}.mp4`;
    await mkdir(join(projectDir, "preview"), { recursive: true });
    await writeFile(join(projectDir, proxySource), "proxy-media");
    const project = JSON.parse(await readFile(join(projectDir, "project.json"), "utf8"));
    project.source = { path: "input/source.mp4", sha256: sourceSha256, immutable: true };
    await writeFile(join(projectDir, "project.json"), JSON.stringify(project));
    await writeFile(join(projectDir, "workbench.json"), JSON.stringify({
      projectId: "demo",
      aspectRatio: "4:3",
      duration: 10,
      sourceSha256,
      previewProxy: {
        schemaVersion: 1,
        profile: "source-timeline-v1",
        status: "ready",
        source: proxySource,
        revision: proxyRevision,
        sourceSha256,
        cacheKey,
        byteLength: 11,
        duration: 10,
        startTime: 0,
      },
    }));
    const adapter = createProductionStudioAdapter({ projectsDir, rendersDir });

    const bundle = await adapter.bundle(projectDir);
    const index = await readFile(join(projectDir, "index.html"), "utf8");

    expect(index).toContain('src="input/source.mp4"');
    expect(index).not.toContain(proxySource);
    expect(bundle).toContain(`${proxySource}?v=${proxyRevision}`);
    expect(bundle).toContain("data-videocut-preview-proxy");
    expect(bundle).toContain('preload="auto" muted playsinline');
    expect(bundle?.match(new RegExp(EDL_PREVIEW_RUNTIME_CONTRACT, "g"))).toHaveLength(1);
    expect(bundle).not.toContain('data-chengfeng-videocut-edl-player="1"');
    const payloadMatch = bundle?.match(new RegExp(
      `<script\\b(?=[^>]*\\b${EDL_PREVIEW_PAYLOAD_ATTRIBUTE}="1")[^>]*>([^<]*)<\\/script>`,
    ));
    expect(payloadMatch).toBeDefined();
    const payload = JSON.parse(payloadMatch?.[1] ?? "null") as {
      segments: Array<{ source: string }>;
    };
    expect(payload.segments.every(
      (segment) => segment.source === `${proxySource}?v=${proxyRevision}`,
    )).toBe(true);
    expect(bundle).not.toContain('"source":"input/source.mp4"');
  });

  it("waits for the shared project mutation lock before repairing and bundling", async () => {
    const { projectDir, projectsDir, rendersDir } = await fixture();
    const adapter = createProductionStudioAdapter({ projectsDir, rendersDir });
    let releaseHolder = (): void => undefined;
    let markHolderStarted = (): void => undefined;
    const holderStarted = new Promise<void>((resolveStarted) => {
      markHolderStarted = resolveStarted;
    });
    const holder = serializeProjectOperation(projectDir, async () => {
      markHolderStarted();
      await new Promise<void>((resolveHeld) => {
        releaseHolder = resolveHeld;
      });
    });
    await holderStarted;

    let settled = false;
    const bundled = adapter.bundle(projectDir).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    expect(settled).toBe(false);

    releaseHolder();
    await holder;
    expect(await bundled).not.toBeNull();
  });

  it("blocks preview instead of serving stale HTML when repair fails", async () => {
    const { projectDir, projectsDir, rendersDir } = await fixture();
    await writeFile(join(projectDir, "edit-list.json"), "{not-json");
    const adapter = createProductionStudioAdapter({ projectsDir, rendersDir });

    await expect(adapter.bundle(projectDir)).rejects.toThrow();
  });
});
