import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = dirname(fileURLToPath(import.meta.url));

export default {
  appId: "com.aiproductfree.chengfengvideocut",
  productName: "Chengfeng VideoCut",
  artifactName: "Chengfeng-VideoCut-${version}-${os}-${arch}.${ext}",
  directories: {
    output: join(appRoot, "release"),
  },
  files: [
    "main.mjs",
    "runtime.mjs",
    "package.json",
  ],
  extraResources: [
    {
      from: join(appRoot, "dist-resources/runtime"),
      to: "runtime",
    },
    {
      from: join(appRoot, "dist-resources/tools"),
      to: "tools",
    },
    {
      from: join(appRoot, "dist-resources/resources-manifest.json"),
      to: "resources-manifest.json",
    },
  ],
  asar: true,
  npmRebuild: false,
  mac: {
    target: ["dmg"],
    category: "public.app-category.video",
    identity: null,
  },
  win: {
    target: ["nsis"],
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
  },
};
