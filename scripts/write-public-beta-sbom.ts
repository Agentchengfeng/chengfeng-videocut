import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dir, "..");
const releaseDir = resolve(process.env.CHENGFENG_VIDEOCUT_RELEASE_DIR ?? join(rootDir, "release"));
const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH);
if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
  throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer for a reproducible public-beta SBOM");
}
const product = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as { version?: unknown };
if (typeof product.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(product.version)) {
  throw new Error("Product version is invalid");
}
const toolsLock = JSON.parse(await readFile(join(rootDir, "installer/managed-tools.lock.json"), "utf8")) as {
  productVersion?: unknown;
  tools?: { bun?: { version?: unknown }; ffmpeg?: { version?: unknown }; ffprobe?: { version?: unknown } };
};
if (toolsLock.productVersion !== product.version || !toolsLock.tools?.bun?.version || !toolsLock.tools.ffmpeg?.version || !toolsLock.tools.ffprobe?.version) {
  throw new Error("managed-tools.lock.json does not match the Product version");
}
const asset = "chengfeng-videocut-installer-windows-x64.exe";
const installerPath = join(releaseDir, asset);
const installer = await readFile(installerPath);
const installerMetadata = await stat(installerPath);
if (!installerMetadata.isFile() || installerMetadata.size <= 0 || installerMetadata.size !== installer.length) {
  throw new Error("Windows public-beta installer is not a regular non-empty file");
}
const installerSha256 = createHash("sha256").update(installer).digest("hex");
const version = product.version;
const created = new Date(sourceDateEpoch * 1000).toISOString();
const document = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `chengfeng-videocut-runtime-${version}-win32-x64`,
  documentNamespace: `https://github.com/Agentchengfeng/chengfeng-videocut/releases/download/v${version}/sbom/win32-x64`,
  creationInfo: {
    created,
    creators: ["Tool: chengfeng-videocut-public-beta-sbom"],
  },
  packages: [
    {
      name: "chengfeng-videocut",
      SPDXID: "SPDXRef-Package-Product",
      versionInfo: version,
      licenseDeclared: "Apache-2.0",
      downloadLocation: "https://github.com/Agentchengfeng/chengfeng-videocut",
    },
    {
      name: "bun",
      SPDXID: "SPDXRef-Package-Bun",
      versionInfo: toolsLock.tools.bun.version,
      licenseDeclared: "MIT",
      downloadLocation: `https://github.com/oven-sh/bun/releases/tag/bun-v${toolsLock.tools.bun.version}`,
    },
    {
      name: "ffmpeg",
      SPDXID: "SPDXRef-Package-FFmpeg",
      versionInfo: toolsLock.tools.ffmpeg.version,
      licenseDeclared: "GPL-3.0-or-later",
      downloadLocation: "https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.0",
    },
    {
      name: "ffprobe",
      SPDXID: "SPDXRef-Package-FFprobe",
      versionInfo: toolsLock.tools.ffprobe.version,
      licenseDeclared: "GPL-3.0-or-later",
      downloadLocation: "https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.0",
    },
  ],
  files: [
    {
      fileName: `payload/${asset}`,
      SPDXID: "SPDXRef-File-Installer",
      checksums: [{ algorithm: "SHA256", checksumValue: installerSha256 }],
    },
  ],
  relationships: [
    { spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: "SPDXRef-Package-Product" },
    { spdxElementId: "SPDXRef-Package-Product", relationshipType: "CONTAINS", relatedSpdxElement: "SPDXRef-File-Installer" },
    { spdxElementId: "SPDXRef-Package-Product", relationshipType: "CONTAINS", relatedSpdxElement: "SPDXRef-Package-Bun" },
    { spdxElementId: "SPDXRef-Package-Product", relationshipType: "CONTAINS", relatedSpdxElement: "SPDXRef-Package-FFmpeg" },
    { spdxElementId: "SPDXRef-Package-Product", relationshipType: "CONTAINS", relatedSpdxElement: "SPDXRef-Package-FFprobe" },
  ],
};
const output = join(releaseDir, `chengfeng-videocut-sbom-${version}-win32-x64.spdx.json`);
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify({ output, installer: { asset, sha256: installerSha256, size: installerMetadata.size }, created }));
