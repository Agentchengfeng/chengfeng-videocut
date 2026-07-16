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
      try {
        const html = await bundleToSingleHtml(projectDir, {
          runtime: "placeholder",
          inlineColorGradingLuts: false,
        });
        return html.replace(
          'data-hyperframes-preview-runtime="1" src=""',
          'data-hyperframes-preview-runtime="1" src="/api/runtime.js"',
        );
      } catch (error) {
        console.warn(
          `[chengfeng-videocut] Bundling ${projectDir} failed; serving source HTML instead.`,
          error instanceof Error ? error.message : String(error),
        );
        return null;
      }
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
