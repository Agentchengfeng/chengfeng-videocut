import { resolve } from "node:path";
import { assertProjectReadable, readOptionalProjectDocument, resolveProject, serializeProjectOperation } from "@video-workbench/core/node";
import { asVideocutError, VideocutError } from "@video-workbench/core";
import { assertEditTargetQuery, resolveEditTargets } from "../../../../packages/core/src/editTargets";
import { projectFilesRevision, snapshotProjectFiles } from "../../../../packages/core/src/projectTransaction";
import { exportInputFingerprint } from "../jobs/runners";
import { isLoopbackAddress, trustedLoopbackOrigin } from "./jobs-api";

async function targetQuery(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new VideocutError("invalid_argument", "Target query body required");
  const chunks: Uint8Array[] = []; let size = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel(); }, 5000);
  try {
    while (true) {
      const part = await reader.read();
      if (expired) throw new VideocutError("invalid_argument", "Target query body timed out");
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 32 * 1024) { await reader.cancel(); throw new VideocutError("invalid_argument", "Target query exceeds 32KiB"); }
      chunks.push(part.value);
    }
    const query: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assertEditTargetQuery(query);
    return query;
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

// A limited adapter to existing deterministic CLI functions, in this service's
// registry. No shell, alternate runtime, paid ASR or arbitrary file endpoint.
export function createConnectionApi(projectsDir: string, port: number) {
  return async (request: Request, clientAddress?: string): Promise<Response | null> => {
    const url = new URL(request.url);
    const match = /^\/api\/v1\/projects\/([^/]+)\/(playback|subtitle-inputs|export-plan|edit-targets)$/.exec(url.pathname);
    if (!match) return null;
    const origin=trustedLoopbackOrigin(request.headers.get("host"),port);
    if (!clientAddress || !isLoopbackAddress(clientAddress) || !origin || url.origin!==origin ||
      (request.headers.has("origin")&&request.headers.get("origin")!==origin)) {
      return Response.json({error:{code:"origin_forbidden"}},{status:403});
    }
    const isTargets = match[2] === "edit-targets";
    if (request.method !== (isTargets ? "POST" : "GET")) return Response.json({error:{code:"method_not_allowed"}},{status:405});
    try {
      if (isTargets && url.search) throw new VideocutError("invalid_argument", "Target selectors belong in the JSON body only");
      const query = isTargets ? await targetQuery(request) : undefined;
      const id = decodeURIComponent(match[1]!);
      if (!id || id === "." || id === ".." || /[\\/\0]/.test(id)) throw new Error("Invalid project id");
      const project = await resolveProject(resolve(projectsDir,id));
      const data = await serializeProjectOperation(project.directory, async () => {
        if (isTargets) {
          await assertProjectReadable(project.directory);
          const files = await snapshotProjectFiles(project.directory);
          const result = resolveEditTargets(project.directory, id, files, query);
          await assertProjectReadable(project.directory);
          if (result.revision !== projectFilesRevision(await snapshotProjectFiles(project.directory))) {
            throw new VideocutError("revision_conflict", "Project changed during target lookup; inspect again");
          }
          return result;
        }
        if (match[2] === "subtitle-inputs") {
          const files: Record<string,string|null> = {};
          for (const name of ["transcript.json","edit-list.json","subtitles.json"] as const) {
            const document = await readOptionalProjectDocument(project,name);
            files[name] = document?.raw ?? null;
          }
          if (JSON.stringify(files).length > 3*1024*1024) throw new Error("subtitle inputs exceed bounded transfer limit");
          return {schemaVersion:1,projectId:id,files};
        }
        const {runCli} = await import("../run");
        const argv = match[2] === "playback"
          ? ["transcript","playback",project.directory,"--limit",url.searchParams.get("limit")??"64",...(url.searchParams.has("cursor")?["--cursor",url.searchParams.get("cursor")!]:[])]
          : ["export",project.directory,"--dry-run","--profile",url.searchParams.get("profile")??"master"];
        const output: string[]=[];
        const code=await runCli([...argv,"--projects-dir",projectsDir,"--json"],{io:{stdout:s=>output.push(s),stderr:s=>output.push(s)}});
        const result=JSON.parse(output[0]??"{}");
        if(code!==0) throw Object.assign(new Error(result.error?.message??"Runtime adapter failed"),{code:result.error?.code});
        return {...result.data, ...(match[2]==="export-plan"?{snapshotFingerprint:await exportInputFingerprint(project.directory)}:{})};
      });
      return Response.json(data,{headers:{"Cache-Control":"no-store"}});
    } catch(error) {
      const e=asVideocutError(error);
      return Response.json({error:{code:e.code,message:e.message,details:e.details}},{status:e.code==="revision_conflict"?409:400,headers:{"Cache-Control":"no-store"}});
    }
  };
}
