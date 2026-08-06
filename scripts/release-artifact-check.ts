import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { verifyReleaseAssetManifest } from "./release-assets";

const rootDir = resolve(import.meta.dir, "..");
const releaseDir = resolve(process.env.CHENGFENG_VIDEOCUT_RELEASE_AUDIT_DIR ?? join(rootDir, "release"));
const version = JSON.parse(await Bun.file(join(rootDir, "package.json")).text()) as { version?: string };

if (!version.version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version.version)) {
  throw new Error(`Invalid package version: ${String(version.version)}`);
}

const forbiddenContent = [
  { label: "developer volume path", pattern: /\/Volumes\/成峰(?:\/|$)/ },
  { label: "developer home path", pattern: /\/Users\/chengfeng(?:\/|$)/ },
  { label: "credential-like sk token", pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { label: "credential-like PostHog token", pattern: /phc_[A-Za-z0-9]{20,}/ },
] as const;

async function scanFile(path: string, label: string): Promise<void> {
  const utf8Decoder = new TextDecoder("utf-8");
  let rawTail = "";
  let utf8Tail = "";
  const scanText = (text: string) => {
    for (const forbidden of forbiddenContent) {
      if (forbidden.pattern.test(text)) {
        throw new Error(`Release leak scan found ${forbidden.label} in ${label}`);
      }
    }
  };
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.from(chunk);
    const rawText = rawTail + bytes.toString("latin1");
    const utf8Text = utf8Tail + utf8Decoder.decode(bytes, { stream: true });
    scanText(rawText);
    scanText(utf8Text);
    rawTail = rawText.slice(-256);
    utf8Tail = utf8Text.slice(-256);
  }
  scanText(utf8Tail + utf8Decoder.decode());
}

async function scanExtractedTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    const label = relative(root, absolute);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || !metadata.isFile() && !metadata.isDirectory()) {
      throw new Error(`Release archive contains non-regular entry: ${label}`);
    }
    if (metadata.isDirectory()) {
      await scanExtractedTree(absolute);
    } else {
      await scanFile(absolute, label);
    }
  }
}

async function extractAndScan(archiveName: string, temporaryRoot: string): Promise<void> {
  const destination = join(temporaryRoot, archiveName.replace(/[^A-Za-z0-9._-]/g, "_"));
  await mkdir(destination, { recursive: true });
  const child = Bun.spawn(["tar", "-xzf", join(releaseDir, archiveName), "-C", destination], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (status !== 0) {
    throw new Error(`Cannot extract ${archiveName}: ${stderr.trim().slice(-1_000)}`);
  }
  await scanExtractedTree(destination);
}

const manifest = await verifyReleaseAssetManifest({ releaseDir, version: version.version });
for (const name of manifest.assetNames) await scanFile(join(releaseDir, name), name);

const temporaryRoot = await mkdtemp(join(tmpdir(), "chengfeng-videocut-release-audit-"));
try {
  await extractAndScan(`chengfeng-videocut-${version.version}-portable.tar.gz`, temporaryRoot);
  await extractAndScan(`chengfeng-videocut-${version.version}.tgz`, temporaryRoot);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(`Release artifact audit passed for ${version.version}: ${manifest.assetNames.join(", ")}`);
