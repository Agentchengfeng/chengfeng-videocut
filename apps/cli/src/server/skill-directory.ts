import { SKILL_DIRECTORY } from "@video-workbench/contracts";

/** Read-only build metadata, never host Skill paths or an installation authority. */
export function skillDirectoryResponse(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== "/api/v1/skills") return null;
  const headers = { "Cache-Control": "no-store", "Allow": "GET, HEAD" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "read_only" }, { status: 405, headers });
  }
  if (url.search) return Response.json({ error: "unsupported_query" }, { status: 400, headers });
  return new Response(request.method === "HEAD" ? null : JSON.stringify(SKILL_DIRECTORY), {
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}
