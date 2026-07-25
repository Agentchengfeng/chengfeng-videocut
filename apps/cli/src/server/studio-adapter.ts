import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { bundleToSingleHtml } from "@hyperframes/core/compiler";
import { lintHyperframeHtml } from "@hyperframes/core/lint";
import {
  materializeKouboEditListIndex,
  patchKouboProjectIndex,
  resolveKouboPreviewProxySource,
} from "@video-workbench/koubo-adapter";
import { serializeProjectOperation } from "@video-workbench/core/node";
import {
  createProjectSignature,
  type RenderJobState,
  type ResolvedProject,
  type StudioApiAdapter,
} from "@hyperframes/studio-server";

function hasProjectEntrypoint(projectsDir: string, id: string): boolean {
  const directory = join(projectsDir, id);
  return (
    existsSync(join(directory, "index.html")) ||
    existsSync(join(directory, `${id}.html`))
  );
}

function isSafeProjectId(id: string): boolean {
  return (
    id.length > 0 &&
    id !== "." &&
    id !== ".." &&
    !id.includes("/") &&
    !id.includes("\\") &&
    !id.includes("\0")
  );
}

export interface ProductionStudioAdapterOptions {
  projectsDir: string;
  rendersDir: string;
}

const GENERATED_MEDIA_TIMING_ATTRIBUTE =
  /\s(?:data-start|data-hf-auto-start)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi;

/** Keep the single EDL backing video out of HyperFrames' native media clock. */
export function prepareVideocutPreviewBundle(html: string): string {
  const localized = html.replace(
    'data-hyperframes-preview-runtime="1" src=""',
    'data-hyperframes-preview-runtime="1" src="/api/runtime.js"',
  );
  return localized.replace(
    /<video\b(?=[^>]*\bdata-videocut-edl-backing(?:\s*=|\s|>))[^>]*>/gi,
    (tag) => tag.replace(GENERATED_MEDIA_TIMING_ATTRIBUTE, ""),
  );
}

/** Filesystem adapter used by the packaged, non-Vite Studio server. */
export function createProductionStudioAdapter(
  options: ProductionStudioAdapterOptions,
): StudioApiAdapter {
  const projectsDir = resolve(options.projectsDir);
  const rendersRoot = resolve(options.rendersDir);

  const resolveProject = (id: string): ResolvedProject | null => {
    if (!isSafeProjectId(id)) return null;
    const candidate = join(projectsDir, id);
    if (!existsSync(candidate) || !hasProjectEntrypoint(projectsDir, id)) return null;
    try {
      return { id, dir: realpathSync(candidate), title: id };
    } catch {
      return null;
    }
  };

  return {
    listProjects(): ResolvedProject[] {
      if (!existsSync(projectsDir)) return [];
      return readdirSync(projectsDir, { withFileTypes: true })
        .filter(
          (entry) =>
            (entry.isDirectory() || entry.isSymbolicLink()) &&
            isSafeProjectId(entry.name) &&
            hasProjectEntrypoint(projectsDir, entry.name),
        )
        .map((entry) => resolveProject(entry.name))
        .filter((project): project is ResolvedProject => project !== null)
        .sort((left, right) => left.id.localeCompare(right.id));
    },

    resolveProject,

    async bundle(projectDir: string): Promise<string | null> {
      return serializeProjectOperation(projectDir, async () => {
        // index.html is a rebuildable projection of edit-list.json. A process
        // can stop after the EDL commit but before projection materialization,
        // so the Studio repairs and bundles one locked project snapshot.
        // Keep this outside the bundle fallback: serving stale source HTML
        // would silently show a different edit than the Product truth.
        const projection = existsSync(join(projectDir, "edit-list.json"))
          ? await materializeKouboEditListIndex(projectDir)
          : null;
        try {
          const html = await bundleToSingleHtml(projectDir, {
            runtime: "placeholder",
            inlineColorGradingLuts: false,
          });
          const previewProxy = projection
            ? await resolveKouboPreviewProxySource(projectDir)
            : null;
          const previewHtml = projection && previewProxy
            ? patchKouboProjectIndex(
                html,
                projection.editList,
                projection.revision,
                previewProxy.browserSource,
              )
            : html;
          return prepareVideocutPreviewBundle(previewHtml);
        } catch (error) {
          console.warn(
            `[chengfeng-videocut] Bundling ${projectDir} failed; serving source HTML instead.`,
            error instanceof Error ? error.message : String(error),
          );
          return null;
        }
      });
    },

    getProjectSignature(projectDir: string): string {
      return createProjectSignature(resolve(projectDir));
    },

    lint(html: string, lintOptions?: { filePath?: string }) {
      return lintHyperframeHtml(html, lintOptions);
    },

    runtimeUrl: "/api/runtime.js",

    rendersDir(project: ResolvedProject): string {
      const directory = join(rendersRoot, project.id);
      mkdirSync(directory, { recursive: true });
      return directory;
    },

    startRender(renderOptions): RenderJobState {
      return {
        id: renderOptions.jobId,
        status: "failed",
        progress: 0,
        outputPath: renderOptions.outputPath,
        error:
          "Legacy Studio render jobs are disabled. Use the confirmation-gated chengfeng-videocut workflow and chengfeng-videocut render run.",
      };
    },
  };
}
