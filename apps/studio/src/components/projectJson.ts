export async function readProjectJson(
  projectId: string,
  filePath: string,
): Promise<unknown | null> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(filePath)}`,
  );
  if (!response.ok) return null;
  const payload = (await response.json()) as unknown;
  if (
    payload &&
    typeof payload === "object" &&
    "content" in payload &&
    typeof (payload as { content?: unknown }).content === "string"
  ) {
    return JSON.parse((payload as { content: string }).content);
  }
  return payload;
}
