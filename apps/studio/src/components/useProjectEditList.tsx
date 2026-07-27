import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  type EditListDocument,
  type EditListOperation,
} from "@video-workbench/core";
import { subscribeProjectFileChanges } from "../product/projectEvents";
import { readStudioFileChangePath } from "./editor/manualEdits";
import {
  EditListApiError,
  getProjectEditList,
  patchProjectEditList,
  type EditListActor,
} from "./editListApi";

export type EditListSaveState = "idle" | "saving" | "saved" | "error" | "conflict";

export interface ProjectEditListState {
  projectId: string | null;
  document: EditListDocument | null;
  revision: string;
  loading: boolean;
  ready: boolean;
  saveState: EditListSaveState;
  reload: () => Promise<boolean>;
  patchOperation: (
    operation: EditListOperation,
    actor?: EditListActor,
  ) => Promise<EditListDocument>;
  canUndo: boolean;
  undoLastEditListChange: () => Promise<void>;
}

function readFileChangeProjectId(payload: unknown): string | null {
  if (typeof payload === "string") {
    const value = payload.trim();
    if (!value.startsWith("{")) return null;
    try {
      return readFileChangeProjectId(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.projectId === "string") return record.projectId;
  return "data" in record ? readFileChangeProjectId(record.data) : null;
}

export function isEditListFileChange(payload: unknown, projectId: string): boolean {
  const path = readStudioFileChangePath(payload);
  return (
    readFileChangeProjectId(payload) === projectId &&
    (path === "edit-list.json" || Boolean(path?.endsWith("/edit-list.json")))
  );
}

export function useProjectEditList(
  projectId: string | null,
  options: { onDocumentChange?: (document: EditListDocument) => void } = {},
): ProjectEditListState {
  const [document, setDocument] = useState<EditListDocument | null>(null);
  const [revision, setRevision] = useState("none");
  const [loading, setLoading] = useState(Boolean(projectId));
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<EditListSaveState>("idle");
  const projectEpochRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const revisionRef = useRef("none");
  const documentRef = useRef<EditListDocument | null>(null);
  const patchQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const pendingPatchesRef = useRef(0);
  const onDocumentChangeRef = useRef(options.onDocumentChange);
  onDocumentChangeRef.current = options.onDocumentChange;

  const applyResource = useCallback(
    (
      resource: Awaited<ReturnType<typeof getProjectEditList>>,
      notify: boolean,
      applyOptions: { clearUndo?: boolean } = {},
    ) => {
      // Same revision means the same document — the revision *is* the content's
      // hash. Handing React a fresh object anyway makes every consumer keyed on its
      // identity recompute: three thousand transcript words re-derived, re-indexed
      // and re-rendered for a document that did not change.
      //
      // That is not hypothetical. A write lands twice here: once from the response,
      // once from the file-change event that follows it. The second pass produces an
      // identical document and costs exactly as much as the first.
      const unchanged = resource.revision === revisionRef.current
        && documentRef.current !== null
        && resource.document !== null;
      const document = unchanged ? documentRef.current : resource.document;
      revisionRef.current = resource.revision;
      setRevision(resource.revision);
      documentRef.current = document;
      setDocument(document);
      setReady(true);
      setLoading(false);
      setSaveState("idle");
      if (notify && document) onDocumentChangeRef.current?.(document);
    },
    [],
  );

  const load = useCallback(async (notify = false): Promise<boolean> => {
    if (!projectId) {
      revisionRef.current = "none";
      setRevision("none");
      setDocument(null);
      setReady(false);
      setLoading(false);
      return false;
    }
    const generation = ++loadGenerationRef.current;
    try {
      const resource = await getProjectEditList(projectId);
      if (generation !== loadGenerationRef.current) return false;
      applyResource(resource, notify);
      return true;
    } catch {
      if (generation === loadGenerationRef.current) {
        setLoading(false);
        setReady(false);
        setSaveState("error");
      }
      return false;
    }
  }, [applyResource, projectId]);

  const reload = useCallback(() => {
    setLoading(true);
    setReady(false);
    return load(false);
  }, [load]);

  useEffect(() => {
    const epoch = ++projectEpochRef.current;
    loadGenerationRef.current += 1;
    revisionRef.current = "none";
    documentRef.current = null;
    patchQueueRef.current = Promise.resolve();
    pendingPatchesRef.current = 0;
    setRevision("none");
    setDocument(null);
    setReady(false);
    setLoading(Boolean(projectId));
    setSaveState("idle");
    void load(false);
    return () => {
      loadGenerationRef.current += 1;
      if (projectEpochRef.current === epoch) projectEpochRef.current += 1;
    };
  }, [load, projectId]);

  useEffect(() => {
    if (!projectId) return;
    const handleChange = (payload: unknown) => {
      if (!isEditListFileChange(payload, projectId) || pendingPatchesRef.current > 0) return;
      void load(true);
    };
    return subscribeProjectFileChanges(handleChange);
  }, [load, projectId]);

  const patchOperation = useCallback((
    operation: EditListOperation,
    actor?: EditListActor,
  ): Promise<EditListDocument> => {
    if (!projectId || !ready) {
      return Promise.reject(new Error("Editable timeline is not ready"));
    }
    const epoch = projectEpochRef.current;
    setSaveState("saving");
    pendingPatchesRef.current += 1;
    const run = patchQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (epoch !== projectEpochRef.current) throw new Error("Project changed while editing");
        try {
          const resource = await patchProjectEditList(projectId, revisionRef.current, operation, actor);
          if (epoch !== projectEpochRef.current) throw new Error("Project changed while editing");
          applyResource(resource, true);
          setSaveState("saved");
          if (!resource.document) throw new Error("Edit-list response did not contain a document");
          return resource.document;
        } catch (error) {
          if (
            error instanceof EditListApiError &&
            error.code === "revision_conflict" &&
            epoch === projectEpochRef.current
          ) {
            const reloaded = await load(true);
            setSaveState(reloaded ? "conflict" : "error");
          } else if (epoch === projectEpochRef.current) {
            setSaveState("error");
          }
          throw error;
        } finally {
          pendingPatchesRef.current = Math.max(0, pendingPatchesRef.current - 1);
        }
      });
    patchQueueRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }, [applyResource, load, projectId, ready]);

  const undoLastEditListChange = useCallback(async (): Promise<void> => {
    // Product-owned cut workspace history is ordered globally in CutWorkspace.
  }, []);

  return useMemo(
    () => ({
      projectId,
      document,
      revision,
      loading,
      ready,
      saveState,
      reload,
      patchOperation,
      canUndo: false,
      undoLastEditListChange,
    }),
    [
      document,
      loading,
      patchOperation,
      projectId,
      ready,
      reload,
      revision,
      saveState,
      undoLastEditListChange,
    ],
  );
}

const ProjectEditListContext = createContext<ProjectEditListState | null>(null);

export function ProjectEditListProvider({
  value,
  children,
}: {
  value: ProjectEditListState;
  children: ReactNode;
}) {
  return (
    <ProjectEditListContext.Provider value={value}>
      {children}
    </ProjectEditListContext.Provider>
  );
}

export function useProjectEditListContext(): ProjectEditListState {
  const value = useContext(ProjectEditListContext);
  if (!value) throw new Error("ProjectEditListProvider is missing");
  return value;
}
